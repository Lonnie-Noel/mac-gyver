"""Serialized Appium/XCUITest device access; coordinates are logical WDA points.

References: appium.github.io/appium-xcuitest-driver/latest/reference/execute-methods/
and github.com/appium/python-client (AppiumClientConfig, W3C actions).
No gesture is retried: a timed-out command may already have reached the phone.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import math
import threading
from typing import Any
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

PHOTOS_BUNDLE_ID = "com.apple.mobileslideshow"


class DeviceError(RuntimeError):
    """Device operation could not be completed safely."""


class UnexpectedAlertError(DeviceError):
    """An alert needs manual attention on the phone."""


def finite_number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name}: 숫자를 입력하세요.")
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"{name}: {minimum}~{maximum} 범위여야 합니다.")
    return number


def normalized_point(target: dict, geometry: dict) -> tuple[int, int]:
    """Map the full screenshot fraction to full-screen WDA logical points.

    A screenshot's pixel dimensions must never be used as the input coordinate size.
    Endpoint 1.0 is clamped to the last addressable point, not beyond the screen.
    """
    if not isinstance(target, dict):
        raise ValueError("좌표 대상은 객체여야 합니다.")
    x = finite_number(target.get("x"), "x", 0, 1)
    y = finite_number(target.get("y"), "y", 0, 1)
    width, height = int(geometry["width"]), int(geometry["height"])
    if width < 2 or height < 2:
        raise DeviceError("아이폰의 화면 크기를 확인하지 못했습니다.")
    return min(width - 1, round(x * width)), min(height - 1, round(y * height))


def _duration(step: dict, key: str, default: int, *, positive: bool = False) -> int:
    return int(finite_number(step.get(key, default), key, 1 if positive else 0, 60000))


def _pointer(name: str, points: list[tuple[int, int, int]], press: int = 0, hold: int = 0) -> dict:
    x, y, _ = points[0]
    actions = [
        {"type": "pointerMove", "duration": 0, "origin": "viewport", "x": x, "y": y},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": press},
    ]
    actions.extend({"type": "pointerMove", "duration": ms, "origin": "viewport", "x": px, "y": py}
                   for px, py, ms in points[1:])
    actions.extend([{"type": "pause", "duration": hold}, {"type": "pointerUp", "button": 0}])
    return {"type": "pointer", "id": name, "parameters": {"pointerType": "touch"}, "actions": actions}


def gesture_actions(step: dict, geometry: dict) -> list[dict]:
    """Build one W3C action bundle, with synchronized ticks for two fingers."""
    kind = step["type"]
    if kind in {"swipe", "drag"}:
        start = normalized_point(step["from"], geometry)
        end = normalized_point(step["to"], geometry)
        move = _duration(step, "move_duration_ms", 300, positive=True)
        press = _duration(step, "press_duration_ms", 0 if kind == "swipe" else 500)
        hold = _duration(step, "hold_duration_ms", 0)
        if press + move + hold > 60000:
            raise ValueError("한 제스처의 총 시간은 60초 이하여야 합니다.")
        return [_pointer("finger-1", [(*start, 0), (*end, move)], press, hold)]
    if kind not in {"pinch", "rotate"}:
        raise ValueError(f"W3C 제스처로 지원하지 않는 동작: {kind}")
    cx, cy = normalized_point(step["target"], geometry)
    room = min(cx, cy, geometry["width"] - 1 - cx, geometry["height"] - 1 - cy) - 2
    if room < 8:
        raise ValueError("두 손가락 제스처의 중심을 화면 가장자리에서 더 안쪽으로 옮기세요.")
    radius = min(float(room), min(geometry["width"], geometry["height"]) * 0.18)
    if kind == "pinch":
        scale = finite_number(step.get("scale"), "scale", 0.1, 20)
        speed = finite_number(step.get("velocity", 1), "velocity", 0.01, 100)
        if scale == 1:
            raise ValueError("확대·축소 배율은 1과 달라야 합니다.")
        start_radius = radius / max(1, scale)
        end_radius = start_radius * scale
        if min(start_radius, end_radius) < 2:
            raise ValueError("이 위치와 배율로 두 손가락을 구분할 공간이 부족합니다.")
        total = max(1, round(abs(scale - 1) / speed * 1000))
        if total > 60000:
            raise ValueError("확대·축소 시간이 60초를 초과합니다. 속도를 높이세요.")
        return [_pointer(f"finger-{i + 1}", [
            (round(cx + sign * start_radius), cy, 0),
            (round(cx + sign * end_radius), cy, total),
        ]) for i, sign in enumerate((-1, 1))]
    angle = finite_number(step.get("angle_degrees"), "angle_degrees", -720, 720)
    speed = finite_number(step.get("velocity_degrees", 90), "velocity_degrees", 0.1, 1440)
    if angle == 0:
        raise ValueError("회전 각도는 0과 달라야 합니다.")
    total = max(1, round(abs(angle) / speed * 1000))
    if total > 60000:
        raise ValueError("회전 시간이 60초를 초과합니다. 속도를 높이세요.")
    segments = max(2, math.ceil(abs(angle) / 10))
    fingers = []
    for finger in range(2):
        points = []
        for tick in range(segments + 1):
            radians = math.radians(angle * tick / segments) + finger * math.pi
            # XCTest positive rotation is counter-clockwise; screen y points down.
            x, y = round(cx + radius * math.cos(radians)), round(cy - radius * math.sin(radians))
            ms = round(total * tick / segments) - round(total * (tick - 1) / segments) if tick else 0
            points.append((x, y, ms))
        fingers.append(_pointer(f"finger-{finger + 1}", points))
    return fingers


def validate_server_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("Appium 서버 URL은 인증정보 없는 http(s) 주소여야 합니다.")
    if parts.query or parts.fragment:
        raise ValueError("Appium 서버 URL에 쿼리나 fragment를 사용할 수 없습니다.")
    return url.rstrip("/")


class AppiumDevice:
    def __init__(self, config: dict):
        self.config = dict(config)
        self.server_url = validate_server_url(config.get("server_url") or "http://127.0.0.1:4723")
        self._lock = threading.RLock()
        self._driver = None
        self._session_bundle_id: str | None = None
        self._info: dict = {"simulated": False, "connected": False}

    def _require_driver(self):
        if self._driver is None:
            raise DeviceError("아이폰이 연결되어 있지 않습니다.")
        return self._driver

    def connect(self) -> dict:
        from appium import webdriver
        from appium.options.ios import XCUITestOptions
        from appium.webdriver.client_config import AppiumClientConfig

        with self._lock:
            if self._driver is not None:
                return self.metadata()
            udid = self.config.get("udid", "").strip()
            if not udid or udid.lower() == "auto":
                raise ValueError("연결할 실제 아이폰의 UDID를 선택하세요.")
            timeout = finite_number(self.config.get("command_timeout_seconds", 75), "command timeout", 10, 300)
            startup = finite_number(self.config.get("connect_timeout_seconds", 180), "connect timeout", 30, 600)
            bundle_id = self.config.get("bundle_id") or PHOTOS_BUNDLE_ID
            if not isinstance(bundle_id, str) or not bundle_id.strip():
                raise ValueError("앱 bundle ID가 필요합니다.")
            capabilities = {
                "platformName": "iOS", "appium:automationName": "XCUITest", "appium:udid": udid,
                "appium:deviceName": self.config.get("device_name") or "iPhone",
                "appium:bundleId": bundle_id,
                "appium:noReset": True, "appium:fullReset": False, "appium:useNewWDA": False,
                "appium:autoAcceptAlerts": False, "appium:autoDismissAlerts": False,
                "appium:shouldTerminateApp": False, "appium:forceAppLaunch": False,
                "appium:newCommandTimeout": 3600,
                "appium:wdaConnectionTimeout": int((timeout - 5) * 1000),
                "appium:wdaLaunchTimeout": 120000, "appium:wdaStartupRetries": 1,
                "appium:usePreinstalledWDA": bool(self.config.get("use_preinstalled_wda", False)),
            }
            for key, capability in (("platform_version", "platformVersion"), ("team_id", "xcodeOrgId"),
                                    ("wda_bundle_id", "updatedWDABundleId")):
                if self.config.get(key):
                    capabilities[f"appium:{capability}"] = self.config[key]
            if self.config.get("team_id"):
                capabilities["appium:xcodeSigningId"] = "Apple Development"
            client_config = AppiumClientConfig(
                remote_server_addr=self.server_url, timeout=startup, direct_connection=False,
                init_args_for_pool_manager={"init_args_for_pool_manager": {"retries": False}},
            )
            self._driver = webdriver.Remote(options=XCUITestOptions().load_capabilities(capabilities),
                                            client_config=client_config)
            self._session_bundle_id = bundle_id
            # RemoteConnection keeps this config object; subsequent HTTP calls use the shorter timeout.
            client_config.timeout = timeout
            try:
                self._driver.implicitly_wait(0)
                self._info = {
                    "simulated": False, "connected": True, "udid": udid,
                    "name": self.config.get("device_name") or "iPhone",
                    "platform_version": self._driver.capabilities.get("platformVersion", self.config.get("platform_version", "")),
                    "bundle_id": capabilities["appium:bundleId"], "geometry": self.geometry(),
                }
                self._check_alert()
                return self.metadata()
            except Exception:
                try:
                    self.close()
                except Exception:
                    pass  # Preserve the original connection error if cleanup also fails.
                raise

    def close(self) -> None:
        with self._lock:
            driver, self._driver = self._driver, None
            self._info["connected"] = False
            if driver is not None:
                driver.quit()

    def metadata(self) -> dict:
        with self._lock:
            # bundle_id and geometry describe the connected session, not mutable UI fields
            # or an app activated explicitly by a later scenario step.
            return {**deepcopy(self._info), "connected": self._driver is not None}

    def geometry(self) -> dict:
        with self._lock:
            driver = self._require_driver()
            size = driver.get_window_size()
            orientation = str(driver.orientation).upper()
            if orientation not in {"PORTRAIT", "LANDSCAPE"}:
                raise DeviceError(f"지원하지 않는 화면 방향: {orientation}")
            width, height = int(size["width"]), int(size["height"])
            if min(width, height) < 2:
                raise DeviceError("아이폰에서 올바른 화면 크기를 받지 못했습니다.")
            return {"width": width, "height": height, "orientation": orientation}

    def screenshot(self) -> bytes:
        with self._lock:
            # Capture remains available when an alert interrupts playback.
            return self._require_driver().get_screenshot_as_png()

    def _check_alert(self) -> None:
        from selenium.common.exceptions import NoAlertPresentException
        try:
            text = self._require_driver().switch_to.alert.text
        except NoAlertPresentException:
            return
        raise UnexpectedAlertError(f"아이폰에 팝업이 표시되었습니다. 직접 처리한 뒤 다시 실행하세요: {text}")

    @staticmethod
    def _locator(target: dict) -> tuple[str, str]:
        by_map = {"accessibility_id": "accessibility id", "predicate": "-ios predicate string",
                  "class_chain": "-ios class chain", "xpath": "xpath"}
        if not isinstance(target, dict) or target.get("mode") != "element":
            raise ValueError("요소 대상이 필요합니다.")
        by, value = target.get("by"), target.get("value")
        if by not in by_map or not isinstance(value, str) or not value.strip():
            raise ValueError("지원하는 요소 선택 방식과 비어 있지 않은 값을 입력하세요.")
        return by_map[by], value

    def _find(self, target: dict):
        # Intentionally resolve anew each time. No WebElement escapes the adapter.
        return self._require_driver().find_element(*self._locator(target))

    def has_element(self, target: dict) -> bool:
        from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException
        with self._lock:
            self._check_alert()
            try:
                return bool(self._find(target).is_displayed())
            except (NoSuchElementException, StaleElementReferenceException):
                return False

    def _target_args(self, target: dict) -> dict:
        if target.get("mode") == "element":
            element = self._find(target)
            if not element.is_displayed():
                raise DeviceError("대상 요소가 화면에 표시되지 않습니다.")
            return {"elementId": element.id}
        if target.get("mode") != "normalized":
            raise ValueError("대상 모드는 normalized 또는 element여야 합니다.")
        x, y = normalized_point(target, self.geometry())
        return {"x": x, "y": y}

    def perform(self, step: dict) -> dict:
        with self._lock:
            driver = self._require_driver()
            self._check_alert()
            kind = step.get("type")
            if kind == "activate_app":
                bundle_id = step.get("bundle_id") or self._session_bundle_id or PHOTOS_BUNDLE_ID
                if not isinstance(bundle_id, str) or not bundle_id.strip():
                    raise ValueError("앱 bundle ID가 필요합니다.")
                driver.activate_app(bundle_id)
            elif kind in {"tap", "double_tap", "long_press"}:
                if kind == "tap" and step["target"].get("mode") == "element":
                    element = self._find(step["target"])
                    if not element.is_displayed():
                        raise DeviceError("대상 요소가 화면에 표시되지 않습니다.")
                    # mobile:tap requires x/y offsets even with elementId; native click targets its center.
                    element.click()
                else:
                    arguments = self._target_args(step["target"])
                    method = {"tap": "tap", "double_tap": "doubleTap", "long_press": "touchAndHold"}[kind]
                    if kind == "long_press":
                        arguments["duration"] = _duration(step, "press_duration_ms", 1500, positive=True) / 1000
                    driver.execute_script(f"mobile: {method}", arguments)
            elif kind in {"swipe", "drag"} or (
                kind in {"pinch", "rotate"} and step["target"].get("mode") == "normalized"
            ):
                from selenium.webdriver.remote.command import Command
                actions = gesture_actions(step, self.geometry())
                # Exactly one request preserves multi-finger tick synchronization.
                driver.execute(Command.W3C_ACTIONS, {"actions": actions})
            elif kind in {"pinch", "rotate"}:
                arguments = self._target_args(step["target"])
                if kind == "pinch":
                    scale = finite_number(step.get("scale"), "scale", 0.1, 20)
                    velocity = finite_number(step.get("velocity", 1), "velocity", 0.01, 100)
                    if scale == 1 or abs(scale - 1) / velocity > 60:
                        raise ValueError("배율은 1과 달라야 하며 제스처는 60초 이하여야 합니다.")
                    arguments.update(scale=scale, velocity=velocity)
                    method = "pinch"
                else:
                    angle = finite_number(step.get("angle_degrees"), "angle_degrees", -720, 720)
                    velocity = finite_number(step.get("velocity_degrees", 90), "velocity_degrees", 0.1, 1440)
                    if angle == 0 or abs(angle) / velocity > 60:
                        raise ValueError("각도는 0과 달라야 하며 제스처는 60초 이하여야 합니다.")
                    arguments.update(rotation=math.radians(angle), velocity=math.radians(velocity))
                    method = "rotateElement"
                driver.execute_script(f"mobile: {method}", arguments)
            else:
                raise ValueError(f"기기에서 지원하지 않는 단계: {kind}")
            self._check_alert()
            return {"type": kind, "command_completed": True, "simulated": False}

    def inspect_elements(self) -> list[dict]:
        with self._lock:
            self._check_alert()
            source = self._require_driver().page_source
            if len(source) > 5_000_000:
                raise DeviceError("요소 트리가 너무 큽니다. 다른 화면에서 다시 시도하세요.")
            root = ET.fromstring(source)
            nodes = list(root.iter())
            if len(nodes) > 10000:
                raise DeviceError("요소가 너무 많습니다. 다른 화면에서 다시 시도하세요.")
            names = Counter(node.get("name") for node in nodes if node.get("name"))
            results = []

            def visit(node: ET.Element, path: str) -> None:
                if len(results) >= 500:
                    return
                attrs = node.attrib
                kind = attrs.get("type", node.tag)
                try:
                    rect = {key: float(attrs[key]) for key in ("x", "y", "width", "height")}
                    valid = all(math.isfinite(v) for v in rect.values()) and min(rect["width"], rect["height"]) > 0
                except (KeyError, ValueError):
                    valid = False
                if valid and kind.startswith("XCUIElementType"):
                    name = attrs.get("name", "")
                    target = {"mode": "element", "by": "accessibility_id", "value": name} if name and names[name] == 1 else {
                        "mode": "element", "by": "xpath", "value": path}
                    results.append({"label": attrs.get("label") or name or attrs.get("value") or kind,
                                    "type": kind, "target": target, "rect": rect,
                                    "visible": attrs.get("visible", "false").lower() == "true"})
                counts: Counter = Counter()
                for child in node:
                    counts[child.tag] += 1
                    visit(child, f"{path}/{child.tag}[{counts[child.tag]}]")

            visit(root, f"/{root.tag}")
            return results
