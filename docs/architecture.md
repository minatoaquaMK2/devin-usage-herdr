# Architecture and collector design

This page explains how `cli-usage` integrates into Herdr's GPUI layout engine, how it collects telemetry across local and remote SSH machines, and why it separates fast local polling from remote quota checks.

## Herdr mod runtime and sandboxing

Herdr embeds QuickJS (`rquickjs`) to execute JavaScript mods inside a native Rust GPUI application. Mods do not run in a browser or Node.js environment. Instead, each mod exports a declarative `view(cx)` function that returns GPUI elements from the `gpui-kit` module (`div`, `button`, `scroll`, `svg`, `icon`) and interacts with the host through the global `herdr` capability object.

Herdr enforces two boundaries on user mods:

1. **No direct edits to shipped files.** Files inside `/Applications/Herdr.app/Contents/Resources/` are read-only templates. User customizations live in `~/.config/herdr-app/mods/` and `~/.config/herdr-app/layouts/`.
2. **Subprocess-based I/O.** Mods do not have raw filesystem or socket APIs in JavaScript. Instead, collectors spawn a single `python3` subprocess through `herdr.run(["python3", "-c", script])` and parse its JSON stdout.

## Why `tabs-usage` and `main-usage` are cloned

In Herdr's stock `main` layout, the top-right **Files** and **Changes** buttons are rendered by the built-in `tabs` mod (`mods/tabs/main.js`), and their corresponding views live inside the `panel-body` stack container.

Adding a third **Usage** button beside **Files** and **Changes** requires two overrides in `~/.config/herdr-app/`:

1. **`mods/tabs-usage/main.js`.** A clone of the stock `tabs` mod that adds a third `panelButton("cli-usage", "Usage", "mods/cli-usage/devin.svg")` call right beside `files` and `changes`. Clicking **Usage** selects `cli-usage` in `panel-body` and shows `panel` (or hides `panel` when already active).
2. **`layouts/main-usage.json`.** A clone of the stock `main` layout that replaces `"mod": "tabs"` with `"mod": "tabs-usage"` in the top bar and adds `{ "id": "cli-usage", "mod": "cli-usage", "title": "Usage" }` to the `panel-body` stack.

Because both overrides are stored as separate clones (`tabs-usage` and `main-usage`), the built-in `main` layout remains untouched. Switching back to `"main"` with `herdr-app do layout.switch '{"name":"main"}'` immediately restores stock behavior.

## Remote SSH collection via `{ on: machine }`

Herdr workspaces can attach to remote SSH hosts. Every tab in Herdr exposes its target host through `cx.activeTab()?.machine` (which is `undefined` for local tabs or an SSH host alias for remote tabs).

`herdr.run(argv, options)` supports an `{ on: machine }` option that routes subprocess execution over Herdr's multiplexed SSH connection to the remote host. Each collector in `cli-usage` builds a self-contained Python probe script and passes it through a single shell invocation when targeting a remote machine:

```js
const res = await herdr.run(
	["sh", "-c", "python3 -c " + shellQuote(pyScript)],
	machine ? { on: machine } : undefined,
);
```

Running one self-contained Python script per collector keeps remote collection fast:

- It avoids opening multiple SSH channels per tool.
- It reads SQLite databases (`history.db`, `MetricsDatabase`, `state_5.sqlite`), JSONL session logs, and local language server ports directly on the remote host.
- It returns a single compact JSON document over stdout.

When the machine selector is set to **Auto**, `main.js` reads `cx.activeTab()?.machine` on every render. Switching between a local workspace tab and a remote SSH workspace tab automatically switches the active telemetry target and triggers a background refresh for that host.

## Two-tier polling and `mergeSnapshotPreservingQuota`

Different telemetry sources have different costs:

- **Local files and localhost ports** (SQLite databases, JSONL rollouts, and the localhost Antigravity language server) take 50 to 150 milliseconds to query and incur no external API traffic.
- **Devin live cloud quota** exchanges `~/.config/devin/RefreshToken` against `https://api.cognition.ai` when an active `devin` CLI process is running.

To keep token counters responsive without polling external authentication endpoints every 30 seconds, `main.js` uses a two-tier refresh strategy:

1. **Fast poll (every 30 seconds and on the Sync button).** Calls `collectAll({ includeRemoteQuota: false })`. Collectors read SQLite databases, JSONL logs, and the localhost Antigravity server, while skipping external token exchange.
2. **Full quota poll (on initial startup, every 5 minutes, and on `herdr-app do cli-usage.refresh`).** Calls `collectAll({ includeRemoteQuota: true })` to refresh live cloud ACU quota when a `devin` CLI session is active.

When a fast poll finishes, `mergeSnapshotPreservingQuota(prev, next, includeRemoteQuota)` merges the new snapshot with the previous snapshot for the same machine. If the fast poll fell back to a stale on-disk `.bin` cache (`source: "cache"`), the merge preserves the previously fetched `"live"` plan object until the next 5-minute full quota poll runs.
