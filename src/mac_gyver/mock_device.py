"""An explicitly simulated three-image gallery for learning and offline tests.

This is not an iOS simulator and never claims to validate a real Photos app.
"""
from __future__ import annotations

from io import BytesIO
import threading
from PIL import Image, ImageDraw, ImageFont

from .device import DeviceError, PHOTOS_BUNDLE_ID, finite_number, gesture_actions, normalized_point


class MockDevice:
    def __init__(self, config: dict | None = None):
        self.config = dict(config or {})
        self._lock = threading.RLock()
        self.connected = False
        self._session_bundle_id: str | None = None
        self.index = 0
        self.zoom = 1.0
        self.rotation = 0.0
        self.view = "gallery"
        self.last_action = ""
        self._geometry = {"width": 390, "height": 844, "orientation": "PORTRAIT"}

    def connect(self) -> dict:
        with self._lock:
            if self.connected:
                return self.metadata()
            bundle_id = self.config.get("bundle_id") or PHOTOS_BUNDLE_ID
            if not isinstance(bundle_id, str) or not bundle_id.strip():
                raise ValueError("앱 bundle ID가 필요합니다.")
            self._session_bundle_id = bundle_id
            self.connected = True
            return self.metadata()

    def close(self) -> None:
        with self._lock:
            self.connected = False

    def _require_connection(self) -> None:
        if not self.connected:
            raise DeviceError("모의 기기가 연결되지 않았습니다.")

    def metadata(self) -> dict:
        with self._lock:
            return {"simulated": True, "connected": self.connected, "name": "모의 iPhone · 실제 기기 아님",
                    "udid": "SIMULATED-OFFLINE", "platform_version": "모의 환경",
                    "bundle_id": self._session_bundle_id,
                    "geometry": dict(self._geometry), "photo_index": self.index, "zoom": self.zoom}

    def geometry(self) -> dict:
        with self._lock:
            self._require_connection()
            return dict(self._geometry)

    @staticmethod
    def _element(label: str, identifier: str, rect: dict, kind: str = "XCUIElementTypeButton") -> dict:
        return {"label": label, "type": kind,
                "target": {"mode": "element", "by": "accessibility_id", "value": identifier},
                "rect": rect, "visible": True}

    def inspect_elements(self) -> list[dict]:
        with self._lock:
            self._require_connection()
            if self.view == "gallery":
                items = [self._element("Gallery", "gallery", {"x": 0, "y": 120, "width": 390, "height": 660}, "XCUIElementTypeCollectionView")]
                for index in range(3):
                    items.append(self._element(f"Sample photo {index + 1}", f"photo-{index}",
                                               {"x": 20 + index * 121, "y": 188, "width": 109, "height": 190}, "XCUIElementTypeImage"))
                return items
            return [
                self._element("Back to gallery", "back", {"x": 12, "y": 58, "width": 80, "height": 48}),
                self._element(f"Sample photo {self.index + 1}", "photo-viewer", {"x": 12, "y": 158, "width": 366, "height": 520}, "XCUIElementTypeImage"),
                self._element(f"Current photo {self.index + 1}", f"photo-{self.index}", {"x": 12, "y": 158, "width": 366, "height": 520}, "XCUIElementTypeImage"),
                self._element(f"Current photo {self.index + 1} (viewer)", f"current-photo-{self.index}", {"x": 12, "y": 158, "width": 366, "height": 520}, "XCUIElementTypeImage"),
            ]

    def has_element(self, target: dict) -> bool:
        with self._lock:
            self._require_connection()
            if target.get("mode") != "element" or target.get("by") != "accessibility_id":
                raise ValueError("모의 기기는 예제 accessibility_id 요소만 지원합니다.")
            return any(item["target"]["value"] == target.get("value") for item in self.inspect_elements())

    def _point(self, target: dict) -> tuple[int, int]:
        if target.get("mode") == "normalized":
            return normalized_point(target, self._geometry)
        if target.get("mode") == "element":
            if not self.has_element(target):
                raise DeviceError(f"모의 기기에서 요소를 찾지 못했습니다: {target.get('value')}")
            item = next(item for item in self.inspect_elements() if item["target"]["value"] == target["value"])
            rect = item["rect"]
            return round(rect["x"] + rect["width"] / 2), round(rect["y"] + rect["height"] / 2)
        raise ValueError("지원하지 않는 대상 모드입니다.")

    def perform(self, step: dict) -> dict:
        with self._lock:
            self._require_connection()
            kind = step.get("type")
            self.last_action = str(kind)
            if kind == "activate_app":
                # Match activate semantics: do not pretend activation resets app state.
                pass
            elif kind in {"tap", "double_tap", "long_press"}:
                x, y = self._point(step["target"])
                if self.view == "gallery":
                    for i in range(3):
                        if 20 + i * 121 <= x <= 129 + i * 121 and 188 <= y <= 378:
                            self.index, self.view, self.zoom, self.rotation = i, "photo", 1.0, 0
                            break
                elif x < 95 and 50 <= y <= 115:
                    self.view, self.zoom, self.rotation = "gallery", 1.0, 0
                elif kind == "double_tap":
                    self.zoom = 1.0 if self.zoom > 1.01 else 2.0
            elif kind in {"swipe", "drag"}:
                gesture_actions(step, self._geometry)  # Same coordinate and timing checks.
                if self.view == "photo" and self.zoom <= 1.01:
                    dx = step["to"]["x"] - step["from"]["x"]
                    if abs(dx) > 0.1:
                        self.index = max(0, min(2, self.index + (1 if dx < 0 else -1)))
                        self.rotation = 0
            elif kind in {"pinch", "rotate"}:
                self._point(step["target"])
                if step["target"].get("mode") == "normalized":
                    gesture_actions(step, self._geometry)
                if kind == "pinch":
                    scale = finite_number(step.get("scale"), "scale", 0.1, 20)
                    finite_number(step.get("velocity", 1), "velocity", 0.01, 100)
                    if self.view == "photo":
                        self.zoom = max(1, min(5, self.zoom * scale))
                else:
                    angle = finite_number(step.get("angle_degrees"), "angle_degrees", -720, 720)
                    finite_number(step.get("velocity_degrees", 90), "velocity_degrees", 0.1, 1440)
                    if self.view == "photo":
                        self.rotation = (self.rotation + angle) % 360
            else:
                raise ValueError(f"모의 기기에서 지원하지 않는 동작: {kind}")
            return {"type": kind, "command_completed": True, "simulated": True,
                    "photo_index": self.index, "zoom": self.zoom, "view": self.view}

    @staticmethod
    def _font(size: int):
        try:
            return ImageFont.truetype("DejaVuSans.ttf", size)
        except OSError:
            return ImageFont.load_default(size=size)

    @staticmethod
    def _card(index: int, size: tuple[int, int]) -> Image.Image:
        palette = [("#c7ded4", "#3a7365", "#f5dda8"), ("#d6d9f4", "#625a9a", "#ffd4b5"), ("#f6d7c7", "#a56148", "#fff1bb")]
        background, ink, light = palette[index]
        width, height = size
        picture = Image.new("RGB", size, background)
        draw = ImageDraw.Draw(picture)
        draw.ellipse((width * .5, height * .12, width * .88, height * .12 + width * .38), fill=light)
        draw.polygon([(0, height * .85), (width * .38, height * .4), (width * .62, height * .7), (width * .82, height * .53), (width, height), (0, height)], fill=ink)
        draw.rounded_rectangle((width * .12, height * .08, width * .3, height * .08 + width * .18), radius=max(2, width // 40), fill="white")
        draw.text((width * .15, height * .08 + width * .01), str(index + 1), fill=ink, font=MockDevice._font(max(12, width // 8)))
        return picture

    def screenshot(self) -> bytes:
        with self._lock:
            self._require_connection()
            image = Image.new("RGB", (390, 844), "#f4f6fa")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle((20, 12, 370, 42), radius=12, fill="#ece3ff")
            draw.text((77, 18), "SIMULATED DEVICE - OFFLINE", fill="#674598", font=self._font(13))
            if self.view == "gallery":
                draw.text((22, 78), "Sample Gallery", fill="#202938", font=self._font(29))
                draw.text((22, 124), "Three cards for practice", fill="#6a7385", font=self._font(16))
                for index in range(3):
                    image.paste(self._card(index, (109, 190)), (20 + index * 121, 188))
                    draw.text((37 + index * 121, 392), f"Photo {index + 1}", fill="#43506b", font=self._font(15))
                draw.text((22, 474), "Tap a card to open it.", fill="#6a7385", font=self._font(16))
                draw.text((22, 505), "Then swipe left or right.", fill="#6a7385", font=self._font(16))
            else:
                draw.text((18, 72), "< Back", fill="#6250bd", font=self._font(20))
                draw.text((160, 80), f"Photo {self.index + 1} / 3", fill="#43506b", font=self._font(16))
                card = self._card(self.index, (366, 520))
                if self.rotation:
                    card = card.rotate(self.rotation, resample=Image.Resampling.BICUBIC, fillcolor="#e8eaf1")
                if self.zoom > 1:
                    w, h = card.size
                    dw, dh = w / self.zoom, h / self.zoom
                    card = card.crop(((w - dw) / 2, (h - dh) / 2, (w + dw) / 2, (h + dh) / 2)).resize((366, 520))
                image.paste(card, (12, 158))
                draw.text((25, 710), f"Zoom {self.zoom:.2f}x   Rotation {self.rotation:.0f} deg", fill="#43506b", font=self._font(17))
            draw.text((25, 790), "No iPhone connected. Demo only.", fill="#8a769c", font=self._font(15))
            buffer = BytesIO()
            image.save(buffer, "PNG")
            return buffer.getvalue()
