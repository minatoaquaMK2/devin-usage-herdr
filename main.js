// Herdr CLI Usage Mod — Live Quota, Token, & Session Analytics for Devin, Antigravity (agy), and Codex
// Supports both the local machine and remote SSH machines configured in Herdr spaces/machines.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec,
  readTextFile,
  home,
  spaces,
  machines,
  panes,
  focused,
  theme,
  run,
  shared,
  setShared,
  nextCommand,
  props,
  closeOverlay,
} from "herdr";

import { collectDevinUsage } from "./collectors/devin.js";
import { collectAgyUsage } from "./collectors/agy.js";
import { collectCodexUsage } from "./collectors/codex.js";

const STORAGE_PREFIX = "cli-usage:v1:";
const TABS = [
  { id: "all", label: "All" },
  { id: "devin", label: "Devin" },
  { id: "agy", label: "AGY" },
  { id: "codex", label: "Codex" },
];

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

function formatCompactNumber(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function formatResetCountdown(targetTime) {
  if (!targetTime) return null;
  let targetMs = null;
  if (typeof targetTime === "number") {
    targetMs = targetTime < 1e11 ? targetTime * 1000 : targetTime;
  } else if (typeof targetTime === "string") {
    const parsed = Date.parse(targetTime);
    if (Number.isFinite(parsed)) targetMs = parsed;
  }
  if (!targetMs) return null;
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "resetting soon";
  const totalMins = Math.floor(diffMs / 60000);
  if (totalMins < 60) return `resets in ${Math.max(1, totalMins)}m`;
  const totalHours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (totalHours < 24) {
    return mins > 0 ? `resets in ${totalHours}h ${mins}m` : `resets in ${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
}

function formatRelativeAgo(timestampMs) {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function shortenPath(p) {
  if (!p || typeof p !== "string") return "";
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

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
    for (const s of spaces() || []) {
      if (s?.machine) set.add(s.machine);
    }
  } catch {}
  try {
    for (const m of machines() || []) {
      if (m?.name) set.add(m.name);
    }
  } catch {}
  return [...set].sort();
}

function mergeSnapshotPreservingQuota(prev, next, includeRemoteQuota) {
  if (!prev || includeRemoteQuota) return next;
  const merged = { ...next };

  // Devin: when includeRemoteQuota is false, always prefer previous live plan over local .bin cache
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

  // AGY: preserve groups, credits, and activeModel when local-only refresh skips CLI calls
  if (prev.agy && next.agy) {
    const hasPrevGroups = Array.isArray(prev.agy.groups) && prev.agy.groups.length > 0;
    const hasNextGroups = Array.isArray(next.agy.groups) && next.agy.groups.length > 0;
    merged.agy = {
      ...next.agy,
      authenticated: Boolean(next.agy.authenticated || prev.agy.authenticated),
      activeModel: prev.agy.activeModel || next.agy.activeModel || null,
      credits:
        prev.agy.credits?.remaining > 0
          ? prev.agy.credits
          : next.agy.credits || prev.agy.credits,
      groups: hasPrevGroups ? prev.agy.groups : hasNextGroups ? next.agy.groups : [],
      error: next.agy.error || prev.agy.error || null,
    };
  }

  // Codex: when includeRemoteQuota is false, prefer previous live quota over rollout event fallback
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
          next.codex.localStats?.lifetimeTokens ??
          prev.codex.localStats?.lifetimeTokens ??
          null,
        peakDailyTokens:
          next.codex.localStats?.peakDailyTokens ??
          prev.codex.localStats?.peakDailyTokens ??
          null,
        streakDays:
          next.codex.localStats?.streakDays ?? prev.codex.localStats?.streakDays ?? null,
      },
    };
  }

  return merged;
}

export default class CliUsageMod extends View {
  init(_props, cx) {
    this.panelWidth = 360;
    this.activeTab = localStorage.getItem("cli-usage:active-tab") || "all";
    this.machineMode = localStorage.getItem("cli-usage:machine-mode") || "auto";
    this.remoteHomes = {};
    this.snapshots = {};
    this.loadingByMachine = {};
    this.expandedSections = {
      "devin:models": true,
      "devin:recent": false,
      "agy:recent": false,
      "codex:models": true,
      "codex:recent": false,
    };
    this.focusHandle = cx.focus_handle();

    try {
      const panels = shared("workspace.panels") ?? ["changes", "files"];
      if (Array.isArray(panels) && !panels.includes("cli-usage")) {
        setShared("workspace.panels", [...panels, "cli-usage"]);
      }
    } catch {}

    // Load cached local snapshot immediately so initial render is instant
    this.loadCachedSnapshot(null);
    const currentSpaceMach = activeSpaceMachine();
    if (currentSpaceMach) {
      this.loadCachedSnapshot(currentSpaceMach);
    }

    // Listen for keyboard / mod commands (e.g. cli-usage.refresh)
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.focusHandle.focus();
        } else if (cmd === "refresh") {
          this.refresh(cx, { includeRemoteQuota: true, force: true });
        } else if (cmd.startsWith("tab:")) {
          const tabId = cmd.slice(4).trim();
          if (TABS.some((t) => t.id === tabId)) {
            this.setTab(tabId, cx);
          }
        }
        cx.notify();
      }
    });

    // Initial full collection
    this.refresh(cx, { includeRemoteQuota: true });

    // Fast SQLite refresh every 30s, full remote quota refresh every 120s
    cx.timer.every(30000, (cx) => this.refresh(cx, { includeRemoteQuota: false }));
    cx.timer.every(120000, (cx) => this.refresh(cx, { includeRemoteQuota: true }));
  }

  machineKey(machine) {
    return machine ? `ssh:${machine}` : "local";
  }

  resolvedMachine() {
    if (this.machineMode === "local") return null;
    if (this.machineMode.startsWith("ssh:")) {
      return this.machineMode.slice(4) || null;
    }
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
      const agyPrimaryBucket = snapshot?.agy?.groups?.[0]?.buckets?.[0] || null;
      setShared("cli-usage.summary", {
        machine: machine || null,
        updatedAt: snapshot.updatedAt,
        devin: snapshot.devin
          ? {
              installed: snapshot.devin.installed,
              acuUsed: snapshot.devin.plan?.acuUsed ?? null,
              acuLimit: snapshot.devin.plan?.acuLimit ?? null,
              usedPercent: snapshot.devin.plan?.usedPercent ?? null,
              totalSessions: snapshot.devin.localStats?.totalSessions ?? 0,
            }
          : null,
        agy: snapshot.agy
          ? {
              installed: snapshot.agy.installed,
              activeModel: snapshot.agy.activeModel?.label ?? null,
              creditsRemaining: snapshot.agy.credits?.remaining ?? null,
              usedPercent: agyPrimaryBucket?.usedPercent ?? null,
              remainingPercent: agyPrimaryBucket?.remainingPercent ?? null,
            }
          : null,
        codex: snapshot.codex
          ? {
              installed: snapshot.codex.installed,
              planType: snapshot.codex.quota?.planType ?? null,
              usedPercent: snapshot.codex.quota?.usedPercent ?? null,
              remainingPercent: snapshot.codex.quota?.remainingPercent ?? null,
              creditsBalance: snapshot.codex.quota?.creditsBalance ?? null,
            }
          : null,
      });
    } catch {}
  }

  async resolveHomeDir(machine) {
    if (!machine) {
      try {
        const h = home();
        if (h) return h;
      } catch {}
    }
    if (machine && this.remoteHomes[machine]) {
      return this.remoteHomes[machine];
    }
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
          readTextFile: (path, opts = {}) =>
            readTextFile(path, { on: machine || undefined, ...opts }),
          fetch: globalThis.fetch,
          includeRemoteQuota,
        };

        const [devin, agy, codex] = await Promise.all([
          collectDevinUsage(target).catch((err) => ({
            installed: false,
            authenticated: false,
            error: String(err?.message || err),
            machine,
            plan: null,
            localStats: {},
            updatedAt: Date.now(),
          })),
          collectAgyUsage(target).catch((err) => ({
            installed: false,
            authenticated: false,
            error: String(err?.message || err),
            machine,
            activeModel: null,
            credits: { remaining: 0 },
            groups: [],
            localStats: {},
            updatedAt: Date.now(),
          })),
          collectCodexUsage(target).catch((err) => ({
            installed: false,
            authenticated: false,
            error: String(err?.message || err),
            machine,
            quota: {},
            localStats: {},
            updatedAt: Date.now(),
          })),
        ]);

        const prev = this.snapshots[key] || this.loadCachedSnapshot(machine);
        const nextSnapshot = mergeSnapshotPreservingQuota(
          prev,
          {
            machine,
            homeDir,
            devin,
            agy,
            codex,
            updatedAt: Date.now(),
          },
          includeRemoteQuota
        );

        this.saveSnapshot(machine, nextSnapshot);
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
    const cached = this.loadCachedSnapshot(machine);
    cx.notify();
    this.refresh(cx, { includeRemoteQuota: !cached, force: true });
  }

  toggleSection(key, cx) {
    this.expandedSections[key] = !this.expandedSections[key];
    cx.notify();
  }

  usageColor(usedPercent, t) {
    const pct = Number(usedPercent ?? 0);
    if (pct >= 85) return t.blocked || "#ef4444";
    if (pct >= 65) return t.working || "#f59e0b";
    return t.done || "#10b981";
  }

  renderProgressBar(usedPercent, t, height = 6) {
    const clamped = Math.max(0, Math.min(100, Number(usedPercent ?? 0)));
    const trackWidth = Math.max(140, (this.panelWidth || 360) - 56);
    const fillWidth = clamped <= 0 ? 0 : Math.max(4, Math.round((clamped / 100) * trackWidth));
    const color = this.usageColor(clamped, t);

    return h_flex()
      .w_full()
      .h(height)
      .rounded(Math.ceil(height / 2))
      .bg(alpha(t.foreground, 0.08, t.border))
      .overflow_hidden()
      .when(fillWidth > 0, (el) =>
        el.child(
          div()
            .w(fillWidth)
            .h(height)
            .rounded(Math.ceil(height / 2))
            .bg(color)
        )
      );
  }

  renderPill(text, fg, bg, borderColor = null) {
    const el = h_flex()
      .flex_none()
      .items_center()
      .gap(4)
      .px(6)
      .py(2)
      .rounded(5)
      .bg(bg)
      .text_size(10.5)
      .font_medium()
      .text_color(fg)
      .whitespace_nowrap()
      .child(String(text));
    return borderColor ? el.border(1).border_color(borderColor) : el;
  }

  renderMachineBadge(machine, t) {
    const isRemote = Boolean(machine);
    const fg = isRemote ? t.accent : t.muted;
    const bg = isRemote ? alpha(t.accent, 0.14, t.selected) : alpha(t.foreground, 0.06, t.raised);
    return h_flex()
      .flex_none()
      .items_center()
      .gap(4)
      .px(6)
      .py(2)
      .rounded(5)
      .bg(bg)
      .text_size(10.5)
      .text_color(fg)
      .child(
        svg(`mods/workspace-chrome/${isRemote ? "server" : "monitor"}.svg`)
          .size(11)
          .text_color(fg)
      )
      .child(isRemote ? `SSH: ${machine}` : "Local");
  }

  renderStatBox(label, value, sub, t) {
    return v_flex()
      .flex_1()
      .min_w(0)
      .p(8)
      .gap(2)
      .rounded(8)
      .bg(alpha(t.foreground, 0.035, t.raised))
      .border(1)
      .border_color(alpha(t.foreground, 0.06, t.border))
      .child(div().text_size(10.5).text_color(t.muted).truncate().child(label))
      .child(
        div()
          .text_size(13.5)
          .font_semibold()
          .text_color(t.foreground)
          .truncate()
          .child(String(value))
      )
      .when(Boolean(sub), (el) =>
        el.child(div().text_size(10).text_color(t.dim).truncate().child(String(sub)))
      );
  }

  renderOverviewBanner(snap, t, cx) {
    const devinPct = snap?.devin?.plan?.usedPercent ?? null;
    const agyPrimary = snap?.agy?.groups?.[0]?.buckets?.[0] ?? null;
    const agyPct = agyPrimary?.usedPercent ?? null;
    const codexPct = snap?.codex?.quota?.usedPercent ?? null;

    const miniCard = (id, title, iconPath, isTinted, pct, primaryMetric, subMetric) => {
      const hasPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
      const barColor = hasPct ? this.usageColor(pct, t) : t.dim;
      return v_flex()
        .id(`overview-${id}`)
        .flex_1()
        .min_w(0)
        .p(8)
        .gap(5)
        .rounded(9)
        .bg(t.background)
        .border(1)
        .border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setTab(id, cx))
        .child(
          h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(4)
            .child(
              h_flex()
                .items_center()
                .gap(5)
                .min_w(0)
                .child(
                  isTinted
                    ? svg(iconPath).size(12).flex_none().text_color(t.foreground)
                    : image(iconPath).size(12).flex_none()
                )
                .child(
                  div()
                    .text_size(11.5)
                    .font_semibold()
                    .text_color(t.foreground)
                    .truncate()
                    .child(title)
                )
            )
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(barColor)
                .child(hasPct ? `${Math.round(pct)}%` : "—")
            )
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.foreground)
            .truncate()
            .child(primaryMetric)
        )
        .child(
          div()
            .text_size(10)
            .text_color(t.muted)
            .truncate()
            .child(subMetric)
        );
    };

    const devinPlan = snap?.devin?.plan;
    const devinPrimary = devinPlan
      ? `${devinPlan.acuUsed}/${devinPlan.acuLimit} ACU`
      : snap?.devin?.installed
        ? `${snap?.devin?.localStats?.totalSessions ?? 0} sessions`
        : "Not installed";
    const devinSub = devinPlan
      ? `${devinPlan.remainingAcu} ACU left`
      : `${formatCompactNumber(snap?.devin?.localStats?.totalAcuCost ?? 0)} ACU local`;

    const agyCredits = snap?.agy?.credits?.remaining ?? 0;
    const agyPrimaryText = agyPrimary
      ? `${agyPrimary.remainingPercent}% left`
      : snap?.agy?.installed
        ? `${snap?.agy?.localStats?.totalConversations ?? 0} convs`
        : "Not installed";
    const agySubText = snap?.agy?.installed
      ? `${formatCompactNumber(agyCredits)} credits`
      : "No local state";

    const codexQuota = snap?.codex?.quota;
    const codexPrimaryText =
      codexQuota?.remainingPercent !== null && codexQuota?.remainingPercent !== undefined
        ? `${codexQuota.remainingPercent}% left (7d)`
        : snap?.codex?.installed
          ? `${snap?.codex?.localStats?.totalThreads ?? 0} threads`
          : "Not installed";
    const codexSubText =
      codexQuota?.creditsBalance !== null && codexQuota?.creditsBalance !== undefined
        ? `${formatCompactNumber(codexQuota.creditsBalance)} credits`
        : `${formatCompactNumber(snap?.codex?.localStats?.totalTokens ?? 0)} tok`;

    return h_flex()
      .w_full()
      .gap(6)
      .child(
        miniCard(
          "devin",
          "Devin",
          "mods/cli-usage/devin.svg",
          true,
          devinPct,
          devinPrimary,
          devinSub
        )
      )
      .child(
        miniCard(
          "agy",
          "AGY",
          "icons/antigravity.svg",
          false,
          agyPct,
          agyPrimaryText,
          agySubText
        )
      )
      .child(
        miniCard(
          "codex",
          "Codex",
          "icons/codex.svg",
          false,
          codexPct,
          codexPrimaryText,
          codexSubText
        )
      );
  }

  renderDevinCard(devin, machine, t, cx) {
    if (!devin) return div();
    const plan = devin.plan;
    const stats = devin.localStats || {};
    const models = Array.isArray(stats.models) ? stats.models : [];
    const recent = Array.isArray(stats.recentSessions) ? stats.recentSessions : [];
    const showModels = Boolean(this.expandedSections["devin:models"]);
    const showRecent = Boolean(this.expandedSections["devin:recent"]);

    return v_flex()
      .w_full()
      .p(12)
      .gap(10)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      // Card Header
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .flex_wrap()
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(svg("mods/cli-usage/devin.svg").size(15).flex_none().text_color(t.accent))
              .child(
                div()
                  .text_size(13.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("Devin CLI")
              )
              .when(Boolean(devin.version), (el) =>
                el.child(
                  this.renderPill(
                    `v${devin.version.split(/\s+/)[0]}`,
                    t.muted,
                    alpha(t.foreground, 0.06, t.raised)
                  )
                )
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .when(Boolean(plan?.name), (el) =>
                el.child(
                  this.renderPill(
                    plan.org ? `${plan.org} · ${plan.name}` : plan.name,
                    t.accent,
                    alpha(t.accent, 0.14, t.selected)
                  )
                )
              )
              .child(this.renderMachineBadge(machine, t))
          )
      )
      // Uninstalled / Error banner
      .when(!devin.installed, (el) =>
        el.child(
          div()
            .w_full()
            .p(8)
            .rounded(7)
            .bg(alpha(t.foreground, 0.04, t.raised))
            .text_size(11.5)
            .text_color(t.muted)
            .child(
              devin.error ||
                `Devin CLI is not installed on ${machine ? `SSH host ${machine}` : "this computer"}.`
            )
        )
      )
      .when(Boolean(devin.installed && devin.error), (el) =>
        el.child(
          div()
            .w_full()
            .p(7)
            .rounded(6)
            .bg(alpha(t.blocked || "#ef4444", 0.12, t.raised))
            .text_size(11)
            .text_color(t.blocked || "#ef4444")
            .child(devin.error)
        )
      )
      // Live ACU Quota Block
      .when(Boolean(plan), (el) => {
        const resetText = formatResetCountdown(plan.planEnd);
        return el.child(
          v_flex()
            .w_full()
            .p(9)
            .gap(6)
            .rounded(8)
            .bg(alpha(t.foreground, 0.03, t.raised))
            .border(1)
            .border_color(alpha(t.foreground, 0.06, t.border))
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .child(
                      div()
                        .text_size(11.5)
                        .font_medium()
                        .text_color(t.foreground)
                        .child("Cycle ACU Quota")
                    )
                    .when(plan.source === "cache", (s) =>
                      s.child(
                        this.renderPill("cached", t.dim, alpha(t.foreground, 0.06, t.raised))
                      )
                    )
                )
                .child(
                  div()
                    .text_size(12)
                    .font_semibold()
                    .text_color(this.usageColor(plan.usedPercent, t))
                    .child(`${plan.acuUsed} / ${plan.acuLimit} ACU (${plan.usedPercent}%)`)
                )
            )
            .child(this.renderProgressBar(plan.usedPercent, t, 7))
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .text_size(10.5)
                .text_color(t.muted)
                .child(div().child(`${plan.remainingAcu} ACU remaining`))
                .child(div().text_color(t.dim).child(resetText || "Billing cycle active"))
            )
        );
      })
      // Summary Stat Boxes
      .when(Boolean(devin.installed), (el) =>
        el
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .child(
                this.renderStatBox(
                  "Sessions",
                  formatCompactNumber(stats.totalSessions ?? 0),
                  `${formatCompactNumber(stats.totalTurns ?? 0)} assistant turns`,
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "Local ACU Cost",
                  `${Number(stats.totalAcuCost ?? 0).toFixed(2)} ACU`,
                  `${formatCompactNumber(stats.totalCreditCost ?? 0)} credits`,
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "Total Tokens",
                  formatCompactNumber(
                    (stats.totalInputTokens ?? 0) +
                      (stats.totalOutputTokens ?? 0) +
                      (stats.totalCacheReadTokens ?? 0)
                  ),
                  `In ${formatCompactNumber(stats.totalInputTokens ?? 0)} · Out ${formatCompactNumber(
                    stats.totalOutputTokens ?? 0
                  )}`,
                  t
                )
              )
          )
          // Expandable Per-Model Breakdown
          .when(models.length > 0, (s) =>
            s.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  h_flex()
                    .id("devin-toggle-models")
                    .w_full()
                    .py(3)
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => this.toggleSection("devin:models", cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(`Per-Model ACU & Tokens (${models.length})`)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(showModels ? "Hide ▾" : "Show ▸")
                    )
                )
                .when(showModels, (mEl) =>
                  mEl.children(
                    models.slice(0, 8).map((m, idx) =>
                      h_flex()
                        .id(`devin-model-${idx}`)
                        .w_full()
                        .px(8)
                        .py(5)
                        .rounded(6)
                        .bg(alpha(t.foreground, idx % 2 === 0 ? 0.03 : 0.015, t.raised))
                        .items_center()
                        .justify_between()
                        .gap(6)
                        .child(
                          v_flex()
                            .min_w(0)
                            .flex_1()
                            .child(
                              div()
                                .text_size(11.5)
                                .font_medium()
                                .text_color(t.foreground)
                                .truncate()
                                .child(m.model)
                            )
                            .child(
                              div()
                                .text_size(10)
                                .text_color(t.dim)
                                .truncate()
                                .child(
                                  `${m.turns} turns · Out ${formatCompactNumber(
                                    m.outputTokens
                                  )} · Cache ${formatCompactNumber(m.cacheReadTokens)}`
                                )
                            )
                        )
                        .child(
                          div()
                            .flex_none()
                            .text_size(11.5)
                            .font_semibold()
                            .text_color(t.accent)
                            .child(`${Number(m.acuCost ?? 0).toFixed(2)} ACU`)
                        )
                    )
                  )
                )
            )
          )
          // Expandable Recent Sessions
          .when(recent.length > 0, (s) =>
            s.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  h_flex()
                    .id("devin-toggle-recent")
                    .w_full()
                    .py(3)
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => this.toggleSection("devin:recent", cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(`Recent Sessions (${recent.length})`)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(showRecent ? "Hide ▾" : "Show ▸")
                    )
                )
                .when(showRecent, (rEl) =>
                  rEl.children(
                    recent.slice(0, 5).map((sess, idx) =>
                      v_flex()
                        .id(`devin-sess-${idx}`)
                        .w_full()
                        .px(8)
                        .py(5)
                        .gap(2)
                        .rounded(6)
                        .bg(alpha(t.foreground, 0.025, t.raised))
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(6)
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .text_size(11.5)
                                .font_medium()
                                .text_color(t.foreground)
                                .truncate()
                                .child(sess.title || sess.id)
                            )
                            .child(
                              div()
                                .flex_none()
                                .text_size(11)
                                .font_semibold()
                                .text_color(t.muted)
                                .child(`${Number(sess.acuCost ?? 0).toFixed(2)} ACU`)
                            )
                        )
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .text_size(10)
                            .text_color(t.dim)
                            .child(div().truncate().child(sess.model || "default"))
                            .child(div().truncate().child(shortenPath(sess.cwd)))
                        )
                    )
                  )
                )
            )
          )
      );
  }

  renderAgyCard(agy, machine, t, cx) {
    if (!agy) return div();
    const groups = Array.isArray(agy.groups) ? agy.groups : [];
    const stats = agy.localStats || {};
    const recent = Array.isArray(stats.recentConversations) ? stats.recentConversations : [];
    const showRecent = Boolean(this.expandedSections["agy:recent"]);

    return v_flex()
      .w_full()
      .p(12)
      .gap(10)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      // Header
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .flex_wrap()
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(image("icons/antigravity.svg").size(15).flex_none())
              .child(
                div()
                  .text_size(13.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("Antigravity (agy)")
              )
              .when(Boolean(agy.version), (el) =>
                el.child(
                  this.renderPill(
                    `v${agy.version}`,
                    t.muted,
                    alpha(t.foreground, 0.06, t.raised)
                  )
                )
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .when(Boolean(agy.activeModel?.label), (el) =>
                el.child(
                  this.renderPill(
                    agy.activeModel.label,
                    t.accent,
                    alpha(t.accent, 0.14, t.selected)
                  )
                )
              )
              .child(this.renderMachineBadge(machine, t))
          )
      )
      .when(!agy.installed, (el) =>
        el.child(
          div()
            .w_full()
            .p(8)
            .rounded(7)
            .bg(alpha(t.foreground, 0.04, t.raised))
            .text_size(11.5)
            .text_color(t.muted)
            .child(
              agy.error ||
                `Antigravity CLI (agy) is not installed on ${
                  machine ? `SSH host ${machine}` : "this computer"
                }.`
            )
        )
      )
      .when(Boolean(agy.installed && agy.error), (el) =>
        el.child(
          div()
            .w_full()
            .p(7)
            .rounded(6)
            .bg(alpha(t.blocked || "#ef4444", 0.12, t.raised))
            .text_size(11)
            .text_color(t.blocked || "#ef4444")
            .child(agy.error)
        )
      )
      // Model Group Quota Buckets
      .when(groups.length > 0, (el) =>
        el.children(
          groups.map((grp, gIdx) =>
            v_flex()
              .id(`agy-group-${gIdx}`)
              .w_full()
              .p(9)
              .gap(7)
              .rounded(8)
              .bg(alpha(t.foreground, 0.03, t.raised))
              .border(1)
              .border_color(alpha(t.foreground, 0.06, t.border))
              .child(
                h_flex()
                  .w_full()
                  .items_center()
                  .justify_between()
                  .gap(8)
                  .child(
                    div()
                      .flex_none()
                      .text_size(11.5)
                      .font_semibold()
                      .text_color(t.foreground)
                      .child(grp.title || "Model Quota")
                  )
                  .when(Boolean(grp.description), (dEl) =>
                    dEl.child(
                      div().flex_1().min_w(0).text_size(10).text_color(t.dim).truncate().child(grp.description)
                    )
                  )
              )
              .children(
                (grp.buckets || []).map((b, bIdx) => {
                  const resetStr = formatResetCountdown(b.resetTime);
                  return v_flex()
                    .id(`agy-bucket-${gIdx}-${bIdx}`)
                    .w_full()
                    .gap(4)
                    .child(
                      h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .text_size(11)
                        .child(
                          div()
                            .text_color(t.muted)
                            .truncate()
                            .child(b.label || b.id || "Quota window")
                        )
                        .child(
                          h_flex()
                            .items_center()
                            .gap(6)
                            .child(
                              div()
                                .font_semibold()
                                .text_color(this.usageColor(b.usedPercent, t))
                                .child(`${b.remainingPercent}% left (${b.usedPercent}% used)`)
                            )
                            .when(Boolean(resetStr), (rEl) =>
                              rEl.child(div().text_size(10).text_color(t.dim).child(`· ${resetStr}`))
                            )
                        )
                    )
                    .child(this.renderProgressBar(b.usedPercent, t, 6));
                })
              )
          )
        )
      )
      // Summary Stat Boxes (Credits + IDE/CLI Conversations & Steps)
      .when(Boolean(agy.installed), (el) =>
        el
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .child(
                this.renderStatBox(
                  "AI Credits",
                  formatCompactNumber(agy.credits?.remaining ?? 0),
                  agy.credits?.useAiCredits ? "Overage enabled" : "Standard quota",
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "IDE Usage",
                  `${formatCompactNumber(stats.ideConversations ?? 0)} convs`,
                  `${formatCompactNumber(stats.ideSteps ?? 0)} total steps`,
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "CLI Usage",
                  `${formatCompactNumber(stats.cliConversations ?? 0)} convs`,
                  `${formatCompactNumber(stats.cliSteps ?? 0)} total steps`,
                  t
                )
              )
          )
          // Expandable Recent Conversations
          .when(recent.length > 0, (s) =>
            s.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  h_flex()
                    .id("agy-toggle-recent")
                    .w_full()
                    .py(3)
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => this.toggleSection("agy:recent", cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(`Recent Conversations (${recent.length})`)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(showRecent ? "Hide ▾" : "Show ▸")
                    )
                )
                .when(showRecent, (rEl) =>
                  rEl.children(
                    recent.slice(0, 5).map((conv, idx) =>
                      v_flex()
                        .id(`agy-conv-${idx}`)
                        .w_full()
                        .px(8)
                        .py(5)
                        .gap(2)
                        .rounded(6)
                        .bg(alpha(t.foreground, 0.025, t.raised))
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(6)
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .text_size(11.5)
                                .font_medium()
                                .text_color(t.foreground)
                                .truncate()
                                .child(conv.title || conv.id)
                            )
                            .child(
                              this.renderPill(
                                `${conv.steps ?? 0} steps`,
                                t.muted,
                                alpha(t.foreground, 0.06, t.raised)
                              )
                            )
                        )
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .text_size(10)
                            .text_color(t.dim)
                            .child(
                              div()
                                .truncate()
                                .child(`${(conv.source || "ide").toUpperCase()} · ${conv.status}`)
                            )
                            .child(div().truncate().child(shortenPath(conv.cwd)))
                        )
                    )
                  )
                )
            )
          )
      );
  }

  renderCodexCard(codex, machine, t, cx) {
    if (!codex) return div();
    const quota = codex.quota || {};
    const stats = codex.localStats || {};
    const models = Array.isArray(stats.models) ? stats.models : [];
    const recent = Array.isArray(stats.recentThreads) ? stats.recentThreads : [];
    const showModels = Boolean(this.expandedSections["codex:models"]);
    const showRecent = Boolean(this.expandedSections["codex:recent"]);
    const hasQuota = quota.usedPercent !== null && quota.usedPercent !== undefined;

    return v_flex()
      .w_full()
      .p(12)
      .gap(10)
      .rounded(10)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      // Header
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(6)
          .flex_wrap()
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(image("icons/codex.svg").size(15).flex_none())
              .child(
                div()
                  .text_size(13.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("Codex CLI")
              )
              .when(Boolean(codex.version), (el) =>
                el.child(
                  this.renderPill(
                    `v${codex.version}`,
                    t.muted,
                    alpha(t.foreground, 0.06, t.raised)
                  )
                )
              )
          )
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .when(Boolean(quota.planType), (el) =>
                el.child(
                  this.renderPill(
                    String(quota.planType).toUpperCase(),
                    t.accent,
                    alpha(t.accent, 0.14, t.selected)
                  )
                )
              )
              .child(this.renderMachineBadge(machine, t))
          )
      )
      .when(!codex.installed, (el) =>
        el.child(
          div()
            .w_full()
            .p(8)
            .rounded(7)
            .bg(alpha(t.foreground, 0.04, t.raised))
            .text_size(11.5)
            .text_color(t.muted)
            .child(
              codex.error ||
                `Codex CLI is not installed on ${
                  machine ? `SSH host ${machine}` : "this computer"
                }.`
            )
        )
      )
      .when(Boolean(codex.installed && codex.error), (el) =>
        el.child(
          div()
            .w_full()
            .p(7)
            .rounded(6)
            .bg(alpha(t.blocked || "#ef4444", 0.12, t.raised))
            .text_size(11)
            .text_color(t.blocked || "#ef4444")
            .child(codex.error)
        )
      )
      // Live Rate Limit Quota Block
      .when(hasQuota, (el) => {
        const resetStr = formatResetCountdown(quota.resetAt);
        return el.child(
          v_flex()
            .w_full()
            .p(9)
            .gap(6)
            .rounded(8)
            .bg(alpha(t.foreground, 0.03, t.raised))
            .border(1)
            .border_color(alpha(t.foreground, 0.06, t.border))
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .child(
                  div()
                    .text_size(11.5)
                    .font_medium()
                    .text_color(t.foreground)
                    .child("Primary Rate Limit (7d Window)")
                )
                .child(
                  div()
                    .text_size(12)
                    .font_semibold()
                    .text_color(this.usageColor(quota.usedPercent, t))
                    .child(`${quota.usedPercent}% used · ${quota.remainingPercent}% left`)
                )
            )
            .child(this.renderProgressBar(quota.usedPercent, t, 7))
            .child(
              h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .text_size(10.5)
                .text_color(t.muted)
                .child(
                  div().child(
                    quota.creditsBalance !== null && quota.creditsBalance !== undefined
                      ? `Credits: ${formatCompactNumber(quota.creditsBalance)}${
                          quota.resetCreditsAvailable
                            ? ` · ${quota.resetCreditsAvailable} full resets`
                            : ""
                        }`
                      : "Included in plan"
                  )
                )
                .child(div().text_color(t.dim).child(resetStr || ""))
            )
        );
      })
      // Stat Boxes
      .when(Boolean(codex.installed), (el) =>
        el
          .child(
            h_flex()
              .w_full()
              .gap(6)
              .child(
                this.renderStatBox(
                  "Local Threads",
                  formatCompactNumber(stats.totalThreads ?? 0),
                  stats.streakDays ? `${stats.streakDays}d active streak` : "SQLite state_5",
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "Local Tokens",
                  formatCompactNumber(stats.totalTokens ?? 0),
                  `${models.length} models used`,
                  t
                )
              )
              .child(
                this.renderStatBox(
                  "Lifetime Tokens",
                  formatCompactNumber(stats.lifetimeTokens ?? stats.totalTokens ?? 0),
                  stats.peakDailyTokens
                    ? `Peak ${formatCompactNumber(stats.peakDailyTokens)}/d`
                    : "Account total",
                  t
                )
              )
          )
          // Expandable Per-Model Breakdown
          .when(models.length > 0, (s) =>
            s.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  h_flex()
                    .id("codex-toggle-models")
                    .w_full()
                    .py(3)
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => this.toggleSection("codex:models", cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(`Per-Model Token Usage (${models.length})`)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(showModels ? "Hide ▾" : "Show ▸")
                    )
                )
                .when(showModels, (mEl) =>
                  mEl.children(
                    models.slice(0, 8).map((m, idx) =>
                      h_flex()
                        .id(`codex-model-${idx}`)
                        .w_full()
                        .px(8)
                        .py(5)
                        .rounded(6)
                        .bg(alpha(t.foreground, idx % 2 === 0 ? 0.03 : 0.015, t.raised))
                        .items_center()
                        .justify_between()
                        .gap(6)
                        .child(
                          v_flex()
                            .min_w(0)
                            .flex_1()
                            .child(
                              div()
                                .text_size(11.5)
                                .font_medium()
                                .text_color(t.foreground)
                                .truncate()
                                .child(m.model)
                            )
                            .child(
                              div()
                                .text_size(10)
                                .text_color(t.dim)
                                .truncate()
                                .child(`${m.threads} threads · ${m.provider || "openai"}`)
                            )
                        )
                        .child(
                          div()
                            .flex_none()
                            .text_size(11.5)
                            .font_semibold()
                            .text_color(t.accent)
                            .child(`${formatCompactNumber(m.tokensUsed)} tok`)
                        )
                    )
                  )
                )
            )
          )
          // Expandable Recent Threads
          .when(recent.length > 0, (s) =>
            s.child(
              v_flex()
                .w_full()
                .gap(4)
                .child(
                  h_flex()
                    .id("codex-toggle-recent")
                    .w_full()
                    .py(3)
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .on_click((_e, cx) => this.toggleSection("codex:recent", cx))
                    .child(
                      div()
                        .text_size(11)
                        .font_semibold()
                        .text_color(t.muted)
                        .child(`Recent Threads (${recent.length})`)
                    )
                    .child(
                      div()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(showRecent ? "Hide ▾" : "Show ▸")
                    )
                )
                .when(showRecent, (rEl) =>
                  rEl.children(
                    recent.slice(0, 5).map((thr, idx) =>
                      v_flex()
                        .id(`codex-thread-${idx}`)
                        .w_full()
                        .px(8)
                        .py(5)
                        .gap(2)
                        .rounded(6)
                        .bg(alpha(t.foreground, 0.025, t.raised))
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(6)
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .text_size(11.5)
                                .font_medium()
                                .text_color(t.foreground)
                                .truncate()
                                .child(thr.title || thr.id)
                            )
                            .child(
                              div()
                                .flex_none()
                                .text_size(11)
                                .font_semibold()
                                .text_color(t.muted)
                                .child(`${formatCompactNumber(thr.tokensUsed)} tok`)
                            )
                        )
                        .child(
                          h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .text_size(10)
                            .text_color(t.dim)
                            .child(
                              div()
                                .truncate()
                                .child(
                                  thr.reasoningEffort
                                    ? `${thr.model} (${thr.reasoningEffort})`
                                    : thr.model
                                )
                            )
                            .child(div().truncate().child(shortenPath(thr.cwd)))
                        )
                    )
                  )
                )
            )
          )
      );
  }

  render(cx) {
    const t = theme();
    const overlayId = props()?.overlay ?? null;
    const remoteList = discoverMachines();
    const currentSpaceMach = activeSpaceMachine();
    const targetMachine = this.resolvedMachine();
    const machKey = this.machineKey(targetMachine);
    const snap = this.snapshots[machKey] || this.loadCachedSnapshot(targetMachine);
    const isLoading = Boolean(this.loadingByMachine[machKey]);

    const machineOptions = [
      {
        id: "auto",
        label: currentSpaceMach ? `Auto (${currentSpaceMach})` : "Auto (Local)",
      },
      { id: "local", label: "Local" },
      ...remoteList.map((m) => ({ id: `ssh:${m}`, label: m })),
    ];

    return v_flex()
      .id("cli-usage-root")
      .size_full()
      .bg(t.chrome)
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
        if (e.key === "r" || e.key === "R") {
          this.refresh(cx, { includeRemoteQuota: true, force: true });
        } else if (e.key === "Escape" && overlayId) {
          closeOverlay(overlayId);
        }
      })
      // Top Title & Refresh Bar
      .child(
        h_flex()
          .w_full()
          .px(12)
          .py(9)
          .items_center()
          .justify_between()
          .gap(8)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .items_center()
              .gap(7)
              .min_w(0)
              .child(
                div()
                  .text_size(13.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("CLI Usage & Quotas")
              )
              .child(this.renderMachineBadge(targetMachine, t))
          )
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(isLoading ? "Syncing…" : formatRelativeAgo(snap?.updatedAt))
              )
              .child(
                h_flex()
                  .id("cli-usage-refresh-btn")
                  .px(8)
                  .py(4)
                  .gap(5)
                  .rounded(6)
                  .items_center()
                  .bg(t.raised)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(t.foreground)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) =>
                    this.refresh(cx, { includeRemoteQuota: true, force: true })
                  )
                  .when(isLoading, (el) =>
                    el.child(
                      svg("mods/workspace-chrome/spinner.svg")
                        .size(11)
                        .text_color(t.accent)
                        .spin(900)
                    )
                  )
                  .child("Refresh")
              )
              .when(Boolean(overlayId), (el) =>
                el.child(
                  div()
                    .id("cli-usage-close-overlay")
                    .px(6)
                    .py(3)
                    .rounded(5)
                    .text_size(11)
                    .text_color(t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => closeOverlay(overlayId))
                    .child("✕")
                )
              )
          )
      )
      // Machine Selector Strip & Provider Filter Tabs
      .child(
        v_flex()
          .w_full()
          .px(12)
          .py(7)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .bg(alpha(t.foreground, 0.02, t.chrome))
          // Target Machine Selector Row
          .child(
            h_flex()
              .w_full()
              .items_center()
              .gap(4)
              .flex_wrap()
              .child(div().text_size(10.5).text_color(t.dim).mr(2).child("Target:"))
              .children(
                machineOptions.map((opt) => {
                  const selected = this.machineMode === opt.id;
                  return h_flex()
                    .id(`mach-opt-${opt.id}`)
                    .px(7)
                    .py(2.5)
                    .rounded(5)
                    .text_size(11)
                    .font_medium()
                    .bg(selected ? t.selected : alpha(t.foreground, 0.04, t.raised))
                    .text_color(selected ? t.foreground : t.muted)
                    .border(1)
                    .border_color(selected ? t.accent : alpha(t.foreground, 0.08, t.border))
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((_e, cx) => this.setMachineMode(opt.id, cx))
                    .child(opt.label);
                })
              )
          )
          // Provider Filter Pills (All | Devin | AGY | Codex)
          .child(
            h_flex()
              .w_full()
              .p(2)
              .gap(3)
              .rounded(7)
              .bg(alpha(t.foreground, 0.05, t.raised))
              .children(
                TABS.map((tab) => {
                  const active = this.activeTab === tab.id;
                  return h_flex()
                    .id(`cli-tab-${tab.id}`)
                    .flex_1()
                    .py(4)
                    .rounded(5)
                    .items_center()
                    .justify_center()
                    .text_size(11.5)
                    .font_medium()
                    .bg(active ? t.background : "#00000000")
                    .text_color(active ? t.foreground : t.muted)
                    .cursor_pointer()
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => this.setTab(tab.id, cx))
                    .child(tab.label);
                })
              )
          )
      )
      // Scrollable Body
      .child(
        v_flex()
          .id("cli-usage-scroll-body")
          .flex_1()
          .w_full()
          .p(10)
          .gap(10)
          .overflow_y_scrollbar()
          .when(!snap && isLoading, (el) =>
            el.child(
              h_flex()
                .w_full()
                .p(16)
                .gap(8)
                .items_center()
                .justify_center()
                .text_color(t.muted)
                .child(
                  svg("mods/workspace-chrome/spinner.svg")
                    .size(14)
                    .text_color(t.accent)
                    .spin(900)
                )
                .child(
                  `Collecting CLI usage from ${
                    targetMachine ? `SSH machine ${targetMachine}` : "this computer"
                  }…`
                )
            )
          )
          .when(Boolean(snap), (el) =>
            el
              .when(this.activeTab === "all", (s) =>
                s.child(this.renderOverviewBanner(snap, t, cx))
              )
              .when(this.activeTab === "all" || this.activeTab === "devin", (s) =>
                s.child(this.renderDevinCard(snap.devin, targetMachine, t, cx))
              )
              .when(this.activeTab === "all" || this.activeTab === "agy", (s) =>
                s.child(this.renderAgyCard(snap.agy, targetMachine, t, cx))
              )
              .when(this.activeTab === "all" || this.activeTab === "codex", (s) =>
                s.child(this.renderCodexCard(snap.codex, targetMachine, t, cx))
              )
          )
      );
  }
}
