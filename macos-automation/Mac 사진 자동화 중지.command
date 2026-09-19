#!/bin/zsh
set -euo pipefail
export PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
task_root="${0:A:h}"
cd "$task_root"
if [[ -x "$HOME/.local/bin/node" ]]; then
  task_node="$HOME/.local/bin/node"
else
  task_node="$(command -v node || true)"
fi
if [[ -z "$task_node" ]]; then
  print -u2 'Node.js 22.12 이상, 23 미만을 설치한 뒤 다시 실행하세요.'
  exit 1
fi
"$task_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==22||b<12){console.error("Node.js 22.12 이상, 23 미만이 필요합니다. 현재: "+process.versions.node);process.exit(1)}'
exec "$task_node" scripts/run.mjs stop "$@"
