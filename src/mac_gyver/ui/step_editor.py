import copy
from pathlib import Path
import uuid

from PySide6.QtWidgets import (QDialog, QVBoxLayout, QFormLayout, QComboBox, QLineEdit,
    QSpinBox, QDoubleSpinBox, QDialogButtonBox, QMessageBox, QWidget, QHBoxLayout,
    QPushButton, QFileDialog, QScrollArea, QLabel)

LABELS = {
    "activate_app": "앱 열기", "tap": "탭", "double_tap": "더블탭",
    "long_press": "길게 누르기", "swipe": "스와이프", "drag": "드래그",
    "pinch": "확대 / 축소", "rotate": "두 손가락 회전", "wait": "고정 대기",
    "wait_element": "조건 대기", "assert_element": "요소 검사", "assert_image": "이미지 영역 검사",
    "screenshot": "스크린샷", "repeat": "반복 구간",
}


def default_step(kind):
    step = {"type": kind}
    if kind in ("tap", "double_tap", "long_press", "pinch", "rotate", "wait_element", "assert_element"):
        step["target"] = {"mode": "normalized", "x": .5, "y": .5}
    if kind in ("wait_element", "assert_element"):
        step["target"] = {"mode": "element", "by": "accessibility_id", "value": "photo-viewer"}
        step["state"] = "visible"
    if kind == "wait_element":
        step["timeout_ms"] = 5000
    if kind in ("swipe", "drag"):
        step.update({"from": {"x": .8, "y": .5}, "to": {"x": .2, "y": .5}, "move_duration_ms": 300})
    if kind in ("long_press", "drag"):
        step["press_duration_ms"] = 1500 if kind == "long_press" else 500
    if kind == "drag":
        step["hold_duration_ms"] = 100
    if kind == "pinch":
        step.update(scale=2.0, velocity=1.0)
    if kind == "rotate":
        step.update(angle_degrees=45.0, velocity_degrees=45.0)
    if kind == "wait":
        step["duration_ms"] = 1000
    if kind == "assert_image":
        step.update(baseline="", region={"x": 0., "y": .1, "width": 1., "height": .8}, tolerance=.05, expected="match")
    if kind == "repeat":
        step.update(count=20, between_iterations_ms=500, steps=[])
    if kind in ("tap", "double_tap", "long_press", "swipe", "drag", "pinch", "rotate", "activate_app"):
        step["after_delay_ms"] = 500
    return step


def describe_step(step):
    kind = step.get("type", "?")
    title = step.get("name") or LABELS.get(kind, kind)
    details = []
    if kind == "repeat":
        details.append(f"{step.get('count', 1)}회 · {len(step.get('steps', []))}단계")
    if kind in ("swipe", "drag"):
        details.append(f"이동 {step.get('move_duration_ms', 300)}ms")
    if kind == "long_press":
        details.append(f"누름 {step.get('press_duration_ms', 1500)}ms")
    if kind == "wait":
        details.append(f"{step.get('duration_ms', 0)}ms")
    if kind == "pinch":
        details.append(f"배율 {step.get('scale', 1):g}")
    if kind == "rotate":
        details.append(f"{step.get('angle_degrees', 0):g}°")
    if step.get("after_delay_ms"):
        details.append(f"후 대기 {step['after_delay_ms']}ms")
    return title, " · ".join(details)


class StepDialog(QDialog):
    def __init__(self, step=None, asset_root=None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("테스트 단계 편집")
        self.resize(470, 650)
        self.original = copy.deepcopy(step or default_step("tap"))
        self.result_step = None
        self.asset_root = Path(asset_root) if asset_root else None
        self.fields = {}
        layout = QVBoxLayout(self)
        self.kind = QComboBox()
        for key, label in LABELS.items():
            if key != "repeat" or self.original["type"] == "repeat":
                self.kind.addItem(label, key)
        self.kind.setCurrentIndex(self.kind.findData(self.original["type"]))
        self.kind.setEnabled(self.original["type"] != "repeat")
        layout.addWidget(self.kind)
        self.name = QLineEdit(self.original.get("name", ""))
        self.name.setPlaceholderText("단계 이름 (선택)")
        layout.addWidget(self.name)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        layout.addWidget(self.scroll)
        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Save).setText("저장")
        buttons.button(QDialogButtonBox.Cancel).setText("취소")
        buttons.accepted.connect(self.save)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.kind.currentIndexChanged.connect(self.rebuild)
        self.rebuild()

    def number(self, key, label, value, minimum=0, maximum=3_600_000, decimal=False):
        field = QDoubleSpinBox() if decimal else QSpinBox()
        field.setRange(minimum, maximum)
        if decimal:
            field.setDecimals(4)
            field.setSingleStep(.05 if maximum <= 1 else .1)
        field.setValue(value)
        self.fields[key] = field
        if key.endswith("_ms"):
            row = QWidget()
            layout = QHBoxLayout(row)
            layout.setContentsMargins(0, 0, 0, 0)
            seconds = QLabel(f"{field.value()/1000:g}초")
            field.valueChanged.connect(lambda value: seconds.setText(f"{value/1000:g}초"))
            layout.addWidget(field, 1)
            layout.addWidget(seconds)
            self.form.addRow(label, row)
        else:
            self.form.addRow(label, field)
        return field

    def text(self, key, label, value):
        field = QLineEdit(str(value))
        self.fields[key] = field
        self.form.addRow(label, field)
        return field

    def choose(self, key, label, choices, value):
        field = QComboBox()
        for text, data in choices:
            field.addItem(text, data)
        field.setCurrentIndex(max(0, field.findData(value)))
        self.fields[key] = field
        self.form.addRow(label, field)
        return field

    def rebuild(self):
        kind = self.kind.currentData()
        data = self.original if kind == self.original["type"] else default_step(kind)
        self.fields = {}
        body = QWidget()
        self.form = QFormLayout(body)
        self.form.setSpacing(12)
        self.scroll.setWidget(body)
        if "target" in data:
            target = data["target"]
            mode = target.get("by") if target.get("mode") == "element" else "normalized"
            choices = [("화면 좌표", "normalized"), ("접근성 ID", "accessibility_id"),
                       ("iOS Predicate", "predicate"), ("iOS Class Chain", "class_chain"), ("XPath", "xpath")]
            if kind in ("wait_element", "assert_element"):
                choices = choices[1:]
            self.choose("target_mode", "대상 방식", choices, mode)
            self.number("target_x", "X 위치 (0~1)", target.get("x", .5), 0, 1, True)
            self.number("target_y", "Y 위치 (0~1)", target.get("y", .5), 0, 1, True)
            self.text("target_value", "요소 식별자", target.get("value", ""))
        if kind in ("swipe", "drag"):
            for edge, label in (("from", "시작"), ("to", "끝")):
                for axis in ("x", "y"):
                    self.number(f"{edge}_{axis}", f"{label} {axis.upper()} (0~1)", data[edge][axis], 0, 1, True)
            self.number("move_duration_ms", "이동 시간 (ms)", data.get("move_duration_ms", 300), 1, 60_000)
        if kind in ("long_press", "drag"):
            self.number("press_duration_ms", "누르는 시간 (ms)", data.get("press_duration_ms", 1500), 0, 60_000)
        if kind == "drag":
            self.number("hold_duration_ms", "끝점 유지 (ms)", data.get("hold_duration_ms", 100), 0, 60_000)
        if kind == "pinch":
            self.number("scale", "배율 (1 미만 축소)", data.get("scale", 2), .1, 20, True)
            self.number("velocity", "속도 (배율 / 초)", data.get("velocity", 1), .01, 100, True)
        if kind == "rotate":
            self.number("angle_degrees", "회전 각도 (°)", data.get("angle_degrees", 45), -720, 720, True)
            self.number("velocity_degrees", "속도 (° / 초)", data.get("velocity_degrees", 45), .1, 1440, True)
        if kind in ("wait_element", "assert_element"):
            self.choose("state", "기대 상태", [("표시됨", "visible"), ("표시되지 않음", "absent")], data.get("state", "visible"))
        if kind == "wait_element":
            self.number("timeout_ms", "최대 대기 (ms)", data.get("timeout_ms", 5000), 1)
        if kind == "wait":
            self.number("duration_ms", "대기 시간 (ms)", data.get("duration_ms", 1000))
        if kind == "assert_image":
            self.text("baseline", "기준 이미지 (상대 경로)", data.get("baseline", ""))
            pick = QPushButton("기준 이미지 파일 선택…")
            pick.clicked.connect(self.pick_baseline)
            self.form.addRow(pick)
            region = data.get("region", {"x": 0, "y": 0, "width": 1, "height": 1})
            for key, label in (("x", "영역 X"), ("y", "영역 Y"), ("width", "영역 너비"), ("height", "영역 높이")):
                self.number("region_"+key, label+" (0~1)", region[key], 0, 1, True)
            self.number("tolerance", "허용 차이 (0~1)", data.get("tolerance", .05), 0, 1, True)
            self.choose("expected", "기대 결과", [("기준과 일치", "match"), ("기준과 다름", "different")], data.get("expected", "match"))
            note = QLabel("전체 화면 PNG를 기준으로 저장하고 선택한 영역만 비교합니다.\n‘다름’ 검사는 특정 사진으로 전환됐음을 보장하지 않습니다.")
            note.setWordWrap(True)
            self.form.addRow(note)
        if kind == "repeat":
            self.number("count", "반복 횟수", data.get("count", 20), 1, 10_000)
            self.number("between_iterations_ms", "회차 사이 대기 (ms)", data.get("between_iterations_ms", 500))
        self.number("after_delay_ms", "동작 후 대기 (ms)", data.get("after_delay_ms", 0))

    def pick_baseline(self):
        path, _ = QFileDialog.getOpenFileName(self, "기준 이미지 선택", "", "Images (*.png *.jpg *.jpeg)")
        if not path or not self.asset_root:
            return
        try:
            from PIL import Image
            relative = Path("baselines") / (uuid.uuid4().hex + ".png")
            target = self.asset_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(path) as image:
                image.convert("RGB").save(target)
            self.fields["baseline"].setText(relative.as_posix())
        except Exception as exc:
            QMessageBox.warning(self, "기준 이미지", str(exc))

    def save(self):
        from ..models import validate_step
        kind = self.kind.currentData()
        result = copy.deepcopy(self.original if kind == self.original["type"] else default_step(kind))
        result["type"] = kind
        if name := self.name.text().strip():
            result["name"] = name
        else:
            result.pop("name", None)
        values = {}
        for key, field in self.fields.items():
            values[key] = field.currentData() if isinstance(field, QComboBox) else field.text() if isinstance(field, QLineEdit) else field.value()
        for key, value in values.items():
            if not key.startswith(("target_", "from_", "to_", "region_")):
                result[key] = value
        if "target_mode" in values:
            mode = values["target_mode"]
            result["target"] = ({"mode": "normalized", "x": values["target_x"], "y": values["target_y"]}
                                if mode == "normalized" else {"mode": "element", "by": mode, "value": values["target_value"].strip()})
        if kind in ("swipe", "drag"):
            result["from"] = {axis: values["from_"+axis] for axis in ("x", "y")}
            result["to"] = {axis: values["to_"+axis] for axis in ("x", "y")}
        if kind == "assert_image":
            result["region"] = {key: values["region_"+key] for key in ("x", "y", "width", "height")}
        try:
            self.result_step = validate_step(result)
        except (ValueError, TypeError) as exc:
            QMessageBox.warning(self, "설정 확인", str(exc))
            return
        self.accept()
