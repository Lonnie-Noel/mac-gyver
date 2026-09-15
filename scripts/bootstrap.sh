#!/bin/bash
# Project-local dependencies only. This script never installs Python/Xcode/Node.
set -euo pipefail
MAC_GYVER_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$MAC_GYVER_ROOT"

fail() { printf '\n%s\n' "$*" >&2; exit 1; }
check_python() {
  "$1" -c 'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 15) else 1)' >/dev/null 2>&1
}

if [ ! -x "$MAC_GYVER_ROOT/.venv/bin/python" ]; then
  MAC_GYVER_INTERPRETER="${MAC_GYVER_PYTHON:-}"
  if [ -n "$MAC_GYVER_INTERPRETER" ]; then
    check_python "$MAC_GYVER_INTERPRETER" || fail 'MAC_GYVER_PYTHON은 실행 가능한 Python 3.11~3.14 경로여야 합니다.'
  else
    for candidate in python3.13 python3.12 python3.11 python3.14 python3; do
      if command -v "$candidate" >/dev/null 2>&1 && check_python "$candidate"; then
        MAC_GYVER_INTERPRETER="$(command -v "$candidate")"
        break
      fi
    done
  fi
  [ -n "$MAC_GYVER_INTERPRETER" ] || fail 'Python 3.11~3.14가 필요합니다. python.org의 macOS 설치 프로그램 또는 기존 Python을 설치한 뒤 다시 실행하세요. 자세한 내용: docs/SETUP_MAC.md'
  if [ -e "$MAC_GYVER_ROOT/.venv" ]; then
    fail '기존 .venv가 실행되지 않습니다. 폴더를 옮겼다면 .venv를 다른 이름으로 옮긴 후 다시 실행하세요. 시나리오와 결과는 삭제하지 않아도 됩니다.'
  fi
  printf '프로젝트 전용 Python 환경을 만듭니다.\n'
  "$MAC_GYVER_INTERPRETER" -m venv "$MAC_GYVER_ROOT/.venv" || fail 'Python venv 생성 실패: venv/ensurepip이 포함된 Python 배포판을 사용하세요.'
fi
MAC_GYVER_ENV_PYTHON="$MAC_GYVER_ROOT/.venv/bin/python"
check_python "$MAC_GYVER_ENV_PYTHON" || fail '기존 .venv의 Python이 지원 범위 밖입니다. .venv를 다른 이름으로 옮긴 뒤 Python 3.11~3.14로 다시 실행하세요.'

# Keep startup offline after a successful bootstrap, unless the manifest changed.
MAC_GYVER_FINGERPRINT="$("$MAC_GYVER_ENV_PYTHON" - "$MAC_GYVER_ROOT" <<'PY'
from pathlib import Path
import hashlib, sys
root = Path(sys.argv[1])
h = hashlib.sha256()
for name in ('pyproject.toml', 'requirements.txt'):
    h.update((root / name).read_bytes())
h.update(str(root.resolve()).encode())
h.update(sys.version.encode())
print(h.hexdigest())
PY
)"
MAC_GYVER_STAMP="$MAC_GYVER_ROOT/.venv/.mac-gyver-dependencies"
MAC_GYVER_INSTALLED=""
if [ -f "$MAC_GYVER_STAMP" ]; then MAC_GYVER_INSTALLED="$(cat "$MAC_GYVER_STAMP")"; fi
pins_match() {
  "$MAC_GYVER_ENV_PYTHON" - "$MAC_GYVER_ROOT/requirements.txt" <<'PY_CHECK'
from importlib.metadata import version
from pathlib import Path
import sys
try:
    for line in Path(sys.argv[1]).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            name, expected = line.split('==', 1)
            if version(name) != expected:
                raise ValueError(name)
    import mac_gyver, appium, selenium, PIL
    from PySide6 import QtCore, QtGui, QtWidgets
except Exception:
    raise SystemExit(1)
PY_CHECK
}
if [ "$MAC_GYVER_INSTALLED" != "$MAC_GYVER_FINGERPRINT" ] || ! pins_match >/dev/null 2>&1; then
  printf 'Python 의존성을 설치합니다. 첫 실행에는 인터넷 연결이 필요합니다.\n'
  "$MAC_GYVER_ENV_PYTHON" -m pip install --disable-pip-version-check -r "$MAC_GYVER_ROOT/requirements.txt" || fail '의존성 설치 실패. 인터넷 연결과 Python 버전을 확인하세요. SSL 인증서 오류는 docs/SETUP_MAC.md를 참고하세요.'
  "$MAC_GYVER_ENV_PYTHON" -m pip install --disable-pip-version-check --no-deps -e "$MAC_GYVER_ROOT" || fail 'mac-gyver 패키지 설치 실패. 위의 pip 오류를 확인하세요.'
  "$MAC_GYVER_ENV_PYTHON" -c 'import mac_gyver; from PySide6 import QtCore, QtGui, QtWidgets; import PIL, appium, selenium' || fail 'Qt 또는 네이티브 라이브러리를 불러오지 못했습니다. Python과 macOS 아키텍처, 지원 OS 및 docs/SETUP_MAC.md를 확인하세요.'
  printf '%s\n' "$MAC_GYVER_FINGERPRINT" > "$MAC_GYVER_STAMP"
fi
