from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import threading
import time
import uuid

from PySide6.QtCore import Qt, QThread, Signal, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QDesktopServices
from PySide6.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QLabel, QPushButton, QComboBox, QLineEdit, QSpinBox, QDoubleSpinBox, QCheckBox,
    QSplitter, QTreeWidget, QTreeWidgetItem, QPlainTextEdit, QTabWidget, QGroupBox,
    QDialog, QDialogButtonBox, QMessageBox, QFileDialog, QInputDialog, QAbstractItemView,
    QScrollArea, QSizePolicy)

from .. import __version__
from ..coordinates import selection_region
from ..models import new_scenario, load_scenario, validate_scenario, validate_step
from ..recording import RecordingClock, application_dir, workspace, save_project
from .preview import PhonePreview
from .step_editor import StepDialog, LABELS, default_step, describe_step


class Task(QThread):
    succeeded = Signal(object)
    failed = Signal(str)
    progress = Signal(dict)

    def __init__(self, function, parent):
        super().__init__(parent)
        self.function = function

    def run(self):
        try:
            self.succeeded.emit(self.function())
        except Exception as exc:
            self.failed.emit(f"{type(exc).__name__}: {exc}")


class ConfigDialog(QDialog):
    def __init__(self, config, devices, parent):
        super().__init__(parent)
        self.setWindowTitle("아이폰 연결 설정")
        self.resize(540, 430)
        self.config = dict(config)
        layout = QVBoxLayout(self)
        note = QLabel("Appium 서버를 시작하고 아이폰의 개발자 모드·컴퓨터 신뢰를 확인하세요.\nWDA 최초 설치에는 Apple 개발 서명이 필요합니다.")
        note.setWordWrap(True)
        layout.addWidget(note)
        form = QFormLayout()
        layout.addLayout(form)
        self.udid = QComboBox()
        self.udid.setEditable(True)
        for device in devices:
            self.udid.addItem(device["udid"])
        self.udid.setCurrentText(config.get("udid", ""))
        form.addRow("아이폰 UDID", self.udid)
        self.fields = {}
        for key, title, default in (("server_url", "Appium 서버", "http://127.0.0.1:4723"),
                                    ("platform_version", "iOS 버전 (선택)", ""),
                                    ("bundle_id", "대상 앱 Bundle ID", "com.apple.mobileslideshow"),
                                    ("team_id", "Apple Team ID", ""),
                                    ("wda_bundle_id", "WDA Bundle ID", "")):
            field = QLineEdit(config.get(key, default))
            self.fields[key] = field
            form.addRow(title, field)
        self.preinstalled = QCheckBox("이미 설치된 WDA 사용")
        self.preinstalled.setChecked(config.get("use_preinstalled_wda", False))
        form.addRow(self.preinstalled)
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Save).setText("설정 저장")
        buttons.accepted.connect(self.save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def save(self):
        from ..device import validate_server_url
        try:
            validate_server_url(self.fields["server_url"].text().strip())
        except ValueError as exc:
            QMessageBox.warning(self, "주소 확인", str(exc))
            return
        self.config.update({key: field.text().strip() for key, field in self.fields.items()})
        self.config["udid"] = self.udid.currentText().strip()
        self.config["use_preinstalled_wda"] = self.preinstalled.isChecked()
        self.accept()


class MainWindow(QMainWindow):
    def __init__(self, config=None, demo=False):
        super().__init__()
        self.setWindowTitle(f"mac-gyver · iPhone Gesture Studio {__version__}")
        self.resize(1320, 900)
        self.setMinimumSize(1000, 720)
        self.config_path = application_dir() / "config.json"
        self.config = {"server_url": "http://127.0.0.1:4723", "bundle_id": "com.apple.mobileslideshow"}
        try:
            if self.config_path.is_file():
                saved_config = json.loads(self.config_path.read_text(encoding="utf-8"))
                if isinstance(saved_config, dict):
                    self.config.update(saved_config)
        except (ValueError, OSError):
            pass
        self.config.update(config or {})
        self.device = None
        self.devices = []
        self.current_png = None
        self.geometry = None
        self.scenario = new_scenario()
        self.asset_root = workspace()
        self.scenario_path = None
        self.dirty = False
        self.busy = False
        self.recording = False
        self.runner = None
        self.paused = False
        self.task = None
        self.callback = None
        self.close_after_task = False
        self.clock = RecordingClock()
        self.wait_before = 0
        self.record_cancel = threading.Event()
        self.selected_target = None
        self.elements = []
        self.latest_report = None
        self.active_record_path = None
        self.running_selection = None
        self._build()
        self._style()
        self.render_tree()
        self.update_controls()
        if demo:
            QTimer.singleShot(0, lambda: self.connect_device(True))

    def button(self, text, callback, layout, object_name=None):
        button = QPushButton(text)
        if object_name:
            button.setObjectName(object_name)
        button.clicked.connect(callback)
        layout.addWidget(button)
        return button

    def _build(self):
        central = QWidget()
        self.setCentralWidget(central)
        outer = QVBoxLayout(central)
        outer.setContentsMargins(20, 16, 20, 14)
        header = QHBoxLayout()
        brand = QLabel("mac-gyver")
        brand.setObjectName("brand")
        header.addWidget(brand)
        header.addWidget(QLabel("iPhone Gesture Studio"))
        header.addStretch()
        self.connection_label = QLabel("연결 안 됨")
        self.connection_label.setObjectName("badge")
        header.addWidget(self.connection_label)
        outer.addLayout(header)
        bar = QHBoxLayout()
        self.scan_button = self.button("기기 검색 / 진단", self.diagnose, bar)
        self.config_button = self.button("연결 설정", self.configure, bar)
        self.connect_button = self.button("아이폰 연결", lambda: self.connect_device(False), bar)
        self.demo_button = self.button("데모 기기", lambda: self.connect_device(True), bar)
        self.disconnect_button = self.button("연결 해제", self.disconnect_device, bar)
        bar.addStretch()
        self.refresh_button = self.button("화면 새로고침", self.refresh, bar)
        self.inspect_button = self.button("요소 읽기", self.inspect, bar)
        outer.addLayout(bar)
        self.title = QLineEdit(self.scenario["name"])
        self.title.setPlaceholderText("시나리오 이름")
        self.title.editingFinished.connect(self.rename)
        outer.addWidget(self.title)
        splitter = QSplitter(Qt.Horizontal)
        outer.addWidget(splitter, 1)
        left = QWidget()
        layout = QVBoxLayout(left)
        layout.setContentsMargins(0, 0, 8, 0)
        layout.addWidget(QLabel("01   테스트 단계"))
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["동작", "설정"])
        self.tree.setColumnWidth(0, 140)
        self.tree.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.tree.itemSelectionChanged.connect(self.show_properties)
        self.tree.itemDoubleClicked.connect(lambda *_: self.edit_step())
        layout.addWidget(self.tree, 1)
        edits = QHBoxLayout()
        self.add_button = self.button("+ 단계", self.add_step, edits)
        self.edit_button = self.button("수정", self.edit_step, edits)
        self.copy_button = self.button("복제", self.copy_step, edits)
        self.delete_button = self.button("삭제", self.delete_steps, edits)
        layout.addLayout(edits)
        order = QHBoxLayout()
        self.up_button = self.button("↑", lambda: self.move_step(-1), order)
        self.down_button = self.button("↓", lambda: self.move_step(1), order)
        self.repeat_button = self.button("반복으로 묶기", self.group_repeat, order)
        self.ungroup_button = self.button("반복 풀기", self.ungroup, order)
        layout.addLayout(order)
        self.delay_button = QPushButton("선택 단계의 후 대기 일괄 변경")
        self.delay_button.clicked.connect(self.bulk_delay)
        layout.addWidget(self.delay_button)
        splitter.addWidget(left)
        middle = QWidget()
        layout = QVBoxLayout(middle)
        layout.setContentsMargins(2, 0, 2, 0)
        layout.addWidget(QLabel("02   아이폰 화면 · 맥에서 입력한 동작 기록"))
        self.preview = PhonePreview()
        self.preview.gesture.connect(self.on_gesture)
        self.preview.input_started.connect(self.input_started)
        self.preview.entered.connect(self.clock_resume)
        self.preview.left.connect(self.clock.pause)
        layout.addWidget(self.preview, 1)
        self.preview_note = QLabel("연결 후 도구를 선택하세요. 드래그는 마우스를 놓을 때 전송됩니다.")
        self.preview_note.setWordWrap(True)
        self.preview_note.setMinimumHeight(48)
        self.preview_note.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Minimum)
        layout.addWidget(self.preview_note)
        splitter.addWidget(middle)
        right = QWidget()
        right.setObjectName("inputPanel")
        layout = QVBoxLayout(right)
        layout.setContentsMargins(8, 0, 0, 0)
        layout.addWidget(QLabel("03   동작 입력"))
        form = QFormLayout()
        self.gesture_form = form
        self.tool = QComboBox()
        for kind in ("tap", "double_tap", "long_press", "swipe", "drag", "pinch", "rotate", "assert_image"):
            self.tool.addItem(LABELS[kind], kind)
        self.tool.currentIndexChanged.connect(self.tool_changed)
        form.addRow("입력 도구", self.tool)
        self.press_ms = QSpinBox(); self.press_ms.setRange(0, 60000); self.press_ms.setValue(1500)
        self.move_ms = QSpinBox(); self.move_ms.setRange(1, 60000); self.move_ms.setValue(300)
        self.hold_ms = QSpinBox(); self.hold_ms.setRange(0, 60000); self.hold_ms.setValue(100)
        self.after_ms = QSpinBox(); self.after_ms.setRange(0, 3_600_000); self.after_ms.setValue(500)
        self.scale = QDoubleSpinBox(); self.scale.setRange(.1, 20); self.scale.setValue(2); self.scale.setSingleStep(.1)
        self.speed = QDoubleSpinBox(); self.speed.setRange(.01, 100); self.speed.setValue(1)
        self.angle = QDoubleSpinBox(); self.angle.setRange(-720, 720); self.angle.setValue(45)
        self.rotation_speed = QDoubleSpinBox(); self.rotation_speed.setRange(.1, 1440); self.rotation_speed.setValue(45)
        for text, field in (("누름 (ms)", self.press_ms), ("이동 (ms)", self.move_ms), ("끝점 유지 (ms)", self.hold_ms),
                            ("후 대기 (ms)", self.after_ms), ("확대/축소 배율", self.scale), ("배율 / 초", self.speed),
                            ("회전 (°)", self.angle), ("회전 속도 (°/초)", self.rotation_speed)):
            form.addRow(text, field)
            field.valueChanged.connect(self.reset_idle_clock)
        layout.addLayout(form)
        self.use_drag_time = QCheckBox("마우스 이동 시간을 자동으로 기록")
        self.use_drag_time.setChecked(True)
        layout.addWidget(self.use_drag_time)
        self.capture_wait = QCheckBox("동작 사이 대기도 기록")
        self.capture_wait.setToolTip("미리보기 위에서 입력을 기다린 시간만 기록합니다. 도구 편집과 기기 응답 대기는 제외됩니다.")
        layout.addWidget(self.capture_wait)
        self.guard = QCheckBox("기록 시작 화면을 재생 전 검사")
        self.guard.setChecked(True)
        layout.addWidget(self.guard)
        self.destination = QComboBox()
        self.destination.addItem("테스트 단계에 기록", "steps")
        self.destination.addItem("준비 단계에 기록", "setup")
        layout.addWidget(self.destination)
        self.record_button = QPushButton("● 기록 시작")
        self.record_button.setObjectName("record")
        self.record_button.clicked.connect(self.toggle_recording)
        layout.addWidget(self.record_button)
        self.target_label = QLabel("대상: 화면 좌표")
        self.target_label.setWordWrap(True)
        layout.addWidget(self.target_label)
        self.clear_target_button = QPushButton("선택한 요소 해제")
        self.clear_target_button.clicked.connect(self.clear_target)
        layout.addWidget(self.clear_target_button)
        self.properties = QPlainTextEdit()
        self.properties.setReadOnly(True)
        self.properties.setMaximumHeight(140)
        self.properties.setPlaceholderText("목록의 단계를 선택하면 설정이 표시됩니다.\n더블클릭해서 수정할 수 있어요.")
        layout.addWidget(self.properties)
        layout.addStretch()
        right_scroll = QScrollArea()
        right_scroll.setWidgetResizable(True)
        right_scroll.setMinimumWidth(290)
        right_scroll.setWidget(right)
        splitter.addWidget(right_scroll)
        splitter.setSizes([380, 540, 320])
        self.tabs = QTabWidget()
        self.tabs.setMaximumHeight(155)
        self.log = QPlainTextEdit(); self.log.setReadOnly(True)
        self.log.document().setMaximumBlockCount(2000)
        self.tabs.addTab(self.log, "실행 로그")
        self.element_tree = QTreeWidget()
        self.element_tree.setHeaderLabels(["요소", "종류", "식별자"])
        self.element_tree.itemSelectionChanged.connect(self.select_element)
        self.tabs.addTab(self.element_tree, "UI 요소")
        json_page = QWidget(); json_layout = QHBoxLayout(json_page)
        self.json_editor = QPlainTextEdit()
        json_layout.addWidget(self.json_editor, 1)
        json_buttons = QVBoxLayout()
        self.json_apply_button = self.button("JSON 적용", self.apply_json, json_buttons)
        self.json_refresh_button = self.button("현재 내용 읽기", self.refresh_json, json_buttons)
        json_buttons.addStretch(); json_layout.addLayout(json_buttons)
        self.tabs.addTab(json_page, "JSON 편집")
        outer.addWidget(self.tabs)
        footer = QHBoxLayout()
        self.run_setup = QCheckBox("준비 단계 포함"); self.run_setup.setChecked(True)
        footer.addWidget(self.run_setup)
        footer.addWidget(QLabel("전체 반복"))
        self.cycles = QSpinBox(); self.cycles.setRange(1, 10000); self.cycles.setValue(1)
        footer.addWidget(self.cycles)
        self.one_button = self.button("선택 단계 실행", self.run_selected, footer)
        self.run_button = self.button("▶ 전체 실행", self.run_all, footer, "primary")
        self.pause_button = self.button("일시정지", self.pause_run, footer)
        self.stop_button = self.button("■ 중단", self.stop_run, footer)
        footer.addStretch()
        self.report_button = self.button("결과 보고서", self.open_report, footer)
        outer.addLayout(footer)
        file_menu = self.menuBar().addMenu("파일")
        self.file_actions = []
        for text, shortcut, fn in (("새 시나리오", "Ctrl+N", self.new_file), ("열기…", "Ctrl+O", self.open_file),
                                   ("저장", "Ctrl+S", self.save_file), ("다른 이름으로 저장…", "Ctrl+Shift+S", lambda: self.save_file(True))):
            action = QAction(text, self)
            action.setShortcut(shortcut); action.triggered.connect(fn)
            file_menu.addAction(action); self.file_actions.append(action)
        help_menu = self.menuBar().addMenu("도움말")
        for title, url in (("맥 설치 안내", "https://github.com/Lonnie-Noel/mac-gyver/blob/main/docs/SETUP_MAC.md"),
                           ("GitHub 저장소", "https://github.com/Lonnie-Noel/mac-gyver")):
            action = QAction(title, self)
            action.triggered.connect(lambda checked=False, url=url: QDesktopServices.openUrl(QUrl(url)))
            help_menu.addAction(action)
        self.statusBar().showMessage("시나리오를 만들거나 데모 기기로 시작하세요.")
        self.tool_changed()

    def _style(self):
        self.setStyleSheet("""
            QMainWindow, QDialog { background: #111a2b; color: #e3eaf5; }
            QWidget { font-family: 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif; font-size: 12px; color: #e3eaf5; }
            QLabel#brand { font-size: 26px; font-weight: 700; color: #72dfce; }
            QLabel#badge { background: #243248; border-radius: 10px; padding: 7px 14px; }
            QPushButton { background: #26344c; border: 1px solid #39485e; border-radius: 6px; padding: 7px 10px; }
            QPushButton:hover { background: #334764; }
            QPushButton:disabled { color: #637089; background: #192335; border-color: #243146; }
            QPushButton#primary { background: #236f65; border-color: #3ba995; font-weight: 600; }
            QPushButton#record { background: #713e50; border-color: #ae667f; }
            QLineEdit, QPlainTextEdit, QTreeWidget, QSpinBox, QDoubleSpinBox, QComboBox {
              background: #172337; color: #e3eaf5; border: 1px solid #33435a; border-radius: 4px; padding: 5px;
              selection-background-color: #365d73; }
            QTreeWidget::item { padding: 5px 0; }
            QTreeWidget::item:selected { background: #31546a; }
            QHeaderView::section { background: #223049; border: none; padding: 6px; color: #9bb1cb; }
            QTabWidget::pane { border: 1px solid #33435a; }
            QTabBar::tab { background: #172337; padding: 6px 14px; }
            QTabBar::tab:selected { background: #2d425b; }
            QMenuBar, QMenu, QStatusBar { background: #111a2b; }
            QMenu::item:selected { background: #31546a; }
            QSplitter::handle { background: #223047; }
            QScrollArea { border: none; background: #111a2b; }
            QWidget#inputPanel { background: #111a2b; }
        """)

    def message(self, text):
        self.log.appendPlainText(time.strftime("%H:%M:%S") + "  " + str(text))
        self.statusBar().showMessage(str(text), 15000)

    def submit(self, function, callback, label):
        if self.busy:
            return False
        self.busy = True
        self.clock.pause()
        self.callback = callback
        self.task = Task(function, self)
        self.task.succeeded.connect(self.task_succeeded)
        self.task.failed.connect(self.task_failed)
        self.task.progress.connect(self.run_event)
        self.task.finished.connect(self.task_finished)
        self.update_controls()
        self.message(label)
        self.task.start()
        return True

    def task_succeeded(self, result):
        try:
            if self.callback:
                self.callback(result)
        except Exception as exc:
            self.task_failed(f"{type(exc).__name__}: {exc}")

    def task_failed(self, error):
        if self.active_record_path is not None:
            self.at(self.active_record_path)["recording_error"] = str(error)
            self.mark_changed()
        self.recording = False
        self.clock.reset()
        self.message(error)
        if not self.close_after_task:
            QMessageBox.warning(self, "작업을 완료하지 못했습니다", error + "\n\n기기 상태를 확인한 뒤 다시 실행해 주세요. 실패한 제스처는 자동 재시도하지 않습니다.")

    def task_finished(self):
        self.active_record_path = None
        task, self.task = self.task, None
        self.callback = None
        self.busy = False
        self.runner = None
        self.paused = False
        if task:
            task.deleteLater()
        self.update_controls()
        self.clock_resume()
        if self.close_after_task:
            QTimer.singleShot(0, self.close)

    def update_controls(self):
        idle = not self.busy
        editing = idle and not self.recording
        connected = self.device is not None
        for widget in (self.scan_button, self.config_button, self.connect_button, self.demo_button):
            widget.setEnabled(editing and not connected if widget in (self.connect_button,self.demo_button) else editing)
        self.disconnect_button.setEnabled(editing and connected)
        for widget in (self.refresh_button, self.inspect_button):
            widget.setEnabled(idle and connected)
        for widget in (self.add_button, self.edit_button, self.copy_button, self.delete_button, self.up_button,
                       self.down_button, self.repeat_button, self.ungroup_button, self.delay_button,
                       self.json_apply_button, self.json_refresh_button, self.title, self.run_setup, self.cycles):
            widget.setEnabled(editing)
        for action in self.file_actions:
            action.setEnabled(editing)
        self.json_editor.setReadOnly(not editing)
        self.record_button.setEnabled(connected and (idle or self.recording))
        self.record_button.setText("■ 기록 종료" if self.recording else "● 기록 시작")
        self.run_button.setEnabled(editing and connected and bool(self.scenario.get("steps") or self.scenario.get("setup")))
        self.one_button.setEnabled(editing and connected and bool(self.selected_paths()))
        self.pause_button.setEnabled(self.runner is not None)
        self.pause_button.setText("재개" if self.paused else "일시정지")
        self.stop_button.setEnabled(self.runner is not None or self.recording)
        self.report_button.setEnabled(self.latest_report is not None)
        self.guard.setEnabled(editing)
        self.tree.setEnabled(not self.busy)
        self.element_tree.setEnabled(not self.busy)
        self.destination.setEnabled(idle)
        for widget in (self.tool, self.press_ms, self.move_ms, self.hold_ms, self.after_ms, self.scale,
                       self.speed, self.angle, self.rotation_speed, self.use_drag_time, self.capture_wait):
            widget.setEnabled(idle)
        self.clear_target_button.setEnabled(idle)
        self.preview.set_input_enabled(connected and idle)

    def snapshot(self):
        return {"png": self.device.screenshot(), "geometry": self.device.geometry()}

    def display_snapshot(self, snapshot):
        self.current_png = snapshot["png"]
        self.geometry = snapshot["geometry"]
        self.preview.set_image(self.current_png)
        self.elements = []
        self.element_tree.clear()
        self.clear_target()
        self.preview_note.setText(f"{self.geometry['width']} × {self.geometry['height']} · {self.geometry['orientation']}\n화면 갱신 {time.strftime('%H:%M:%S')} · 입력은 작업 종료 후 가능합니다.")

    def configure(self):
        dialog = ConfigDialog(self.config, self.devices, self)
        if dialog.exec():
            self.config = dialog.config
            self.config_path.write_text(json.dumps(self.config, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
            self.message("연결 설정을 저장했습니다. 변경한 설정은 다음 연결부터 적용됩니다.")

    def diagnose(self):
        from ..diagnostics import run_diagnostics, discover_devices
        def work():
            return {"diagnostics": run_diagnostics(self.config["server_url"]), "devices": discover_devices()}
        def done(result):
            self.devices = result["devices"]
            for row in result["diagnostics"]:
                self.message(f"[{row['status']}] {row['name']}: {row['message']}")
            for device in self.devices:
                self.message(f"기기: {device['name']} · {device['udid']}")
            if len(self.devices) == 1:
                self.config.update({key:self.devices[0].get(key, "") for key in ("udid", "platform_version")})
            self.tabs.setCurrentIndex(0)
        self.submit(work, done, "개발 환경과 연결 가능한 기기를 확인합니다…")

    def connect_device(self, demo):
        if self.busy or self.device:
            return
        if not demo and not self.config.get("udid"):
            self.configure()
            if not self.config.get("udid"):
                self.message("기기 검색 또는 연결 설정에서 아이폰 UDID를 지정해 주세요.")
                return
        from ..device import AppiumDevice
        from ..mock_device import MockDevice
        def connect():
            device = MockDevice() if demo else AppiumDevice(dict(self.config))
            try:
                info = device.connect()
                return {"device":device, "info":info, "png":device.screenshot(), "geometry":device.geometry()}
            except Exception:
                device.close()
                raise
        def done(result):
            self.device = result["device"]
            self.display_snapshot(result)
            self.connection_label.setText("모의 기기 · 실제 iPhone 아님" if demo else "실제 iPhone 연결됨")
            self.message("모의 기기를 연결했습니다. 결과는 실기기 검증과 구분됩니다." if demo else "아이폰에 연결했습니다.")
        self.submit(connect, done, "모의 기기 연결 중…" if demo else "아이폰과 WDA에 연결 중… 최초 연결은 시간이 걸릴 수 있습니다.")

    def disconnect_device(self):
        if not self.device or self.busy:
            return
        device = self.device
        def done(_):
            self.device = None
            self.current_png = None
            self.connection_label.setText("연결 안 됨")
            self.message("기기 연결을 종료했습니다.")
        self.submit(device.close, done, "연결 종료 중…")

    def refresh(self):
        if self.device:
            self.submit(self.snapshot, self.display_snapshot, "아이폰 화면을 갱신합니다…")

    def inspect(self):
        if not self.device:
            return
        def done(elements):
            self.elements = elements
            self.element_tree.clear()
            for element in elements:
                item = QTreeWidgetItem([element.get("label", ""), element.get("type", ""), element["target"].get("value", "")])
                item.setData(0, Qt.UserRole, element)
                self.element_tree.addTopLevelItem(item)
            self.tabs.setCurrentIndex(1)
            self.message(f"{len(elements)}개 요소를 읽었습니다. 사용할 요소를 선택하세요.")
        self.submit(self.device.inspect_elements, done, "화면의 UI 요소를 읽습니다…")

    def select_element(self):
        selected = self.element_tree.selectedItems()
        if not selected:
            return
        element = selected[0].data(0, Qt.UserRole)
        self.selected_target = copy.deepcopy(element["target"])
        self.target_label.setText("대상 요소: " + (element.get("label") or self.selected_target["value"]))
        if self.geometry and (rect := element.get("rect")):
            self.preview.highlight = {"x":rect["x"]/self.geometry["width"], "y":rect["y"]/self.geometry["height"],
                                      "width":rect["width"]/self.geometry["width"], "height":rect["height"]/self.geometry["height"]}
            self.preview.update()
        self.reset_idle_clock()

    def clear_target(self):
        self.selected_target = None
        self.target_label.setText("대상: 화면 좌표")
        self.preview.highlight = None
        self.preview.update()

    def tool_changed(self):
        kind = self.tool.currentData()
        self.preview.tool = kind
        visible = {self.press_ms: kind in ("long_press", "drag"),
                   self.move_ms: kind in ("swipe", "drag"),
                   self.hold_ms: kind == "drag", self.after_ms: kind != "assert_image",
                   self.scale: kind == "pinch", self.speed: kind == "pinch",
                   self.angle: kind == "rotate", self.rotation_speed: kind == "rotate"}
        for field, show in visible.items():
            self.gesture_form.setRowVisible(field, show)
        self.use_drag_time.setVisible(kind in ("swipe", "drag"))
        self.reset_idle_clock()

    def reset_idle_clock(self):
        self.clock.reset()
        self.clock_resume()

    def clock_resume(self):
        if self.recording and not self.busy and self.preview.underMouse():
            self.clock.resume()

    def input_started(self):
        self.wait_before = self.clock.take_ms() if self.recording else 0

    def baseline_step(self, region, name="화면 검사"):
        if not self.current_png:
            raise ValueError("먼저 화면을 갱신해 주세요.")
        relative = Path("baselines") / (uuid.uuid4().hex + ".png")
        path = self.asset_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.current_png)
        return {"type":"assert_image", "name":name, "baseline":relative.as_posix(),
                "region":region, "tolerance":.05, "expected":"match"}

    def toggle_recording(self):
        if self.recording:
            self.recording = False
            self.record_cancel.set()
            self.clock.reset()
            self.message("기록을 종료했습니다. 단계와 반복 구간을 편집할 수 있습니다.")
            self.update_controls()
            return
        if self.busy or not self.device:
            return
        if self.scenario.get("steps") or self.scenario.get("setup"):
            if self.scenario.get("geometry") and self.scenario["geometry"] != self.geometry:
                QMessageBox.warning(self, "화면 조건 확인", "시나리오와 연결된 기기의 화면 조건이 다릅니다. 새 시나리오를 만들어 주세요.")
                return
        def done(snapshot):
            self.display_snapshot(snapshot)
            first_recording = not self.scenario.get("geometry")
            if self.scenario.get("geometry") and self.scenario["geometry"] != self.geometry:
                raise ValueError("기록 전에 화면 방향이 바뀌었습니다. 원래 화면 방향으로 맞춰 주세요.")
            bundle_id = self.device.metadata()["bundle_id"]
            if self.scenario.get("app_bundle_id") not in (None, bundle_id):
                raise ValueError("시나리오의 대상 앱과 연결 설정이 다릅니다. 원래 앱으로 다시 연결하세요.")
            self.scenario["geometry"] = dict(self.geometry)
            self.scenario["device_profile"] = "recorded-device"
            self.scenario["app_bundle_id"] = bundle_id
            if self.guard.isChecked() and first_recording:
                self.scenario["precondition"] = self.baseline_step({"x":0.,"y":.1,"width":1.,"height":.8}, "기록 시작 화면")
            self.recording = True
            self.record_cancel.clear()
            self.clock.reset()
            self.mark_changed()
            self.message("기록 중입니다. 미리보기에서 입력한 동작이 실행되며 단계에 저장됩니다.")
        self.submit(self.snapshot, done, "기록 시작 화면을 준비합니다…")

    def on_gesture(self, gesture):
        if self.busy or not self.device:
            return
        kind = gesture["tool"]
        try:
            if kind == "assert_image":
                region = selection_region(gesture["from"], gesture["to"])
                self.clock.pause()
                dialog = StepDialog(self.baseline_step(region), self.asset_root, self)
                if dialog.exec():
                    self.append_step(dialog.result_step)
                self.reset_idle_clock()
                return
            step = default_step(kind)
            if "target" in step:
                step["target"] = copy.deepcopy(self.selected_target or {"mode":"normalized", **gesture["from"]})
            if kind in ("swipe", "drag"):
                step.update({"from":gesture["from"], "to":gesture["to"],
                             "move_duration_ms": min(60000, gesture["duration_ms"]) if self.use_drag_time.isChecked() else self.move_ms.value()})
            if kind in ("long_press", "drag"):
                step["press_duration_ms"] = self.press_ms.value()
            if kind == "drag":
                step["hold_duration_ms"] = self.hold_ms.value()
            if kind == "pinch":
                step.update(scale=self.scale.value(), velocity=self.speed.value())
            if kind == "rotate":
                step.update(angle_degrees=self.angle.value(), velocity_degrees=self.rotation_speed.value())
            step["after_delay_ms"] = self.after_ms.value()
            step["geometry"] = dict(self.geometry)
            step = validate_step(step)
            record_path = None
            if self.recording:
                if self.capture_wait.isChecked() and self.wait_before > 0:
                    self.append_step({"type":"wait", "name":"기록된 입력 대기", "duration_ms":min(3_600_000,self.wait_before)})
                record_path = self.append_step(step)
            self.active_record_path = record_path
            self.record_cancel.clear()
            def work():
                # Verify before a coordinate gesture even when not replaying a scenario.
                if self.device.geometry() != step["geometry"]:
                    raise ValueError("아이폰 화면 조건이 바뀌었습니다. 화면을 갱신한 뒤 다시 입력하세요.")
                self.device.perform(step)
                if self.record_cancel.wait(step.get("after_delay_ms",0)/1000):
                    return None
                return self.snapshot()
            def done(snapshot):
                if snapshot:
                    self.display_snapshot(snapshot)
                self.message("동작 입력 완료" + (" · 단계에 기록됨" if record_path else " · 기록하지 않은 수동 조작"))
            self.submit(work, done, describe_step(step)[0] + " 실행 중…")
        except (ValueError, TypeError) as exc:
            QMessageBox.warning(self, "동작 설정 확인", str(exc))
            self.reset_idle_clock()

    def selected_paths(self):
        return [tuple(item.data(0,Qt.UserRole)) for item in self.tree.selectedItems() if item.data(0,Qt.UserRole)]

    def at(self, path):
        value = self.scenario
        for part in path:
            value = value[part]
        return value

    def mark_changed(self):
        self.dirty = True
        self.render_tree()
        self.refresh_json()
        self.update_controls()

    def render_tree(self):
        selected = self.selected_paths() if hasattr(self,"tree") else []
        self.tree.clear()
        for section, label in (("setup","준비 단계 · 처음 한 번"), ("steps","테스트 단계")):
            root = QTreeWidgetItem([label, ""])
            root.setData(0,Qt.UserRole,(section,))
            self.tree.addTopLevelItem(root)
            for i, step in enumerate(self.scenario.get(section, [])):
                item = QTreeWidgetItem(list(describe_step(step)))
                self.decorate_record_error(item, step)
                path = (section,i)
                item.setData(0,Qt.UserRole,path)
                root.addChild(item)
                item.setSelected(path in selected)
                for j, child in enumerate(step.get("steps",[])) if step["type"]=="repeat" else []:
                    entry = QTreeWidgetItem(list(describe_step(child)))
                    self.decorate_record_error(entry, child)
                    child_path = (section,i,"steps",j)
                    entry.setData(0,Qt.UserRole,child_path)
                    item.addChild(entry)
                    entry.setSelected(child_path in selected)
            root.setExpanded(True)
        self.tree.expandAll()
        self.show_properties()

    @staticmethod
    def decorate_record_error(item, step):
        if step.get("recording_error"):
            item.setText(0, "⚠ " + item.text(0))
            item.setForeground(0, QColor("#ff9d9d"))
            item.setToolTip(0, "기록할 때 실행 실패: " + step["recording_error"])

    def append_step(self, step):
        section = self.destination.currentData()
        step = validate_step(step)
        self.scenario[section].append(copy.deepcopy(step))
        path = (section,len(self.scenario[section])-1)
        self.mark_changed()
        return path

    def show_properties(self):
        paths = self.selected_paths()
        if len(paths)==1:
            self.properties.setPlainText(json.dumps(self.at(paths[0]),ensure_ascii=False,indent=2))
        else:
            self.properties.setPlainText(f"{len(paths)}개 항목 선택" if paths else "")
        if hasattr(self,"one_button"):
            self.one_button.setEnabled(not self.busy and not self.recording and self.device is not None and any(len(p)>1 for p in paths))

    def add_step(self):
        step = default_step("tap")
        if self.selected_target:
            step["target"] = copy.deepcopy(self.selected_target)
        dialog = StepDialog(step,self.asset_root,self)
        if dialog.exec():
            self.append_step(dialog.result_step)

    def edit_step(self):
        paths = self.selected_paths()
        if self.busy or self.recording or len(paths)!=1 or len(paths[0])<2:
            return
        path = paths[0]
        dialog = StepDialog(self.at(path),self.asset_root,self)
        if dialog.exec():
            self.at(path[:-1])[path[-1]] = dialog.result_step
            self.mark_changed()

    def copy_step(self):
        paths = self.selected_paths()
        if len(paths)==1 and len(paths[0])>1:
            path = paths[0]
            self.at(path[:-1]).insert(path[-1]+1,copy.deepcopy(self.at(path)))
            self.mark_changed()

    def delete_steps(self):
        paths = [p for p in self.selected_paths() if len(p)>1]
        paths = [p for p in paths if not any(p[:len(q)]==q and p!=q for q in paths)]
        for path in sorted(paths,key=lambda p:tuple(str(x).zfill(8) if isinstance(x,int) else x for x in p),reverse=True):
            del self.at(path[:-1])[path[-1]]
        if paths:
            for section in ("setup", "steps"):
                self.scenario[section] = [step for step in self.scenario[section]
                                          if step["type"] != "repeat" or step.get("steps")]
            self.mark_changed()

    def move_step(self, offset):
        paths = self.selected_paths()
        if len(paths)!=1 or len(paths[0])<2:
            return
        path = paths[0]; parent = self.at(path[:-1]); old = path[-1]; new = old+offset
        if 0<=new<len(parent):
            parent[old],parent[new] = parent[new],parent[old]
            self.tree.clearSelection()
            self.mark_changed()

    def group_repeat(self):
        paths = self.selected_paths()
        if not paths or any(len(p)!=2 or p[0]!="steps" for p in paths):
            QMessageBox.information(self,"반복 구간","테스트 단계에서 연속된 동작들을 선택해 주세요.")
            return
        indices = sorted(p[1] for p in paths)
        if indices!=list(range(indices[0],indices[-1]+1)) or any(self.scenario["steps"][i]["type"]=="repeat" for i in indices):
            QMessageBox.information(self,"반복 구간","기존 반복 그룹을 포함하지 않는 연속된 동작만 묶을 수 있습니다.")
            return
        group = default_step("repeat")
        group["steps"] = copy.deepcopy(self.scenario["steps"][indices[0]:indices[-1]+1])
        dialog = StepDialog(group,self.asset_root,self)
        if dialog.exec():
            self.scenario["steps"][indices[0]:indices[-1]+1] = [dialog.result_step]
            self.mark_changed()

    def ungroup(self):
        paths = self.selected_paths()
        if len(paths)==1 and len(paths[0])==2:
            path=paths[0]; step=self.at(path)
            if step["type"]=="repeat":
                self.at(path[:-1])[path[-1]:path[-1]+1]=step["steps"]
                self.mark_changed()

    def bulk_delay(self):
        paths = [p for p in self.selected_paths() if len(p)>1]
        if not paths:
            return
        value, ok = QInputDialog.getInt(self,"후 대기 변경","선택 단계의 동작 후 대기 (ms)",500,0,3_600_000)
        if ok:
            for path in paths:
                self.at(path)["after_delay_ms"] = value
            self.mark_changed()

    def rename(self):
        if self.title.text().strip() and self.title.text().strip()!=self.scenario["name"]:
            self.scenario["name"] = self.title.text().strip()
            self.mark_changed()

    def refresh_json(self):
        self.json_editor.setPlainText(json.dumps(self.scenario,ensure_ascii=False,indent=2))

    def apply_json(self):
        try:
            data=validate_scenario(json.loads(self.json_editor.toPlainText()))
            self.scenario=data
            self.title.setText(data["name"])
            self.tree.clearSelection()
            self.mark_changed()
            self.message("JSON 시나리오를 적용했습니다.")
        except (ValueError,TypeError) as exc:
            QMessageBox.warning(self,"JSON 확인",str(exc))

    def confirm_discard(self):
        if not self.dirty:
            return True
        choice=QMessageBox.question(self,"변경 내용","변경한 시나리오를 저장할까요?",QMessageBox.Save|QMessageBox.Discard|QMessageBox.Cancel)
        if choice==QMessageBox.Cancel:
            return False
        return self.save_file() if choice==QMessageBox.Save else True

    def new_file(self):
        if not self.confirm_discard():
            return
        self.scenario=new_scenario(); self.scenario_path=None; self.asset_root=workspace(); self.dirty=False
        self.title.setText(self.scenario["name"])
        self.render_tree(); self.refresh_json(); self.update_controls()

    def open_file(self):
        if not self.confirm_discard():
            return
        path,_=QFileDialog.getOpenFileName(self,"시나리오 열기",str(application_dir()),"JSON (*.json)")
        if not path:
            return
        try:
            data=load_scenario(path)
            self.scenario=data; self.scenario_path=Path(path).resolve(); self.asset_root=self.scenario_path.parent
            self.dirty=False; self.title.setText(data["name"])
            self.tree.clearSelection(); self.render_tree(); self.refresh_json(); self.update_controls()
            self.message(f"시나리오를 열었습니다: {path}")
        except (ValueError,OSError) as exc:
            QMessageBox.warning(self,"열기 실패",str(exc))

    def save_file(self, save_as=False):
        self.rename()
        destination=self.scenario_path
        if save_as or destination is None:
            path,_=QFileDialog.getSaveFileName(self,"시나리오 저장",str(application_dir()/"scenario.json"),"JSON (*.json)")
            if not path:
                return False
            destination=Path(path if path.lower().endswith(".json") else path+".json")
        try:
            self.scenario=save_project(self.scenario,destination,self.asset_root)
            self.scenario_path=destination.resolve(); self.asset_root=self.scenario_path.parent
            self.dirty=False; self.refresh_json()
            self.message(f"시나리오와 기준 이미지를 저장했습니다: {destination}")
            return True
        except (ValueError,OSError) as exc:
            QMessageBox.warning(self,"저장 실패",str(exc))
            return False

    def run_selected(self):
        paths=[p for p in self.selected_paths() if len(p)>1]
        if len(paths)!=1:
            QMessageBox.information(self,"단계 실행","실행할 단계 또는 반복 그룹 하나를 선택해 주세요.")
            return
        data=copy.deepcopy(self.scenario)
        data.pop("precondition",None)
        data["setup"]=[]; data["steps"]=[copy.deepcopy(self.at(paths[0]))]
        self.start_run(data,False,1,selected_path=paths[0])

    def run_all(self):
        self.rename()
        self.start_run(self.scenario,self.run_setup.isChecked(),self.cycles.value())

    def start_run(self,data,setup,cycles,selected_path=None):
        if self.busy or self.recording or not self.device:
            return
        from ..engine import Runner
        try:
            scenario=validate_scenario(data)
        except ValueError as exc:
            QMessageBox.warning(self,"시나리오 확인",str(exc)); return
        self.running_selection = selected_path
        self.render_tree()
        self.runner=Runner(self.device,application_dir()/"reports",on_event=self._emit_run_event,asset_root=self.asset_root)
        runner=self.runner
        def work():
            report=runner.run(scenario,run_setup=setup,cycles=cycles)
            snapshot=None
            if report["status"] != "stopped":
                try:
                    snapshot=self.snapshot()
                except Exception:
                    pass
            return {"report":report,"snapshot":snapshot}
        def done(result):
            self.latest_report=result["report"]
            if result["snapshot"]:
                self.display_snapshot(result["snapshot"])
            self.message(f"실행 종료: {self.latest_report['status']} · 보고서가 저장됐습니다.")
            self.tabs.setCurrentIndex(0)
        self.submit(work,done,"시나리오 실행을 시작합니다…")

    def _emit_run_event(self,event):
        if self.task:
            self.task.progress.emit(event)

    def run_event(self,event):
        kind=event.get("kind")
        if kind in ("step_start", "step_finish"):
            self.highlight_run_step(event)
        if kind in ("step_start","step_finish","state","log"):
            result=event.get("result",{})
            self.message(event.get("message") or f"{kind}: {event.get('path','')} {event.get('status',result.get('status',''))}")

    def highlight_run_step(self, event):
        match = re.fullmatch(r"(?:cycle/\d+/)?(setup|steps)/(\d+)(?:/repeat/\d+/(\d+))?", event.get("path", ""))
        if not match:
            return
        section, index, child = match.groups()
        path = (section, int(index)-1)
        if self.running_selection:
            path = self.running_selection
        if child:
            path += ("steps", int(child)-1)
        root = self.tree.topLevelItem(0 if path[0] == "setup" else 1)
        item = root.child(path[1])
        if item and len(path) == 4:
            item = item.child(path[3])
        if item is None:
            return
        result = event.get("result", {})
        color = "#31546a" if event["kind"] == "step_start" else (
            "#6b3646" if result.get("status") in ("failed", "error") else "#254b45")
        for column in (0, 1):
            item.setBackground(column, QColor(color))
        self.tree.scrollToItem(item)

    def pause_run(self):
        if self.runner:
            self.paused=not self.paused
            self.runner.pause() if self.paused else self.runner.resume()
            self.message("현재 명령 종료 후 일시정지합니다." if self.paused else "실행을 재개합니다.")
            self.update_controls()

    def stop_run(self):
        self.record_cancel.set()
        if self.recording:
            self.toggle_recording()
        if self.runner:
            self.runner.stop()
            self.message("중단 요청됨 · 이미 전송된 제스처는 종료될 때까지 기다립니다.")

    def open_report(self):
        if self.latest_report and self.latest_report.get("html_path"):
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.latest_report["html_path"])))

    def closeEvent(self,event):
        if self.busy:
            self.close_after_task=True
            self.stop_run()
            self.message("진행 중인 작업을 종료한 뒤 창을 닫습니다.")
            event.ignore(); return
        if self.recording:
            self.toggle_recording()
        if not self.confirm_discard():
            self.close_after_task=False
            event.ignore(); return
        self.dirty=False
        if self.device:
            self.close_after_task=True
            self.disconnect_device()
            event.ignore(); return
        event.accept()
