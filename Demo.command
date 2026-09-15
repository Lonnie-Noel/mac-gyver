#!/bin/bash
set -euo pipefail
MAC_GYVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec /bin/bash "$MAC_GYVER_ROOT/Start.command" --demo "$@"
