# Reference guide

This page documents the file locations, commands, manifest fields, and collector output schemas for the `cli-usage` Herdr mod.

## Installed file paths

The installer places files in the following paths under `~/.config/herdr-app/`:

| Path | Purpose |
| :--- | :--- |
| `~/.config/herdr-app/mods/cli-usage/mod.json` | Mod manifest for `cli-usage`. |
| `~/.config/herdr-app/mods/cli-usage/main.js` | GPUI view, state management, and command handlers for `cli-usage`. |
| `~/.config/herdr-app/mods/cli-usage/devin.svg` | Vector icon rendered in the panel and in the top-bar **Usage** button. |
| `~/.config/herdr-app/mods/cli-usage/collectors/devin.js` | Collector for Devin CLI SQLite databases, session logs, and live ACU quota. |
| `~/.config/herdr-app/mods/cli-usage/collectors/agy.js` | Collector for Antigravity local language server quota and conversation files. |
| `~/.config/herdr-app/mods/cli-usage/collectors/codex.js` | Collector for Codex CLI SQLite threads, rollout JSONL files, and rate limits. |
| `~/.config/herdr-app/mods/tabs-usage/mod.json` | Mod manifest for the cloned top-bar mod. |
| `~/.config/herdr-app/mods/tabs-usage/main.js` | Cloned top-bar mod that adds the **Usage** button beside **Files** and **Changes**. |
| `~/.config/herdr-app/layouts/main-usage.json` | Cloned workspace layout that wires `tabs-usage` and docks `cli-usage` in `panel-body`. |

## CLI commands

Run these commands with `herdr-app do <command> [json-payload]`:

| Command | Payload | Effect |
| :--- | :--- | :--- |
| `layout.select` | `'{"stack":"panel-body","child":"cli-usage"}'` | Selects `cli-usage` inside the right-hand `panel-body` stack. |
| `layout.show` | `'{"id":"panel"}'` | Shows the right-hand `panel` dock. |
| `layout.hide` | `'{"id":"panel"}'` | Hides the right-hand `panel` dock. |
| `layout.toggle:cli-usage` | None | Toggles `cli-usage` as a floating popup overlay in any layout. |
| `cli-usage.refresh` | None | Runs a full collection pass, including remote quota probes. |
| `cli-usage.tab:all` | None | Switches the active panel view to the **All** summary tab. |
| `cli-usage.tab:devin` | None | Switches the active panel view to the **Devin** detail tab. |
| `cli-usage.tab:agy` | None | Switches the active panel view to the **AGY** detail tab. |
| `cli-usage.tab:codex` | None | Switches the active panel view to the **Codex** detail tab. |
| `layout.switch` | `'{"name":"main-usage"}'` | Activates the `main-usage` layout. |
| `layout.switch` | `'{"name":"main"}'` | Restores the built-in `main` layout. |

## Mod manifest (`mod.json`)

`~/.config/herdr-app/mods/cli-usage/mod.json` uses the following configuration:

```json
{
	"place": "none",
	"title": "CLI Usage",
	"focusable": true,
	"overlay": {
		"kind": "popup",
		"at": "top",
		"offset": 40,
		"width": 440,
		"height": 0.82
	}
}
```

- `place`: Set to `"none"` so the mod does not auto-insert into a default slot when using the stock `main` layout.
- `title`: Display title reported by `herdr-app status`.
- `focusable`: Allows keyboard focus inside the panel.
- `overlay`: Configures geometry when opened via `herdr-app do layout.toggle:cli-usage`.

## Monitored data sources

Each collector inspects specific paths on the target machine (local Mac or remote SSH host):

### Devin CLI (`collectors/devin.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `~/.local/share/devin/cli/history.db` | Session count, prompt history, and active working directories. |
| `~/.local/share/devin/cli/MetricsDatabase` | Per-session token totals (`prompt_tokens`, `completion_tokens`, `cached_tokens`). |
| `~/.local/share/devin/cli/sessions/*.jsonl` | Model names, tool call distributions, and active state. |
| `~/.cache/devin/cli/user_status.*.bin` | Cached plan name, organization name, and cycle ACU limits. |
| `~/.config/devin/RefreshToken` | Refresh token used only when `includeRemoteQuota` is `true` to query `https://api.cognition.ai/auth/SelectedOrg`. |

### Antigravity (`collectors/agy.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `ps -ax` (`language_server_macos_*`) | CSRF token and local port for the running Antigravity language server. |
| `https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus` | Live per-model remaining quota fractions, reset timestamps, and tier info. |
| `~/.gemini/antigravity/conversations/*.pb` | Total conversations, active conversations today, and storage size. |
| `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl` | Step counts, model calls, and tool invocations. |

### OpenAI Codex CLI (`collectors/codex.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `~/.codex/state_5.sqlite` | Thread count, total tokens used, and recent thread metadata from `threads`. |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Latest `token_count` events, model names, and `rate_limits` windows (`primary` 5-hour and `secondary` 7-day). |
| `~/.codex/config.toml` | Configured default model and reasoning effort. |
| `~/.codex/auth.json` | Authentication mode (`chatgpt` or API key) and plan type from JWT claims. |

## Collector options

Each collector exports an async function that accepts an options object:

```js
await collectDevinUsage({ on: machine, includeRemoteQuota: false });
await collectAgyUsage({ on: machine });
await collectCodexUsage({ on: machine });
```

- `on`: Optional machine identifier string passed directly to `herdr.run(cmd, { on })`. Omit or pass `undefined` to run on the local machine.
- `includeRemoteQuota`: Boolean used by `collectDevinUsage`. When `false`, the collector skips external HTTPS token exchange and reads only local SQLite databases, session logs, and protobuf caches.
