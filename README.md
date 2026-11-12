# Herdr CLI usage mod

`cli-usage` is a user mod for Herdr that displays live quota and session token usage for Claude Code, OpenAI Codex CLI, Antigravity (`agy`), and Devin CLI. Only the CLIs that are actually installed on the target machine are shown. It adds a **Usage** button to the top-right titlebar beside **Files** and **Changes**, and it opens as an integrated side panel or a keyboard-accessible popup overlay.

When you select a remote SSH workspace in Herdr, the mod automatically collects telemetry from that remote machine over Herdr's SSH bridge.

## Prerequisites

Before you install the mod, verify that your environment meets these requirements:

- macOS with `Herdr.app` installed in `/Applications/Herdr.app` or `~/Applications/Herdr.app`.
- `herdr-app` CLI installed in `~/.local/bin/herdr-app` or on your `PATH`.
- `sqlite3` available on the local machine and on any monitored remote SSH host.
- One or more supported coding CLIs installed (`claude`, `codex`, `agy`, or `devin`).
- `python3` on the target machine for Claude Code token statistics (optional).

## Install the mod

You can install the mod with the included installer script or by running `herdr-app` commands manually.

### Run the installer script

1. Clone this repository and enter the directory:

```sh
git clone https://github.com/minatoaquaMK2/devin-usage-herdr.git
cd devin-usage-herdr
```

2. Run the installer script:

```sh
./install.sh
```

The installer copies `cli-usage` and `tabs-usage` into `~/.config/herdr-app/mods/`, installs `main-usage.json` into `~/.config/herdr-app/layouts/`, validates both mods with `herdr-app check`, and switches the active layout to `main-usage`.

### Install manually

If you prefer not to run the installer script, install each component with `herdr-app`:

1. Create the mod and layout directories:

```sh
mkdir -p ~/.config/herdr-app/mods/cli-usage/collectors
mkdir -p ~/.config/herdr-app/mods/tabs-usage
mkdir -p ~/.config/herdr-app/layouts
```

2. Copy the `cli-usage` mod files into `~/.config/herdr-app/mods/cli-usage/`:

```sh
cp mod.json main.js *.svg ~/.config/herdr-app/mods/cli-usage/
cp collectors/*.js ~/.config/herdr-app/mods/cli-usage/collectors/
```

3. Copy the cloned top-bar mod and layout into `~/.config/herdr-app/`:

```sh
cp herdr/mods/tabs-usage/mod.json herdr/mods/tabs-usage/main.js herdr/mods/tabs-usage/*.svg ~/.config/herdr-app/mods/tabs-usage/
cp herdr/layouts/main-usage.json ~/.config/herdr-app/layouts/main-usage.json
```

4. Validate the mods and activate the `main-usage` layout:

```sh
herdr-app check ~/.config/herdr-app/mods/cli-usage
herdr-app check ~/.config/herdr-app/mods/tabs-usage
herdr-app do layout.switch '{"name":"main-usage"}'
herdr-app do layout.select '{"stack":"panel-body","child":"cli-usage"}'
herdr-app do layout.show '{"id":"panel"}'
```

## Open and use the panel

After you activate the `main-usage` layout, the **Usage** button appears in the top-right titlebar beside **Files** and **Changes**.

### Toggle the side panel

- To open the usage panel in the right-hand dock, click **Usage** in the top-right titlebar.
- To switch to the file tree or Git diff view, click **Files** or **Changes**.
- To close the right-hand dock, click the active panel button a second time.

### Filter by tool tab

Tabs appear only for CLIs detected on the target machine. CLIs that are not installed are hidden and listed in a single "Not detected" line at the bottom of **Overview**. With only one CLI installed, the tab bar is hidden and its details are shown directly; with none, the panel shows an empty state with a **Scan again** button.

- **Overview.** One compact card per detected CLI with every plan-limit bar, reset countdown, and a one-line summary. Click a card to open its details.
- **Claude.** 5-hour session and weekly (all models / Opus / Sonnet) plan limits, extra-usage, today / 7-day / 30-day token totals, a 7-day daily token chart, per-model breakdown, and recent sessions.
- **Codex.** Primary and weekly rate-limit windows, credits, token usage, model distribution, and recent threads.
- **AGY.** Live per-model quota bars, reset countdowns, credit balances, and local conversation metrics.
- **Devin.** Cycle ACU consumption, plan, model breakdown, and recent sessions.

Keyboard shortcuts (when the panel is focused): `R` refreshes, `1`–`5` jump to a tab, `←`/`→` cycle tabs, `Esc` closes the popup. A colored dot on a tab means one of that CLI's limits is above 65%.

### Switch the target machine

The machine bar beneath the header controls where collectors run:

- **Auto.** Tracks the machine attached to the active Herdr workspace (`spaces().find(s => s.active)?.machine` and `focused()`).
- **Local.** Forces collection on the local Mac regardless of the active workspace.
- **SSH host pills.** Connects to a specific SSH machine discovered from `spaces()` and `machines()`.

To run a full refresh that queries both local databases and remote quota endpoints, click **Refresh** in the panel header or run `herdr-app do cli-usage.refresh` from a terminal.

## Control the mod from the CLI

You can control `cli-usage` from scripts, keybindings, or the terminal with `herdr-app do`:

```sh
# Select and show the Usage panel in the right-hand dock
herdr-app do layout.select '{"stack":"panel-body","child":"cli-usage"}'
herdr-app do layout.show '{"id":"panel"}'

# Hide the right-hand dock
herdr-app do layout.hide '{"id":"panel"}'

# Trigger a full refresh (local metrics and remote quota probes)
herdr-app do cli-usage.refresh

# Switch the active tab (all, devin, agy, or codex)
herdr-app do cli-usage.tab:all
herdr-app do cli-usage.tab:claude
herdr-app do cli-usage.tab:devin
herdr-app do cli-usage.tab:agy
herdr-app do cli-usage.tab:codex
```

If you keep the stock `main` layout instead of switching to `main-usage`, open the mod as a centered popup overlay:

```sh
herdr-app do mod.open '{"name":"cli-usage"}'
```

## Uninstall the mod

To restore the default `main` layout and remove the installed files, run the uninstaller script:

```sh
./uninstall.sh
```

## Troubleshoot common issues

Use the solutions below if the panel does not appear or reports missing data.

### The Usage button does not appear in the top bar

Verify that Herdr is using the `main-usage` layout:

```sh
herdr-app status
```

If `"layout"` is `"main"`, switch to `"main-usage"`:

```sh
herdr-app do layout.switch '{"name":"main-usage"}'
```

### Claude Code shows local stats but no plan limits

Plan limits come from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code stores in the macOS Keychain (`Claude Code-credentials`) or in `~/.claude/.credentials.json`. They are only available when you sign in to `claude` with a Pro / Max / Team subscription; API-key and custom-endpoint setups show local token stats only. The mod never refreshes the token itself, so if it reports an expired token, run `claude` once. Token statistics are aggregated from `~/.claude/projects/**/*.jsonl` (last 30 days) with `python3`, and per-file results are cached in `~/.cache/herdr-cli-usage/`.

### Devin shows cached or empty plan quota

Devin live plan quota requires `windsurf_api_key` in `~/.local/share/devin/credentials.toml` to query `https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`. When live quota cannot be reached, the collector reads the most recent protobuf status cache from `~/.cache/devin/cli/user_status.*.bin`. Sign in to `devin` CLI and click **Refresh** to populate live cycle ACU figures.

### Antigravity shows local metrics without live model quota bars

Live per-model quota bars and credit balances come from running `agy -p "/usage" --output-format json` and `agy -p "/credits" --output-format json`. When the `agy` CLI cannot reach the quota service, the collector still reports conversation metrics from `~/.gemini/antigravity/conversation_summaries.db` and `~/.gemini/antigravity-cli/conversation_summaries.db`.

### Remote SSH collection fails or times out

Herdr executes remote collector commands through `exec(cmd, args, { on: machine })` and `readTextFile(path, { on: machine })`. Verify that the remote host is reachable over non-interactive SSH (`ssh <host> sqlite3 --version`) and that `sqlite3` is installed on the remote machine.

## Further reading

- For command names, manifest fields, data paths, and collector schemas, see the [Reference guide](docs/reference.md).
- For design decisions, sandboxing rules, and remote execution architecture, see [Architecture and collector design](docs/architecture.md).

## License

MIT License. See [LICENSE](LICENSE).
