#!/bin/sh
set -eu
RLM_PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RLM_CACHE_PLUGIN_DIR=$(dirname -- "$RLM_PLUGIN_ROOT")
RLM_MARKETPLACE_DIR=$(dirname -- "$RLM_CACHE_PLUGIN_DIR")
RLM_CACHE_DIR=$(dirname -- "$RLM_MARKETPLACE_DIR")
RLM_PLUGINS_DIR=$(dirname -- "$RLM_CACHE_DIR")

if [ "$(basename -- "$RLM_CACHE_DIR")" = "cache" ] &&
   [ "$(basename -- "$RLM_PLUGINS_DIR")" = "plugins" ]; then
  RLM_PLUGIN_NAME=$(basename -- "$RLM_CACHE_PLUGIN_DIR")
  RLM_MARKETPLACE_NAME=$(basename -- "$RLM_MARKETPLACE_DIR")
  RLM_PLUGIN_DATA="$RLM_PLUGINS_DIR/data/$RLM_PLUGIN_NAME-$RLM_MARKETPLACE_NAME"
elif [ -n "${RLM_DEV_PLUGIN_DATA:-}" ]; then
  RLM_PLUGIN_DATA=$RLM_DEV_PLUGIN_DATA
else
  echo "Codex RLM refuses an unrecognized plugin install layout" >&2
  exit 78
fi

export RLM_PLUGIN_DATA
exec node "$RLM_PLUGIN_ROOT/dist/src/server.js"
