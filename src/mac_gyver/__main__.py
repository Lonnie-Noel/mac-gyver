"""Desktop entry point and headless scenario runner."""

import argparse
import json
from pathlib import Path
import signal
import sys

from . import __version__


def main(argv=None):
    parser = argparse.ArgumentParser(description="mac-gyver · iPhone gesture recording and replay")
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--demo", action="store_true", help="use an explicitly simulated offline device")
    parser.add_argument("--diagnose", action="store_true", help="print read-only host/device diagnostics")
    parser.add_argument("--run", metavar="SCENARIO", help="run a scenario without opening the GUI")
    parser.add_argument("--config", metavar="JSON", help="connection configuration")
    parser.add_argument("--output", metavar="DIR", help="report output root")
    parser.add_argument("--cycles", type=int, default=1, help="repeat the test section; setup runs once")
    parser.add_argument("--skip-setup", action="store_true", help="skip setup steps (start guard still applies)")
    args = parser.parse_args(argv)
    from .recording import application_dir
    config_path = Path(args.config).expanduser() if args.config else application_dir() / "config.json"
    config = {}
    try:
        if args.config or config_path.is_file():
            config = json.loads(config_path.read_text(encoding="utf-8"))
            if not isinstance(config, dict):
                raise ValueError("연결 설정 JSON은 객체여야 합니다.")
        if args.diagnose:
            from .diagnostics import run_diagnostics, discover_devices
            result = {"diagnostics": run_diagnostics(config.get("server_url", "http://127.0.0.1:4723")),
                      "devices": discover_devices()}
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0 if not any(row["status"] == "error" for row in result["diagnostics"]) else 1
        if args.run:
            from .device import AppiumDevice
            from .mock_device import MockDevice
            from .models import load_scenario
            from .engine import Runner
            path = Path(args.run).expanduser().resolve()
            scenario = load_scenario(path)
            device = MockDevice(config) if args.demo else AppiumDevice(config)
            try:
                device.connect()
                runner = Runner(device, Path(args.output).expanduser() if args.output else application_dir()/"reports", asset_root=path.parent)
                previous = signal.getsignal(signal.SIGINT)
                signal.signal(signal.SIGINT, lambda *_: runner.stop())
                try:
                    result = runner.run(scenario, run_setup=not args.skip_setup, cycles=args.cycles)
                finally:
                    signal.signal(signal.SIGINT, previous)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return {"passed": 0, "unchecked": 2, "stopped": 130}.get(result["status"], 1)
            finally:
                device.close()
        from PySide6.QtWidgets import QApplication
        from .ui.main_window import MainWindow
        app = QApplication.instance() or QApplication([sys.argv[0]])
        app.setApplicationName("mac-gyver")
        app.setOrganizationName("mac-gyver")
        window = MainWindow(config=config, demo=args.demo)
        window.show()
        return app.exec()
    except (ValueError, OSError, RuntimeError) as exc:
        print(f"mac-gyver: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
