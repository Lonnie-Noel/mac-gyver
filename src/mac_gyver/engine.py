"""Sequential, cancellable execution independent of Qt and Appium.

Only host-side waits can be interrupted. An already dispatched device command is
allowed to return; stopping prevents any further device commands, including captures.
"""
from __future__ import annotations

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import threading
import time
from typing import Any, Callable

from PIL import Image, ImageChops, ImageStat

from .models import (
    CHECK_TYPES, MAX_EXPANDED_STEPS, MAX_REPEAT, ValidationError,
    expanded_count, validate_geometry, validate_scenario,
)
from .reports import create_run_dir, json_safe, safe_filename, utc_now, write_report


class RunStopped(Exception):
    """Internal control flow for a user-requested stop."""


class CheckFailed(AssertionError):
    """An explicit assertion did not match the current device state."""


class GeometryMismatch(RuntimeError):
    """Recorded coordinates must not be used with a different screen geometry."""


class Runner:
    def __init__(self, backend: Any, output_root: str | Path,
                 on_event: Callable[[dict], None] | None = None,
                 asset_root: str | Path | None = None):
        self.backend = backend
        self.output_root = Path(output_root)
        self.on_event = on_event
        self.asset_root = Path(asset_root).resolve() if asset_root is not None else None
        self._condition = threading.Condition()
        self._stop = threading.Event()
        self._paused = False
        self._run_lock = threading.Lock()
        self._run_dir: Path | None = None
        self._geometry: dict | None = None
        self._results: list[dict] = []
        self._capture_index = 0
        self._paused_seconds = 0.0

    def _emit(self, kind: str, **values: Any) -> None:
        if self.on_event is not None:
            try:
                self.on_event({"kind": kind, **json_safe(values)})
            except Exception:
                # Presentation callbacks cannot turn a successful gesture into a retry.
                pass

    def pause(self) -> None:
        with self._condition:
            self._paused = True
            self._condition.notify_all()
        self._emit("state", state="pausing", message="현재 명령이 끝난 뒤 일시정지합니다.")

    def resume(self) -> None:
        with self._condition:
            self._paused = False
            self._condition.notify_all()
        self._emit("state", state="running")

    def stop(self) -> None:
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        self._emit("state", state="stopping", message="전달된 명령은 끝날 수 있으며 새 명령은 전송하지 않습니다.")

    def _checkpoint(self) -> None:
        announced = False
        pause_started = None
        with self._condition:
            while self._paused and not self._stop.is_set():
                if not announced:
                    pause_started = time.monotonic()
                    self._emit("state", state="paused")
                    announced = True
                self._condition.wait()
            if pause_started is not None:
                self._paused_seconds += time.monotonic() - pause_started
            if self._stop.is_set():
                raise RunStopped("사용자가 실행을 중단했습니다.")

    def _active_time(self) -> float:
        return time.monotonic() - self._paused_seconds

    def _sleep(self, duration_ms: int) -> None:
        remaining = duration_ms / 1000.0
        self._checkpoint()
        while remaining > 0:
            self._checkpoint()
            with self._condition:
                if self._stop.is_set():
                    raise RunStopped("사용자가 대기 중 실행을 중단했습니다.")
                if self._paused:
                    continue
                start = time.monotonic()
                self._condition.wait(timeout=min(remaining, 0.05))
                remaining -= time.monotonic() - start
        self._checkpoint()

    def _call(self, method: str, *args: Any) -> Any:
        self._checkpoint()
        return getattr(self.backend, method)(*args)

    @staticmethod
    def _coordinates_used(step: dict) -> bool:
        return step["type"] in {"swipe", "drag", "assert_image"} or step.get("target", {}).get("mode") == "normalized"

    def _check_geometry(self, step: dict | None = None) -> None:
        expected = (step or {}).get("geometry") or self._geometry
        current = validate_geometry(self._call("geometry"), "device.geometry")
        if expected is None:
            self._geometry = current
            return
        if any(current[key] != expected[key] for key in ("width", "height", "orientation")):
            raise GeometryMismatch(
                "화면 크기 또는 방향이 기록할 때와 다릅니다. "
                f"기록: {expected['width']}×{expected['height']} {expected['orientation']}; "
                f"현재: {current['width']}×{current['height']} {current['orientation']}. "
                "원래 방향으로 맞추고 다시 실행하세요."
            )

    def _save_capture(self, png: bytes, name: str) -> str:
        if self._run_dir is None:
            raise RuntimeError("Run directory has not been initialized")
        self._decode_png(png)  # Validate before saving an artifact as .png.
        self._capture_index += 1
        relative = Path("screenshots") / f"{self._capture_index:05d}_{safe_filename(name)}.png"
        (self._run_dir / relative).write_bytes(png)
        return relative.as_posix()

    @staticmethod
    def _decode_png(png: bytes) -> Image.Image:
        if not isinstance(png, bytes) or len(png) > 100_000_000:
            raise ValueError("Expected screenshot PNG bytes of at most 100 MB")
        with Image.open(BytesIO(png)) as image:
            if image.format != "PNG" or image.width * image.height > 50_000_000:
                raise ValueError("Expected PNG image with at most 50 million pixels")
            image.load()
            return image.convert("RGB")

    def _save_image(self, image: Image.Image, name: str) -> str:
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return self._save_capture(buffer.getvalue(), name)

    def _assert_image(self, step: dict, result: dict) -> dict:
        if self.asset_root is None:
            raise ValueError("이미지 기준 파일을 사용하려면 시나리오를 저장하고 asset_root를 지정하세요.")
        baseline_path = (self.asset_root / step["baseline"]).resolve()
        if not baseline_path.is_relative_to(self.asset_root):
            raise ValueError("기준 이미지는 시나리오 폴더 안에 있어야 합니다.")
        if baseline_path.stat().st_size > 100_000_000:
            raise ValueError("Baseline PNG exceeds 100 MB")
        baseline = self._decode_png(baseline_path.read_bytes())
        screenshot = self._call("screenshot")
        current = self._decode_png(screenshot)
        result["screenshot"] = self._save_capture(screenshot, "image_check")
        if baseline.size != current.size:
            raise CheckFailed(f"기준 이미지 크기 {baseline.size}와 현재 이미지 크기 {current.size}가 다릅니다.")
        region = step["region"]
        width, height = current.size
        left, top = int(region["x"] * width), int(region["y"] * height)
        right = min(width, max(left + 1, round((region["x"] + region["width"]) * width)))
        bottom = min(height, max(top + 1, round((region["y"] + region["height"]) * height)))
        box = (left, top, right, bottom)
        reference_crop, current_crop = baseline.crop(box), current.crop(box)
        error = sum(ImageStat.Stat(ImageChops.difference(reference_crop, current_crop)).mean) / (3 * 255)
        matches = error <= step["tolerance"]
        observations = {"metric": "mean_absolute_rgb_difference", "difference": error,
                        "tolerance": step["tolerance"], "expected": step["expected"], "region": region}
        result["observations"] = observations
        result["actual_image"] = self._save_image(current_crop, "actual_region")
        result["baseline_image"] = self._save_image(reference_crop, "baseline_region")
        if matches != (step["expected"] == "match"):
            raise CheckFailed(f"이미지 조건 불만족: 차이 {error:.5f}, 허용값 {step['tolerance']:.5f}, 기대 {step['expected']}")
        return observations

    def _element_state(self, step: dict) -> bool:
        visible = bool(self._call("has_element", step["target"]))
        return visible == (step["state"] == "visible")

    def _perform(self, step: dict, result: dict, scenario: dict) -> dict:
        kind = step["type"]
        if self._coordinates_used(step):
            self._check_geometry(step)
        if kind == "wait":
            self._sleep(step["duration_ms"])
            return {"wait_duration_ms": step["duration_ms"]}
        if kind == "wait_element":
            deadline = self._active_time() + step["timeout_ms"] / 1000
            while True:
                if self._element_state(step):
                    return {"state": step["state"], "condition_met": True}
                remaining = deadline - self._active_time()
                if remaining <= 0:
                    raise TimeoutError(f"{step['timeout_ms']}ms 안에 요소의 {step['state']} 상태를 확인하지 못했습니다.")
                self._sleep(min(step["poll_interval_ms"], max(1, int(remaining * 1000))))
        if kind == "assert_element":
            if not self._element_state(step):
                raise CheckFailed(f"요소의 기대 상태({step['state']})와 현재 상태가 다릅니다.")
            return {"state": step["state"], "condition_met": True}
        if kind == "assert_image":
            return self._assert_image(step, result)
        if kind == "screenshot":
            png = self._call("screenshot")
            result["screenshot"] = self._save_capture(png, step.get("name", "capture"))
            return {"capture_saved": True}
        command = deepcopy(step)
        if kind == "activate_app":
            command.setdefault("app_profile", scenario["app_profile"])
        observation = self._call("perform", command)
        if kind == "activate_app":
            self._check_geometry(step)
        return json_safe(observation) if isinstance(observation, dict) else {"response": json_safe(observation)}

    def _failure_capture(self, result: dict) -> None:
        if "screenshot" in result or self._stop.is_set():
            return
        try:
            result["screenshot"] = self._save_capture(self._call("screenshot"), "failure")
        except RunStopped:
            result["screenshot_error"] = "중단 요청으로 추가 캡처를 보내지 않았습니다."
        except Exception as exc:
            result["screenshot_error"] = f"{type(exc).__name__}: {exc}"

    def _execute_step(self, step: dict, path: str, phase: str, scenario: dict) -> str:
        self._checkpoint()
        started = time.monotonic()
        result = {"path": path, "phase": phase, "type": step["type"], "step": deepcopy(step),
                  "started_at": utc_now(), "status": "unchecked"}
        self._emit("step_start", path=path, step=step, phase=phase)
        try:
            result["observations"] = self._perform(step, result, scenario)
            if step["type"] in CHECK_TYPES:
                result["status"] = "passed"
            self._sleep(step["after_delay_ms"])
        except RunStopped as exc:
            result.update(status="stopped", message=str(exc))
        except CheckFailed as exc:
            result.update(status="failed", error=str(exc), error_type=type(exc).__name__)
            self._failure_capture(result)
        except Exception as exc:
            result.update(status="error", error=str(exc), error_type=type(exc).__name__)
            self._failure_capture(result)
        result.update(finished_at=utc_now(), duration_ms=round((time.monotonic() - started) * 1000, 3))
        self._results.append(result)
        self._emit("step_finish", path=path, result=result)
        return result["status"]

    def _execute_steps(self, steps: list[dict], path: str, phase: str, scenario: dict) -> str | None:
        for index, step in enumerate(steps):
            self._checkpoint()
            step_path = f"{path}/{index + 1}"
            if step["type"] == "repeat":
                for iteration in range(step["count"]):
                    self._checkpoint()
                    status = self._execute_steps(step["steps"], f"{step_path}/repeat/{iteration + 1}", phase, scenario)
                    if status:
                        return status
                    if iteration + 1 < step["count"]:
                        self._sleep(step["between_iterations_ms"])
                self._sleep(step["after_delay_ms"])
            else:
                status = self._execute_step(step, step_path, phase, scenario)
                if status in {"failed", "error", "stopped"}:
                    return status
        return None

    def run(self, scenario: dict, run_setup: bool = True, cycles: int = 1) -> dict:
        if not self._run_lock.acquire(blocking=False):
            raise RuntimeError("이 Runner에서는 이미 실행 중입니다.")
        start = time.monotonic()
        report: dict = {"name": scenario.get("name", "실행") if isinstance(scenario, dict) else "실행",
                        "started_at": utc_now(), "status": "error", "results": [], "scenario": json_safe(scenario)}
        self._results = []
        self._capture_index = 0
        self._paused_seconds = 0.0
        self._geometry = None
        self._run_dir = None
        try:
            self._run_dir = create_run_dir(self.output_root, report["name"])
            validated = validate_scenario(scenario)
            if not isinstance(run_setup, bool):
                raise ValidationError("run_setup must be a boolean")
            if isinstance(cycles, bool) or not isinstance(cycles, int) or not 1 <= cycles <= MAX_REPEAT:
                raise ValidationError(f"cycles must be an integer between 1 and {MAX_REPEAT}")
            planned = expanded_count(validated["steps"]) * cycles
            planned += expanded_count(validated["setup"]) if run_setup else 0
            planned += 1 if "precondition" in validated else 0
            if planned > MAX_EXPANDED_STEPS:
                raise ValidationError(f"run expands to more than {MAX_EXPANDED_STEPS} steps")
            report.update(scenario=validated, planned_steps=planned, cycles=cycles, run_setup=run_setup)
            self._emit("state", state="running", planned_steps=planned)
            self._checkpoint()
            report["device"] = json_safe(self._call("metadata"))
            if not isinstance(report["device"], dict):
                raise RuntimeError("연결된 기기의 메타데이터를 확인하지 못했습니다.")
            report["simulated"] = bool(report["device"].get("simulated", False))
            expected_bundle = validated.get("app_bundle_id")
            if expected_bundle is not None:
                connected_bundle = report["device"].get("bundle_id")
                if connected_bundle != expected_bundle:
                    raise RuntimeError(
                        "시나리오를 기록한 앱과 현재 연결된 앱이 다릅니다. "
                        f"기록: {expected_bundle}; 연결: {connected_bundle or '앱 식별자 확인 불가'}. "
                        "기록한 앱의 bundle ID로 연결한 뒤 다시 실행하세요."
                    )
            self._geometry = validated.get("geometry")
            self._check_geometry()
            report["geometry"] = deepcopy(self._geometry)
            terminal = None
            if "precondition" in validated:
                status = self._execute_step(validated["precondition"], "precondition", "precondition", validated)
                terminal = status if status in {"failed", "error", "stopped"} else None
            if terminal is None and run_setup:
                terminal = self._execute_steps(validated["setup"], "setup", "setup", validated)
            if terminal is None:
                for cycle in range(cycles):
                    self._checkpoint()
                    terminal = self._execute_steps(validated["steps"], f"cycle/{cycle + 1}/steps", "steps", validated)
                    if terminal:
                        break
            # Precondition/setup checks do not establish successful task outcomes.
            checks = sum(result["type"] in CHECK_TYPES and result["phase"] == "steps" for result in self._results)
            report["status"] = terminal or ("passed" if checks else "unchecked")
            if terminal in {"failed", "error"} and self._results:
                report["error"] = self._results[-1].get("error", terminal)
            if self._stop.is_set() and terminal is None:
                report["status"] = "stopped"
        except RunStopped as exc:
            report.update(status="stopped", error=str(exc))
        except Exception as exc:
            report.update(status="error", error=f"{type(exc).__name__}: {exc}")
        finally:
            report["results"] = self._results
            report["checks"] = sum(result["type"] in CHECK_TYPES and result["phase"] == "steps" for result in self._results)
            report["setup_checks"] = sum(result["type"] in CHECK_TYPES and result["phase"] != "steps" for result in self._results)
            report["unchecked_steps"] = sum(result["status"] == "unchecked" for result in self._results)
            report["partial_verification"] = report["checks"] > 0 and report["unchecked_steps"] > 0
            report.update(finished_at=utc_now(), duration_ms=round((time.monotonic() - start) * 1000, 3))
            if self._run_dir is not None:
                try:
                    report = write_report(report, self._run_dir)
                except Exception as exc:
                    report.update(report_error=f"{type(exc).__name__}: {exc}", run_dir=str(self._run_dir))
                    report["status"] = "error"
                    self._emit("log", message=f"보고서 저장 실패: {exc}")
            self._stop.clear()
            with self._condition:
                self._paused = False
            self._run_lock.release()
            self._emit("run_finished", result=report, status=report["status"])
        return report
