// Antigravity (agy CLI & Antigravity IDE) Usage & Quota Collector for Herdr Mod
// Supports both local machine (target.machine == null) and remote SSH machines (target.machine)

function parseJsonSafe(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Handle cases where spinner or log lines precede the JSON object
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    const firstBracket = trimmed.indexOf("[");
    const lastBracket = trimmed.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseModelFromLabel(label) {
  if (!label || typeof label !== "string") {
    return { id: "unknown", label: "Unknown", effort: "medium" };
  }
  const effortMatch = label.match(/\((Low|Medium|High|XHigh|Max)\)\s*$/i);
  const effort = effortMatch ? effortMatch[1].toLowerCase() : "medium";
  const id = label
    .toLowerCase()
    .replace(/[()]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return { id, label, effort };
}

function extractFirstWorkspacePath(workspaceUrisRaw) {
  if (!workspaceUrisRaw) return "";
  try {
    const arr =
      typeof workspaceUrisRaw === "string"
        ? JSON.parse(workspaceUrisRaw)
        : workspaceUrisRaw;
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string") {
      return decodeURIComponent(arr[0].replace(/^file:\/\//, ""));
    }
  } catch {
    // ignore
  }
  return "";
}

function normalizeStatus(statusRaw) {
  if (!statusRaw || typeof statusRaw !== "string") return "idle";
  return statusRaw
    .replace(/^CASCADE_RUN_STATUS_/, "")
    .toLowerCase()
    .replace(/_/g, " ");
}

async function querySummaryDb(runExec, dbPath, sourceLabel) {
  const script = `
if [ ! -f "$1" ]; then
  printf '{"exists":false}\n'
  exit 0
fi
counts=$(sqlite3 -json "$1" "SELECT COUNT(*) AS count, COALESCE(SUM(step_count), 0) AS steps FROM conversation_summaries;" 2>/dev/null || printf '[]')
recent=$(sqlite3 -json "$1" "SELECT conversation_id AS id, title, preview, agent_name AS agentName, step_count AS steps, status, workspace_uris, last_modified_time AS updatedAt FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 6;" 2>/dev/null || printf '[]')
printf '{"exists":true,"counts":%s,"recent":%s}\n' "\${counts:-[]}" "\${recent:-[]}"
`;
  const res = await runExec("sh", ["-c", script, "sh", dbPath], {
    timeout: 8000,
  });
  if (!res || res.code !== 0) {
    return { exists: false, conversations: 0, steps: 0, recent: [] };
  }
  const parsed = parseJsonSafe(res.stdout);
  if (!parsed || !parsed.exists) {
    return { exists: false, conversations: 0, steps: 0, recent: [] };
  }
  const countRow =
    Array.isArray(parsed.counts) && parsed.counts[0] ? parsed.counts[0] : {};
  const conversations = Number(countRow.count) || 0;
  const steps = Number(countRow.steps) || 0;
  const recentRows = Array.isArray(parsed.recent) ? parsed.recent : [];
  const recent = recentRows.map((r) => {
    const rawTitle = (r.title || "").trim() || (r.preview || "").trim();
    const agentName = (r.agentName || "").trim();
    const shortId = (r.id || "").slice(0, 8);
    const cleanTitle = rawTitle
      ? rawTitle.replace(/\s+/g, " ").slice(0, 80)
      : agentName
        ? `Swarm @${agentName} (${shortId})`
        : `Session ${shortId}`;
    return {
      id: r.id || "",
      title: cleanTitle,
      agentName: agentName || null,
      steps: Number(r.steps) || 0,
      status: normalizeStatus(r.status),
      rawStatus: r.status || "",
      source: sourceLabel,
      cwd: extractFirstWorkspacePath(r.workspace_uris),
      updatedAt: r.updatedAt || "",
    };
  });
  return { exists: true, conversations, steps, recent };
}

export async function collectAgyUsage(target = {}) {
  const machine = target.machine ?? null;
  const includeRemoteQuota = target.includeRemoteQuota !== false;

  const runExec = async (cmd, args = [], opts = {}) => {
    if (typeof target.exec !== "function") {
      return { code: 1, stdout: "", stderr: "target.exec not provided" };
    }
    try {
      const execOpts = { ...opts };
      if (machine && !("on" in execOpts)) {
        execOpts.on = machine;
      }
      return await target.exec(cmd, args, execOpts);
    } catch (err) {
      return {
        code: 1,
        stdout: "",
        stderr: err?.message ? String(err.message) : String(err),
      };
    }
  };

  const runReadText = async (path, opts = {}) => {
    if (typeof target.readTextFile !== "function") return null;
    try {
      const readOpts = { ...opts };
      if (machine && !("on" in readOpts)) {
        readOpts.on = machine;
      }
      return await target.readTextFile(path, readOpts);
    } catch {
      return null;
    }
  };

  // Resolve target homeDir dynamically if not provided
  let homeDir = target.homeDir || "";
  if (!homeDir) {
    const homeRes = await runExec("sh", ["-c", 'printf %s "$HOME"'], {
      timeout: 5000,
    });
    if (homeRes.code === 0 && homeRes.stdout.trim()) {
      homeDir = homeRes.stdout.trim();
    }
  }

  // Locate agy binary and version on target.machine
  const probeScript = `
for candidate in "$(command -v agy 2>/dev/null)" "$HOME/.local/bin/agy" "/opt/homebrew/bin/agy" "/usr/local/bin/agy"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    ver=$("$candidate" --version 2>/dev/null | head -n 1)
    printf '{"bin":"%s","version":"%s"}\n' "$candidate" "$ver"
    exit 0
  fi
done
printf '{"bin":"","version":""}\n'
`;
  const probeRes = await runExec("sh", ["-c", probeScript], { timeout: 6000 });
  const probeInfo = parseJsonSafe(probeRes.stdout) || { bin: "", version: "" };
  const agyBin = probeInfo.bin || "";
  const version = (probeInfo.version || "").trim() || null;

  // Read CLI settings & global config + query IDE & CLI SQLite DBs in parallel
  const cliSettingsPath = `${homeDir}/.gemini/antigravity-cli/settings.json`;
  const globalConfigPath = `${homeDir}/.gemini/config/config.json`;
  const ideDbPath = `${homeDir}/.gemini/antigravity/conversation_summaries.db`;
  const cliDbPath = `${homeDir}/.gemini/antigravity-cli/conversation_summaries.db`;

  const [cliSettingsRaw, globalConfigRaw, ideStats, cliStats] =
    await Promise.all([
      homeDir ? runReadText(cliSettingsPath) : Promise.resolve(null),
      homeDir ? runReadText(globalConfigPath) : Promise.resolve(null),
      homeDir
        ? querySummaryDb(runExec, ideDbPath, "ide")
        : Promise.resolve({
            exists: false,
            conversations: 0,
            steps: 0,
            recent: [],
          }),
      homeDir
        ? querySummaryDb(runExec, cliDbPath, "cli")
        : Promise.resolve({
            exists: false,
            conversations: 0,
            steps: 0,
            recent: [],
          }),
    ]);

  const cliSettings = parseJsonSafe(cliSettingsRaw) || {};
  const globalConfig = parseJsonSafe(globalConfigRaw) || {};
  const useAiCredits = Boolean(globalConfig?.userSettings?.useAiCredits);

  let activeModel = cliSettings.model
    ? parseModelFromLabel(cliSettings.model)
    : {
        id: "gemini-4-argon-medium",
        label: "Gemini 4 Argon (Medium)",
        effort: "medium",
      };

  const installed = Boolean(agyBin || ideStats.exists || cliStats.exists);

  // Merge recent conversations from IDE and CLI, sorted by updatedAt descending
  const mergedRecent = [...(ideStats.recent || []), ...(cliStats.recent || [])]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 5);

  const localStats = {
    ideConversations: ideStats.conversations || 0,
    ideSteps: ideStats.steps || 0,
    cliConversations: cliStats.conversations || 0,
    cliSteps: cliStats.steps || 0,
    totalConversations:
      (ideStats.conversations || 0) + (cliStats.conversations || 0),
    totalSteps: (ideStats.steps || 0) + (cliStats.steps || 0),
    recentConversations: mergedRecent,
  };

  if (!installed) {
    return {
      installed: false,
      authenticated: false,
      version: null,
      error: "Antigravity CLI (agy) is not installed on this machine.",
      machine,
      activeModel: null,
      credits: { remaining: 0, useAiCredits },
      groups: [],
      localStats,
      updatedAt: Date.now(),
    };
  }

  let authenticated = false;
  let error = null;
  let groups = [];
  let creditsRemaining = 0;

  if (agyBin && includeRemoteQuota) {
    const [usageRes, creditsRes, modelRes] = await Promise.all([
      runExec(agyBin, ["-p", "/usage", "--output-format", "json"], {
        timeout: 18000,
      }),
      runExec(agyBin, ["-p", "/credits", "--output-format", "json"], {
        timeout: 18000,
      }),
      runExec(agyBin, ["-p", "/model", "--output-format", "json"], {
        timeout: 15000,
      }),
    ]);

    const usageJson = parseJsonSafe(usageRes.stdout);
    const creditsJson = parseJsonSafe(creditsRes.stdout);
    const modelJson = parseJsonSafe(modelRes.stdout);

    if (modelJson?.status === "SUCCESS" && modelJson?.command?.data) {
      const mData = modelJson.command.data;
      activeModel = {
        id: mData.id || activeModel.id,
        label: mData.label || activeModel.label,
        effort: mData.effort || activeModel.effort,
        isDefault: Boolean(mData.is_default),
      };
    }

    if (creditsJson?.status === "SUCCESS" && creditsJson?.command?.data) {
      creditsRemaining =
        Number(creditsJson.command.data.remaining_credits) || 0;
      authenticated = true;
    }

    if (
      usageJson?.status === "SUCCESS" &&
      Array.isArray(usageJson?.command?.data?.groups)
    ) {
      authenticated = true;
      groups = usageJson.command.data.groups.map((grp) => {
        const title = grp.name || grp.title || "Models";
        const buckets = Array.isArray(grp.buckets)
          ? grp.buckets.map((b) => {
              const fracRaw =
                typeof b.remaining_fraction === "number"
                  ? b.remaining_fraction
                  : 1;
              const remainingFraction = Math.max(0, Math.min(1, fracRaw));
              const remainingPercent = Math.round(remainingFraction * 100);
              const usedPercent = Math.max(0, 100 - remainingPercent);
              const label = b.name || b.label || b.window || b.id || "Limit";
              return {
                id: b.id || "",
                label,
                name: label,
                window: b.window || "",
                description: b.description || "",
                remainingFraction,
                remainingPercent,
                usedPercent,
                resetTime: b.reset_time || null,
              };
            })
          : [];
        return {
          title,
          name: title,
          description: grp.description || "",
          buckets,
        };
      });
    } else {
      const combinedErr =
        usageJson?.error ||
        (usageRes.stderr || "").trim() ||
        (usageRes.stdout || "").trim();
      if (/not logged in|authenticate|login/i.test(combinedErr)) {
        authenticated = false;
        error = "Not logged into Antigravity CLI (run `agy` to sign in).";
      } else if (combinedErr) {
        error = `Failed to query agy quota: ${combinedErr.slice(0, 160)}`;
      }
    }
  } else if (!agyBin && (ideStats.exists || cliStats.exists)) {
    error =
      "Antigravity local state found, but `agy` CLI binary was not found.";
  }

  return {
    installed,
    authenticated,
    version,
    error,
    machine,
    activeModel,
    credits: {
      remaining: creditsRemaining,
      useAiCredits,
    },
    groups,
    localStats,
    updatedAt: Date.now(),
  };
}

export default collectAgyUsage;
