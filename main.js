// Herdr CLI Usage Mod — live quota, token and session analytics for
// Claude Code, OpenAI Codex CLI, Antigravity (agy) and Devin CLI.
// Works on the local machine and on remote SSH machines configured in Herdr spaces/machines.
// Providers that are not installed on the target machine are hidden automatically.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec,
  readTextFile,
  home,
  spaces,
  machines,
  focused,
  theme,
  shared,
  setShared,
  nextCommand,
  props,
  closeOverlay,
} from "herdr";

import { collectDevinUsage } from "./collectors/devin.js";
import { collectAgyUsage } from "./collectors/agy.js";
import { collectCodexUsage } from "./collectors/codex.js";
import { collectClaudeUsage } from "./collectors/claude.js";

const STORAGE_PREFIX = "cli-usage:v1:";
const ICON_USAGE = "mods/cli-usage/usage.svg";
const ICON_REFRESH = "mods/cli-usage/refresh.svg";
const ICON_SPINNER = "mods/workspace-chrome/spinner.svg";
const ICON_CHEVRON_RIGHT = "mods/workspace-chrome/chevron-right.svg";
const ICON_CHEVRON_DOWN = "mods/workspace-chrome/chevron-down.svg";

const PROVIDERS = [
  {
    id: "claude",
    label: "Claude",
    title: "Claude Code",
    icon: "icons/claude.svg",
    tinted: false,
    collect: collectClaudeUsage,
  },
  {
    id: "codex",
    label: "Codex",
    title: "Codex CLI",
    icon: "icons/codex.svg",
    tinted: false,
    collect: collectCodexUsage,
  },
  {
    id: "agy",
    label: "AGY",
    title: "Antigravity",
    icon: "icons/antigravity.svg",
    tinted: false,
    collect: collectAgyUsage,
  },
  {
    id: "devin",
    label: "Devin",
    title: "Devin CLI",
    icon: "icons/agent.svg",
    tinted: true,
    collect: collectDevinUsage,
  },
];
const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const TAB_IDS = ["all", ...PROVIDERS.map((p) => p.id)];

// ───────────────────────────── formatting helpers ─────────────────────────────

function rgb(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color ?? "")?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function alpha(color, amount, fallback = color) {
  const channels = rgb(color);
  if (!channels) return fallback;
  return `#${[...channels, Math.round(amount * 255)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

function isNum(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function fmtNum(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString?.("en-US") ?? String(n);
  return n.toFixed(2);
}

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)}%`;
}

function toMs(targetTime) {
  if (!targetTime) return null;
  if (typeof targetTime === "number") return targetTime < 1e11 ? targetTime * 1000 : targetTime;
  if (typeof targetTime === "string") {
    if (/^\d+$/.test(targetTime)) return toMs(Number(targetTime));
    const parsed = Date.parse(targetTime);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fmtDuration(ms) {
  const totalMins = Math.max(1, Math.floor(ms / 60000));
  if (totalMins < 60) return `${totalMins}m`;
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}

function fmtReset(targetTime, { short = false } = {}) {
  const ms = toMs(targetTime);
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return short ? "now" : "resetting now";
  return short ? fmtDuration(diff) : `resets in ${fmtDuration(diff)}`;
}

function fmtAgo(timestamp) {
  const ms = toMs(timestamp);
  if (!ms) return null;
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtWindowSeconds(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s === 604800) return "Weekly";
  if (s % 86400 === 0) return `${s / 86400}-day`;
  if (s % 3600 === 0) return `${s / 3600}-hour`;
  return `${Math.round(s / 60)}-min`;
}

function shortenPath(p) {
  if (!p || typeof p !== "string") return "";
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

function sumTokens(o) {
  if (!o) return 0;
  return (o.input ?? 0) + (o.output ?? 0) + (o.cacheWrite ?? 0) + (o.cacheRead ?? 0);
}

// ───────────────────────────── machine helpers ─────────────────────────────

function activeSpaceMachine() {
  try {
    const f = focused();
    if (f?.pane === null && typeof f?.terminal === "string" && f.terminal.includes("/")) {
      return f.terminal.split("/")[0] || null;
    }
    const activeSpace = (spaces() || []).find((s) => s.active);
    return activeSpace?.machine ?? null;
  } catch {
    return null;
  }
}

function discoverMachines() {
  const set = new Set();
  try {
    for (const s of spaces() || []) if (s?.machine) set.add(s.machine);
  } catch {}
  try {
    for (const m of machines() || []) if (m?.name) set.add(m.name);
  } catch {}
  return [...set].sort();
}

// ───────────────────────────── snapshot merging ─────────────────────────────

// Fast polls skip network quota probes; keep the last live quota data until the next full poll.
// Claude's quota is also kept across failed full polls (e.g. HTTP 429) and marked stale.
function mergeSnapshotPreservingQuota(prev, next, includeRemoteQuota) {
  if (!prev) return next;
  const merged = { ...next };

  if (prev.claude && next.claude) {
    const prevWin = prev.claude.quota?.windows?.length > 0;
    const nextWin = next.claude.quota?.windows?.length > 0;
    merged.claude = {
      ...next.claude,
      plan: next.claude.plan || prev.claude.plan || null,
      quota: nextWin
        ? next.claude.quota
        : prevWin
          ? { ...prev.claude.quota, stale: includeRemoteQuota && Boolean(next.claude.error) }
          : next.claude.quota,
      error: includeRemoteQuota ? next.claude.error : next.claude.error || prev.claude.error || null,
    };
  }

  if (includeRemoteQuota) return merged;

  if (prev.devin && next.devin) {
    const prevPlan = prev.devin.plan;
    const nextPlan = next.devin.plan;
    const bestPlan =
      prevPlan && (!nextPlan || nextPlan.source === "cache" || prevPlan.source !== "cache")
        ? prevPlan
        : nextPlan || prevPlan || null;
    merged.devin = {
      ...next.devin,
      plan: bestPlan,
      authenticated: Boolean(next.devin.authenticated || prev.devin.authenticated),
    };
  }

  if (prev.agy && next.agy) {
    const hasPrevGroups = Array.isArray(prev.agy.groups) && prev.agy.groups.length > 0;
    const hasNextGroups = Array.isArray(next.agy.groups) && next.agy.groups.length > 0;
    merged.agy = {
      ...next.agy,
      authenticated: Boolean(next.agy.authenticated || prev.agy.authenticated),
      activeModel: prev.agy.activeModel || next.agy.activeModel || null,
      credits:
        prev.agy.credits?.remaining > 0 ? prev.agy.credits : next.agy.credits || prev.agy.credits,
      groups: hasPrevGroups ? prev.agy.groups : hasNextGroups ? next.agy.groups : [],
      error: next.agy.error || prev.agy.error || null,
    };
  }

  if (prev.codex && next.codex) {
    const hasPrevQuota =
      prev.codex.quota &&
      (prev.codex.quota.usedPercent !== null || prev.codex.quota.creditsBalance !== null);
    merged.codex = {
      ...next.codex,
      quota: hasPrevQuota ? prev.codex.quota : next.codex.quota || prev.codex.quota,
      localStats: {
        ...next.codex.localStats,
        lifetimeTokens:
          next.codex.localStats?.lifetimeTokens ?? prev.codex.localStats?.lifetimeTokens ?? null,
        peakDailyTokens:
          next.codex.localStats?.peakDailyTokens ?? prev.codex.localStats?.peakDailyTokens ?? null,
        streakDays: next.codex.localStats?.streakDays ?? prev.codex.localStats?.streakDays ?? null,
      },
    };
  }

  return merged;
}

// ───────────────────────────── provider view models ─────────────────────────────
// Each collector returns its own shape; these adapters normalize them into one view model
// so a single renderer draws every provider consistently.

function devinView(d) {
  const plan = d.plan;
  const s = d.localStats || {};
  const notices = [];
  if (d.error) notices.push({ kind: "error", text: d.error });
  else if (!d.authenticated && !plan)
    notices.push({ kind: "info", text: "Not signed in — sign in to Devin CLI to see plan limits." });
  const totalTokens = (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0) + (s.totalCacheReadTokens ?? 0);
  return {
    version: d.version ? String(d.version).split(/\s+/)[0] : null,
    badge: plan?.name ? (plan.org ? `${plan.org} · ${plan.name}` : plan.name) : null,
    windows: plan
      ? [
          {
            label: "Cycle ACU",
            usedPercent: plan.usedPercent,
            detail: `${fmtNum(plan.acuUsed)} / ${fmtNum(plan.acuLimit)} ACU · ${fmtNum(plan.remainingAcu)} left`,
            resetAt: plan.planEnd,
            tag: plan.source === "cache" ? "cached" : null,
          },
        ]
      : [],
    notices,
    stats: [
      { label: "Sessions", value: fmtNum(s.totalSessions ?? 0), sub: `${fmtNum(s.totalTurns ?? 0)} turns` },
      {
        label: "Local ACU",
        value: Number(s.totalAcuCost ?? 0).toFixed(2),
        sub: `${fmtNum(s.totalCreditCost ?? 0)} credits`,
      },
      {
        label: "Tokens",
        value: fmtNum(totalTokens),
        sub: `In ${fmtNum(s.totalInputTokens ?? 0)} · Out ${fmtNum(s.totalOutputTokens ?? 0)}`,
      },
    ],
    sections: [
      {
        key: "devin:models",
        title: "Models",
        items: (s.models || []).slice(0, 8).map((m) => ({
          title: m.model,
          right: `${Number(m.acuCost ?? 0).toFixed(2)} ACU`,
          meta: `${fmtNum(m.turns)} turns · Out ${fmtNum(m.outputTokens)} · Cache ${fmtNum(m.cacheReadTokens)}`,
        })),
      },
      {
        key: "devin:recent",
        title: "Recent sessions",
        items: (s.recentSessions || []).slice(0, 6).map((r) => ({
          title: r.title || r.id,
          right: `${Number(r.acuCost ?? 0).toFixed(2)} ACU`,
          meta: [r.model || "default", shortenPath(r.cwd)].filter(Boolean).join(" · "),
        })),
      },
    ],
    summary: `${fmtNum(s.totalSessions ?? 0)} sessions · ${Number(s.totalAcuCost ?? 0).toFixed(1)} ACU local`,
  };
}

function agyView(d) {
  const s = d.localStats || {};
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const notices = [];
  if (d.error) notices.push({ kind: "error", text: d.error });
  const windows = [];
  for (const g of groups) {
    const buckets = g.buckets || [];
    for (const b of buckets) {
      const clean = (x) => String(x || "").replace(/\s+remaining$/i, "").trim();
      windows.push({
        label:
          buckets.length > 1
            ? `${clean(g.title) || "Quota"} · ${clean(b.label || b.id) || "window"}`
            : clean(g.title || b.label) || "Quota",
        usedPercent: b.usedPercent,
        resetAt: b.resetTime,
      });
    }
  }
  const credits = d.credits?.remaining;
  const convs = (s.ideConversations ?? 0) + (s.cliConversations ?? 0) || s.totalConversations || 0;
  return {
    version: d.version || null,
    badge: d.activeModel?.label || null,
    windows,
    notices,
    stats: [
      {
        label: "AI credits",
        value: fmtNum(credits ?? 0),
        sub: d.credits?.useAiCredits ? "Overage enabled" : "Standard quota",
      },
      {
        label: "IDE",
        value: `${fmtNum(s.ideConversations ?? 0)} convs`,
        sub: `${fmtNum(s.ideSteps ?? 0)} steps`,
      },
      {
        label: "CLI",
        value: `${fmtNum(s.cliConversations ?? 0)} convs`,
        sub: `${fmtNum(s.cliSteps ?? 0)} steps`,
      },
    ],
    sections: [
      {
        key: "agy:recent",
        title: "Recent conversations",
        items: (s.recentConversations || []).slice(0, 6).map((c) => ({
          title: c.title || c.id,
          right: `${c.steps ?? 0} steps`,
          meta: [`${(c.source || "ide").toUpperCase()}${c.status ? ` · ${c.status}` : ""}`, shortenPath(c.cwd)]
            .filter(Boolean)
            .join(" · "),
        })),
      },
    ],
    summary: `${fmtNum(credits ?? 0)} credits · ${fmtNum(convs)} conversations`,
  };
}

function codexView(d) {
  const q = d.quota || {};
  const s = d.localStats || {};
  const notices = [];
  if (d.error) notices.push({ kind: "error", text: d.error });
  else if (!d.authenticated) notices.push({ kind: "info", text: "Not signed in — run `codex login` to see plan limits." });
  const windows = [];
  if (isNum(q.usedPercent)) {
    windows.push({
      label: fmtWindowSeconds(q.windowSeconds) ? `${fmtWindowSeconds(q.windowSeconds)} window` : "Primary window",
      usedPercent: q.usedPercent,
      resetAt: q.resetAt,
    });
  }
  if (isNum(q.secondaryUsedPercent)) {
    windows.push({ label: "Weekly window", usedPercent: q.secondaryUsedPercent, resetAt: q.secondaryResetAt });
  }
  const hasCredits = isNum(q.creditsBalance);
  return {
    version: d.version || null,
    badge: q.planType ? String(q.planType).toUpperCase() : d.authMode === "apikey" ? "API key" : null,
    windows,
    notices,
    stats: [
      {
        label: "Threads",
        value: fmtNum(s.totalThreads ?? 0),
        sub: s.streakDays ? `${s.streakDays}d streak` : "local",
      },
      {
        label: "Tokens",
        value: fmtNum(s.totalTokens ?? 0),
        sub: `${(s.models || []).length} models`,
      },
      hasCredits
        ? {
            label: "Credits",
            value: fmtNum(q.creditsBalance),
            sub: q.resetCreditsAvailable ? `${q.resetCreditsAvailable} resets left` : "balance",
          }
        : {
            label: "Lifetime",
            value: fmtNum(s.lifetimeTokens ?? s.totalTokens ?? 0),
            sub: s.peakDailyTokens ? `Peak ${fmtNum(s.peakDailyTokens)}/day` : "tokens",
          },
    ],
    sections: [
      {
        key: "codex:models",
        title: "Models",
        items: (s.models || []).slice(0, 8).map((m) => ({
          title: m.model,
          right: `${fmtNum(m.tokensUsed)} tok`,
          meta: `${fmtNum(m.threads)} threads · ${m.provider || "openai"}`,
        })),
      },
      {
        key: "codex:recent",
        title: "Recent threads",
        items: (s.recentThreads || []).slice(0, 6).map((r) => ({
          title: r.title || r.id,
          right: `${fmtNum(r.tokensUsed)} tok`,
          meta: [r.reasoningEffort ? `${r.model} (${r.reasoningEffort})` : r.model, shortenPath(r.cwd)]
            .filter(Boolean)
            .join(" · "),
        })),
      },
    ],
    summary: `${fmtNum(s.totalThreads ?? 0)} threads · ${fmtNum(s.totalTokens ?? 0)} tokens`,
  };
}

function claudeView(d) {
  const s = d.localStats || {};
  const q = d.quota || {};
  const notices = [];
  if (d.error) notices.push({ kind: /429|rate-limited/i.test(d.error) ? "warn" : "error", text: d.error });
  if (d.notice) notices.push({ kind: "info", text: d.notice });
  const windows = (q.windows || []).map((w) => ({
    label: w.label,
    usedPercent: w.usedPercent,
    resetAt: w.resetAt,
    tag: q.stale ? "stale" : null,
  }));
  if (q.extraUsage?.enabled && isNum(q.extraUsage.usedPercent)) {
    windows.push({ label: "Extra usage (monthly)", usedPercent: q.extraUsage.usedPercent });
  }
  const today = sumTokens(s.today);
  const week = sumTokens(s.last7d);
  const days = s.windowDays || 30;
  return {
    version: d.version || null,
    badge:
      d.plan ||
      (d.authMode === "custom" ? "Custom API" : d.authMode === "apikey" ? "API key" : null),
    windows,
    notices,
    stats: [
      {
        label: "Today",
        value: fmtNum(today),
        sub: `In ${fmtNum(s.today?.input ?? 0)} · Out ${fmtNum(s.today?.output ?? 0)}`,
      },
      {
        label: "Last 7 days",
        value: fmtNum(week),
        sub: `Last 5h ${fmtNum(sumTokens(s.last5h))}`,
      },
      {
        label: `Sessions · ${days}d`,
        value: fmtNum(s.totalSessions ?? 0),
        sub: `${fmtNum(s.totalMessages ?? 0)} replies`,
      },
    ],
    chart: Array.isArray(s.daily) && s.daily.some((x) => Number(x.tokens) > 0) ? s.daily : null,
    sections: [
      {
        key: "claude:models",
        title: `Models · ${days}d`,
        items: (s.models || []).slice(0, 8).map((m) => ({
          title: m.model,
          right: `${fmtNum((m.input ?? 0) + (m.output ?? 0) + (m.cacheWrite ?? 0) + (m.cacheRead ?? 0))} tok`,
          meta: `${fmtNum(m.messages)} replies · In ${fmtNum(m.input)} · Out ${fmtNum(m.output)} · Cache ${fmtNum(
            (m.cacheRead ?? 0) + (m.cacheWrite ?? 0)
          )}`,
        })),
      },
      {
        key: "claude:recent",
        title: "Recent sessions",
        items: (s.recentSessions || []).slice(0, 6).map((r) => ({
          title: r.title || r.id,
          right: `${fmtNum(r.tokens)} tok`,
          meta: [r.model, shortenPath(r.cwd), fmtAgo(r.updatedAt)].filter(Boolean).join(" · "),
        })),
      },
    ],
    summary: `${fmtNum(today)} tokens today · ${fmtNum(s.totalSessions ?? 0)} sessions in ${days}d`,
  };
}

const VIEW_BUILDERS = { devin: devinView, agy: agyView, codex: codexView, claude: claudeView };

function buildView(id, data) {
  if (!data?.installed) return null;
  const v = VIEW_BUILDERS[id](data);
  const pcts = v.windows.map((w) => Number(w.usedPercent)).filter(Number.isFinite);
  v.peak = pcts.length ? Math.max(...pcts) : null;
  v.provider = PROVIDER_BY_ID[id];
  return v;
}

// ───────────────────────────── the view ─────────────────────────────

export default class CliUsageMod extends View {
  init(_props, cx) {
    this.activeTab = localStorage.getItem("cli-usage:active-tab") || "all";
    if (!TAB_IDS.includes(this.activeTab)) this.activeTab = "all";
    this.machineMode = localStorage.getItem("cli-usage:machine-mode") || "auto";
    this.remoteHomes = {};
    this.snapshots = {};
    this.loadingByMachine = {};
    this.lastMachineKey = null;
    this.panelWidth = 400;
    this.expandedSections = {
      "claude:models": true,
      "codex:models": true,
      "devin:models": true,
    };
    try {
      const saved = JSON.parse(localStorage.getItem("cli-usage:sections") || "null");
      if (saved && typeof saved === "object") Object.assign(this.expandedSections, saved);
    } catch {}
    this.focusHandle = cx.focus_handle();

    try {
      const panels = shared("workspace.panels") ?? ["changes", "files"];
      if (Array.isArray(panels) && !panels.includes("cli-usage")) {
        setShared("workspace.panels", [...panels, "cli-usage"]);
      }
    } catch {}

    // Cached snapshots make the first paint instant.
    this.loadCachedSnapshot(null);
    const currentSpaceMach = activeSpaceMachine();
    if (currentSpaceMach) this.loadCachedSnapshot(currentSpaceMach);

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.focusHandle.focus();
        } else if (cmd === "refresh") {
          this.refresh(cx, { includeRemoteQuota: true, force: true });
        } else if (cmd.startsWith("tab:")) {
          const tabId = cmd.slice(4).trim();
          if (TAB_IDS.includes(tabId)) this.setTab(tabId, cx);
        }
        cx.notify();
      }
    });

    this.lastMachineKey = this.machineKey(this.resolvedMachine());
    this.refresh(cx, { includeRemoteQuota: true });

    // Fast local refresh every 30s, full quota refresh every 120s.
    cx.timer.every(30000, (cx) => this.refresh(cx, { includeRemoteQuota: false }));
    cx.timer.every(120000, (cx) => this.refresh(cx, { includeRemoteQuota: true }));
    // Follow workspace switches in Auto mode without waiting for the next poll.
    cx.timer.every(1500, (cx) => {
      const key = this.machineKey(this.resolvedMachine());
      if (key !== this.lastMachineKey) {
        this.lastMachineKey = key;
        const cached = this.loadCachedSnapshot(this.resolvedMachine());
        this.refresh(cx, { includeRemoteQuota: !cached });
        cx.notify();
      }
    });
  }

  machineKey(machine) {
    return machine ? `ssh:${machine}` : "local";
  }

  resolvedMachine() {
    if (this.machineMode === "local") return null;
    if (this.machineMode.startsWith("ssh:")) return this.machineMode.slice(4) || null;
    return activeSpaceMachine();
  }

  loadCachedSnapshot(machine) {
    const key = this.machineKey(machine);
    if (this.snapshots[key]) return this.snapshots[key];
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          this.snapshots[key] = parsed;
          return parsed;
        }
      }
    } catch {}
    return null;
  }

  saveSnapshot(machine, snapshot) {
    const key = this.machineKey(machine);
    this.snapshots[key] = snapshot;
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(snapshot));
    } catch {}
    try {
      const summary = { machine: machine || null, updatedAt: snapshot.updatedAt };
      for (const p of PROVIDERS) {
        const v = buildView(p.id, snapshot[p.id]);
        summary[p.id] = snapshot[p.id]
          ? {
              installed: Boolean(snapshot[p.id].installed),
              plan: v?.badge ?? null,
              usedPercent: v?.peak ?? null,
              summary: v?.summary ?? null,
            }
          : null;
      }
      setShared("cli-usage.summary", summary);
    } catch {}
  }

  async resolveHomeDir(machine) {
    if (!machine) {
      try {
        const h = home();
        if (h) return h;
      } catch {}
    }
    if (machine && this.remoteHomes[machine]) return this.remoteHomes[machine];
    try {
      const res = await exec("sh", ["-c", 'printf %s "$HOME"'], {
        on: machine || undefined,
        timeout: 8000,
      });
      if (res && res.code === 0 && res.stdout.trim()) {
        const resolved = res.stdout.trim();
        if (machine) this.remoteHomes[machine] = resolved;
        return resolved;
      }
    } catch {}
    return "";
  }

  refresh(cx, { includeRemoteQuota = true, force = false } = {}) {
    const machine = this.resolvedMachine();
    const key = this.machineKey(machine);
    if (this.loadingByMachine[key] && !force) return;

    this.loadingByMachine[key] = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const homeDir = await this.resolveHomeDir(machine);
        const target = {
          machine,
          homeDir,
          exec: (cmd, args = [], opts = {}) =>
            exec(cmd, args, { on: machine || undefined, timeout: 15000, ...opts }),
          readTextFile: (path, opts = {}) => readTextFile(path, { on: machine || undefined, ...opts }),
          fetch: globalThis.fetch,
          includeRemoteQuota,
        };

        const results = await Promise.all(
          PROVIDERS.map((p) =>
            p.collect(target).catch((err) => ({
              installed: false,
              authenticated: false,
              error: String(err?.message || err),
              machine,
              updatedAt: Date.now(),
            }))
          )
        );

        const next = { machine, homeDir, updatedAt: Date.now() };
        PROVIDERS.forEach((p, i) => (next[p.id] = results[i]));

        const prev = this.snapshots[key] || this.loadCachedSnapshot(machine);
        this.saveSnapshot(machine, mergeSnapshotPreservingQuota(prev, next, includeRemoteQuota));
      } finally {
        this.loadingByMachine[key] = false;
        cx.notify();
      }
    });
  }

  setTab(tabId, cx) {
    this.activeTab = tabId;
    try {
      localStorage.setItem("cli-usage:active-tab", tabId);
    } catch {}
    cx.notify();
  }

  setMachineMode(mode, cx) {
    this.machineMode = mode;
    try {
      localStorage.setItem("cli-usage:machine-mode", mode);
    } catch {}
    const machine = this.resolvedMachine();
    this.lastMachineKey = this.machineKey(machine);
    const cached = this.loadCachedSnapshot(machine);
    cx.notify();
    this.refresh(cx, { includeRemoteQuota: !cached, force: true });
  }

  toggleSection(key, cx) {
    this.expandedSections[key] = !this.expandedSections[key];
    try {
      localStorage.setItem("cli-usage:sections", JSON.stringify(this.expandedSections));
    } catch {}
    cx.notify();
  }

  // ─────────────── small building blocks ───────────────

  usageColor(usedPercent, t) {
    const pct = Number(usedPercent ?? 0);
    if (pct >= 85) return t.blocked || "#ef4444";
    if (pct >= 65) return t.working || "#f59e0b";
    return t.done || "#10b981";
  }

  icon(provider, size, t) {
    return provider.tinted
      ? svg(provider.icon).size(size).flex_none().text_color(t.foreground)
      : image(provider.icon).size(size).flex_none();
  }

  bar(usedPercent, t, height = 6) {
    const pct = Math.max(0, Math.min(100, Number(usedPercent ?? 0)));
    return div()
      .w_full()
      .h(height)
      .flex_none()
      .rounded(height / 2)
      .bg(alpha(t.foreground, 0.08, t.border))
      .overflow_hidden()
      .when(pct > 0, (el) =>
        el.child(
          div()
            .h_full()
            .w(`${Math.max(pct, 2)}%`)
            .rounded(height / 2)
            .bg(this.usageColor(pct, t))
        )
      );
  }

  pill(text, t, tone = "neutral") {
    const fg = tone === "accent" ? t.accent : tone === "dim" ? t.dim : t.muted;
    const bg =
      tone === "accent" ? alpha(t.accent, 0.12, t.selected) : alpha(t.foreground, 0.06, t.raised);
    return div()
      .flex_none()
      .px(6)
      .py(1)
      .rounded(4)
      .bg(bg)
      .text_size(10.5)
      .font_medium()
      .text_color(fg)
      .whitespace_nowrap()
      .child(String(text));
  }

  notice(n, t, idx) {
    const color =
      n.kind === "error" ? t.blocked || "#ef4444" : n.kind === "warn" ? t.working || "#f59e0b" : t.muted;
    return h_flex()
      .id(`notice-${idx}`)
      .w_full()
      .px(9)
      .py(6)
      .gap(7)
      .items_start()
      .rounded(7)
      .bg(n.kind === "info" ? alpha(t.foreground, 0.04, t.raised) : alpha(color, 0.1, t.raised))
      .child(div().mt(5).size(5).flex_none().rounded(3).bg(color))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .text_size(11)
          .line_height(1.4)
          .text_color(n.kind === "info" ? t.muted : color)
          .child(n.text)
      );
  }

  windowRow(w, t, key, compact = false) {
    const reset = fmtReset(w.resetAt, { short: compact });
    const color = this.usageColor(w.usedPercent, t);
    if (compact) {
      return v_flex()
        .id(key)
        .w_full()
        .gap(4)
        .child(
          h_flex()
            .w_full()
            .items_center()
            .gap(6)
            .text_size(11)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(w.label))
            .when(Boolean(reset), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(reset)))
            .child(
              h_flex()
                .flex_none()
                .items_baseline()
                .gap(3)
                .child(div().font_semibold().text_color(color).child(fmtPct(w.usedPercent)))
                .child(div().text_size(9.5).text_color(t.dim).child("used"))
            )
        )
        .child(this.bar(w.usedPercent, t, 4));
    }
    const remaining = isNum(w.usedPercent) ? Math.max(0, 100 - Number(w.usedPercent)) : null;
    return v_flex()
      .id(key)
      .w_full()
      .gap(5)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .gap(6)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .items_center()
              .gap(5)
              .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(w.label))
              .when(Boolean(w.tag), (el) => el.child(this.pill(w.tag, t, "dim")))
          )
          .child(
            h_flex()
              .flex_none()
              .items_baseline()
              .gap(3)
              .child(div().text_size(13).font_semibold().text_color(color).child(fmtPct(w.usedPercent)))
              .child(div().text_size(10).text_color(t.dim).child("used"))
          )
      )
      .child(this.bar(w.usedPercent, t, 6))
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(8)
          .text_size(10.5)
          .text_color(t.dim)
          .child(
            div()
              .min_w(0)
              .truncate()
              .child(w.detail || (remaining !== null ? `${fmtPct(remaining)} left` : ""))
          )
          .child(div().flex_none().child(reset || ""))
      );
  }

  statGrid(stats, t) {
    return h_flex()
      .w_full()
      .gap(6)
      .children(
        stats.map((s) =>
          v_flex()
            .flex_1()
            .min_w(0)
            .px(9)
            .py(7)
            .gap(1)
            .rounded(8)
            .bg(alpha(t.foreground, 0.035, t.raised))
            .child(div().text_size(10).text_color(t.dim).truncate().child(s.label))
            .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(String(s.value)))
            .when(Boolean(s.sub), (el) => el.child(div().text_size(10).text_color(t.muted).truncate().child(String(s.sub))))
        )
      );
  }

  dailyChart(days, t, providerId) {
    const max = Math.max(1, ...days.map((d) => Number(d.tokens) || 0));
    const H = 36;
    return v_flex()
      .w_full()
      .gap(6)
      .child(
        h_flex()
          .w_full()
          .justify_between()
          .child(div().text_size(11).font_semibold().text_color(t.muted).child("Daily tokens · 7d"))
          .child(div().text_size(10).text_color(t.dim).child(`peak ${fmtNum(max === 1 ? 0 : max)}`))
      )
      .child(
        h_flex()
          .w_full()
          .h(H + 14)
          .items_end()
          .gap(4)
          .children(
            days.map((d, i) => {
              const val = Number(d.tokens) || 0;
              const h = val > 0 ? Math.max(3, Math.round((val / max) * H)) : 2;
              const isToday = i === days.length - 1;
              return v_flex()
                .id(`${providerId}-day-${i}`)
                .flex_1()
                .min_w(0)
                .h_full()
                .items_center()
                .justify_end()
                .gap(3)
                .tooltip(`${d.date}: ${fmtNum(val)} tokens`)
                .child(
                  div()
                    .w_full()
                    .h(h)
                    .rounded(3)
                    .bg(val > 0 ? alpha(t.accent, isToday ? 0.9 : 0.45, t.accent) : alpha(t.foreground, 0.08, t.border))
                )
                .child(
                  div()
                    .text_size(9)
                    .text_color(isToday ? t.foreground : t.dim)
                    .child(String(d.label || "").slice(0, 2))
                );
            })
          )
      );
  }

  section(sec, t) {
    if (!sec.items?.length) return null;
    const open = Boolean(this.expandedSections[sec.key]);
    return v_flex()
      .w_full()
      .gap(3)
      .child(
        h_flex()
          .id(`toggle-${sec.key}`)
          .w_full()
          .py(3)
          .gap(5)
          .items_center()
          .rounded(5)
          .cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.toggleSection(sec.key, cx))
          .child(svg(open ? ICON_CHEVRON_DOWN : ICON_CHEVRON_RIGHT).size(12).flex_none().text_color(t.dim))
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(sec.title))
          .child(div().text_size(10.5).text_color(t.dim).child(String(sec.items.length)))
      )
      .when(open, (el) =>
        el.children(
          sec.items.map((it, idx) =>
            v_flex()
              .id(`${sec.key}-${idx}`)
              .w_full()
              .px(8)
              .py(5)
              .gap(1)
              .rounded(6)
              .hover((s) => s.bg(t.hover))
              .child(
                h_flex()
                  .w_full()
                  .items_center()
                  .gap(8)
                  .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(String(it.title)))
                  .child(div().flex_none().text_size(11).font_medium().text_color(t.muted).child(String(it.right)))
              )
              .when(Boolean(it.meta), (e) =>
                e.child(div().w_full().truncate().text_size(10).text_color(t.dim).child(String(it.meta)))
              )
          )
        )
      );
  }

  // ─────────────── cards ───────────────

  cardShell(t, id) {
    return v_flex()
      .id(id)
      .w_full()
      .p(12)
      .gap(10)
      .rounded(10)
      .bg(t.background)
      .border_1()
      .border_color(t.border);
  }

  cardHeader(v, t, { compact = false } = {}) {
    const p = v.provider;
    return h_flex()
      .w_full()
      .items_center()
      .gap(7)
      .child(this.icon(p, compact ? 15 : 17, t))
      .child(div().flex_none().text_size(compact ? 12.5 : 13.5).font_semibold().text_color(t.foreground).child(p.title))
      .when(!compact && Boolean(v.version), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`v${v.version}`)))
      .child(div().flex_1())
      .when(Boolean(v.badge), (el) => el.child(this.pill(v.badge, t, "accent")));
  }

  overviewCard(v, t) {
    const p = v.provider;
    const windows = v.windows.slice(0, 3);
    const firstIssue = v.notices.find((n) => n.kind !== "info");
    return this.cardShell(t, `overview-${p.id}`)
      .gap(8)
      .cursor_pointer()
      .hover((s) => s.border_color(alpha(t.accent, 0.5, t.accent)))
      .on_click((_e, cx) => this.setTab(p.id, cx))
      .child(
        this.cardHeader(v, t, { compact: true }).child(
          svg(ICON_CHEVRON_RIGHT).size(12).flex_none().text_color(t.dim)
        )
      )
      .when(windows.length > 0, (el) =>
        el.child(
          v_flex()
            .w_full()
            .gap(7)
            .children(windows.map((w, i) => this.windowRow(w, t, `ov-${p.id}-${i}`, true)))
        )
      )
      .when(v.windows.length > windows.length, (el) =>
        el.child(div().text_size(10).text_color(t.dim).child(`+${v.windows.length - windows.length} more limits`))
      )
      .when(Boolean(firstIssue), (el) =>
        el.child(
          div()
            .w_full()
            .truncate()
            .text_size(10.5)
            .text_color(firstIssue.kind === "error" ? t.blocked || "#ef4444" : t.working || "#f59e0b")
            .child(firstIssue?.text || "")
        )
      )
      .child(div().w_full().truncate().text_size(10.5).text_color(t.dim).child(v.summary));
  }

  detailCard(v, t) {
    const p = v.provider;
    const sections = v.sections.map((s) => this.section(s, t)).filter(Boolean);
    return this.cardShell(t, `detail-${p.id}`)
      .gap(12)
      .child(this.cardHeader(v, t))
      .when(v.notices.length > 0, (el) =>
        el.child(v_flex().w_full().gap(5).children(v.notices.map((n, i) => this.notice(n, t, `${p.id}-${i}`))))
      )
      .when(v.windows.length > 0, (el) =>
        el.child(
          v_flex()
            .w_full()
            .gap(12)
            .p(10)
            .rounded(8)
            .border_1()
            .border_color(alpha(t.foreground, 0.07, t.border))
            .children(v.windows.map((w, i) => this.windowRow(w, t, `win-${p.id}-${i}`)))
        )
      )
      .child(this.statGrid(v.stats, t))
      .when(Boolean(v.chart), (el) => el.child(this.dailyChart(v.chart, t, p.id)))
      .when(sections.length > 0, (el) => el.child(v_flex().w_full().gap(4).children(sections)));
  }

  emptyState(t, targetMachine, isLoading) {
    const where = targetMachine ? `on ${targetMachine}` : "on this computer";
    return v_flex()
      .w_full()
      .py(36)
      .px(16)
      .gap(10)
      .items_center()
      .child(
        div()
          .size(44)
          .rounded(22)
          .flex()
          .items_center()
          .justify_center()
          .bg(alpha(t.foreground, 0.05, t.raised))
          .child(svg(ICON_USAGE).size(20).text_color(t.muted))
      )
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("No coding CLIs detected"))
      .child(
        div()
          .text_size(11.5)
          .text_center()
          .line_height(1.5)
          .text_color(t.muted)
          .child(`Looked for ${PROVIDERS.map((p) => p.title).join(", ")} ${where}.`)
      )
      .child(
        h_flex()
          .id("empty-rescan")
          .mt(4)
          .px(10)
          .py(5)
          .gap(6)
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .text_size(11.5)
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx, { includeRemoteQuota: true, force: true }))
          .child(
            isLoading
              ? svg(ICON_SPINNER).size(12).text_color(t.accent).spin(900)
              : svg(ICON_REFRESH).size(12).text_color(t.muted)
          )
          .child(isLoading ? "Scanning…" : "Scan again")
      );
  }

  loadingState(t, targetMachine) {
    return v_flex()
      .w_full()
      .py(40)
      .gap(10)
      .items_center()
      .child(svg(ICON_SPINNER).size(18).text_color(t.accent).spin(900))
      .child(
        div()
          .text_size(11.5)
          .text_color(t.muted)
          .child(`Detecting coding CLIs ${targetMachine ? `on ${targetMachine}` : "on this computer"}…`)
      );
  }

  // ─────────────── render ───────────────

  render(cx) {
    const t = theme();
    const overlayId = props()?.overlay ?? null;
    const remoteList = discoverMachines();
    const currentSpaceMach = activeSpaceMachine();
    const targetMachine = this.resolvedMachine();
    const machKey = this.machineKey(targetMachine);
    const snap = this.snapshots[machKey] || this.loadCachedSnapshot(targetMachine);
    const isLoading = Boolean(this.loadingByMachine[machKey]);

    const views = snap ? PROVIDERS.map((p) => buildView(p.id, snap[p.id])).filter(Boolean) : [];
    const missing = snap ? PROVIDERS.filter((p) => snap[p.id] && !snap[p.id].installed) : [];
    const visibleTabs = views.length > 1 ? ["all", ...views.map((v) => v.provider.id)] : [];
    let tab = this.activeTab;
    if (views.length === 1) tab = views[0].provider.id;
    else if (!visibleTabs.includes(tab)) tab = "all";

    const machineOptions = [
      { id: "auto", label: currentSpaceMach ? `Auto · ${currentSpaceMach}` : "Auto" },
      { id: "local", label: "This computer" },
      ...remoteList.map((m) => ({ id: `ssh:${m}`, label: m })),
    ];
    const updatedText = isLoading
      ? "Updating…"
      : snap?.updatedAt
        ? `Updated ${fmtAgo(snap.updatedAt)}`
        : "";

    const doRefresh = (cx) => this.refresh(cx, { includeRemoteQuota: true, force: true });

    // Header
    const header = h_flex()
      .w_full()
      .h(42)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(svg(ICON_USAGE).size(14).flex_none().text_color(t.muted))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child("Usage"))
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .gap(4)
          .px(6)
          .py(1)
          .rounded(4)
          .border_1()
          .border_color(t.border)
          .text_size(10.5)
          .text_color(targetMachine ? t.accent : t.muted)
          .child(svg(`mods/workspace-chrome/${targetMachine ? "server" : "monitor"}.svg`).size(10).text_color(targetMachine ? t.accent : t.muted))
          .child(targetMachine || "Local")
      )
      .child(div().flex_1())
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(updatedText))
      .child(
        div()
          .id("cli-usage-refresh-btn")
          .size(24)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip("Refresh (R)")
          .on_click((_e, cx) => doRefresh(cx))
          .child(
            isLoading
              ? svg(ICON_SPINNER).size(13).text_color(t.accent).spin(900)
              : svg(ICON_REFRESH).size(13).text_color(t.muted)
          )
      )
      .when(Boolean(overlayId), (el) =>
        el.child(
          div()
            .id("cli-usage-close-overlay")
            .size(24)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip("Close (Esc)")
            .on_click(() => closeOverlay(overlayId))
            .child(svg("mods/workspace-chrome/x.svg").size(13).text_color(t.muted))
        )
      );

    // Machine selector: only useful when SSH machines exist.
    const machineBar =
      remoteList.length > 0
        ? h_flex()
            .w_full()
            .flex_none()
            .px(12)
            .py(6)
            .gap(4)
            .items_center()
            .flex_wrap()
            .border_b(1)
            .border_color(t.border)
            .children(
              machineOptions.map((opt) => {
                const selected = this.machineMode === opt.id;
                return div()
                  .id(`mach-opt-${opt.id}`)
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .text_size(11)
                  .bg(selected ? t.selected : "#00000000")
                  .text_color(selected ? t.foreground : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.setMachineMode(opt.id, cx))
                  .child(opt.label);
              })
            )
        : null;

    // Provider tabs: only detected providers, hidden when there is just one.
    // In a narrow dock, provider tabs collapse to icons (names stay in the tooltip).
    const iconOnlyTabs = this.panelWidth < 90 + visibleTabs.length * 72;
    const tabBar =
      visibleTabs.length > 0
        ? h_flex()
            .w_full()
            .flex_none()
            .px(10)
            .py(6)
            .gap(2)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .children(
              visibleTabs.map((id, idx) => {
                const active = tab === id;
                const v = views.find((x) => x.provider.id === id);
                const hot = v && isNum(v.peak) && v.peak >= 65;
                return h_flex()
                  .id(`cli-tab-${id}`)
                  .h(26)
                  .px(8)
                  .gap(5)
                  .items_center()
                  .rounded(6)
                  .text_size(12)
                  .bg(active ? t.selected : "#00000000")
                  .text_color(active ? t.foreground : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip(`${id === "all" ? "Overview" : PROVIDER_BY_ID[id].title} (${idx + 1})`)
                  .on_click((_e, cx) => this.setTab(id, cx))
                  .when(id !== "all", (el) => el.child(this.icon(PROVIDER_BY_ID[id], 13, t)))
                  .when(id === "all" || !iconOnlyTabs, (el) =>
                    el.child(id === "all" ? "Overview" : PROVIDER_BY_ID[id].label)
                  )
                  .when(hot, (el) => el.child(div().size(6).rounded(3).bg(this.usageColor(v.peak, t))));
              })
            )
        : null;

    // Body
    let body;
    if (!snap) {
      body = isLoading ? this.loadingState(t, targetMachine) : this.emptyState(t, targetMachine, isLoading);
    } else if (views.length === 0) {
      body = this.emptyState(t, targetMachine, isLoading);
    } else if (tab === "all") {
      body = v_flex()
        .w_full()
        .gap(8)
        .children(views.map((v) => this.overviewCard(v, t)))
        .when(missing.length > 0, (el) =>
          el.child(
            div()
              .w_full()
              .pt(2)
              .px(2)
              .text_size(10.5)
              .text_color(t.dim)
              .child(`Not detected: ${missing.map((p) => p.title).join(" · ")}`)
          )
        );
    } else {
      const v = views.find((x) => x.provider.id === tab);
      body = v ? this.detailCard(v, t) : div();
    }

    return v_flex()
      .id("cli-usage-root")
      .size_full()
      .rounded(10)
      .overflow_hidden()
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.focusHandle)
      .on_size_change((size, cx) => {
        if (size?.width && Math.abs(size.width - this.panelWidth) > 2) {
          this.panelWidth = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const key = String(e.key || "").toLowerCase();
        const m = e.modifiers || {};
        if (m.platform || m.control || m.alt) return;
        if (key === "r") {
          doRefresh(cx);
        } else if (key === "escape" && overlayId) {
          closeOverlay(overlayId);
        } else if (/^[1-9]$/.test(key) && visibleTabs[Number(key) - 1]) {
          this.setTab(visibleTabs[Number(key) - 1], cx);
        } else if ((key === "left" || key === "right" || key === "arrowleft" || key === "arrowright") && visibleTabs.length) {
          const i = Math.max(0, visibleTabs.indexOf(tab));
          const dir = key === "left" || key === "arrowleft" ? -1 : 1;
          this.setTab(visibleTabs[(i + dir + visibleTabs.length) % visibleTabs.length], cx);
        }
      })
      .child(header)
      .when(Boolean(machineBar), (el) => el.child(machineBar))
      .when(Boolean(tabBar), (el) => el.child(tabBar))
      .child(
        v_flex()
          .id("cli-usage-scroll-body")
          .flex_1()
          .w_full()
          .p(10)
          .gap(8)
          .overflow_y_scrollbar()
          .child(body)
      );
  }
}
