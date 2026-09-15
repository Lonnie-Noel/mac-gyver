"""Local, self-contained run reports with escaped content and safe filenames."""
from __future__ import annotations

from datetime import datetime, timezone
import html
import json
import math
from pathlib import Path
import re
import unicodedata
import uuid
from typing import Any
from urllib.parse import quote

STATUS_LABELS = {
    "passed": "통과", "failed": "실패", "error": "실행 오류",
    "unchecked": "검사 없음", "stopped": "중단",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def safe_filename(value: str, fallback: str = "capture", max_length: int = 80) -> str:
    """Never let user-controlled names create paths or hidden filenames."""
    normalized = unicodedata.normalize("NFKC", str(value))
    normalized = re.sub(r"[^\w-]+", "_", normalized, flags=re.UNICODE).strip("_.-")
    return normalized[:max_length].rstrip("_.-") or fallback


def create_run_dir(output_root: str | Path, name: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    run_dir = Path(output_root).expanduser().resolve() / f"{stamp}_{safe_filename(name)}_{uuid.uuid4().hex[:6]}"
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "screenshots").mkdir()
    return run_dir


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return str(value)


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _json(value: Any) -> str:
    return _escape(json.dumps(json_safe(value), ensure_ascii=False, indent=2))


def _capture_link(relative: Any, run_dir: Path, label: str) -> str:
    if not isinstance(relative, str):
        return ""
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        return ""
    resolved = (run_dir / path).resolve()
    if not resolved.is_relative_to(run_dir.resolve()) or not resolved.is_file():
        return ""
    href = _escape(quote(path.as_posix(), safe="/"))
    return f'<a href="{href}">{_escape(label)}</a>'


def render_html(report: dict, run_dir: str | Path) -> str:
    run_dir = Path(run_dir)
    rows = []
    for result in report.get("results", []):
        status = str(result.get("status", "error"))
        css = status if status in STATUS_LABELS else "error"
        links = []
        for key, label in (("screenshot", "화면"), ("actual_image", "비교 영역"), ("baseline_image", "기준 영역")):
            link = _capture_link(result.get(key), run_dir, label)
            if link:
                links.append(link)
        diagnostic = result.get("error") or result.get("message") or ""
        details = {key: result[key] for key in ("step", "observations", "screenshot_error") if key in result}
        rows.append(
            f'<tr><td>{_escape(result.get("path", ""))}</td>'
            f'<td>{_escape(result.get("type", ""))}</td>'
            f'<td class="{css}">{_escape(STATUS_LABELS.get(status, status))}</td>'
            f'<td>{_escape(result.get("duration_ms", ""))}</td>'
            f'<td>{_escape(diagnostic)}<br>{" · ".join(links)}'
            f'<details><summary>설정과 관측값</summary><pre>{_json(details)}</pre></details></td></tr>'
        )
    status = str(report.get("status", "error"))
    title = report.get("name", "mac-gyver 실행 결과")
    summary = {
        "시작 (UTC)": report.get("started_at"), "종료 (UTC)": report.get("finished_at"),
        "호스트 관측 소요 시간(ms)": report.get("duration_ms"),
        "실행 단계 수": len(report.get("results", [])),
        "본문 검사 수": report.get("checks", 0), "검사 없는 단계 수": report.get("unchecked_steps", 0),
        "기기": report.get("device", {}),
    }
    banner = ""
    if report.get("simulated"):
        banner += '<p class="notice">모의 기기 실행입니다. 실제 아이폰 검증 결과가 아닙니다.</p>'
    if report.get("partial_verification"):
        banner += '<p class="notice">지정한 검사 조건만 확인했습니다. 검사 없는 동작의 기능 성공은 보장하지 않습니다.</p>'
    if report.get("error"):
        banner += f'<p class="error">{_escape(report["error"])}</p>'
    return f'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;">
<title>{_escape(title)} — mac-gyver</title>
<style>body{{font-family:system-ui,sans-serif;color:#1c2838;background:#f5f7fb;margin:32px auto;max-width:1160px;padding:0 20px}}
h1{{font-size:28px}}table{{width:100%;border-collapse:collapse;background:white}}td,th{{padding:12px;border-bottom:1px solid #dde3ed;text-align:left;vertical-align:top}}
pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf1f7;padding:14px;font-size:12px}}.passed{{color:#086845}}.failed,.error{{color:#b51d36}}.unchecked,.stopped{{color:#75520a}}
.notice{{background:#fff2d1;padding:14px;border-radius:8px}}a{{color:#194db1}}summary{{cursor:pointer;margin-top:8px}}footer{{margin-top:24px;color:#57637a}}</style></head>
<body><h1>{_escape(title)}</h1><p>결과: <strong>{_escape(STATUS_LABELS.get(status, status))}</strong></p>{banner}
<pre>{_json(summary)}</pre><table><thead><tr><th>단계</th><th>동작</th><th>상태</th><th>시간(ms)</th><th>결과</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table>
<details><summary>전체 시나리오</summary><pre>{_json(report.get("scenario", {}))}</pre></details>
<footer>시간은 Mac 호스트에서 관측한 명령 실행 시간입니다. 실제 터치 시각 또는 렌더링 성능을 측정한 값이 아닙니다. 이미지 차이만으로 사진의 의미나 동일성을 판정하지 않습니다.</footer></body></html>'''


def write_report(report: dict, run_dir: str | Path) -> dict:
    """Write JSON first, then HTML; return a JSON-serializable report including paths."""
    run_dir = Path(run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    output = json_safe(report)
    output.update({"run_dir": str(run_dir), "json_path": str(run_dir / "result.json"), "html_path": str(run_dir / "report.html")})
    Path(output["json_path"]).write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    Path(output["html_path"]).write_text(render_html(output, run_dir), encoding="utf-8")
    return output
