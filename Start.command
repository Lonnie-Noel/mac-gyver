#!/bin/bash
set -euo pipefail
MAC_GYVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Finder does not load the user's shell profile. Include normal Homebrew paths.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
finish() {
  status=$?
  if [ "$status" -ne 0 ] && [ -t 0 ]; then
    printf '\n실행하지 못했습니다. 위의 오류와 docs/SETUP_MAC.md를 확인하세요.\n'
    read -r -p '창을 닫으려면 Return 키를 누르세요. ' _unused || true
  fi
}
trap finish EXIT
cd -- "$MAC_GYVER_ROOT"
/bin/bash "$MAC_GYVER_ROOT/scripts/bootstrap.sh"
"$MAC_GYVER_ROOT/.venv/bin/python" -m mac_gyver "$@"
