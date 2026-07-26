#!/bin/sh
set -eu
RLM_PLUGIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$RLM_PLUGIN_ROOT/dist/src/hook.js"
