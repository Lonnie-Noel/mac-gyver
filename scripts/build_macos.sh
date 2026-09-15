#!/bin/bash
# Run on the Mac architecture you want to distribute (Apple Silicon or Intel).
set -euo pipefail
MAC_GYVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$(uname -s)" != Darwin ]; then
  printf 'macOS .app 빌드는 Mac에서 수행해야 합니다.\n' >&2
  exit 1
fi
cd -- "$MAC_GYVER_ROOT"
/bin/bash "$MAC_GYVER_ROOT/scripts/bootstrap.sh"
MAC_GYVER_ENV_PYTHON="$MAC_GYVER_ROOT/.venv/bin/python"
"$MAC_GYVER_ENV_PYTHON" -m pip install --disable-pip-version-check -e '.[dev]'
mkdir -p "$MAC_GYVER_ROOT/build"
# Absolute import works both frozen and as a source checkout; no cwd asset paths.
cat > "$MAC_GYVER_ROOT/build/mac_gyver_launcher.py" <<'PY'
from mac_gyver.__main__ import main
if __name__ == '__main__':
    raise SystemExit(main())
PY
"$MAC_GYVER_ENV_PYTHON" -m PyInstaller \
  --name mac-gyver \
  --windowed --onedir --noconfirm --clean \
  --osx-bundle-identifier chat.lonnie.macgyver \
  --paths "$MAC_GYVER_ROOT/src" \
  --collect-data mac_gyver \
  --distpath "$MAC_GYVER_ROOT/dist" \
  --workpath "$MAC_GYVER_ROOT/build/pyinstaller" \
  --specpath "$MAC_GYVER_ROOT/build" \
  "$MAC_GYVER_ROOT/build/mac_gyver_launcher.py"
printf '\n생성 경로: %s/dist/mac-gyver.app\n' "$MAC_GYVER_ROOT"
printf '생성된 Mac에서 열기·저장·데모 실행을 확인하세요. Appium/Xcode/WDA는 별도로 준비해야 합니다.\n'
