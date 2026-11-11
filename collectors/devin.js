// Devin CLI (`devin`) Usage & Quota Collector for Herdr Mod
// Supports both local machine (`target.machine === null`) and remote SSH machines (`target.machine`).

function parseTomlKeyValues(text) {
  const out = {};
  if (!text || typeof text !== "string") return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function decodeBase64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = alphabet.indexOf(clean[i]);
    const c1 = alphabet.indexOf(clean[i + 1]);
    const c2 = i + 2 < clean.length ? alphabet.indexOf(clean[i + 2]) : -1;
    const c3 = i + 3 < clean.length ? alphabet.indexOf(clean[i + 3]) : -1;
    const triple =
      (c0 << 18) | (c1 << 12) | ((c2 & 63) << 6) | (c3 & 63);
    out.push((triple >> 16) & 0xff);
    if (c2 !== -1) out.push((triple >> 8) & 0xff);
    if (c3 !== -1) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  const signed = BigInt.asIntN(64, result);
  return { value: Number(signed), nextOffset: i };
}

function parseProtoFields(bytes) {
  const fields = {};
  let i = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i < bytes.length) {
    const tagRes = readVarint(bytes, i);
    i = tagRes.nextOffset;
    const fieldNum = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (!fieldNum) break;
    let val;
    if (wireType === 0) {
      const vRes = readVarint(bytes, i);
      val = vRes.value;
      i = vRes.nextOffset;
    } else if (wireType === 1) {
      if (i + 8 > bytes.length) break;
      val = view.getFloat64(i, true);
      i += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(bytes, i);
      i = lenRes.nextOffset;
      const end = Math.min(bytes.length, i + lenRes.value);
      val = bytes.subarray(i, end);
      i = end;
    } else if (wireType === 5) {
      if (i + 4 > bytes.length) break;
      val = view.getFloat32(i, true);
      i += 4;
    } else {
      break;
    }
    if (!fields[fieldNum]) fields[fieldNum] = [];
    fields[fieldNum].push({ wireType, value: val });
  }
  return fields;
}

function bytesToUtf8(bytes) {
  if (!bytes) return "";
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function parseCachedUserStatusBin(binJsonText) {
  if (!binJsonText) return null;
  try {
    const wrapper = JSON.parse(binJsonText);
    if (!wrapper || !wrapper.payload) return null;
    const raw = decodeBase64ToBytes(wrapper.payload);
    const userStatus = parseProtoFields(raw);
    const psEntry = userStatus[13]?.[0];
    if (!psEntry || psEntry.wireType !== 2) return null;
    const ps = parseProtoFields(psEntry.value);

    let planName = "Devin";
    let orgName = null;
    let orgId = null;
    let webappHost = null;
    let personalAnalyticsUrl = null;
    let requestUsageUrl = null;

    const piEntry = ps[1]?.[0];
    if (piEntry && piEntry.wireType === 2) {
      const pi = parseProtoFields(piEntry.value);
      if (pi[2]?.[0]?.wireType === 2) {
        planName = bytesToUtf8(pi[2][0].value) || planName;
      }
      const devinInfoEntry = pi[33]?.[0];
      if (devinInfoEntry && devinInfoEntry.wireType === 2) {
        const di = parseProtoFields(devinInfoEntry.value);
        if (di[4]?.[0]?.wireType === 2) orgId = bytesToUtf8(di[4][0].value);
        if (di[5]?.[0]?.wireType === 2) webappHost = bytesToUtf8(di[5][0].value);
        if (di[8]?.[0]?.wireType === 2) orgName = bytesToUtf8(di[8][0].value);
        if (di[9]?.[0]?.wireType === 2) {
          personalAnalyticsUrl = bytesToUtf8(di[9][0].value);
        }
        if (di[11]?.[0]?.wireType === 2) {
          requestUsageUrl = bytesToUtf8(di[11][0].value);
        }
      }
    }

    const decodeTimestampIso = (entry) => {
      if (!entry || entry.wireType !== 2) return null;
      const ts = parseProtoFields(entry.value);
      const secs = ts[1]?.[0]?.value;
      if (typeof secs === "number" && secs > 0) {
        return new Date(secs * 1000).toISOString();
      }
      return null;
    };

    const planStart = decodeTimestampIso(ps[2]?.[0]);
    const planEnd = decodeTimestampIso(ps[3]?.[0]);
    const acuUsed =
      typeof ps[19]?.[0]?.value === "number" ? ps[19][0].value : 0;
    const acuLimit =
      typeof ps[20]?.[0]?.value === "number" ? ps[20][0].value : 0;
    const usedPromptCredits =
      typeof ps[4]?.[0]?.value === "number" ? ps[4][0].value : 0;
    const availablePromptCredits =
      typeof ps[8]?.[0]?.value === "number" ? ps[8][0].value : -1;

    return normalizePlanObject({
      planName,
      org: orgName || orgId || null,
      orgId,
      webappHost,
      personalAnalyticsUrl,
      requestUsageUrl,
      acuUsed,
      acuLimit,
      planStart,
      planEnd,
      creditsUsed: usedPromptCredits > 0 ? usedPromptCredits : 0,
      creditsLimit: availablePromptCredits > 0 ? availablePromptCredits : null,
      source: "cache",
      fetchedAtSecs: wrapper.fetched_at_secs || null,
    });
  } catch (_err) {
    return null;
  }
}

function normalizePlanObject(raw) {
  const acuUsed = Number(raw.acuUsed ?? 0);
  const acuLimit = Number(raw.acuLimit ?? 0);
  const usedPercent =
    acuLimit > 0
      ? Math.min(100, Math.max(0, Number(((acuUsed / acuLimit) * 100).toFixed(1))))
      : 0;
  const remainingAcu =
    acuLimit > 0 ? Math.max(0, Number((acuLimit - acuUsed).toFixed(2))) : 0;

  return {
    name: raw.planName || "Devin",
    org: raw.org || null,
    orgId: raw.orgId || null,
    webappHost: raw.webappHost || null,
    personalAnalyticsUrl: raw.personalAnalyticsUrl || null,
    requestUsageUrl: raw.requestUsageUrl || null,
    acuUsed: Number(acuUsed.toFixed(2)),
    acuLimit: Number(acuLimit.toFixed(2)),
    usedPercent,
    remainingPercent:
      acuLimit > 0 ? Math.max(0, Number((100 - usedPercent).toFixed(1))) : 0,
    remainingAcu,
    planStart: raw.planStart || null,
    planEnd: raw.planEnd || null,
    creditsUsed: raw.creditsUsed ?? 0,
    creditsLimit: raw.creditsLimit ?? null,
    dailyQuotaRemainingPercent: raw.dailyQuotaRemainingPercent ?? null,
    weeklyQuotaRemainingPercent: raw.weeklyQuotaRemainingPercent ?? null,
    source: raw.source || "live",
  };
}

function parseLiveGetUserStatusJson(data) {
  const us = data?.userStatus;
  const ps = us?.planStatus;
  if (!ps) return null;
  const pi = ps.planInfo || {};
  const di = pi.devinInfo || {};
  const acuUsed = Number(ps.acuConsumed ?? 0);
  const acuLimit = Number(ps.acuLimit ?? 0);
  const usedPromptCredits = Number(ps.usedPromptCredits ?? 0);
  const availPromptCredits = Number(ps.availablePromptCredits ?? -1);

  return normalizePlanObject({
    planName: pi.planName || "Devin",
    org: di.accountDisplayName || di.orgId || di.primaryOrgId || null,
    orgId: di.orgId || di.primaryOrgId || null,
    webappHost: di.webappHost || null,
    personalAnalyticsUrl: di.personalAnalyticsUrl || null,
    requestUsageUrl: di.requestUsageUrl || null,
    acuUsed,
    acuLimit,
    planStart: ps.planStart || null,
    planEnd: ps.planEnd || null,
    creditsUsed: usedPromptCredits > 0 ? usedPromptCredits : 0,
    creditsLimit: availPromptCredits > 0 ? availPromptCredits : null,
    dailyQuotaRemainingPercent:
      ps.dailyQuotaRemainingPercent !== undefined
        ? Number(ps.dailyQuotaRemainingPercent)
        : null,
    weeklyQuotaRemainingPercent:
      ps.weeklyQuotaRemainingPercent !== undefined
        ? Number(ps.weeklyQuotaRemainingPercent)
        : null,
    source: "live",
  });
}

const SESSIONS_SQL = `
WITH dedup_nodes AS (
  SELECT
    session_id,
    COALESCE(json_extract(chat_message, '$.metadata.generation_model'), 'unknown') AS model,
    MAX(CAST(json_extract(chat_message, '$.metadata.committed_acu_cost') AS REAL)) AS acu_cost,
    MAX(CAST(json_extract(chat_message, '$.metadata.metrics.input_tokens') AS INTEGER)) AS input_tokens,
    MAX(CAST(json_extract(chat_message, '$.metadata.metrics.output_tokens') AS INTEGER)) AS output_tokens,
    MAX(CAST(json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS INTEGER)) AS cache_read_tokens,
    MAX(CAST(json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS INTEGER)) AS cache_creation_tokens
  FROM message_nodes
  WHERE json_extract(chat_message, '$.role') = 'assistant'
  GROUP BY session_id, COALESCE(json_extract(chat_message, '$.metadata.request_id'), json_extract(chat_message, '$.message_id'), CAST(row_id AS TEXT))
),
model_agg AS (
  SELECT
    model,
    COUNT(*) AS turns,
    ROUND(COALESCE(SUM(acu_cost), 0), 4) AS acuCost,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens
  FROM dedup_nodes
  WHERE model != 'unknown' AND model != 'compactor'
  GROUP BY model
  ORDER BY acuCost DESC, turns DESC
),
recent_sess AS (
  SELECT
    id,
    COALESCE(NULLIF(TRIM(title), ''), id) AS title,
    model,
    working_directory AS cwd,
    created_at AS createdAt,
    last_activity_at AS updatedAt,
    ROUND(COALESCE(CAST(json_extract(metadata, '$.total_acu_cost') AS REAL), 0), 4) AS acuCost,
    ROUND(COALESCE(CAST(json_extract(metadata, '$.total_credit_cost') AS REAL), 0), 4) AS creditCost
  FROM sessions
  WHERE COALESCE(hidden, 0) = 0
  ORDER BY last_activity_at DESC
  LIMIT 5
)
SELECT json_object(
  'totalSessions', (SELECT COUNT(*) FROM sessions WHERE COALESCE(hidden, 0) = 0),
  'totalAcuCost', (SELECT ROUND(COALESCE(SUM(CAST(json_extract(metadata, '$.total_acu_cost') AS REAL)), 0), 4) FROM sessions),
  'totalCreditCost', (SELECT ROUND(COALESCE(SUM(CAST(json_extract(metadata, '$.total_credit_cost') AS REAL)), 0), 4) FROM sessions),
  'totalInputTokens', (SELECT COALESCE(SUM(inputTokens), 0) FROM model_agg),
  'totalOutputTokens', (SELECT COALESCE(SUM(outputTokens), 0) FROM model_agg),
  'totalCacheReadTokens', (SELECT COALESCE(SUM(cacheReadTokens), 0) FROM model_agg),
  'totalCacheCreationTokens', (SELECT COALESCE(SUM(cacheCreationTokens), 0) FROM model_agg),
  'totalTurns', (SELECT COALESCE(SUM(turns), 0) FROM model_agg),
  'models', COALESCE((SELECT json_group_array(json_object(
    'model', model,
    'turns', turns,
    'acuCost', acuCost,
    'inputTokens', inputTokens,
    'outputTokens', outputTokens,
    'cacheReadTokens', cacheReadTokens,
    'cacheCreationTokens', cacheCreationTokens
  )) FROM model_agg), json('[]')),
  'recentSessions', COALESCE((SELECT json_group_array(json_object(
    'id', id,
    'title', title,
    'model', model,
    'cwd', cwd,
    'createdAt', createdAt,
    'updatedAt', updatedAt,
    'acuCost', acuCost,
    'creditCost', creditCost
  )) FROM recent_sess), json('[]'))
);
`.trim();

async function resolveTargetHelpers(target) {
  const machine = target?.machine ?? null;
  const onOpt = machine ? { on: machine } : {};

  let rawExec = target?.exec;
  let rawReadTextFile = target?.readTextFile;
  let rawHome = null;

  if (!rawExec || !rawReadTextFile) {
    try {
      const herdrMod = await import("herdr");
      if (!rawExec) rawExec = herdrMod.exec;
      if (!rawReadTextFile) rawReadTextFile = herdrMod.readTextFile;
      rawHome = herdrMod.home;
    } catch (_e) {
      // Running outside Herdr (e.g., Node test runner)
    }
  }

  const runExec = async (cmd, args = [], opts = {}) => {
    if (!rawExec) throw new Error("exec helper not available on target");
    return rawExec(cmd, args, { timeout: 15000, ...onOpt, ...opts });
  };

  const readFile = async (path, opts = {}) => {
    if (!rawReadTextFile) return null;
    try {
      return await rawReadTextFile(path, { ...onOpt, ...opts });
    } catch (_e) {
      return null;
    }
  };

  let homeDir = target?.homeDir;
  if (!homeDir) {
    if (!machine && typeof rawHome === "function") {
      try {
        homeDir = rawHome();
      } catch (_e) {}
    }
    if (!homeDir) {
      const res = await runExec("sh", ["-c", 'printf "%s" "$HOME"'], {
        timeout: 10000,
      });
      if (res && res.code === 0 && res.stdout) {
        homeDir = res.stdout.trim();
      }
    }
  }

  return {
    machine,
    homeDir: homeDir || "",
    runExec,
    readFile,
    fetchFn: target?.fetch || globalThis.fetch,
    includeRemoteQuota: target?.includeRemoteQuota !== false,
  };
}

export async function collectDevinUsage(target = {}) {
  const emptyStats = {
    totalSessions: 0,
    totalAcuCost: 0,
    totalCreditCost: 0,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    models: [],
    recentSessions: [],
  };

  let ctx;
  try {
    ctx = await resolveTargetHelpers(target);
  } catch (err) {
    return {
      installed: false,
      authenticated: false,
      version: null,
      error: `Failed to initialize target helpers: ${err?.message || String(err)}`,
      machine: target?.machine ?? null,
      plan: null,
      localStats: emptyStats,
      updatedAt: Date.now(),
    };
  }

  const { machine, homeDir, runExec, readFile, fetchFn, includeRemoteQuota } = ctx;

  if (!homeDir) {
    return {
      installed: false,
      authenticated: false,
      version: null,
      error: `Could not resolve $HOME on ${machine || "local"}`,
      machine,
      plan: null,
      localStats: emptyStats,
      updatedAt: Date.now(),
    };
  }

  const credentialsPath = `${homeDir}/.local/share/devin/credentials.toml`;
  const sessionsDbPath = `${homeDir}/.local/share/devin/cli/sessions.db`;

  // Run probe (binary location + version + cache lookup) and read credentials.toml in parallel
  const probeScript = [
    'BIN=$(command -v devin 2>/dev/null || ([ -x "$HOME/.local/bin/devin" ] && printf "%s" "$HOME/.local/bin/devin") || ([ -x "/opt/homebrew/bin/devin" ] && printf "%s" "/opt/homebrew/bin/devin"))',
    'printf "BIN:%s\\n" "$BIN"',
    'if [ -n "$BIN" ]; then VER=$("$BIN" --version 2>/dev/null | head -n 1); printf "VER:%s\\n" "$VER"; fi',
    'if [ -f "$HOME/.local/share/devin/cli/sessions.db" ]; then printf "DB:1\\n"; else printf "DB:0\\n"; fi',
    'CACHE=$(ls -t "$HOME"/.cache/devin/cli/user_status.*.bin 2>/dev/null | head -n 1)',
    'printf "CACHE:%s\\n" "$CACHE"',
  ].join("; ");

  const [probeRes, credsText] = await Promise.all([
    runExec("sh", ["-c", probeScript], { timeout: 10000 }).catch((err) => ({
      code: -1,
      stdout: "",
      stderr: err?.message || String(err),
    })),
    readFile(credentialsPath),
  ]);

  let binPath = "";
  let version = null;
  let hasDb = false;
  let latestCachePath = "";

  if (probeRes && probeRes.stdout) {
    for (const line of probeRes.stdout.split(/\r?\n/)) {
      if (line.startsWith("BIN:")) binPath = line.slice(4).trim();
      else if (line.startsWith("VER:")) {
        const rawVer = line.slice(4).trim();
        if (rawVer) version = rawVer.replace(/^devin\s+/i, "");
      } else if (line.startsWith("DB:")) {
        hasDb = line.slice(3).trim() === "1";
      } else if (line.startsWith("CACHE:")) {
        latestCachePath = line.slice(6).trim();
      }
    }
  }

  const creds = parseTomlKeyValues(credsText);
  const apiKey = creds.windsurf_api_key || "";
  const apiServerUrl = (
    creds.api_server_url || "https://server.codeium.com"
  ).replace(/\/+$/, "");

  const installed = Boolean(binPath || credsText || hasDb);
  const authenticated = Boolean(apiKey);

  if (!installed) {
    return {
      installed: false,
      authenticated: false,
      version: null,
      error:
        probeRes && probeRes.code === -1 && probeRes.stderr
          ? `Unreachable or probe failed: ${probeRes.stderr}`
          : null,
      machine,
      plan: null,
      localStats: emptyStats,
      updatedAt: Date.now(),
    };
  }

  const cleanVer = version ? version.split(/\s+/)[0] : "3000.12.43";
  const errors = [];

  // 1. Fetch Account Quota & ACU Plan Status (and query local SQLite in parallel)
  const fetchPlanPromise = (async () => {
    let plan = null;

    if (authenticated && includeRemoteQuota) {
      const endpoint = `${apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`;
      const reqBody = JSON.stringify({
        metadata: {
          ideName: "chisel",
          extensionVersion: cleanVer,
          apiKey,
          locale: "en",
          os: "darwin",
          ideVersion: cleanVer,
          extensionName: "chisel",
        },
      });
      const headers = {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      };

      // Primary: Direct HTTP fetch from mod host
      if (typeof fetchFn === "function") {
        try {
          const resp = await fetchFn(endpoint, {
            method: "POST",
            headers,
            body: reqBody,
          });
          if (resp && resp.ok) {
            const json = await resp.json();
            plan = parseLiveGetUserStatusJson(json);
          } else if (resp) {
            errors.push(`GetUserStatus HTTP ${resp.status}`);
          }
        } catch (fetchErr) {
          errors.push(`GetUserStatus fetch error: ${fetchErr?.message || String(fetchErr)}`);
        }
      }

      // Fallback 1: Run curl on target.machine (useful if remote machine is on a private network/VPN)
      if (!plan) {
        try {
          const curlRes = await runExec(
            "curl",
            [
              "-sS",
              "--max-time",
              "10",
              "-X",
              "POST",
              endpoint,
              "-H",
              `Authorization: Basic ${apiKey}`,
              "-H",
              "Content-Type: application/json",
              "-H",
              "Connect-Protocol-Version: 1",
              "-d",
              reqBody,
            ],
            { timeout: 12000 }
          );
          if (curlRes && curlRes.code === 0 && curlRes.stdout) {
            const json = JSON.parse(curlRes.stdout);
            plan = parseLiveGetUserStatusJson(json);
            if (plan) errors.length = 0; // Cleared by curl fallback
          }
        } catch (_curlErr) {}
      }
    }

    // Fallback 2 (or fast local refresh when includeRemoteQuota === false): Read local user_status.*.bin cache
    if (!plan && latestCachePath) {
      const binText = await readFile(latestCachePath);
      if (binText) {
        plan = parseCachedUserStatusBin(binText);
      }
    }

    return plan;
  })();

  // 2. Query local/remote sessions.db via sqlite3
  const fetchDbPromise = (async () => {
    if (!hasDb) return emptyStats;
    try {
      const sqlRes = await runExec(
        "sqlite3",
        ["-init", "/dev/null", "-noheader", "-batch", sessionsDbPath, SESSIONS_SQL],
        { timeout: 15000 }
      );
      if (sqlRes && sqlRes.code === 0 && sqlRes.stdout) {
        const line = sqlRes.stdout.trim();
        const firstBrace = line.indexOf("{");
        const lastBrace = line.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1) {
          const parsed = JSON.parse(line.slice(firstBrace, lastBrace + 1));
          return {
            totalSessions: Number(parsed.totalSessions ?? 0),
            totalAcuCost: Number(parsed.totalAcuCost ?? 0),
            totalCreditCost: Number(parsed.totalCreditCost ?? 0),
            totalTurns: Number(parsed.totalTurns ?? 0),
            totalInputTokens: Number(parsed.totalInputTokens ?? 0),
            totalOutputTokens: Number(parsed.totalOutputTokens ?? 0),
            totalCacheReadTokens: Number(parsed.totalCacheReadTokens ?? 0),
            totalCacheCreationTokens: Number(parsed.totalCacheCreationTokens ?? 0),
            models: Array.isArray(parsed.models) ? parsed.models : [],
            recentSessions: Array.isArray(parsed.recentSessions)
              ? parsed.recentSessions
              : [],
          };
        }
      } else if (sqlRes && sqlRes.stderr) {
        errors.push(`sqlite3 error: ${sqlRes.stderr.trim()}`);
      }
    } catch (dbErr) {
      errors.push(`sessions.db query failed: ${dbErr?.message || String(dbErr)}`);
    }
    return emptyStats;
  })();

  const [plan, localStats] = await Promise.all([fetchPlanPromise, fetchDbPromise]);

  return {
    installed,
    authenticated,
    version,
    error: errors.length > 0 ? errors.join("; ") : null,
    machine,
    plan,
    localStats,
    updatedAt: Date.now(),
  };
}

export default collectDevinUsage;
