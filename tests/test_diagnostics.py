import subprocess

from mac_gyver import diagnostics


def test_xctrace_only_returns_real_online_devices():
    output = """== Devices ==
Mac (TEST-MAC-ID)
Lonnie iPhone (18.5) (00008110-001E18023410801E)
== Devices Offline ==
Offline Phone (17.0) (00008110-001E18023410802E)
== Simulators ==
iPhone 16 Simulator (18.5) (00008110-001E18023410803E)
"""
    assert diagnostics._parse_xctrace(output) == [{"name": "Lonnie iPhone", "platform_version": "18.5", "udid": "00008110-001E18023410801E"}]


def test_devicectl_uses_hardware_udid_not_coredevice_identifier():
    data = {"result": {"devices": [
        {"identifier": "WRONG-COREDEVICE-UUID", "hardwareProperties": {"udid": "REAL-HARDWARE-UDID", "platform": "iOS", "deviceType": "iPhone"},
         "deviceProperties": {"name": "Test", "osVersionNumber": "18.5", "developerModeStatus": "enabled"},
         "connectionProperties": {"pairingState": "paired", "transportType": "wired"}},
        {"identifier": "NOT-A-UDID", "hardwareProperties": {"platform": "iOS"}},
        {"hardwareProperties": {"udid": "APPLETV", "platform": "tvOS"}},
    ]}}
    devices = diagnostics._parse_devicectl(data)
    assert len(devices) == 1
    assert devices[0]["udid"] == "REAL-HARDWARE-UDID"
    assert devices[0]["developer_mode"] == "enabled"


def test_device_discovery_timeouts_are_bounded_and_do_not_raise(monkeypatch):
    monkeypatch.setattr(diagnostics.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(diagnostics.shutil, "which", lambda command: "/usr/bin/" + command)
    calls = []

    def timeout(args, timeout):
        calls.append((args, timeout))
        raise subprocess.TimeoutExpired(args, timeout)

    monkeypatch.setattr(diagnostics, "_run", timeout)
    assert diagnostics.discover_devices() == []
    assert len(calls) == 2
    assert all(timeout == 15 for _, timeout in calls)


def test_run_diagnostics_reports_timeout_without_installs(monkeypatch):
    monkeypatch.setattr(diagnostics.platform, "system", lambda: "Linux")
    monkeypatch.setattr(diagnostics.shutil, "which", lambda command: "/usr/bin/" + command)
    calls = []

    def timeout(args, timeout=12):
        calls.append(args)
        raise subprocess.TimeoutExpired(args, timeout)

    def offline(*args, **kwargs):
        assert kwargs["timeout"] == 5
        raise TimeoutError("offline")

    monkeypatch.setattr(diagnostics, "_run", timeout)
    monkeypatch.setattr(diagnostics, "urlopen", offline)
    rows = diagnostics.run_diagnostics()
    assert next(row for row in rows if row["name"] == "Appium")["status"] == "error"
    assert next(row for row in rows if row["name"] == "Appium 서버")["status"] == "error"
    assert next(row for row in rows if row["name"] == "WDA 서명 및 연결")["status"] == "manual"
    assert all("install" not in args for args in calls)


def test_subprocess_uses_argv_and_a_timeout(monkeypatch):
    captured = {}

    def run(args, **kwargs):
        captured.update(kwargs)
        assert args == ["xcrun", "xctrace", "list", "devices"]
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(diagnostics.subprocess, "run", run)
    diagnostics._run(["xcrun", "xctrace", "list", "devices"], 9)
    assert captured["timeout"] == 9
    assert captured.get("shell", False) is False
