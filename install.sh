#!/usr/bin/env sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
HERDR_BIN=$(command -v herdr-app 2>/dev/null || true)
if [ -z "$HERDR_BIN" ] && [ -x "$HOME/.local/bin/herdr-app" ]; then
	HERDR_BIN="$HOME/.local/bin/herdr-app"
fi

mkdir -p "$APP_HOME/mods/cli-usage/collectors"
mkdir -p "$APP_HOME/mods/tabs-usage"
mkdir -p "$APP_HOME/layouts"

cp "$REPO_DIR/mod.json" "$REPO_DIR/main.js" "$REPO_DIR/devin.svg" "$APP_HOME/mods/cli-usage/"
cp "$REPO_DIR/collectors/devin.js" "$REPO_DIR/collectors/agy.js" "$REPO_DIR/collectors/codex.js" "$APP_HOME/mods/cli-usage/collectors/"
cp "$REPO_DIR/herdr/mods/tabs-usage/main.js" "$REPO_DIR/herdr/mods/tabs-usage/mod.json" "$APP_HOME/mods/tabs-usage/"
cp "$REPO_DIR"/herdr/mods/tabs-usage/*.svg "$APP_HOME/mods/tabs-usage/"
cp "$REPO_DIR/herdr/layouts/main-usage.json" "$APP_HOME/layouts/main-usage.json"

printf "Installed files into %s\n" "$APP_HOME"

if [ -n "$HERDR_BIN" ]; then
	"$HERDR_BIN" check "$APP_HOME/mods/cli-usage"
	"$HERDR_BIN" check "$APP_HOME/mods/tabs-usage"
	if "$HERDR_BIN" status >/dev/null 2>&1; then
		"$HERDR_BIN" do layout.switch '{"name":"main-usage"}' >/dev/null
		"$HERDR_BIN" do layout.select '{"stack":"panel-body","child":"cli-usage"}' >/dev/null
		"$HERDR_BIN" do layout.show '{"id":"panel"}' >/dev/null
		printf "Activated main-usage layout and opened the Usage panel.\n"
	fi
fi
