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
    parser.add_argument("--serial", action="store_true",
                        help="Generate brands one at a time (lower peak memory; the old behaviour).")
    parser.add_argument("--refresh-nps", action="store_true",
                        help="Re-query the NPS tables rather than reusing each brand's NPS cache. "
                             "Passed straight through to generate_report.py.")
    args = parser.parse_args()

    # The brands are fully independent - separate spreadsheets, separate MySQL tables,
    # separate output files - and each spends most of its time blocked on Sheets/MySQL I/O,
    # so running them serially made the step cost the SUM of both rather than the slower one.
    # Launched together instead; --serial is kept as an escape hatch since two generators do
    # roughly double the peak memory (each holds its brand's full row set plus the ~20MB HTML
    # it's assembling).
    #
    # Output from the two interleaves. That's why generate_report.py prefixes every line it
    # prints with its brand.
    procs = []
    for i, brand in enumerate(BRANDS):
        # -u so the child's per-stage timing lines reach the CI log as they happen; buffered
        # through a pipe they'd all flush at exit with identical timestamps, which is what
        # previously made this step's ~80s impossible to attribute to a stage.
        cmd = [sys.executable, "-u", str(HERE / "generate_report.py"), "--brand-index", str(i)]
        if args.quick:
            cmd.append("--quick")
        if args.refresh_nps:
            cmd.append("--refresh-nps")
        print(f"=== Generating {brand['brand']} ===", flush=True)
        if args.serial:
            subprocess.run(cmd, check=True)
        else:
            procs.append((brand["brand"], subprocess.Popen(cmd)))

    # Wait on every child before reporting, so one brand failing still lets the other finish
    # (and still surfaces which one broke) instead of aborting mid-flight.
    failed = [name for name, p in procs if p.wait() != 0]
    if failed:
        raise SystemExit(f"Report generation failed for: {', '.join(failed)}")
    print("All reports regenerated.")

    # Cross-brand digest, built from both brands' data/*_digest_facts.json (a side output
    # generate_report.py just wrote above) - needs both brands present, so this can only run
    # after the loop above, not per-brand. Its CSAT/NPS columns inherit whatever freshness
    # --quick/--refresh-nps already gave the small-tabs/NPS caches those numbers come from;
    # the ticket-row-derived facts (classes/categories/couriers/SKUs) are always current
    # since data_rows itself is refreshed on every run regardless of --quick.
    print("=== Building cross-brand trend digest ===", flush=True)
    subprocess.run([sys.executable, "-u", str(HERE / "build_trend_digest.py")], check=True)


if __name__ == "__main__":
    main()
