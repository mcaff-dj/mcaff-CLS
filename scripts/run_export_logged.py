#!/usr/bin/env python3
"""Thin wrapper so the Scheduled Task action is a plain script invocation with
discrete arguments, and every run (including exceptions) is appended to a log
file - same shape as run-export-logged.ps1's wrapper around
export-resolved-tickets.ps1.
"""
import argparse
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-token", required=True)
    parser.add_argument("--tab-name", required=True)
    parser.add_argument("--log-path", required=True)
    args = parser.parse_args()

    log_path = Path(args.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with open(log_path, "a", encoding="utf-8") as log:
        stamp = datetime.now().astimezone().isoformat()
        log.write(f"[{stamp}] wrapper started, script_dir={HERE}, PID={__import__('os').getpid()}\n")
        log.flush()
        try:
            result = subprocess.run(
                [sys.executable, str(HERE / "export_resolved_tickets.py"),
                 "--api-token", args.api_token, "--tab-name", args.tab_name],
                capture_output=True, text=True,
            )
            log.write(result.stdout)
            if result.stderr:
                log.write(result.stderr)
            log.flush()
        except Exception:
            log.write(traceback.format_exc())
            log.flush()


if __name__ == "__main__":
    main()
