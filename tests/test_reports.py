import json
from pathlib import Path

from mac_gyver.reports import create_run_dir, safe_filename, write_report


def test_report_escapes_content_and_labels_simulation(tmp_path):
    run_dir = create_run_dir(tmp_path, '../../<script>alert(1)</script>')
    assert run_dir.parent == tmp_path.resolve()
    report = {
        "name": '<script>alert("name")</script>', "status": "passed", "simulated": True,
        "partial_verification": True, "checks": 1, "scenario": {"name": "<iframe>"},
        "results": [{"path": "steps/1", "type": "assert_element", "status": "passed",
                     "error": '<img src=x onerror="alert(1)">', "screenshot": "../../escape.png"}],
    }
    result = write_report(report, run_dir)
    document = Path(result["html_path"]).read_text()
    assert "<script>" not in document and '<img src=x' not in document
    assert "&lt;script&gt;" in document
    assert "모의 기기 실행" in document and "검사 없는 동작" in document
    assert "../../escape.png" not in document
    assert json.loads(Path(result["json_path"]).read_text())["name"] == report["name"]


def test_capture_link_remains_relative_and_names_never_escape(tmp_path):
    run_dir = create_run_dir(tmp_path, "보고서")
    (run_dir / "screenshots" / "사진.png").write_bytes(b"image")
    result = write_report({"name": "x", "results": [{"screenshot": "screenshots/사진.png", "status": "unchecked"}]}, run_dir)
    assert 'href="screenshots/%EC%82%AC%EC%A7%84.png"' in Path(result["html_path"]).read_text()
    assert "/" not in safe_filename("../../../../outside")
    assert safe_filename("....") == "capture"
