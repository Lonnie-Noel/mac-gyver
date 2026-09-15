from io import BytesIO
import math
from types import SimpleNamespace

from PIL import Image
import pytest
from selenium.common.exceptions import NoAlertPresentException, NoSuchElementException

from mac_gyver.device import AppiumDevice, UnexpectedAlertError, gesture_actions, normalized_point
from mac_gyver.mock_device import MockDevice


G = {"width": 390, "height": 844, "orientation": "PORTRAIT"}
POINT = {"mode": "normalized", "x": .5, "y": .5}
ELEMENT = {"mode": "element", "by": "accessibility_id", "value": "photo-viewer"}


class Switch:
    def __init__(self):
        self.text = None

    @property
    def alert(self):
        if self.text is None:
            raise NoAlertPresentException()
        return SimpleNamespace(text=self.text)


class FakeDriver:
    def __init__(self):
        self.calls = []
        self.switch_to = Switch()
        self.orientation = "PORTRAIT"
        self.capabilities = {"platformVersion": "18.5"}
        self.lookups = 0
        self.missing = False
        self.fail = False
        self.page_source = """<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" x="0" y="0" width="390" height="844" visible="true">
        <XCUIElementTypeButton name="Open" label="Open album" x="20" y="100" width="80" height="44" visible="true"/>
        <XCUIElementTypeButton name="Same" x="20" y="200" width="80" height="44" visible="true"/>
        <XCUIElementTypeButton name="Same" x="20" y="250" width="80" height="44" visible="true"/>
        </XCUIElementTypeApplication></AppiumAUT>"""

    def get_window_size(self):
        return {"width": 390, "height": 844}

    def execute_script(self, script, args):
        self.calls.append((script, args))
        if self.fail:
            raise TimeoutError("Command may have reached phone")

    def execute(self, command, args):
        self.calls.append((command, args))
        if self.fail:
            raise TimeoutError("Command may have reached phone")

    def find_element(self, by, value):
        self.lookups += 1
        if self.missing:
            raise NoSuchElementException()
        identifier = f"element-{self.lookups}"
        return SimpleNamespace(id=identifier, is_displayed=lambda: True,
                               click=lambda: self.calls.append(("click", identifier)))

    def implicitly_wait(self, seconds):
        self.calls.append(("implicit_wait", seconds))

    def get_screenshot_as_png(self):
        image = Image.new("RGB", (1170, 2532), "white")
        buffer = BytesIO()
        image.save(buffer, "PNG")
        return buffer.getvalue()

    def activate_app(self, bundle):
        self.calls.append(("activate", bundle))

    def quit(self):
        self.calls.append(("quit", None))


@pytest.fixture
def device():
    instance = AppiumDevice({})
    instance._driver = FakeDriver()
    return instance


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -.1, 1.1, True, "0.5", None])
def test_rejects_invalid_normalized_coordinates(value):
    with pytest.raises(ValueError):
        normalized_point({"x": value, "y": .5}, G)


def test_coordinate_conversion_uses_logical_points_not_retina_pixels(device):
    assert Image.open(BytesIO(device.screenshot())).size == (1170, 2532)
    device.perform({"type": "tap", "target": POINT})
    assert device._driver.calls == [("mobile: tap", {"x": 195, "y": 422})]
    assert normalized_point({"x": 1, "y": 1}, G) == (389, 843)


def test_drag_has_separate_prepress_movement_and_hold(device):
    device.perform({"type": "drag", "from": {"x": .8, "y": .5}, "to": {"x": .2, "y": .5},
                    "press_duration_ms": 550, "move_duration_ms": 321, "hold_duration_ms": 120})
    command, payload = device._driver.calls[0]
    assert command == "actions"
    actions = payload["actions"][0]["actions"]
    assert actions[2] == {"type": "pause", "duration": 550}
    assert actions[3] == {"type": "pointerMove", "duration": 321, "origin": "viewport", "x": 78, "y": 422}
    assert actions[4] == {"type": "pause", "duration": 120}


@pytest.mark.parametrize("step", [
    {"type": "pinch", "target": POINT, "scale": 2, "velocity": 1},
    {"type": "pinch", "target": POINT, "scale": .5, "velocity": .5},
    {"type": "rotate", "target": POINT, "angle_degrees": 90, "velocity_degrees": 45},
    {"type": "rotate", "target": POINT, "angle_degrees": -180, "velocity_degrees": 90},
])
def test_two_pointer_ticks_synchronized_and_in_bounds(step):
    fingers = gesture_actions(step, G)
    assert len(fingers) == 2
    first, second = [finger["actions"] for finger in fingers]
    assert [a["type"] for a in first] == [a["type"] for a in second]
    assert [a.get("duration") for a in first] == [a.get("duration") for a in second]
    for finger in fingers:
        for action in finger["actions"]:
            if action["type"] == "pointerMove":
                assert 0 <= action["x"] < G["width"]
                assert 0 <= action["y"] < G["height"]
    if step["type"] == "rotate":
        assert sum(action.get("duration", 0) for action in first) == 2000
    else:
        assert sum(action.get("duration", 0) for action in first) == 1000


def test_rotate_positive_is_counterclockwise_on_screen():
    actions = gesture_actions({"type": "rotate", "target": POINT, "angle_degrees": 90, "velocity_degrees": 90}, G)[0]["actions"]
    moves = [a for a in actions if a["type"] == "pointerMove"]
    assert moves[0]["x"] > 195 and moves[0]["y"] == 422
    assert moves[-1]["x"] == 195 and moves[-1]["y"] < 422


def test_edge_pinch_rejected_before_device_command(device):
    with pytest.raises(ValueError, match="가장자리"):
        device.perform({"type": "pinch", "target": {"mode": "normalized", "x": 0, "y": .5}, "scale": 2, "velocity": 1})
    assert not device._driver.calls


def test_native_rotate_converts_degrees_to_radians(device):
    device.perform({"type": "rotate", "target": ELEMENT, "angle_degrees": -90, "velocity_degrees": 45})
    script, args = device._driver.calls[0]
    assert script == "mobile: rotateElement"
    assert args == {"elementId": "element-1", "rotation": -math.pi / 2, "velocity": math.pi / 4}


def test_elements_are_refound_for_each_action(device):
    device.perform({"type": "tap", "target": ELEMENT})
    device.perform({"type": "tap", "target": ELEMENT})
    assert device._driver.calls == [("click", "element-1"), ("click", "element-2")]
    device._driver.missing = True
    assert device.has_element(ELEMENT) is False


def test_unexpected_alert_stops_without_accepting_or_dismissing(device):
    device._driver.switch_to.text = "Delete these photos?"
    with pytest.raises(UnexpectedAlertError):
        device.perform({"type": "tap", "target": POINT})
    with pytest.raises(UnexpectedAlertError):
        device.has_element(ELEMENT)
    assert device._driver.calls == []
    assert device.screenshot().startswith(b"\x89PNG")


def test_timed_out_gesture_is_not_retried(device):
    device._driver.fail = True
    with pytest.raises(TimeoutError):
        device.perform({"type": "swipe", "from": {"x": .8, "y": .5}, "to": {"x": .2, "y": .5}, "move_duration_ms": 300})
    assert len(device._driver.calls) == 1


def test_connect_preserves_phone_data_and_bounds_http_timeout(monkeypatch):
    import appium.webdriver
    captured = {}
    driver = FakeDriver()

    def remote(**kwargs):
        captured.update(kwargs)
        assert kwargs["client_config"].timeout == 180
        return driver

    monkeypatch.setattr(appium.webdriver, "Remote", remote)
    device = AppiumDevice({"udid": "test-udid", "team_id": "TESTTEAM", "wda_bundle_id": "dev.test.WDA"})
    assert device.connect()["simulated"] is False
    caps = captured["options"].to_capabilities()
    assert caps["appium:noReset"] is True
    assert caps["appium:fullReset"] is False
    assert caps["appium:autoAcceptAlerts"] is False
    assert caps["appium:autoDismissAlerts"] is False
    assert caps["appium:shouldTerminateApp"] is False
    assert caps["appium:updatedWDABundleId"] == "dev.test.WDA"
    assert captured["client_config"].timeout == 75
    assert captured["client_config"].init_args_for_pool_manager["init_args_for_pool_manager"]["retries"] is False
    assert driver.calls[0] == ("implicit_wait", 0)
    device.close()
    assert device.metadata()["connected"] is False


def test_inspector_avoids_duplicate_accessibility_ids(device):
    items = device.inspect_elements()
    assert len(items) == 4
    unique = next(item for item in items if item["label"] == "Open album")
    assert unique["target"]["by"] == "accessibility_id"
    duplicates = [item for item in items if item["label"] == "Same"]
    assert all(item["target"]["by"] == "xpath" for item in duplicates)
    assert duplicates[0]["target"]["value"] != duplicates[1]["target"]["value"]


def test_mock_roundtrip_and_assertions_are_explicitly_simulated():
    device = MockDevice()
    assert device.connect()["simulated"] is True
    first = device.screenshot()
    device.perform({"type": "tap", "target": {**ELEMENT, "value": "photo-0"}})
    assert device.has_element({**ELEMENT, "value": "photo-viewer"})
    assert device.has_element({**ELEMENT, "value": "current-photo-0"})
    before = device.screenshot()
    assert first != before
    device.perform({"type": "swipe", "from": {"x": .8, "y": .5}, "to": {"x": .2, "y": .5}, "move_duration_ms": 300})
    assert device.has_element({**ELEMENT, "value": "current-photo-1"})
    assert not device.has_element({**ELEMENT, "value": "current-photo-0"})
    assert device.screenshot() != before
    device.perform({"type": "swipe", "from": {"x": .2, "y": .5}, "to": {"x": .8, "y": .5}, "move_duration_ms": 300})
    assert device.screenshot() == before


def test_mock_pinch_changes_image_and_activate_does_not_reset():
    device = MockDevice()
    device.connect()
    device.perform({"type": "tap", "target": {**ELEMENT, "value": "photo-0"}})
    before = device.screenshot()
    device.perform({"type": "pinch", "target": POINT, "scale": 2, "velocity": 1})
    assert device.screenshot() != before
    device.perform({"type": "activate_app"})
    assert device.zoom == 2
    assert device.has_element(ELEMENT)
