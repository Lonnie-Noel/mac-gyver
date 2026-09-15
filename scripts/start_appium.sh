#!/bin/bash
# Pin top-level tooling locally; no global npm install or sudo is used.
set -euo pipefail
MAC_GYVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
MAC_GYVER_APPIUM_VERSION=3.7.0
MAC_GYVER_XCUITEST_VERSION=12.12.4
MAC_GYVER_TOOL_DIR="$MAC_GYVER_ROOT/.tools/appium"
export APPIUM_HOME="$MAC_GYVER_ROOT/.tools/appium-home"
fail() { printf '\n%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail '실제 아이폰용 Appium 서버는 Mac에서 실행하세요.'
command -v node >/dev/null 2>&1 || fail 'Node.js가 필요합니다. Node 24 LTS와 npm 10 이상을 준비하세요. docs/SETUP_MAC.md 참고.'
command -v npm >/dev/null 2>&1 || fail 'npm이 없습니다. Node.js 설치를 확인하세요.'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>=24?0:1)' || fail 'Appium 3에 필요한 Node 범위: ^20.19.0 || ^22.12.0 || >=24.0.0'
MAC_GYVER_NPM_VERSION="$(npm --version)"
[ "${MAC_GYVER_NPM_VERSION%%.*}" -ge 10 ] || fail 'npm 10 이상이 필요합니다.'
mkdir -p "$MAC_GYVER_TOOL_DIR" "$APPIUM_HOME"

MAC_GYVER_CURRENT_APPIUM="$(node -e 'try{process.stdout.write(require(process.argv[1]).version)}catch{}' "$MAC_GYVER_TOOL_DIR/node_modules/appium/package.json")"
if [ "$MAC_GYVER_CURRENT_APPIUM" != "$MAC_GYVER_APPIUM_VERSION" ]; then
  printf 'Appium %s을 프로젝트 폴더에 설치합니다.\n' "$MAC_GYVER_APPIUM_VERSION"
  printf '{"name":"mac-gyver-appium-tools","private":true,"version":"1.0.0"}\n' > "$MAC_GYVER_TOOL_DIR/package.json"
  npm install --prefix "$MAC_GYVER_TOOL_DIR" --save-exact --no-audit --no-fund "appium@$MAC_GYVER_APPIUM_VERSION"
fi
MAC_GYVER_APPIUM="$MAC_GYVER_TOOL_DIR/node_modules/.bin/appium"
MAC_GYVER_CURRENT_DRIVER="$(node -e 'try{process.stdout.write(require(process.argv[1]).version)}catch{}' "$APPIUM_HOME/node_modules/appium-xcuitest-driver/package.json")"
if [ "$MAC_GYVER_CURRENT_DRIVER" != "$MAC_GYVER_XCUITEST_VERSION" ]; then
  if [ -n "$MAC_GYVER_CURRENT_DRIVER" ]; then "$MAC_GYVER_APPIUM" driver uninstall xcuitest; fi
  "$MAC_GYVER_APPIUM" driver install "xcuitest@$MAC_GYVER_XCUITEST_VERSION"
fi
case "${1:-}" in
  --install-only) printf 'Appium 및 XCUITest 설치 완료.\n'; exit 0 ;;
  --doctor) exec "$MAC_GYVER_APPIUM" driver doctor xcuitest ;;
  --open-wda) exec "$MAC_GYVER_APPIUM" driver run xcuitest open-wda ;;
  "") ;;
  *) fail '사용법: bash scripts/start_appium.sh [--install-only|--doctor|--open-wda]' ;;
esac
printf '\nAppium: http://127.0.0.1:4723 (이 창을 유지하세요. 종료: Ctrl+C)\n'
exec "$MAC_GYVER_APPIUM" --address 127.0.0.1 --port 4723 --base-path / --log-timestamp
