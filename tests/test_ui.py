"""Offline UI integration checks. These do not validate a real iPhone."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtCore import QPoint, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QFileDialog, QMessageBox

from mac_gyver.ui.main_window import MainWindow
from mac_gyver.ui.step_editor import StepDialog


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if predicate():
            return
        # Release the GIL so Python work in QThread can make progress as it does
        # under QApplication.exec(); repeatedly entering Qt alone can starve it.
        time.sleep(.005)
    raise AssertionError("Timed out while waiting for the UI task to finish")


@pytest.fixture(scope="module")
def qapp():
    app = QApplication.instance() or QApplication([])
    app.setQuitOnLastWindowClosed(False)
    return app


@pytest.fixture
def window(qapp, monkeypatch, tmp_path):
    monkeypatch.setenv("MAC_GYVER_DATA_DIR", str(tmp_path / "app-data"))
    warnings = []
    monkeypatch.setattr(QMessageBox, "warning", lambda parent, title, message, *args: warnings.append(message))
    widget = MainWindow()
    widget._test_warnings = warnings
    widget.show()
    qapp.processEvents()
    widget.demo_button.click()
    wait_for(lambda: not widget.busy)
    assert widget.device is not None
    assert widget.device.metadata()["simulated"] is True
    widget.after_ms.setValue(0)
    widget.capture_wait.setChecked(False)
    yield widget
    widget.stop_run()
    wait_for(lambda: not widget.busy)
    widget.dirty = False
    if widget.device is not None:
        widget.disconnect_device()
        wait_for(lambda: not widget.busy)
    widget.close()
    qapp.processEvents()


def point(preview, x, y):
    left, top, width, height = preview.image_rect()
    return QPoint(round(left + x * width), round(top + y * height))


def gesture(window, kind, start, end=None):
    window.tool.setCurrentIndex(window.tool.findData(kind))
    preview = window.preview
    QTest.mousePress(preview, Qt.LeftButton, pos=point(preview, *start))
    if end is not None:
        QTest.mouseMove(preview, point(preview, *end))
    QTest.mouseRelease(preview, Qt.LeftButton, pos=point(preview, *(end or start)))


def test_record_save_reopen_and_replay_through_ui(window, monkeypatch, tmp_path):
    """Mouse gestures and portable guard images survive a full editor round trip."""
    window.record_button.click()
    wait_for(lambda: not window.busy)
    assert window.recording
    assert window.scenario["precondition"]["type"] == "assert_image"

    gesture(window, "tap", (.18, .32))
    wait_for(lambda: not window.busy)
    assert window.device.view == "photo" and window.device.index == 0
    gesture(window, "swipe", (.8, .5), (.2, .5))
    wait_for(lambda: not window.busy)
    assert window.device.index == 1
    window.record_button.click()

    scenario = json.loads(window.json_editor.toPlainText())
    assert [step["type"] for step in scenario["steps"]] == ["tap", "swipe"]
    assert scenario["steps"][0]["target"]["x"] == pytest.approx(.18, abs=.01)
    assert scenario["steps"][1]["from"]["x"] > scenario["steps"][1]["to"]["x"]
    scenario["steps"].append({"type": "assert_element", "name": "Second photo is visible",
                              "target": {"mode": "element", "by": "accessibility_id",
                                         "value": "current-photo-1"}, "state": "visible"})
    window.json_editor.setPlainText(json.dumps(scenario))
    window.json_apply_button.click()

    destination = tmp_path / "portable scenario" / "round trip.json"
    monkeypatch.setattr(QFileDialog, "getSaveFileName", lambda *a, **k: (str(destination), "JSON"))
    assert window.save_file()
    saved = json.loads(destination.read_text())
    assert not Path(saved["precondition"]["baseline"]).is_absolute()
    assert (destination.parent / saved["precondition"]["baseline"]).is_file()

    window.new_file()
    assert window.scenario["steps"] == []
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: (str(destination), "JSON"))
    window.open_file()
    assert len(window.scenario["steps"]) == 3
    assert window.asset_root == destination.parent

    # Return to the recorded start screen as the real-device workflow requires.
    gesture(window, "tap", (.12, .095))
    wait_for(lambda: not window.busy)
    assert window.device.view == "gallery"
    assert len(window.scenario["steps"]) == 3  # Unrecorded preparation stays unrecorded.
    window.run_button.click()
    wait_for(lambda: not window.busy)
    report = window.latest_report
    assert report["status"] == "passed"
    assert report["simulated"] is True
    assert window.device.view == "photo" and window.device.index == 1
    assert Path(report["json_path"]).is_file()
    assert "실제 아이폰 검증 결과가 아닙니다" in Path(report["html_path"]).read_text()
    assert not window._test_warnings


def test_preview_ignores_letterbox_and_serializes_inflight_commands(window, monkeypatch):
    """A second user input cannot overtake the device command already in flight."""
    window.record_button.click()
    wait_for(lambda: not window.busy)
    QTest.mouseClick(window.preview, Qt.LeftButton, pos=QPoint(1, 1))
    QApplication.processEvents()
    assert not window.busy
    assert window.scenario["steps"] == []

    started, release = threading.Event(), threading.Event()
    calls = []
    original = window.device.perform

    def blocked(step):
        calls.append(step)
        started.set()
        if not release.wait(5):
            raise RuntimeError("Test did not release its device command")
        return original(step)

    monkeypatch.setattr(window.device, "perform", blocked)
    try:
        gesture(window, "tap", (.18, .32))
        wait_for(started.is_set)
        assert window.busy
        assert not window.preview.input_enabled
        assert not window.run_button.isEnabled()
        assert not window.refresh_button.isEnabled()
        QTest.mouseClick(window.preview, Qt.LeftButton, pos=point(window.preview, .5, .32))
        window.refresh_button.click()
        QApplication.processEvents()
        assert len(calls) == 1
        assert len(window.scenario["steps"]) == 1
    finally:
        release.set()
    wait_for(lambda: not window.busy)
    assert window.device.index == 0
    assert window.preview.input_enabled
    assert not window._test_warnings


def test_stop_during_wait_prevents_later_touch_and_preserves_report(window):
    scenario = json.loads(window.json_editor.toPlainText() or json.dumps(window.scenario))
    scenario["steps"] = [{"type": "wait", "duration_ms": 30000},
                         {"type": "tap", "target": {"mode": "normalized", "x": .18, "y": .32}}]
    window.json_editor.setPlainText(json.dumps(scenario))
    window.json_apply_button.click()
    window.run_button.click()
    wait_for(lambda: "step_start:" in window.log.toPlainText())
    assert window.pause_button.isEnabled()
    window.pause_button.click()
    assert window.paused
    started = time.monotonic()
    window.stop_button.click()
    wait_for(lambda: not window.busy)
    assert time.monotonic() - started < 2
    assert window.latest_report["status"] == "stopped"
    assert window.device.view == "gallery"
    assert not any(result["type"] == "tap" for result in window.latest_report["results"])
    assert Path(window.latest_report["json_path"]).is_file()
    assert window.run_button.isEnabled()


def test_recorded_device_failure_is_retained_without_retry(window, monkeypatch):
    window.record_button.click()
    wait_for(lambda: not window.busy)
    calls = []

    def fail(step):
        calls.append(step)
        raise RuntimeError("Synthetic touch failure")

    monkeypatch.setattr(window.device, "perform", fail)
    gesture(window, "tap", (.18, .32))
    wait_for(lambda: not window.busy)
    assert len(calls) == 1
    assert len(window.scenario["steps"]) == 1
    assert window.scenario["steps"][0]["type"] == "tap"
    assert "Synthetic touch failure" in window.scenario["steps"][0]["recording_error"]
    assert "Synthetic touch failure" in window.tree.topLevelItem(1).child(0).toolTip(0)
    assert not window.recording
    assert "Synthetic touch failure" in window.log.toPlainText()
    assert any("Synthetic touch failure" in warning for warning in window._test_warnings)


@pytest.mark.parametrize("settings", [
    {"type": "pinch", "scale": 20, "velocity": 100},
    {"type": "rotate", "angle_degrees": 720, "velocity_degrees": 1440},
])
def test_editing_imported_valid_gesture_does_not_silently_clamp_values(qapp, tmp_path, settings):
    step = {**settings, "target": {"mode": "normalized", "x": .5, "y": .5}}
    dialog = StepDialog(step, tmp_path)
    dialog.save()
    assert dialog.result_step is not None
    for key, value in settings.items():
        assert dialog.result_step[key] == value
    dialog.close()
