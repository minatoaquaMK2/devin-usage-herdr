// Codex CLI Usage Collector for Herdr Mod
// Supports both local machine (target.machine == null) and remote SSH machines (target.machine)

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

export async function collectCodexUsage(target = {}) {
  const machine = target?.machine ?? null;
  const includeRemoteQuota = target?.includeRemoteQuota !== false;
  const fetchFn = typeof target?.fetch === "function" ? target.fetch : globalThis.fetch;

  const runExec = async (cmd, args = [], opts = {}) => {
    if (typeof target?.exec !== "function") {
      return { code: 1, stdout: "", stderr: "exec unavailable on target" };
    }
    try {
      const res = await target.exec(cmd, args, {
        on: machine || undefined,
        timeout: 15000,
        ...opts,
      });
      return {
        code: typeof res?.code === "number" ? res.code : 1,
        stdout: typeof res?.stdout === "string" ? res.stdout : "",
        stderr: typeof res?.stderr === "string" ? res.stderr : "",
      };
    } catch (err) {
      return {
        code: 1,
        stdout: "",
        stderr: err?.message ? String(err.message) : String(err),
      };
    }
  };

  const readFile = async (path, opts = {}) => {
    if (typeof target?.readTextFile === "function") {
      try {
        const content = await target.readTextFile(path, {
          on: machine || undefined,
          ...opts,
        });
        if (typeof content === "string") return content;
      } catch {
        // Fallback to cat via exec below if needed
      }
    }
    const res = await runExec("cat", [path], { timeout: 5000 });
    return res.code === 0 ? res.stdout : null;
  };

  let homeDir = typeof target?.homeDir === "string" ? target.homeDir.trim() : "";
  if (!homeDir) {
    const homeRes = await runExec("sh", ["-c", 'printf %s "$HOME"'], { timeout: 5000 });
    homeDir = homeRes.stdout.trim();
  }

  const emptyResult = {
    installed: false,
    authenticated: false,
    version: null,
    error: null,
    machine,
    quota: {
      planType: null,
      usedPercent: null,
      remainingPercent: null,
      windowSeconds: null,
      resetAt: null,
      secondaryUsedPercent: null,
      secondaryResetAt: null,
      creditsBalance: null,
      resetCreditsAvailable: null,
    },
    localStats: {
      totalThreads: 0,
      totalTokens: 0,
      lifetimeTokens: null,
      peakDailyTokens: null,
      streakDays: null,
      models: [],
      recentThreads: [],
    },
    updatedAt: Date.now(),
  };

  if (!homeDir) {
    emptyResult.error = machine
      ? `Unable to resolve $HOME on remote machine (${machine})`
      : "Unable to resolve local $HOME directory";
    return emptyResult;
  }

  // 1. Probe codex binary, version, state_*.sqlite, and latest rollout file in one command
  const probeScript = [
    'CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"',
    'CODEX_BIN="$(command -v codex 2>/dev/null || true)"',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for p in /opt/homebrew/bin/codex /usr/local/bin/codex "$HOME/.local/bin/codex" "$HOME/.cargo/bin/codex"; do',
    '    if [ -x "$p" ]; then CODEX_BIN="$p"; break; fi',
    '  done',
    'fi',
    'CODEX_VER=""',
    'if [ -n "$CODEX_BIN" ]; then',
    '  CODEX_VER="$("$CODEX_BIN" --version 2>/dev/null | head -n 1 || true)"',
    'fi',
    'STATE_DB="$(ls -1t "$CODEX_HOME_DIR"/state_*.sqlite 2>/dev/null | head -n 1 || true)"',
    'if [ -z "$STATE_DB" ] && [ -f "$CODEX_HOME_DIR/sqlite/state_5.sqlite" ]; then',
    '  STATE_DB="$CODEX_HOME_DIR/sqlite/state_5.sqlite"',
    'fi',
    'AUTH_EXISTS="0"',
    'if [ -f "$CODEX_HOME_DIR/auth.json" ]; then AUTH_EXISTS="1"; fi',
    'printf "BIN=%s\\nVER=%s\\nDB=%s\\nHOME_DIR=%s\\nAUTH=%s\\n" "$CODEX_BIN" "$CODEX_VER" "$STATE_DB" "$CODEX_HOME_DIR" "$AUTH_EXISTS"',
  ].join("\n");

  const probeRes = await runExec("sh", ["-c", probeScript], { timeout: 8000 });
  const probeMap = {};
  for (const line of probeRes.stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      probeMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const codexBin = probeMap.BIN || "";
  const rawVersion = probeMap.VER || "";
  const version = rawVersion ? rawVersion.replace(/^codex-cli\s+/i, "").trim() || rawVersion : null;
  const stateDbPath = probeMap.DB || "";
  const codexHomeDir = probeMap.HOME_DIR || `${homeDir}/.codex`;
  const authExists = probeMap.AUTH === "1";

  // 2. Read auth.json
  const authPath = `${codexHomeDir}/auth.json`;
  const authRaw = authExists ? await readFile(authPath) : null;
  const authJson = parseJsonSafe(authRaw, null);

  const accessToken = authJson?.tokens?.access_token || null;
  const accountId = authJson?.tokens?.account_id || null;
  const apiKey = authJson?.OPENAI_API_KEY || null;
  const authMode =
    authJson?.auth_mode ||
    (accessToken ? "chatgpt" : apiKey ? "apikey" : null);

  const installed = Boolean(codexBin || stateDbPath || authJson);
  const authenticated = Boolean(accessToken || apiKey);

  if (!installed) {
    return emptyResult;
  }

  const result = {
    ...emptyResult,
    installed,
    authenticated,
    version,
    authMode,
  };

  // 3. Query local SQLite stats + fallback rate_limits from latest rollout in parallel with remote quota
  const queryLocalSqlite = async () => {
    if (!stateDbPath) return null;
    const dbQ = shQuote(stateDbPath);
    const sqlScript = [
      `SUMMARY=$(sqlite3 -json ${dbQ} "SELECT COUNT(*) AS totalThreads, COALESCE(SUM(tokens_used), 0) AS totalTokens FROM threads;" 2>/dev/null || echo "[]")`,
      `MODELS=$(sqlite3 -json ${dbQ} "SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model, COALESCE(model_provider, 'openai') AS provider, COUNT(*) AS threads, COALESCE(SUM(tokens_used), 0) AS tokensUsed FROM threads GROUP BY model_provider, model HAVING tokensUsed > 0 OR threads > 0 ORDER BY tokensUsed DESC LIMIT 15;" 2>/dev/null || echo "[]")`,
      `RECENT=$(sqlite3 -json ${dbQ} "SELECT id, COALESCE(NULLIF(title, ''), NULLIF(name, ''), substr(first_user_message, 1, 80), id) AS title, COALESCE(NULLIF(model, ''), 'unknown') AS model, reasoning_effort AS reasoningEffort, COALESCE(tokens_used, 0) AS tokensUsed, cwd, updated_at AS updatedAt, rollout_path AS rolloutPath FROM threads ORDER BY updated_at DESC LIMIT 5;" 2>/dev/null || echo "[]")`,
      `LAST_ROLLOUT=$(sqlite3 ${dbQ} "SELECT rollout_path FROM threads WHERE rollout_path != '' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null || true)`,
      `LAST_TOKEN_EVENT=""`,
      `if [ -n "$LAST_ROLLOUT" ] && [ -f "$LAST_ROLLOUT" ]; then`,
      `  LAST_TOKEN_EVENT=$(grep '"token_count"' "$LAST_ROLLOUT" 2>/dev/null | tail -n 1 || true)`,
      `fi`,
      `printf "===SUMMARY===\\n%s\\n===MODELS===\\n%s\\n===RECENT===\\n%s\\n===LAST_TOKEN_EVENT===\\n%s\\n" "$SUMMARY" "$MODELS" "$RECENT" "$LAST_TOKEN_EVENT"`,
    ].join("\n");

    const sqlRes = await runExec("sh", ["-c", sqlScript], { timeout: 10000 });
    if (sqlRes.code !== 0 && !sqlRes.stdout) return null;

    const sections = {};
    let currentKey = null;
    let buffer = [];
    for (const line of sqlRes.stdout.split("\n")) {
      const m = line.match(/^===(SUMMARY|MODELS|RECENT|LAST_TOKEN_EVENT)===$/);
      if (m) {
        if (currentKey) sections[currentKey] = buffer.join("\n").trim();
        currentKey = m[1];
        buffer = [];
      } else if (currentKey) {
        buffer.push(line);
      }
    }
    if (currentKey) sections[currentKey] = buffer.join("\n").trim();

    const summaryArr = parseJsonSafe(sections.SUMMARY, []);
    const modelsArr = parseJsonSafe(sections.MODELS, []);
    const recentArr = parseJsonSafe(sections.RECENT, []);
    const lastTokenEvent = parseJsonSafe(sections.LAST_TOKEN_EVENT, null);

    return {
      summary: Array.isArray(summaryArr) && summaryArr[0] ? summaryArr[0] : null,
      models: Array.isArray(modelsArr) ? modelsArr : [],
      recent: Array.isArray(recentArr) ? recentArr : [],
      lastTokenEvent,
    };
  };

  // 4. Fetch live quota via WHAM HTTP endpoint and/or codex app-server --stdio
  const queryRemoteQuotaAndUsage = async () => {
    const out = {
      whamData: null,
      appServerRateLimits: null,
      appServerUsage: null,
      error: null,
    };

    if (!includeRemoteQuota) return out;

    // 4a. Direct WHAM HTTP endpoint when ChatGPT OAuth token is available
    if (accessToken) {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": `codex-cli/${version || "0.162.1"}`,
      };
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      if (typeof fetchFn === "function") {
        try {
          const resp = await fetchFn("https://chatgpt.com/backend-api/wham/usage", {
            method: "GET",
            headers,
          });
          if (resp && resp.ok) {
            out.whamData = await resp.json();
          } else if (resp) {
            out.error = `WHAM usage HTTP ${resp.status}`;
          }
        } catch (err) {
          out.error = err?.message ? String(err.message) : String(err);
        }
      }

      // Fallback to curl on target machine if direct fetch failed
      if (!out.whamData) {
        const curlArgs = [
          "-fsSL",
          "--max-time",
          "8",
          "-H",
          `Authorization: Bearer ${accessToken}`,
          "-H",
          `User-Agent: codex-cli/${version || "0.162.1"}`,
        ];
        if (accountId) {
          curlArgs.push("-H", `ChatGPT-Account-Id: ${accountId}`);
        }
        curlArgs.push("https://chatgpt.com/backend-api/wham/usage");
        const curlRes = await runExec("curl", curlArgs, { timeout: 10000 });
        if (curlRes.code === 0 && curlRes.stdout) {
          const parsed = parseJsonSafe(curlRes.stdout, null);
          if (parsed && typeof parsed === "object") {
            out.whamData = parsed;
            out.error = null;
          }
        }
      }
    }

    // 4b. Call `codex app-server --stdio` for lifetime/daily token stats (`account/usage/read`)
    // and as an auto-refreshing fallback for `account/rateLimits/read`
    if (codexBin) {
      const needRateLimitsFromRpc = !out.whamData;
      const rpcInput = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "herdr-cli-usage", version: "1.0.0" } },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "account/usage/read",
          params: {},
        }),
      ];
      if (needRateLimitsFromRpc) {
        rpcInput.push(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "account/rateLimits/read",
            params: {},
          })
        );
      }

      const targetMaxId = needRateLimitsFromRpc ? 3 : 2;
      const payloadLines = rpcInput.map((l) => `${l}\n`).join("");
      const rpcCmd = [
        `if command -v python3 >/dev/null 2>&1; then`,
        `  python3 - ${shQuote(codexBin)} ${targetMaxId} ${shQuote(payloadLines)} <<'PY'`,
        `import json, subprocess, sys`,
        `bin_path, max_id, payload = sys.argv[1], int(sys.argv[2]), sys.argv[3]`,
        `proc = subprocess.Popen([bin_path, "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)`,
        `try:`,
        `    proc.stdin.write(payload)`,
        `    proc.stdin.flush()`,
        `    seen = set()`,
        `    for line in proc.stdout:`,
        `        sys.stdout.write(line)`,
        `        sys.stdout.flush()`,
        `        try:`,
        `            obj = json.loads(line)`,
        `            if isinstance(obj.get("id"), int):`,
        `                seen.add(obj["id"])`,
        `                if max_id in seen and 2 in seen:`,
        `                    break`,
        `        except Exception:`,
        `            pass`,
        `finally:`,
        `    proc.terminate()`,
        `PY`,
        `else`,
        `  (printf '%s' ${shQuote(payloadLines)}; sleep 3) | ${shQuote(codexBin)} app-server --stdio 2>/dev/null`,
        `fi`,
      ].join("\n");
      const rpcRes = await runExec("sh", ["-c", rpcCmd], { timeout: 10000 });
      if (rpcRes.stdout) {
        for (const line of rpcRes.stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          const msg = parseJsonSafe(trimmed, null);
          if (!msg) continue;
          if (msg.id === 2 && msg.result) {
            out.appServerUsage = msg.result;
          } else if (msg.id === 3 && msg.result) {
            out.appServerRateLimits = msg.result;
            out.error = null;
          }
        }
      }
    }

    return out;
  };

  const [localData, remoteData] = await Promise.all([
    queryLocalSqlite(),
    queryRemoteQuotaAndUsage(),
  ]);

  // 5. Populate localStats
  if (localData) {
    const totalThreads = toNumberOrNull(localData.summary?.totalThreads) ?? 0;
    const totalTokens = toNumberOrNull(localData.summary?.totalTokens) ?? 0;
    result.localStats.totalThreads = totalThreads;
    result.localStats.totalTokens = totalTokens;
    result.localStats.lifetimeTokens = totalTokens > 0 ? totalTokens : null;

    result.localStats.models = localData.models.map((m) => ({
      model: m.model || "unknown",
      provider: m.provider || "openai",
      threads: toNumberOrNull(m.threads) ?? 0,
      tokensUsed: toNumberOrNull(m.tokensUsed) ?? 0,
    }));

    result.localStats.recentThreads = localData.recent.map((r) => ({
      id: r.id,
      title: String(r.title || r.id || "Untitled").replace(/\s+/g, " ").trim(),
      model: r.model || "unknown",
      reasoningEffort: r.reasoningEffort || null,
      tokensUsed: toNumberOrNull(r.tokensUsed) ?? 0,
      cwd: r.cwd || null,
      updatedAt: toNumberOrNull(r.updatedAt),
    }));
  }

  // Enrich localStats with account/usage/read summary if available
  if (remoteData?.appServerUsage?.summary) {
    const s = remoteData.appServerUsage.summary;
    const lifetime = toNumberOrNull(s.lifetimeTokens);
    if (lifetime !== null) {
      result.localStats.lifetimeTokens = lifetime;
    }
    result.localStats.peakDailyTokens = toNumberOrNull(s.peakDailyTokens);
    result.localStats.streakDays = toNumberOrNull(s.currentStreakDays);
    result.localStats.longestStreakDays = toNumberOrNull(s.longestStreakDays);
  }

  // 6. Populate quota from WHAM HTTP -> app-server RPC -> cached rollout event_msg fallback
  if (remoteData?.whamData) {
    const w = remoteData.whamData;
    const primary = w.rate_limit?.primary_window || null;
    const secondary = w.rate_limit?.secondary_window || null;
    const usedPercent = clampPercent(primary?.used_percent);
    const secondaryUsedPercent = clampPercent(secondary?.used_percent);

    result.quota = {
      planType: w.plan_type || null,
      usedPercent,
      remainingPercent: usedPercent !== null ? clampPercent(100 - usedPercent) : null,
      windowSeconds: toNumberOrNull(primary?.limit_window_seconds),
      resetAt: toNumberOrNull(primary?.reset_at),
      secondaryUsedPercent,
      secondaryResetAt: toNumberOrNull(secondary?.reset_at),
      creditsBalance: toNumberOrNull(w.credits?.balance),
      resetCreditsAvailable: toNumberOrNull(w.rate_limit_reset_credits?.available_count),
    };
  } else if (remoteData?.appServerRateLimits?.rateLimits) {
    const rl = remoteData.appServerRateLimits.rateLimits;
    const primary = rl.primary || null;
    const secondary = rl.secondary || null;
    const usedPercent = clampPercent(primary?.usedPercent);
    const secondaryUsedPercent = clampPercent(secondary?.usedPercent);
    const winMins = toNumberOrNull(primary?.windowDurationMins);

    result.quota = {
      planType: rl.planType || null,
      usedPercent,
      remainingPercent: usedPercent !== null ? clampPercent(100 - usedPercent) : null,
      windowSeconds: winMins !== null ? winMins * 60 : null,
      resetAt: toNumberOrNull(primary?.resetsAt),
      secondaryUsedPercent,
      secondaryResetAt: toNumberOrNull(secondary?.resetsAt),
      creditsBalance: toNumberOrNull(rl.credits?.balance),
      resetCreditsAvailable: toNumberOrNull(
        remoteData.appServerRateLimits?.rateLimitResetCredits?.availableCount
      ),
    };
  } else if (localData?.lastTokenEvent?.payload?.rate_limits) {
    const rl = localData.lastTokenEvent.payload.rate_limits;
    const primary = rl.primary || null;
    const secondary = rl.secondary || null;
    const usedPercent = clampPercent(primary?.used_percent);
    const secondaryUsedPercent = clampPercent(secondary?.used_percent);
    const winMins = toNumberOrNull(primary?.window_minutes);

    result.quota = {
      planType: rl.plan_type || null,
      usedPercent,
      remainingPercent: usedPercent !== null ? clampPercent(100 - usedPercent) : null,
      windowSeconds: winMins !== null ? winMins * 60 : null,
      resetAt: toNumberOrNull(primary?.resets_at),
      secondaryUsedPercent,
      secondaryResetAt: toNumberOrNull(secondary?.resets_at),
      creditsBalance: toNumberOrNull(rl.credits?.balance),
      resetCreditsAvailable: null,
    };
  } else if (remoteData?.error) {
    result.error = remoteData.error;
  }

  result.updatedAt = Date.now();
  return result;
}

export default collectCodexUsage;
