#!/bin/zsh
set -euo pipefail
task_root="${0:A:h}"
cd "$task_root"
source "$task_root/scripts/node-runtime.zsh"
macgyver_select_node "$task_root"
exec "$MACGYVER_SELECTED_NODE" scripts/run.mjs run "$@" --limit 1
