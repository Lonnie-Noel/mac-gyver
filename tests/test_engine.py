from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import threading
import time

from PIL import Image
import pytest

from mac_gyver.engine import Runner
from mac_gyver.models import new_scenario


def png(color="white", size=(100, 200)):
    stream = BytesIO()
    Image.new("RGB", size, color).save(stream, format="PNG")
    return stream.getvalue()


class Device:
    def __init__(self):
        self.commands = []
        self.info = {"width": 100, "height": 200, "orientation": "PORTRAIT"}
        self.image = png()
        self.visible = True
        self.error = None
        self.capture_error = None
        self.after_command = None
        self.captures = 0

    def metadata(self):
        return {"simulated": True, "name": "Test backend"}

    def geometry(self):
        return deepcopy(self.info)

    def screenshot(self):
        self.captures += 1
        if self.capture_error:
            raise self.capture_error
        return self.image

    def perform(self, step):
        self.commands.append(deepcopy(step))
        if self.error:
            raise self.error
        if self.after_command:
            self.after_command(step)
        return {"sent": True}

    def has_element(self, target):
        return self.visible


def tap():
    return {"type": "tap", "target": {"mode": "normalized", "x": .5, "y": .5}}


def assertion():
    return {"type": "assert_element", "target": {"mode": "element", "by": "accessibility_id", "value": "photo"}}


def scenario(*steps, setup=None):
    value = new_scenario("테스트")
    value["steps"] = list(steps)
    value["setup"] = setup or []
    return value


def test_setup_runs_once_repeats_and_cycles_are_separate(tmp_path):
    device = Device()
    value = scenario({"type": "repeat", "count": 2, "steps": [tap(), assertion()]}, setup=[{"type": "activate_app"}])
    report = Runner(device, tmp_path).run(value, cycles=3)
    assert report["status"] == "passed"
    assert len(device.commands) == 7
    assert sum(step["type"] == "activate_app" for step in device.commands) == 1
    assert report["checks"] == 6
    assert report["partial_verification"] is True
    assert len(report["results"]) == 13
    assert report["simulated"] is True
    assert Path(report["json_path"]).is_file() and Path(report["html_path"]).is_file()


def test_no_assertions_or_only_start_guard_cannot_pass(tmp_path):
    device = Device()
    value = scenario(tap(), setup=[assertion()])
    value["precondition"] = assertion()
    report = Runner(device, tmp_path).run(value)
    assert report["status"] == "unchecked"
    assert report["checks"] == 0 and report["setup_checks"] == 2
    assert report["unchecked_steps"] == 1


def test_failure_is_not_retried_and_screenshot_error_does_not_hide_it(tmp_path):
    device = Device()
    device.error = RuntimeError("connection lost after dispatch")
    device.capture_error = RuntimeError("capture unavailable")
    report = Runner(device, tmp_path).run(scenario(tap(), tap()))
    assert report["status"] == "error"
    assert len(device.commands) == 1
    result = report["results"][0]
    assert result["error"] == "connection lost after dispatch"
    assert "capture unavailable" in result["screenshot_error"]
    assert json.loads(Path(report["json_path"]).read_text())["status"] == "error"


def test_assertion_failure_and_timeout_are_distinct(tmp_path):
    device = Device()
    device.visible = False
    result = Runner(device, tmp_path).run(scenario(assertion(), tap()))
    assert result["status"] == "failed" and not device.commands
    waiting = assertion()
    waiting.update(type="wait_element", timeout_ms=10, poll_interval_ms=10)
    result = Runner(device, tmp_path).run(scenario(waiting, tap()))
    assert result["status"] == "error"
    assert result["results"][0]["error_type"] == "TimeoutError"
    assert not device.commands


def test_geometry_change_blocks_next_coordinate_command(tmp_path):
    device = Device()

    def rotate_screen(step):
        device.info = {"width": 200, "height": 100, "orientation": "LANDSCAPE"}

    device.after_command = rotate_screen
    report = Runner(device, tmp_path).run(scenario(tap(), tap()))
    assert report["status"] == "error"
    assert len(device.commands) == 1
    assert report["results"][1]["error_type"] == "GeometryMismatch"


def test_stored_geometry_mismatch_sends_no_gesture(tmp_path):
    device = Device()
    value = scenario(tap())
    value["geometry"] = {"width": 200, "height": 100, "orientation": "LANDSCAPE"}
    report = Runner(device, tmp_path).run(value)
    assert report["status"] == "error" and "GeometryMismatch" in report["error"]
    assert not device.commands
    assert Path(report["html_path"]).is_file()


def test_geometry_is_checked_again_after_app_activation(tmp_path):
    device = Device()
    device.after_command = lambda step: device.info.update(orientation="LANDSCAPE")
    report = Runner(device, tmp_path).run(scenario(tap(), setup=[{"type": "activate_app"}]))
    assert report["status"] == "error"
    assert [step["type"] for step in device.commands] == ["activate_app"]


def test_stop_interrupts_long_wait_without_next_device_command(tmp_path):
    device = Device()
    started = threading.Event()
    runner = Runner(device, tmp_path, on_event=lambda event: started.set() if event["kind"] == "step_start" else None)
    output = {}
    thread = threading.Thread(target=lambda: output.update(runner.run(scenario({"type": "wait", "duration_ms": 60_000}, tap()))))
    thread.start()
    try:
        assert started.wait(2)
        runner.stop()
        thread.join(2)
        assert not thread.is_alive()
        assert output["status"] == "stopped" and not device.commands
    finally:
        runner.stop()
        thread.join(2)


def test_pause_waits_for_inflight_command_and_stop_prevents_followup(tmp_path):
    device = Device()
    dispatched, release, paused = threading.Event(), threading.Event(), threading.Event()

    def blocking_command(step):
        dispatched.set()
        assert release.wait(2)

    device.after_command = blocking_command
    runner = Runner(device, tmp_path, on_event=lambda event: paused.set() if event.get("state") == "paused" else None)
    output = {}
    thread = threading.Thread(target=lambda: output.update(runner.run(scenario(tap(), tap()))))
    thread.start()
    try:
        assert dispatched.wait(2)
        runner.pause()
        release.set()
        assert paused.wait(2)
        assert len(device.commands) == 1
        runner.stop()
        thread.join(2)
        assert not thread.is_alive() and output["status"] == "stopped"
        assert len(device.commands) == 1 and device.captures == 0
    finally:
        release.set()
        runner.stop()
        thread.join(2)


def test_pause_resume_proceeds_once_at_command_boundary(tmp_path):
    device = Device()
    paused = threading.Event()
    runner = None

    def event_handler(event):
        if event["kind"] == "step_finish" and event["path"].endswith("/1"):
            runner.pause()
        if event.get("state") == "paused":
            paused.set()

    runner = Runner(device, tmp_path, on_event=event_handler)
    output = {}
    thread = threading.Thread(target=lambda: output.update(runner.run(scenario(tap(), tap()))))
    thread.start()
    try:
        assert paused.wait(2)
        assert len(device.commands) == 1
        runner.resume()
        thread.join(2)
        assert not thread.is_alive() and len(device.commands) == 2
        assert output["status"] == "unchecked"
    finally:
        runner.stop()
        thread.join(2)


def test_prestart_stop_and_expansion_limit_dispatch_nothing(tmp_path):
    device = Device()
    runner = Runner(device, tmp_path)
    runner.stop()
    assert runner.run(scenario(tap()))["status"] == "stopped"
    value = scenario({"type": "repeat", "count": 10_000, "steps": [tap(), tap()]})
    result = runner.run(value, cycles=10)
    assert result["status"] == "error" and "expands" in result["error"]
    assert not device.commands


def test_image_comparison_uses_selected_region_and_reports_metric(tmp_path):
    device = Device()
    baseline = Image.new("RGB", (100, 200), "white")
    baseline.save(tmp_path / "baseline.png")
    changed = baseline.copy()
    changed.paste("black", (0, 0, 50, 200))
    buffer = BytesIO()
    changed.save(buffer, format="PNG")
    device.image = buffer.getvalue()
    step = {"type": "assert_image", "baseline": "baseline.png", "tolerance": 0,
            "region": {"x": .5, "y": 0, "width": .5, "height": 1}}
    report = Runner(device, tmp_path / "runs", asset_root=tmp_path).run(scenario(step))
    assert report["status"] == "passed"
    assert report["results"][0]["observations"]["difference"] == 0
    assert (Path(report["run_dir"]) / report["results"][0]["baseline_image"]).is_file()
    step["region"]["x"] = 0
    step["expected"] = "different"
    report = Runner(device, tmp_path / "runs", asset_root=tmp_path).run(scenario(step))
    assert report["status"] == "passed"
    assert report["results"][0]["observations"]["difference"] == 1
    step["expected"] = "match"
    report = Runner(device, tmp_path / "runs", asset_root=tmp_path).run(scenario(step))
    assert report["status"] == "failed"


def test_baseline_symlink_cannot_escape_scenario_folder(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (tmp_path / "outside.png").write_bytes(png())
    (assets / "reference.png").symlink_to(tmp_path / "outside.png")
    device = Device()
    report = Runner(device, tmp_path / "runs", asset_root=assets).run(scenario({"type": "assert_image", "baseline": "reference.png"}))
    assert report["status"] == "error"
    assert "시나리오 폴더" in report["error"]


def test_callback_exception_does_not_retry_or_fail_gestures(tmp_path):
    def broken_ui(event):
        raise RuntimeError("UI update failed")
    device = Device()
    report = Runner(device, tmp_path, on_event=broken_ui).run(scenario(tap()))
    assert report["status"] == "unchecked" and len(device.commands) == 1


def test_condition_timeout_budget_excludes_paused_time(tmp_path):
    device = Device()
    first_poll, paused = threading.Event(), threading.Event()
    polls = []
    runner = None

    def has_element(target):
        polls.append(time.monotonic())
        if len(polls) == 1:
            runner.pause()
            first_poll.set()
        return len(polls) >= 3

    device.has_element = has_element
    runner = Runner(device, tmp_path, on_event=lambda event: paused.set() if event.get("state") == "paused" else None)
    wait = assertion()
    wait.update(type="wait_element", timeout_ms=120, poll_interval_ms=10)
    output = {}
    thread = threading.Thread(target=lambda: output.update(runner.run(scenario(wait))))
    thread.start()
    try:
        assert first_poll.wait(2) and paused.wait(2)
        time.sleep(.15)
        runner.resume()
        thread.join(2)
        assert not thread.is_alive() and output["status"] == "passed"
        assert len(polls) == 3
    finally:
        runner.stop()
        thread.join(2)


@pytest.mark.parametrize("connected_bundle", [None, "com.example.other"])
def test_app_bundle_preflight_blocks_all_device_operations(tmp_path, connected_bundle):
    device = Device()
    device.metadata = lambda: {"simulated": True, "bundle_id": connected_bundle}
    geometry_calls = []
    original_geometry = device.geometry
    device.geometry = lambda: geometry_calls.append(True) or original_geometry()
    value = scenario(tap(), setup=[{"type": "activate_app"}])
    value["app_bundle_id"] = "com.apple.mobileslideshow"
    report = Runner(device, tmp_path).run(value)
    assert report["status"] == "error"
    assert "기록한 앱과 현재 연결된 앱이 다릅니다" in report["error"]
    assert "com.apple.mobileslideshow" in report["error"]
    assert not device.commands and not geometry_calls and device.captures == 0
    assert report["results"] == []
    assert Path(report["json_path"]).is_file()


def test_app_bundle_preflight_accepts_matching_session_and_legacy_scenario(tmp_path):
    device = Device()
    device.metadata = lambda: {"simulated": True, "bundle_id": "com.apple.mobileslideshow"}
    value = scenario(tap())
    value["app_bundle_id"] = "com.apple.mobileslideshow"
    assert Runner(device, tmp_path).run(value)["status"] == "unchecked"
    assert len(device.commands) == 1
    del value["app_bundle_id"]
    device.metadata = lambda: {"simulated": True}
    assert Runner(device, tmp_path).run(value)["status"] == "unchecked"
    assert len(device.commands) == 2


def test_startup_stop_is_not_cleared_before_metadata_or_geometry(tmp_path):
    device = Device()
    calls = []
    device.metadata = lambda: calls.append("metadata") or {"simulated": True}
    device.geometry = lambda: calls.append("geometry") or device.info
    runner = Runner(device, tmp_path)
    runner.stop()
    report = runner.run(scenario(tap()))
    assert report["status"] == "stopped"
    assert calls == [] and device.commands == [] and device.captures == 0
    assert Path(report["html_path"]).is_file()
