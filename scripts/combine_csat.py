"""Combine monthly CSAT CSV files in a folder into a single Excel workbook.

Usage:
    python combine_csat.py <subfolder-under-data/CSAT> <output-filename-without-extension>

Example:
    python combine_csat.py Hyphen Hyphen_CSAT_combine
    python combine_csat.py mcaff mCaff_CSAT_combine
"""
import argparse
import glob
import os

import pandas as pd

CSAT_ROOT = os.path.join(os.path.dirname(__file__), "..", "data", "CSAT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", help="Subfolder name under data/CSAT")
    parser.add_argument("output_name", help="Output filename without extension")
    args = parser.parse_args()

    src_dir = os.path.join(CSAT_ROOT, args.folder)
    out_path = os.path.join(src_dir, f"{args.output_name}.xlsx")

    csv_files = sorted(glob.glob(os.path.join(src_dir, "*.csv")))
    if not csv_files:
        raise SystemExit(f"No CSV files found in {src_dir}")

    frames = []
    for path in csv_files:
        df = pd.read_csv(path, dtype=str)
        df.insert(0, "Source File", os.path.basename(path))
        frames.append(df)
        print(f"Read {os.path.basename(path)}: {len(df)} rows")

    combined = pd.concat(frames, ignore_index=True)
    combined.to_excel(out_path, index=False)
    print(f"Wrote {len(combined)} total rows to {out_path}")


if __name__ == "__main__":
    main()
