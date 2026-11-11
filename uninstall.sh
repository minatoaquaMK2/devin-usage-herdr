#!/usr/bin/env sh
set -eu

APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
HERDR_BIN=$(command -v herdr-app 2>/dev/null || true)
if [ -z "$HERDR_BIN" ] && [ -x "$HOME/.local/bin/herdr-app" ]; then
	HERDR_BIN="$HOME/.local/bin/herdr-app"
fi

if [ -n "$HERDR_BIN" ] && "$HERDR_BIN" status >/dev/null 2>&1; then
	"$HERDR_BIN" do layout.switch '{"name":"main"}' >/dev/null 2>&1 || true
fi

rm -rf "$APP_HOME/mods/cli-usage" "$APP_HOME/mods/tabs-usage"
rm -f "$APP_HOME/layouts/main-usage.json" "$APP_HOME/layouts/.state/main-usage.json"

printf "Removed cli-usage, tabs-usage, and main-usage from %s\n" "$APP_HOME"
