import json

import pytest

from mac_gyver.models import ValidationError, load_scenario, new_scenario, save_scenario, validate_scenario, validate_step


def test_normalized_copy_keeps_asset_references_and_metadata(tmp_path):
    source = new_scenario("사진 변경")
    source["editor"] = {"selected": 2, "description": "내 기준 사진"}
    source["steps"] = [{"type": "assert_image", "baseline": "assets/기준.png"}]
    normalized = validate_scenario(source)
    assert "tolerance" not in source["steps"][0]
    assert normalized["steps"][0]["tolerance"] == 0.03
    path = tmp_path / "scenario.json"
    save_scenario(source, path)
    assert load_scenario(path) == normalized
    assert json.loads(path.read_text())["editor"] == source["editor"]
    assert load_scenario(path)["steps"][0]["baseline"] == "assets/기준.png"


@pytest.mark.parametrize("step", [
    {"type": "tap", "target": {"mode": "normalized", "x": True, "y": 0}},
    {"type": "tap", "target": {"mode": "normalized", "x": float("nan"), "y": 0}},
    {"type": "tap", "target": {"mode": "normalized", "x": 1.01, "y": 0}},
    {"type": "wait", "duration_ms": -1},
    {"type": "wait", "duration_ms": 1.2},
    {"type": "wait", "duration_ms": 10**1000},
    {"type": "repeat", "count": True, "steps": [{"type": "wait"}]},
    {"type": "repeat", "count": 1, "steps": [{"type": "repeat", "count": 1, "steps": [{"type": "wait"}]}]},
    {"type": "repeat", "count": 1, "steps": []},
    {"type": "python", "code": "print('must not run')"},
    {"type": "assert_image", "baseline": "../outside.png"},
    {"type": "assert_image", "baseline": "/outside.png"},
    {"type": "assert_image", "baseline": "C:\\outside.png"},
    {"type": "assert_image", "baseline": "image.png", "region": {"x": .8, "y": 0, "width": .3, "height": 1}},
    {"type": "assert_image", "baseline": "image.png", "expected": []},
    {"type": "assert_element", "target": {"mode": "element", "by": [], "value": "x"}},
    {"type": "assert_element", "target": {"mode": "element", "by": "xpath", "value": "x"}, "state": []},
])
def test_rejects_ambiguous_or_unsafe_step(step):
    with pytest.raises(ValidationError):
        validate_step(step)


def test_repeat_expansion_is_bounded_without_expanding():
    data = new_scenario()
    data["steps"] = [{"type": "repeat", "count": 10_000, "steps": [{"type": "wait"}] * 11}]
    with pytest.raises(ValidationError, match="expanded"):
        validate_scenario(data)


def test_gesture_velocity_units_and_total_time():
    rotate = validate_step({"type": "rotate", "target": {"mode": "normalized", "x": .5, "y": .5}, "angle_degrees": -90})
    assert rotate["velocity_degrees"] == 90
    pinch = validate_step({"type": "pinch", "target": {"mode": "normalized", "x": .5, "y": .5}, "scale": .5})
    assert pinch["velocity"] == 1
    with pytest.raises(ValidationError, match="60 seconds"):
        validate_step({"type": "drag", "from": {"x": 0, "y": 0}, "to": {"x": 1, "y": 1},
                       "press_duration_ms": 40_000, "move_duration_ms": 30_000})


def test_geometry_and_version_validation():
    data = new_scenario()
    data["geometry"] = {"width": 390, "height": 844, "orientation": "portrait"}
    assert validate_scenario(data)["geometry"]["orientation"] == "PORTRAIT"
    for version in (True, 1.0, "1", 2):
        data["schema_version"] = version
        with pytest.raises(ValidationError):
            validate_scenario(data)


def test_malformed_json_is_validation_error(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text('{"schema_version":')
    with pytest.raises(ValidationError):
        load_scenario(path)


def test_optional_app_bundle_id_preserved_and_validated():
    data = new_scenario()
    assert "app_bundle_id" not in validate_scenario(data)
    data["app_bundle_id"] = "com.example.photos"
    assert validate_scenario(data)["app_bundle_id"] == "com.example.photos"
    for invalid in (None, True, 123, "", "   ", [], {}):
        data["app_bundle_id"] = invalid
        with pytest.raises(ValidationError, match="app_bundle_id"):
            validate_scenario(data)
