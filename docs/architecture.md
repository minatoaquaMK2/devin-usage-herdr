# Architecture and collector design

This page explains how `cli-usage` integrates into Herdr's GPUI layout engine, how it collects telemetry across local and remote SSH machines, and why it separates fast local polling from full quota checks.

## Herdr mod runtime and sandboxing

Herdr embeds QuickJS (`rquickjs`) to execute JavaScript mods inside a native Rust GPUI application. Mods do not run in a browser or Node.js environment. Instead, `main.js` exports `default class CliUsageMod extends View` from the `"gpui-kit"` module (`View`, `div`, `h_flex`, `v_flex`, `svg`) and interacts with the host through capabilities imported from `"herdr"` (`exec`, `readTextFile`, `fetch`, `spaces`, `machines`, `focused`, `run`, `onAction`, `interval`).

Herdr enforces two boundaries on user mods:

1. **No direct edits to shipped files.** Files inside `/Applications/Herdr.app/Contents/Resources/` are read-only templates. User customizations live in `~/.config/herdr-app/mods/` and `~/.config/herdr-app/layouts/`.
2. **Capability-based I/O.** Mods read files, query SQLite databases (`sqlite3 -json`), and invoke CLI binaries exclusively through the `exec`, `readTextFile`, and `fetch` functions provided by `"herdr"`.

## Why `tabs-usage` and `main-usage` are cloned

In Herdr's stock `main` layout, the top-right **Files** and **Changes** buttons are rendered by the built-in `tabs` mod (`mods/tabs/main.js`), and their corresponding views live inside the `panel-body` stack container.

Adding a third **Usage** button beside **Files** and **Changes** requires two overrides in `~/.config/herdr-app/`:

1. **`mods/tabs-usage/main.js`.** A clone of the stock `tabs` mod that adds a third `panelButton("cli-usage", "Usage", "mods/cli-usage/devin.svg")` call right beside `files` and `changes`. Clicking **Usage** selects `cli-usage` in `panel-body` and shows `panel` (or hides `panel` when already active).
2. **`layouts/main-usage.json`.** A clone of the stock `main` layout that replaces `"mod": "tabs"` with `"mod": "tabs-usage"` in the top bar and adds `{ "id": "cli-usage", "mod": "cli-usage", "title": "Usage" }` to the `panel-body` stack.

Because both overrides are stored as separate clones (`tabs-usage` and `main-usage`), the built-in `main` layout remains untouched. Switching back to `"main"` with `herdr-app do layout.switch '{"name":"main"}'` immediately restores stock behavior.

## Remote SSH collection via `{ on: machine }`

Herdr workspaces can attach to remote SSH hosts. `main.js` discovers available SSH hosts from `spaces()` and `machines()`, and in **Auto** mode it resolves the active workspace's host from `spaces().find(s => s.active)?.machine` and `focused()`.

Both `exec(cmd, args, opts)` and `readTextFile(path, opts)` from `"herdr"` accept an `{ on: machine }` option that routes execution over Herdr's multiplexed SSH connection to the remote host. Before invoking the three collectors, `main.js` constructs a `target` object (`{ machine, homeDir, exec, readTextFile, fetch, includeRemoteQuota }`) whose `exec` and `readTextFile` helpers automatically pass `{ on: machine }` when `machine` is set:

```js
const runExec = (cmd, args = [], opts = {}) => {
	const execOpts = { ...opts };
	if (machine) execOpts.on = machine;
	return exec(cmd, args, execOpts);
};
```

This target abstraction keeps each collector uniform across local and remote hosts:

- SQLite queries (`sqlite3 -json` against `sessions.db`, `conversation_summaries.db`, and `state_5.sqlite`) run directly on the target host.
- Configuration and rollout files (`credentials.toml`, `auth.json`, `config.toml`, and `rollout-*.jsonl`) are read on the target host.
- Remote HTTP quota requests fall back to `curl` through `target.exec` when `machine` is a remote SSH host, so remote credentials never leave the remote machine.

When the machine selector is set to **Auto**, switching between a local workspace and a remote SSH workspace automatically switches the active telemetry target and triggers a refresh for that host.

## Two-tier polling and `mergeSnapshotPreservingQuota`

Different telemetry sources have different latency costs:

- **Local SQLite and JSONL files** (`sessions.db`, `conversation_summaries.db`, `state_5.sqlite`, and `rollout-*.jsonl`) take milliseconds to read and incur no external API or CLI startup overhead.
- **Live quota probes** (`SeatManagementService/GetUserStatus`, `agy -p "/usage"`, `agy -p "/credits"`, `chatgpt.com/backend-api/wham/usage`, and `codex app-server --stdio`) invoke network endpoints or headless CLI commands.

To keep session and token counters responsive without running network quota probes every 30 seconds, `main.js` uses a two-tier refresh strategy:

1. **Fast poll (every 30 seconds).** Calls `refresh(false)` (`includeRemoteQuota: false`). Collectors query local or remote SQLite databases and rollout logs while skipping network quota endpoints and slow CLI subcommands.
2. **Full quota poll (on initial startup, every 120 seconds, on the Refresh button, and on `herdr-app do cli-usage.refresh`).** Calls `refresh(true)` (`includeRemoteQuota: true`) to fetch live plan and rate-limit data across all three tools.

When a fast poll finishes, `mergeSnapshotPreservingQuota(prev, next, includeRemoteQuota)` merges the new snapshot with the previous snapshot for the same machine. It preserves previously fetched live rate-limit windows, credit balances, and Devin `"live"` plan data (`prev.devin.plan` when non-cache) over `"cache"` fallback values until the next full quota poll runs.
