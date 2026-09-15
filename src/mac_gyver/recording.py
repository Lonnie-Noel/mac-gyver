"""Recording clock and portable scenario assets, independent of Qt."""

import copy
import hashlib
import os
from pathlib import Path
import shutil
import sys
import time
import uuid


def application_dir():
    if override := os.environ.get("MAC_GYVER_DATA_DIR"):
        base = Path(override).expanduser()
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Application Support/mac-gyver"
    else:
        base = Path.home() / ".local/share/mac-gyver"
    base.mkdir(parents=True, exist_ok=True)
    return base


class RecordingClock:
    """Only counts ready time; device execution and property editing are excluded."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.accumulated = 0.0
        self.started = None

    def resume(self):
        if self.started is None:
            self.started = self.clock()

    def pause(self):
        if self.started is not None:
            self.accumulated += max(0.0, self.clock() - self.started)
            self.started = None

    def reset(self):
        self.started = None
        self.accumulated = 0.0

    def take_ms(self):
        self.pause()
        value = round(self.accumulated * 1000)
        self.reset()
        return value


def workspace():
    directory = application_dir() / "drafts" / uuid.uuid4().hex
    directory.mkdir(parents=True)
    return directory


def walk_steps(scenario):
    if scenario.get("precondition"):
        yield scenario["precondition"]
    for key in ("setup", "steps"):
        for step in scenario.get(key, []):
            yield step
            if step.get("type") == "repeat":
                yield from step.get("steps", [])


def save_project(scenario, destination, asset_root):
    from .models import save_scenario, validate_scenario
    result = validate_scenario(copy.deepcopy(scenario))
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    base = Path(asset_root).resolve()
    for step in walk_steps(result):
        if step.get("type") != "assert_image":
            continue
        source = (base / step["baseline"]).resolve()
        if not source.is_relative_to(base) or not source.is_file():
            raise ValueError(f"기준 이미지를 찾을 수 없습니다: {step['baseline']}")
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()[:16]
        target = destination.parent / (destination.stem + ".assets") / (digest + ".png")
        target.parent.mkdir(parents=True, exist_ok=True)
        if source != target.resolve():
            shutil.copyfile(source, target)
        step["baseline"] = target.relative_to(destination.parent).as_posix()
    save_scenario(result, destination)
    return result
