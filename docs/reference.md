# Reference guide

This page documents the file locations, commands, manifest fields, and collector data sources for the `cli-usage` Herdr mod.

## Installed file paths

The installer places files in the following paths under `~/.config/herdr-app/`:

| Path | Purpose |
| :--- | :--- |
| `~/.config/herdr-app/mods/cli-usage/mod.json` | Mod manifest for `cli-usage`. |
| `~/.config/herdr-app/mods/cli-usage/main.js` | GPUI `View` class (`CliUsageMod`), state management, and command handlers for `cli-usage`. |
| `~/.config/herdr-app/mods/cli-usage/usage.svg` | Gauge icon rendered in the panel header and the top-bar **Usage** button. |
| `~/.config/herdr-app/mods/cli-usage/refresh.svg` | Refresh button icon. |
| `~/.config/herdr-app/mods/cli-usage/collectors/claude.js` | Collector for Claude Code session JSONL token usage, OAuth credentials, and live plan limits. |
| `~/.config/herdr-app/mods/cli-usage/collectors/devin.js` | Collector for Devin CLI `sessions.db`, credentials, cached status binaries, and live quota. |
| `~/.config/herdr-app/mods/cli-usage/collectors/agy.js` | Collector for `agy` CLI JSON probes (`/usage`, `/credits`, `/model`) and `conversation_summaries.db`. |
| `~/.config/herdr-app/mods/cli-usage/collectors/codex.js` | Collector for Codex CLI `state_5.sqlite`, rollout JSONL files, `wham/usage`, and `app-server`. |
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
| `mod.open` | `'{"name":"cli-usage"}'` | Opens `cli-usage` as a floating popup overlay in any layout. |
| `cli-usage.refresh` | None | Runs a full collection pass, including remote quota probes. |
| `cli-usage.tab:all` | None | Switches the active panel view to the **All** summary tab. |
| `cli-usage.tab:claude` | None | Switches the active panel view to the **Claude** detail tab. |
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
- `overlay`: Configures geometry when opened via `herdr-app do mod.open '{"name":"cli-usage"}'`.

## Monitored data sources

Each collector inspects specific paths and endpoints on the target machine (local Mac or remote SSH host):

### Claude Code (`collectors/claude.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `claude --version` | Installed flag and version. |
| `$CLAUDE_CONFIG_DIR` or `~/.claude/projects/**/*.jsonl` (and `~/.config/claude/projects`) | Per-reply token usage (input, output, cache write, cache read), models, and sessions for the last 30 days, de-duplicated by message and request ID. Aggregated with `python3`; per-file results cached in `~/.cache/herdr-cli-usage/claude-stats-v1.json`. |
| macOS Keychain `Claude Code-credentials` or `~/.claude/.credentials.json` | OAuth access token, subscription type, and rate-limit tier (read only during full refreshes; never refreshed by the mod). |
| `GET https://api.anthropic.com/api/oauth/usage` | Live `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` utilization and reset times, plus `extra_usage` (`anthropic-beta: oauth-2025-04-20`). Throttled to at most once per minute per machine. |

### Devin CLI (`collectors/devin.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `~/.local/share/devin/cli/sessions.db` | Session metadata and token totals from the `sessions` and `message_nodes` tables via `sqlite3`. |
| `~/.local/share/devin/credentials.toml` | `windsurf_api_key` used for live seat management status requests. |
| `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus` | Live plan name, cycle ACU limits, and per-model quota (`Authorization: Basic <key>`, `Connect-Protocol-Version: 1`). |
| `~/.cache/devin/cli/user_status.*.bin` | Cached protobuf plan name, organization name, and cycle ACU limits when offline or during fast polls. |

### Antigravity (`collectors/agy.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `agy -p "/usage" --output-format json` | Live per-model quota utilization percentages and reset timestamps. |
| `agy -p "/credits" --output-format json` | Available credit balances and tier status. |
| `agy -p "/model" --output-format json` | Active default model configuration. |
| `~/.gemini/antigravity/conversation_summaries.db` | Conversation count and summary metadata from the desktop database via `sqlite3 -json`. |
| `~/.gemini/antigravity-cli/conversation_summaries.db` | Conversation count and summary metadata from the CLI database via `sqlite3 -json`. |
| `~/.gemini/antigravity-cli/settings.json` and `~/.gemini/config/config.json` | Local CLI settings and account configuration. |

### OpenAI Codex CLI (`collectors/codex.js`)

| Path or endpoint | Data collected |
| :--- | :--- |
| `~/.codex/state_5.sqlite` | Thread count, total tokens used, and recent thread metadata from `threads` via `sqlite3 -json`. |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Latest `token_count` events, model names, and `rate_limits` windows (`primary` 5-hour and `secondary` 7-day). |
| `GET https://chatgpt.com/backend-api/wham/usage` | Live ChatGPT rate-limit windows and credit balance authenticated with `~/.codex/auth.json`. |
| `codex app-server --stdio` | Live JSON-RPC `account/rateLimits/read` and `account/usage/read` responses. |
| `~/.codex/config.toml` | Configured default model and reasoning effort. |
| `~/.codex/auth.json` | Authentication mode (`chatgpt` or API key), access token, and plan type from JWT claims. |

## Collector target interface

Each collector exports an async function that accepts a `target` context object constructed by `main.js`:

```js
const target = {
	machine,
	homeDir,
	exec,
	readTextFile,
	fetch,
	includeRemoteQuota,
};

await collectDevinUsage(target);
await collectAgyUsage(target);
await collectCodexUsage(target);
await collectClaudeUsage(target);
```

- `machine`: Optional SSH machine identifier string (`undefined` for local execution) passed to `exec(cmd, args, { on: machine })` and `readTextFile(path, { on: machine })`.
- `homeDir`: Resolved home directory on `machine`.
- `exec`: Helper wrapping Herdr's `exec` capability scoped to `machine`.
- `readTextFile`: Helper wrapping Herdr's `readTextFile` capability scoped to `machine`.
- `fetch`: Herdr's HTTP `fetch` function for local quota API calls.
- `includeRemoteQuota`: Boolean that controls whether the collector queries slow or external quota endpoints (`GetUserStatus`, `agy -p "/usage"`, `wham/usage`, and `codex app-server --stdio`) or reads only fast local SQLite and JSONL state.
