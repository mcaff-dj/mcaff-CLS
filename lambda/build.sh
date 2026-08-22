#!/usr/bin/env bash
# Builds the two cron-job Lambda deployment zips from the repo's real scripts/ - not
# copies maintained separately, the actual files, so there is exactly one source of truth
# for assign_leads.py etc. Run from anywhere; paths are resolved relative to this file.
#
# Needs: python3 + pip3 on Linux (or WSL) - psycopg[binary]/cryptography ship manylinux
# wheels, so --platform manylinux2014_x86_64 gets a Lambda-compatible build without Docker.
# This deliberately does NOT run on plain Windows Python (pip --platform against a
# non-matching host interpreter is unreliable) - use WSL, a Linux CI runner, or AWS
# CloudShell.
#
# Usage:
#   ./build.sh assign_leads
#   ./build.sh assign_ndr_leads
#   ./build.sh            # builds all
set -euo pipefail

LAMBDA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LAMBDA_DIR/.." && pwd)"
OUT_DIR="$LAMBDA_DIR/dist"
mkdir -p "$OUT_DIR"

build_assign_leads() {
  echo "=== Building assign_leads.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts" "$work/api/_lib"

  cp "$LAMBDA_DIR/assign_leads/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/assign_leads.py" \
     "$REPO_ROOT/scripts/lib.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$REPO_ROOT/scripts/lead_priority.py" \
     "$work/scripts/"
  cp "$REPO_ROOT/api/_lib/callingProcesses.json" \
     "$REPO_ROOT/api/_lib/leadAssignmentRules.json" \
     "$work/api/_lib/"

  # pymysql: assign_leads.py imports it directly (not just via mysql_lib's own lazy
  # import) since lead_assignments moved onto MySQL CLS_RTO_calling directly - this was
  # missing here (caught live in production: mcaff-cls-assign-leads crashed on every
  # invocation with ImportModuleError after that move shipped, because this build
  # function was never updated to match - it had been manually patched during earlier
  # testing but that fix was never made permanent here).
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests cryptography pymysql

  ( cd "$work" && zip -r -q "$OUT_DIR/assign_leads.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/assign_leads.zip"
}

build_assign_ndr_leads() {
  echo "=== Building assign_ndr_leads.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts"

  cp "$LAMBDA_DIR/assign_ndr_leads/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/assign_ndr_leads.py" \
     "$REPO_ROOT/scripts/lib.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$work/scripts/"

  # pymysql: assign_ndr_leads.py's fetch_online_ndr_agents now reads agent_presence from
  # MySQL via mysql_lib.query() (moved off Postgres) - same missing-dependency mistake
  # build_assign_leads above already made and documents; copying mysql_lib.py without also
  # installing pymysql would leave this Lambda ImportError-ing on every invocation too.
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests cryptography pymysql

  ( cd "$work" && zip -r -q "$OUT_DIR/assign_ndr_leads.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/assign_ndr_leads.zip"
}

build_csv_upload_worker() {
  echo "=== Building csv_upload_worker.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts" "$work/api/_lib"

  cp "$LAMBDA_DIR/csv_upload_worker/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/process_rto_csv_upload_job.py" \
     "$REPO_ROOT/scripts/assign_leads.py" \
     "$REPO_ROOT/scripts/lib.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$REPO_ROOT/scripts/lead_priority.py" \
     "$work/scripts/"
  cp "$REPO_ROOT/api/_lib/callingProcesses.json" \
     "$REPO_ROOT/api/_lib/leadAssignmentRules.json" \
     "$work/api/_lib/"

  # Same dependency set as assign_leads.zip - this worker imports assign_leads.py unmodified,
  # so it needs everything that file needs (pymysql for MySQL, psycopg for Postgres, requests
  # for Sheets/GoKwik HTTP calls, cryptography as psycopg[binary]'s own dependency).
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests cryptography pymysql

  ( cd "$work" && zip -r -q "$OUT_DIR/csv_upload_worker.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/csv_upload_worker.zip"
}

build_order_punch_worker() {
  echo "=== Building order_punch_worker.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts"

  cp "$LAMBDA_DIR/order_punch_worker/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/process_order_punch_job.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$work/scripts/"

  # The order_punch_* tables live in MySQL, so this needs mysql_lib.py AND pymysql (plus
  # cryptography, which pymysql needs for MySQL 8's caching_sha2_password auth) - the same
  # copy-the-module-but-not-its-driver mistake build_assign_leads above already documents.
  # It shipped without them and every invoke died on "No module named 'mysql_lib'" while
  # the job row sat at 'queued' with nothing anywhere to say why (caught live 2026-08-22).
  #
  # NOT installed: psycopg (process_order_punch_job.py imports no Postgres client) and boto3,
  # which every AWS Python runtime already ships. lib.py is likewise no longer copied - this
  # worker imports nothing from it.
  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" requests pymysql cryptography

  ( cd "$work" && zip -r -q "$OUT_DIR/order_punch_worker.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/order_punch_worker.zip"
}

case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  assign_ndr_leads) build_assign_ndr_leads ;;
  csv_upload_worker) build_csv_upload_worker ;;
  order_punch_worker) build_order_punch_worker ;;
  all) build_assign_leads; build_assign_ndr_leads; build_csv_upload_worker; build_order_punch_worker ;;
  *) echo "Usage: $0 [assign_leads|assign_ndr_leads|csv_upload_worker|order_punch_worker]" >&2; exit 1 ;;
esac
