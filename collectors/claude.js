// Claude Code Usage Collector for Herdr Mod
// Supports both the local machine (target.machine == null) and remote SSH machines (target.machine).
//
// Data sources:
//   - `claude --version`                                   → installed + version
//   - `$CLAUDE_CONFIG_DIR` / `~/.claude` / `~/.config/claude`
//       projects/**/<session>.jsonl                         → per-message token usage (local stats)
//       .credentials.json (Linux) or macOS Keychain item
//       "Claude Code-credentials"                           → OAuth token, subscription type, rate-limit tier
//   - GET https://api.anthropic.com/api/oauth/usage         → live 5-hour / weekly utilization windows
//
// The OAuth token is never refreshed by this collector (refreshing would rotate the refresh token
// out from under Claude Code). When it has expired we ask the user to run `claude` once.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const QUOTA_MIN_INTERVAL_MS = 60_000; // the usage endpoint rate-limits aggressive polling
const quotaCache = new Map(); // machineKey -> { at, quota, error }

const WINDOW_LABELS = {
  five_hour: "5-hour session",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_oauth_apps: "Weekly · OAuth apps",
  seven_day_cowork: "Weekly · Cowork",
};
const WINDOW_ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

function toNumberOrNull(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(val) {
  const n = toNumberOrNull(val);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function parseJsonSafe(text, fallback = null) {
  if (!text || typeof text !== "string") return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function shQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function prettifyKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\bseven day\b/i, "Weekly")
    .replace(/\bfive hour\b/i, "5-hour")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function formatClaudePlan(subscriptionType, rateLimitTier) {
  const sub = String(subscriptionType || "").toLowerCase();
  const tier = String(rateLimitTier || "").toLowerCase();
  if (!sub && !tier) return null;
  const mult = /(\d+)x/.exec(tier)?.[1];
  const base =
    sub === "max"
      ? "Max"
      : sub === "pro"
        ? "Pro"
        : sub === "team"
          ? "Team"
          : sub === "enterprise"
            ? "Enterprise"
            : sub
              ? sub.charAt(0).toUpperCase() + sub.slice(1)
              : "Claude";
  return mult ? `${base} ${mult}x` : base;
}

// Aggregates projects/**/*.jsonl on the target. Per-file results are cached keyed by (size, mtime)
// in ~/.cache/herdr-cli-usage so the 30-second fast poll only re-parses files that changed.
const STATS_SCRIPT = String.raw`
import json, os, sys, time
from datetime import datetime

cfg_dirs = []
for d in sys.argv[1:]:
    if d and os.path.isdir(os.path.join(d, "projects")) and os.path.realpath(d) not in [os.path.realpath(x) for x in cfg_dirs]:
        cfg_dirs.append(d)

WINDOW_DAYS = 30
HOURLY_DAYS = 8
now = time.time()
cutoff = now - WINDOW_DAYS * 86400
hourly_cutoff = int((now - HOURLY_DAYS * 86400) // 3600)

cache_dir = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "herdr-cli-usage")
cache_path = os.path.join(cache_dir, "claude-stats-v1.json")
try:
    with open(cache_path, "r") as fh:
        cache = json.load(fh)
    if not isinstance(cache, dict):
        cache = {}
except Exception:
    cache = {}

def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None

def first_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                return b["text"]
    return None

def parse_file(path):
    models, hours, sessions, seen = {}, {}, {}, set()
    stem = os.path.splitext(os.path.basename(path))[0]
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            is_usage = '"usage"' in line
            is_summary = '"type":"summary"' in line
            is_user = '"type":"user"' in line
            if not (is_usage or is_summary or is_user):
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            t = obj.get("type")
            if t == "summary":
                s = obj.get("summary")
                if isinstance(s, str) and s.strip():
                    sid = stem
                    sess = sessions.setdefault(sid, {"tokens": 0, "msgs": 0})
                    sess["summary"] = s.strip()[:120]
                continue
            sid = obj.get("sessionId") or stem
            if t == "user":
                sess = sessions.setdefault(sid, {"tokens": 0, "msgs": 0})
                if not sess.get("cwd") and obj.get("cwd"):
                    sess["cwd"] = obj.get("cwd")
                if sess.get("title") or obj.get("isMeta") or obj.get("isSidechain"):
                    continue
                msg = obj.get("message") or {}
                txt = first_text(msg.get("content"))
                if txt:
                    txt = " ".join(txt.split())
                    if txt and not txt.startswith("<") and not txt.startswith("Caveat:"):
                        sess["title"] = txt[:120]
                continue
            if t != "assistant":
                continue
            msg = obj.get("message") or {}
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            model = msg.get("model") or "unknown"
            if model == "<synthetic>":
                continue
            key = (msg.get("id"), obj.get("requestId"))
            if key != (None, None):
                if key in seen:
                    continue
                seen.add(key)
            vals = [
                int(usage.get("input_tokens") or 0),
                int(usage.get("output_tokens") or 0),
                int(usage.get("cache_creation_input_tokens") or 0),
                int(usage.get("cache_read_input_tokens") or 0),
            ]
            m = models.setdefault(model, [0, 0, 0, 0, 0])
            for i in range(4):
                m[i] += vals[i]
            m[4] += 1
            ts = parse_ts(obj.get("timestamp"))
            if ts is not None:
                h = int(ts // 3600)
                if h >= hourly_cutoff:
                    hb = hours.setdefault(str(h), [0, 0, 0, 0])
                    for i in range(4):
                        hb[i] += vals[i]
            sess = sessions.setdefault(sid, {"tokens": 0, "msgs": 0})
            sess["tokens"] += sum(vals)
            sess["msgs"] += 1
            sess["model"] = model
            if ts is not None:
                sess["last"] = max(sess.get("last") or 0, ts)
                sess["first"] = min(sess.get("first") or ts, ts)
            if not sess.get("cwd") and obj.get("cwd"):
                sess["cwd"] = obj.get("cwd")
    return {"models": models, "hours": hours, "sessions": sessions}

files = {}
for d in cfg_dirs:
    root = os.path.join(d, "projects")
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            if not n.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_mtime < cutoff:
                continue
            files[os.path.realpath(p)] = st

new_cache = {}
dirty = False
for p, st in files.items():
    sig = [st.st_size, int(st.st_mtime)]
    ent = cache.get(p)
    if isinstance(ent, dict) and ent.get("sig") == sig and isinstance(ent.get("data"), dict):
        new_cache[p] = ent
        continue
    try:
        new_cache[p] = {"sig": sig, "data": parse_file(p)}
        dirty = True
    except Exception:
        continue
if set(new_cache.keys()) != set(cache.keys()):
    dirty = True

if dirty:
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(new_cache, fh, separators=(",", ":"))
        os.replace(tmp, cache_path)
    except Exception:
        pass

models, hours, sessions = {}, {}, {}
for p, ent in new_cache.items():
    data = ent["data"]
    for name, v in data.get("models", {}).items():
        m = models.setdefault(name, [0, 0, 0, 0, 0])
        for i in range(5):
            m[i] += v[i]
    for h, v in data.get("hours", {}).items():
        if int(h) < hourly_cutoff:
            continue
        hb = hours.setdefault(int(h), [0, 0, 0, 0])
        for i in range(4):
            hb[i] += v[i]
    for sid, s in data.get("sessions", {}).items():
        agg = sessions.setdefault(sid, {"tokens": 0, "msgs": 0})
        agg["tokens"] += s.get("tokens", 0)
        agg["msgs"] += s.get("msgs", 0)
        for k in ("title", "summary", "cwd", "model"):
            if s.get(k) and (k == "model" or not agg.get(k)):
                if k == "model" and (s.get("last") or 0) < (agg.get("last") or 0):
                    continue
                agg[k] = s[k]
        if s.get("last"):
            agg["last"] = max(agg.get("last") or 0, s["last"])

def sum_hours(start_h):
    out = [0, 0, 0, 0]
    for h, v in hours.items():
        if h >= start_h:
            for i in range(4):
                out[i] += v[i]
    return out

local_midnight = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
today = sum_hours(int(local_midnight // 3600))
last5h = sum_hours(int((now - 5 * 3600) // 3600))
week = sum_hours(int((now - 7 * 86400) // 3600))

daily = {}
for h, v in hours.items():
    day = datetime.fromtimestamp(h * 3600).strftime("%Y-%m-%d")
    daily[day] = daily.get(day, 0) + sum(v)
days = []
for i in range(6, -1, -1):
    d = datetime.fromtimestamp(local_midnight - i * 86400 + 3600)
    key = d.strftime("%Y-%m-%d")
    days.append({"date": key, "label": d.strftime("%a"), "tokens": daily.get(key, 0)})

totals = [0, 0, 0, 0, 0]
for v in models.values():
    for i in range(5):
        totals[i] += v[i]

model_list = sorted(
    [{"model": k, "input": v[0], "output": v[1], "cacheWrite": v[2], "cacheRead": v[3], "messages": v[4]} for k, v in models.items()],
    key=lambda m: m["input"] + m["output"] + m["cacheWrite"] + m["cacheRead"],
    reverse=True,
)[:12]

active_sessions = [(sid, s) for sid, s in sessions.items() if s.get("msgs")]
recent = sorted(active_sessions, key=lambda kv: kv[1].get("last") or 0, reverse=True)[:6]

print(json.dumps({
    "windowDays": WINDOW_DAYS,
    "files": len(files),
    "totalSessions": len(active_sessions),
    "totalMessages": totals[4],
    "inputTokens": totals[0],
    "outputTokens": totals[1],
    "cacheWriteTokens": totals[2],
    "cacheReadTokens": totals[3],
    "today": {"input": today[0], "output": today[1], "cacheWrite": today[2], "cacheRead": today[3]},
    "last5h": {"input": last5h[0], "output": last5h[1], "cacheWrite": last5h[2], "cacheRead": last5h[3]},
    "last7d": {"input": week[0], "output": week[1], "cacheWrite": week[2], "cacheRead": week[3]},
    "daily": days,
    "models": model_list,
    "recentSessions": [
        {
            "id": sid,
            "title": s.get("summary") or s.get("title") or sid,
            "cwd": s.get("cwd"),
            "model": s.get("model"),
            "tokens": s.get("tokens", 0),
            "messages": s.get("msgs", 0),
            "updatedAt": int((s.get("last") or 0) * 1000) or None,
        }
        for sid, s in recent
    ],
}))
`;

export async function collectClaudeUsage(target = {}) {
  const machine = target?.machine ?? null;
  const includeRemoteQuota = target?.includeRemoteQuota !== false;
  const fetchFn = typeof target?.fetch === "function" ? target.fetch : globalThis.fetch;

  const runExec = async (cmd, args = [], opts = {}) => {
    if (typeof target?.exec !== "function") {
      return { code: 1, stdout: "", stderr: "exec unavailable on target" };
    }
    try {
      const res = await target.exec(cmd, args, { timeout: 15000, ...opts });
      return {
        code: typeof res?.code === "number" ? res.code : 1,
        stdout: typeof res?.stdout === "string" ? res.stdout : "",
        stderr: typeof res?.stderr === "string" ? res.stderr : "",
      };
    } catch (err) {
      return { code: 1, stdout: "", stderr: err?.message ? String(err.message) : String(err) };
    }
  };

  const readFile = async (path) => {
    if (typeof target?.readTextFile === "function") {
      try {
        const content = await target.readTextFile(path);
        if (typeof content === "string") return content;
      } catch {}
    }
    const res = await runExec("cat", [path], { timeout: 5000 });
    return res.code === 0 ? res.stdout : null;
  };

  const emptyResult = {
    installed: false,
    authenticated: false,
    authMode: null,
    version: null,
    error: null,
    notice: null,
    machine,
    plan: null,
    quota: { windows: [], extraUsage: null, source: null, fetchedAt: null },
    localStats: {
      windowDays: 30,
      totalSessions: 0,
      totalMessages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      today: null,
      last5h: null,
      last7d: null,
      daily: [],
      models: [],
      recentSessions: [],
    },
    updatedAt: Date.now(),
  };

  // 1. Probe binary, version, config dir, credentials presence, and python availability in one round-trip
  const probeScript = [
    'CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'ALT="$HOME/.config/claude"',
    'BIN="$(command -v claude 2>/dev/null || true)"',
    'if [ -z "$BIN" ]; then',
    '  for p in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.npm-global/bin/claude" "$HOME/.bun/bin/claude"; do',
    '    if [ -x "$p" ]; then BIN="$p"; break; fi',
    "  done",
    "fi",
    'VER=""',
    'if [ -n "$BIN" ]; then VER="$("$BIN" --version 2>/dev/null | head -n 1 || true)"; fi',
    'PROJ="0"; if [ -d "$CFG/projects" ] || [ -d "$ALT/projects" ]; then PROJ="1"; fi',
    'CREDF="0"; if [ -f "$CFG/.credentials.json" ]; then CREDF="1"; fi',
    'KC="0"',
    'if [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1; then',
    '  if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then KC="1"; fi',
    "fi",
    'APIKEY="0"; if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then APIKEY="1"; fi',
    'CUSTOM="0"',
    'if [ -n "${ANTHROPIC_BASE_URL:-}" ] || grep -qs "ANTHROPIC_BASE_URL\\|apiKeyHelper\\|CLAUDE_CODE_USE_BEDROCK\\|CLAUDE_CODE_USE_VERTEX" "$CFG/settings.json" 2>/dev/null; then CUSTOM="1"; fi',
    'PY="$(command -v python3 2>/dev/null || true)"',
    // macOS ships a /usr/bin/python3 stub that pops an installer dialog when CLT are missing
    'if [ "$PY" = "/usr/bin/python3" ] && [ "$(uname -s)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then PY=""; fi',
    'printf "BIN=%s\\nVER=%s\\nCFG=%s\\nALT=%s\\nPROJ=%s\\nCREDF=%s\\nKC=%s\\nAPIKEY=%s\\nCUSTOM=%s\\nPY=%s\\n" "$BIN" "$VER" "$CFG" "$ALT" "$PROJ" "$CREDF" "$KC" "$APIKEY" "$CUSTOM" "$PY"',
  ].join("\n");

  const probeRes = await runExec("sh", ["-c", probeScript], { timeout: 8000 });
  const probe = {};
  for (const line of probeRes.stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) probe[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const bin = probe.BIN || "";
  const hasProjects = probe.PROJ === "1";
  const installed = Boolean(bin || hasProjects);
  if (!installed) return emptyResult;

  const rawVersion = probe.VER || "";
  const version = /(\d+\.\d+\.\d+)/.exec(rawVersion)?.[1] || (rawVersion || null);
  const cfgDir = probe.CFG || `${target.homeDir || "~"}/.claude`;
  const hasOauth = probe.CREDF === "1" || probe.KC === "1";
  const authMode = hasOauth ? "oauth" : probe.CUSTOM === "1" ? "custom" : probe.APIKEY === "1" ? "apikey" : null;

  const result = {
    ...emptyResult,
    installed: true,
    authenticated: Boolean(authMode),
    authMode,
    version,
  };

  // 2. Local token stats from session JSONL files
  const queryLocalStats = async () => {
    if (!hasProjects) return null;
    if (!probe.PY) return { error: "python3 not found — local token stats unavailable" };
    const cmd = `${shQuote(probe.PY)} - ${shQuote(cfgDir)} ${shQuote(probe.ALT || "")} <<'PY'\n${STATS_SCRIPT}\nPY`;
    const res = await runExec("sh", ["-c", cmd], { timeout: 45000 });
    const parsed = parseJsonSafe(res.stdout.trim().split("\n").pop(), null);
    if (!parsed) {
      return { error: res.stderr ? `Stats scan failed: ${res.stderr.trim().split("\n").pop()}` : null };
    }
    return { stats: parsed };
  };

  // 3. Live plan quota via OAuth usage endpoint
  const queryQuota = async () => {
    if (!includeRemoteQuota || !hasOauth) return null;
    const cacheKey = machine || "local";
    const cached = quotaCache.get(cacheKey);
    if (cached && Date.now() - cached.at < QUOTA_MIN_INTERVAL_MS) return cached;

    let credsText = null;
    if (probe.CREDF === "1") {
      credsText = await readFile(`${cfgDir}/.credentials.json`);
    }
    if (!credsText && probe.KC === "1") {
      const kc = await runExec(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 8000 }
      );
      if (kc.code === 0) credsText = kc.stdout.trim();
    }
    const creds = parseJsonSafe(credsText, null);
    const oauth = creds?.claudeAiOauth || null;
    const out = { at: Date.now(), quota: null, plan: null, error: null, notice: null };
    if (!oauth?.accessToken) {
      out.notice = "Signed-in credentials not readable — showing local stats only.";
      quotaCache.set(cacheKey, out);
      return out;
    }
    out.plan = formatClaudePlan(oauth.subscriptionType, oauth.rateLimitTier);
    const expiresAt = toNumberOrNull(oauth.expiresAt);
    if (expiresAt && expiresAt < Date.now()) {
      out.notice = "OAuth token expired — run `claude` once to refresh it.";
      quotaCache.set(cacheKey, out);
      return out;
    }

    const headers = {
      Authorization: `Bearer ${oauth.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": `claude-code/${version || "2.0.0"}`,
    };

    let body = null;
    let httpError = null;
    if (!machine && typeof fetchFn === "function") {
      try {
        const resp = await fetchFn(USAGE_URL, { method: "GET", headers });
        if (resp?.ok) body = await resp.json();
        else if (resp) httpError = `Usage API HTTP ${resp.status}`;
      } catch (err) {
        httpError = err?.message ? String(err.message) : String(err);
      }
    }
    if (!body) {
      const args = ["-sS", "--max-time", "8", "-w", "\n%{http_code}"];
      for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
      args.push(USAGE_URL);
      const res = await runExec("curl", args, { timeout: 12000 });
      const lines = res.stdout.trim().split("\n");
      const status = Number(lines.pop());
      if (status >= 200 && status < 300) {
        body = parseJsonSafe(lines.join("\n"), null);
        httpError = null;
      } else if (status) {
        httpError = status === 429 ? "Usage API rate-limited (429) — will retry" : `Usage API HTTP ${status}`;
      } else if (!httpError) {
        httpError = res.stderr.trim() || "Usage API unreachable";
      }
    }

    if (body && typeof body === "object") {
      const windows = [];
      for (const [key, val] of Object.entries(body)) {
        if (!val || typeof val !== "object" || key === "extra_usage") continue;
        const used = clampPercent(val.utilization);
        if (used === null) continue;
        windows.push({
          id: key,
          label: WINDOW_LABELS[key] || prettifyKey(key),
          usedPercent: used,
          remainingPercent: clampPercent(100 - used),
          resetAt: val.resets_at || null,
        });
      }
      windows.sort((a, b) => {
        const ia = WINDOW_ORDER.indexOf(a.id);
        const ib = WINDOW_ORDER.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      const extra = body.extra_usage;
      out.quota = {
        windows,
        extraUsage:
          extra && extra.is_enabled
            ? { enabled: true, usedPercent: clampPercent(extra.utilization) }
            : null,
        source: "live",
        fetchedAt: Date.now(),
      };
    } else {
      out.error = httpError;
    }
    quotaCache.set(cacheKey, out);
    return out;
  };

  const [local, quotaRes] = await Promise.all([queryLocalStats(), queryQuota()]);

  if (local?.stats) {
    result.localStats = { ...result.localStats, ...local.stats };
  } else if (local?.error) {
    result.notice = local.error;
  }

  if (quotaRes) {
    if (quotaRes.plan) result.plan = quotaRes.plan;
    if (quotaRes.quota) result.quota = quotaRes.quota;
    if (quotaRes.error) result.error = quotaRes.error;
    if (quotaRes.notice) result.notice = quotaRes.notice;
  }

  if (!hasOauth && !result.notice) {
    result.notice =
      authMode === "custom"
        ? "Custom API endpoint — plan limits not applicable."
        : authMode === "apikey"
          ? "API key mode — plan limits not applicable."
          : "Not signed in to a Claude subscription — showing local stats only.";
  }

  result.updatedAt = Date.now();
  return result;
}

export default collectClaudeUsage;
