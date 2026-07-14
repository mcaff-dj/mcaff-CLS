#!/usr/bin/env python3
"""Orchestrator: regenerates every brand's report at the repo root.
Run locally or from GitHub Actions. Requires a credential source (see lib.py):
  CI    -> GOOGLE_SA_KEY_JSON env var (GitHub secret)
  local -> GOOGLE_SA_KEY_FILE env var or the default dev key path.
"""
import argparse
import subprocess
import sys
from pathlib import Path

from brands import BRANDS

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    args = parser.parse_args()

    for i, brand in enumerate(BRANDS):
        print(f"=== Generating {brand['brand']} ===")
        cmd = [sys.executable, str(HERE / "generate_report.py"), "--brand-index", str(i)]
        if args.quick:
            cmd.append("--quick")
        subprocess.run(cmd, check=True)
    print("All reports regenerated.")


if __name__ == "__main__":
    main()
