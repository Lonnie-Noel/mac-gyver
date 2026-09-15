"""Versioned, JSON-only scenario validation shared by the UI and runner."""
from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path, PurePosixPath
import tempfile
from typing import Any

SCHEMA_VERSION = 1
MAX_STEPS = 2000
MAX_EXPANDED_STEPS = 100_000
MAX_REPEAT = 10_000
MAX_DURATION_MS = 3_600_000
STEP_TYPES = frozenset({
    "activate_app", "tap", "double_tap", "long_press", "swipe", "drag",
    "pinch", "rotate", "wait", "wait_element", "assert_element",
    "assert_image", "screenshot", "repeat",
})
ELEMENT_LOCATORS = frozenset({"accessibility_id", "predicate", "class_chain", "xpath"})
CHECK_TYPES = frozenset({"assert_element", "assert_image", "wait_element"})


class ValidationError(ValueError):
    """A scenario cannot be executed safely or interpreted unambiguously."""


def _fail(path: str, message: str) -> None:
    raise ValidationError(f"{path}: {message}")


def _json_value(value: Any, path: str = "scenario", depth: int = 0) -> None:
    if depth > 30:
        _fail(path, "JSON nesting is too deep")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail(path, "non-finite numbers are not allowed")
        return
    if isinstance(value, list):
        if len(value) > 10_000:
            _fail(path, "list is too large")
        for index, item in enumerate(value):
            _json_value(item, f"{path}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 1000 or any(not isinstance(key, str) for key in value):
            _fail(path, "object needs string keys and at most 1000 entries")
        for key, item in value.items():
            _json_value(item, f"{path}.{key}", depth + 1)
        return
    _fail(path, "only JSON values are supported")


def _object(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        _fail(path, "expected an object")
    return value


def _number(value: Any, path: str, minimum: float, maximum: float, *, integer: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "expected a number")
    if not minimum <= value <= maximum or (isinstance(value, float) and not math.isfinite(value)):
        _fail(path, f"must be between {minimum} and {maximum}")
    if integer and not isinstance(value, int):
        _fail(path, "expected an integer")
    return value


def _text(value: Any, path: str, max_length: int = 2048) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        _fail(path, f"expected non-empty text (maximum {max_length} characters)")
    return value


def _duration(step: dict, key: str, default: int, path: str, *, positive: bool = False) -> None:
    step.setdefault(key, default)
    limit = 60_000 if key in {"press_duration_ms", "move_duration_ms", "hold_duration_ms"} else MAX_DURATION_MS
    _number(step[key], f"{path}.{key}", 1 if positive else 0, limit, integer=True)


def validate_geometry(value: Any, path: str = "geometry") -> dict:
    geom = copy.deepcopy(_object(value, path))
    for dimension in ("width", "height"):
        _number(geom.get(dimension), f"{path}.{dimension}", 1, 100_000)
    orientation = _text(geom.get("orientation"), f"{path}.orientation", 80).upper()
    if orientation not in {"PORTRAIT", "PORTRAIT_UPSIDEDOWN", "LANDSCAPE", "LANDSCAPE_LEFT", "LANDSCAPE_RIGHT"}:
        _fail(f"{path}.orientation", "unsupported screen orientation")
    geom["orientation"] = orientation
    return geom


def _point(value: Any, path: str) -> dict:
    point = _object(value, path)
    for axis in ("x", "y"):
        _number(point.get(axis), f"{path}.{axis}", 0, 1)
    return point


def _target(value: Any, path: str, *, element_only: bool = False) -> None:
    target = _object(value, path)
    mode = target.get("mode")
    if mode == "normalized" and not element_only:
        _point(target, path)
    elif mode == "element":
        if not isinstance(target.get("by"), str) or target["by"] not in ELEMENT_LOCATORS:
            _fail(f"{path}.by", "unsupported element locator")
        _text(target.get("value"), f"{path}.value", 8192)
    else:
        _fail(f"{path}.mode", "expected element" if element_only else "expected normalized or element")


def _step(value: Any, path: str, *, in_repeat: bool = False) -> dict:
    step = _object(value, path)
    kind = step.get("type")
    if not isinstance(kind, str) or kind not in STEP_TYPES:
        _fail(f"{path}.type", "unsupported step type")
    if "name" in step:
        _text(step["name"], f"{path}.name", 240)
    if "geometry" in step:
        step["geometry"] = validate_geometry(step["geometry"], f"{path}.geometry")
    _duration(step, "after_delay_ms", 0, path)
    if kind == "repeat":
        if in_repeat:
            _fail(path, "nested repeat groups are not supported")
        _number(step.get("count"), f"{path}.count", 1, MAX_REPEAT, integer=True)
        _duration(step, "between_iterations_ms", 0, path)
        step["steps"] = _steps(step.get("steps"), f"{path}.steps", in_repeat=True)
        if not step["steps"]:
            _fail(f"{path}.steps", "repeat group is empty")
    elif kind == "activate_app":
        for key in ("app_profile", "bundle_id"):
            if key in step:
                _text(step[key], f"{path}.{key}", 240)
    elif kind in {"tap", "double_tap", "long_press", "pinch", "rotate"}:
        _target(step.get("target"), f"{path}.target")
        if kind == "long_press":
            _duration(step, "press_duration_ms", 1500, path, positive=True)
        elif kind == "pinch":
            step.setdefault("scale", 2.0)
            _number(step["scale"], f"{path}.scale", 0.1, 20)
            if step["scale"] == 1:
                _fail(f"{path}.scale", "scale must differ from 1")
            step.setdefault("velocity", 1.0)
            _number(step["velocity"], f"{path}.velocity", 0.01, 100)
            if abs(step["scale"] - 1) / step["velocity"] > 60:
                _fail(path, "pinch duration must not exceed 60 seconds")
        elif kind == "rotate":
            step.setdefault("angle_degrees", 90.0)
            _number(step["angle_degrees"], f"{path}.angle_degrees", -720, 720)
            if step["angle_degrees"] == 0:
                _fail(f"{path}.angle_degrees", "rotation must be nonzero")
            step.setdefault("velocity_degrees", 90.0)
            _number(step["velocity_degrees"], f"{path}.velocity_degrees", 0.1, 1440)
            if abs(step["angle_degrees"]) / step["velocity_degrees"] > 60:
                _fail(path, "rotation duration must not exceed 60 seconds")
    elif kind in {"swipe", "drag"}:
        _point(step.get("from"), f"{path}.from")
        _point(step.get("to"), f"{path}.to")
        _duration(step, "move_duration_ms", 300, path, positive=True)
        _duration(step, "press_duration_ms", 500 if kind == "drag" else 0, path)
        _duration(step, "hold_duration_ms", 0, path)
        if sum(step[key] for key in ("move_duration_ms", "press_duration_ms", "hold_duration_ms")) > 60_000:
            _fail(path, "one gesture must not exceed 60 seconds")
    elif kind == "wait":
        _duration(step, "duration_ms", 1000, path)
    elif kind in {"wait_element", "assert_element"}:
        _target(step.get("target"), f"{path}.target", element_only=True)
        step.setdefault("state", "visible")
        if not isinstance(step["state"], str) or step["state"] not in {"visible", "absent"}:
            _fail(f"{path}.state", "expected visible or absent")
        if kind == "wait_element":
            _duration(step, "timeout_ms", 5000, path)
            step.setdefault("poll_interval_ms", 200)
            _number(step["poll_interval_ms"], f"{path}.poll_interval_ms", 10, 10_000, integer=True)
    elif kind == "assert_image":
        baseline = _text(step.get("baseline"), f"{path}.baseline", 4096)
        posix = PurePosixPath(baseline)
        if posix.is_absolute() or ".." in posix.parts or "\\" in baseline or ":" in baseline or "\x00" in baseline:
            _fail(f"{path}.baseline", "use a relative path inside the scenario folder")
        region = step.setdefault("region", {"x": 0, "y": 0, "width": 1, "height": 1})
        _point(region, f"{path}.region")
        for axis, dimension in (("x", "width"), ("y", "height")):
            _number(region.get(dimension), f"{path}.region.{dimension}", 0.000001, 1)
            if region[axis] + region[dimension] > 1 + 1e-9:
                _fail(f"{path}.region", "region extends beyond the image")
        step.setdefault("tolerance", 0.03)
        _number(step["tolerance"], f"{path}.tolerance", 0, 1)
        step.setdefault("expected", "match")
        if not isinstance(step["expected"], str) or step["expected"] not in {"match", "different"}:
            _fail(f"{path}.expected", "expected match or different")
    return step


def _steps(value: Any, path: str, *, in_repeat: bool = False) -> list:
    if not isinstance(value, list) or len(value) > MAX_STEPS:
        _fail(path, f"expected a list of at most {MAX_STEPS} steps")
    return [_step(item, f"{path}[{index}]", in_repeat=in_repeat) for index, item in enumerate(value)]


def expanded_count(steps: list[dict]) -> int:
    return sum(step["count"] * len(step["steps"]) if step["type"] == "repeat" else 1 for step in steps)


def new_scenario(name: str = "새 시나리오") -> dict:
    return {"schema_version": SCHEMA_VERSION, "name": name, "app_profile": "photos",
            "device_profile": "", "on_failure": "stop", "setup": [], "steps": []}


def validate_step(step: Any) -> dict:
    _json_value(step, "step")
    normalized = _step(copy.deepcopy(step), "step")
    if expanded_count([normalized]) > MAX_EXPANDED_STEPS:
        _fail("step", "expanded step limit exceeded")
    return normalized


def validate_scenario(data: Any) -> dict:
    _json_value(data)
    result = copy.deepcopy(_object(data, "scenario"))
    if isinstance(result.get("schema_version"), bool) or result.get("schema_version") != SCHEMA_VERSION:
        _fail("schema_version", "only integer schema version 1 is supported")
    if not isinstance(result.get("schema_version"), int):
        _fail("schema_version", "expected integer 1")
    _text(result.get("name"), "name", 240)
    result.setdefault("app_profile", "photos")
    _text(result["app_profile"], "app_profile", 240)
    if "app_bundle_id" in result:
        _text(result["app_bundle_id"], "app_bundle_id", 240)
    result.setdefault("device_profile", "")
    if not isinstance(result["device_profile"], str):
        _fail("device_profile", "expected text")
    result.setdefault("on_failure", "stop")
    if result["on_failure"] != "stop":
        _fail("on_failure", "only stop policy is supported")
    if "geometry" in result:
        result["geometry"] = validate_geometry(result["geometry"])
    result["setup"] = _steps(result.get("setup", []), "setup")
    result["steps"] = _steps(result.get("steps", []), "steps")
    if "precondition" in result:
        result["precondition"] = _step(result["precondition"], "precondition")
        if result["precondition"]["type"] not in {"assert_element", "assert_image"}:
            _fail("precondition", "only assert_element or assert_image is supported")
    if expanded_count(result["setup"]) + expanded_count(result["steps"]) > MAX_EXPANDED_STEPS:
        _fail("scenario", "expanded step limit exceeded")
    return result


def load_scenario(path: str | Path) -> dict:
    file_path = Path(path)
    if file_path.stat().st_size > 10_000_000:
        raise ValidationError("Scenario file exceeds 10 MB")
    try:
        with file_path.open(encoding="utf-8") as stream:
            data = json.load(stream)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValidationError(f"Invalid scenario JSON: {exc}") from exc
    return validate_scenario(data)


def save_scenario(data: dict, path: str | Path) -> None:
    """Atomically save metadata and relative asset references without rewriting them."""
    normalized = validate_scenario(data)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(normalized, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
