"""Read-only, bounded first-run checks. No package installs or shell evaluation."""
from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
from urllib.error import URLError
from urllib.request import Request, urlopen

from .device import validate_server_url


def _run(args: list[str], timeout: float = 12) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def _parse_xctrace(output: str) -> list[dict]:
    devices = []
    in_devices = False
    for line in output.splitlines():
        if line.startswith("=="):
            in_devices = line.strip() == "== Devices =="
            continue
        if not in_devices or "simulator" in line.lower():
            continue
        match = re.match(r"^(.+?)\s+\(([\d.]+)(?:\s[^)]*)?\)\s+\(([A-Fa-f0-9-]{24,40})\)\s*$", line.strip())
        if match:
            devices.append({"name": match[1], "platform_version": match[2], "udid": match[3]})
    return devices


def _parse_devicectl(payload: dict) -> list[dict]:
    devices = []
    for item in payload.get("result", {}).get("devices", []):
        hardware = item.get("hardwareProperties", {})
        props = item.get("deviceProperties", {})
        connection = item.get("connectionProperties", {})
        if hardware.get("platform") not in {None, "iOS"} or hardware.get("deviceType") not in {None, "iPhone", "iPad"}:
            continue
        if connection.get("pairingState") in {"unpaired", "unavailable"} or item.get("visibilityClass") == "unavailable":
            continue
        udid = hardware.get("udid")
        if not udid:
            continue  # CoreDevice identifier is not the hardware UDID Appium needs.
        devices.append({"udid": udid, "name": props.get("name", "iPhone"),
                        "platform_version": props.get("osVersionNumber", ""),
                        "transport": connection.get("transportType", "unknown"),
                        "developer_mode": props.get("developerModeStatus", "unknown")})
    return devices


def discover_devices() -> list[dict]:
    """List paired real iOS devices; never silently select the first device."""
    if platform.system() != "Darwin" or not shutil.which("xcrun"):
        return []
    with tempfile.TemporaryDirectory(prefix="mac-gyver-device-check-") as directory:
        output = Path(directory) / "devices.json"
        try:
            result = _run(["xcrun", "devicectl", "list", "devices", "--timeout", "10", "--json-output", str(output)], 15)
            if result.returncode == 0 and output.exists():
                devices = _parse_devicectl(json.loads(output.read_text(encoding="utf-8")))
                if devices:
                    return devices
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    try:
        result = _run(["xcrun", "xctrace", "list", "devices"], 15)
        return _parse_xctrace(result.stdout) if result.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired):
        return []


def run_diagnostics(server_url: str = "http://127.0.0.1:4723") -> list[dict]:
    """Return ok/warning/error/manual rows. WDA signing is checked by connect()."""
    rows = []

    def add(name: str, status: str, message: str) -> None:
        rows.append({"name": name, "status": status, "message": message})

    is_mac = platform.system() == "Darwin"
    add("macOS", "ok" if is_mac else "warning",
        f"macOS {platform.mac_ver()[0]}" if is_mac else "실제 아이폰 연결은 Xcode가 설치된 Mac에서 실행하세요. 현재는 모의 기기를 사용할 수 있습니다.")
    for package in ("PySide6", "Appium-Python-Client", "selenium", "Pillow"):
        try:
            add(package, "ok", importlib.metadata.version(package))
        except importlib.metadata.PackageNotFoundError:
            add(package, "error", "Python 의존성이 없습니다. 설치 안내에 따라 가상환경을 준비하세요.")

    commands = [("Node.js", ["node", "--version"]), ("npm", ["npm", "--version"]), ("Appium", ["appium", "--version"])]
    if is_mac:
        commands = [("Xcode", ["xcodebuild", "-version"]), ("Xcode 경로", ["xcode-select", "-p"])] + commands
    for name, args in commands:
        if not shutil.which(args[0]):
            add(name, "error", f"{args[0]} 명령을 찾지 못했습니다. 설치 및 PATH를 확인하세요.")
            continue
        try:
            result = _run(args)
            output = (result.stdout or result.stderr).strip()[:1000]
            status = "ok" if result.returncode == 0 else "error"
            if status == "ok" and name == "Node.js":
                match = re.search(r"v?(\d+)\.(\d+)\.(\d+)", output)
                if match:
                    major, minor, _ = map(int, match.groups())
                    if not (major >= 24 or major == 22 and minor >= 12 or major == 20 and minor >= 19):
                        status, output = "error", output + " — Appium 3은 Node 20.19+, 22.12+ 또는 24+가 필요합니다."
            if status == "ok" and name in {"npm", "Appium"}:
                match = re.search(r"(\d+)\.(\d+)", output)
                if match and int(match[1]) < (10 if name == "npm" else 3):
                    status, output = "error", output + (" — npm 10 이상 필요" if name == "npm" else " — Appium 3 이상 필요")
            add(name, status, output or "응답 없음")
        except subprocess.TimeoutExpired:
            add(name, "error", "진단 명령의 제한 시간을 초과했습니다.")
        except OSError as error:
            add(name, "error", str(error))

    if shutil.which("appium"):
        try:
            result = _run(["appium", "driver", "list", "--installed", "--json"], 15)
            payload = json.loads(result.stdout) if result.returncode == 0 else {}
            driver = payload.get("xcuitest") if isinstance(payload, dict) else None
            if driver:
                version = driver.get("version", "unknown") if isinstance(driver, dict) else str(driver)
                add("XCUITest Driver", "ok", f"설치됨: {version}. iOS·Xcode 호환 여부는 실제 연결에서 확인합니다.")
            else:
                add("XCUITest Driver", "error", "XCUITest Driver가 없습니다. appium driver install xcuitest 로 설치하세요.")
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            add("XCUITest Driver", "error", f"설치 상태 확인 실패: {error}")

    try:
        url = validate_server_url(server_url)
        request = Request(url + "/status", headers={"Accept": "application/json"})
        with urlopen(request, timeout=5) as response:
            body = response.read(1_000_001)
        if len(body) > 1_000_000:
            raise ValueError("서버 상태 응답이 너무 큽니다.")
        payload = json.loads(body)
        value = payload.get("value", {}) if isinstance(payload, dict) else {}
        if isinstance(value, dict) and value.get("ready") is True:
            add("Appium 서버", "ok", f"연결 가능: {url}")
        else:
            add("Appium 서버", "warning", "서버에 응답이 있지만 새 세션 준비 상태를 확인하지 못했습니다.")
    except (OSError, ValueError, URLError) as error:
        add("Appium 서버", "error", f"접속하지 못했습니다: {error}")

    if is_mac:
        devices = discover_devices()
        add("실제 아이폰", "ok" if devices else "warning",
            ", ".join(f"{device['name']} ({device['udid']})" for device in devices)
            if devices else "아이폰을 찾지 못했습니다. USB, 잠금 해제, 이 컴퓨터 신뢰를 확인하세요.")
        for device in devices:
            if device.get("developer_mode") in {"enabled", "disabled"}:
                add(f"개발자 모드 — {device['name']}", "ok" if device["developer_mode"] == "enabled" else "error", device["developer_mode"])
    add("기기 설정 확인", "manual", "아이폰에서 개발자 모드, 컴퓨터 신뢰, 설정 > 개발자 > UI Automation을 확인하세요.")
    add("WDA 서명 및 연결", "manual", "Team ID와 WDA Bundle ID 또는 미리 설치한 WDA를 준비하세요. '연결' 시 실제 세션으로 검증합니다.")
    return rows
