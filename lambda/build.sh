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
#   ./build.sh sync_lead_assignments
#   ./build.sh            # builds both
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

  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] requests cryptography

  ( cd "$work" && zip -r -q "$OUT_DIR/assign_leads.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/assign_leads.zip"
}

build_sync_lead_assignments() {
  echo "=== Building sync_lead_assignments.zip ==="
  work="$(mktemp -d)"
  mkdir -p "$work/scripts"

  cp "$LAMBDA_DIR/sync_lead_assignments/handler.py" "$work/handler.py"
  cp "$REPO_ROOT/scripts/sync_lead_assignments_to_mysql.py" \
     "$REPO_ROOT/scripts/sync_agent_presence_log_to_mysql.py" \
     "$REPO_ROOT/scripts/mysql_lib.py" \
     "$work/scripts/"

  pip3 install --disable-pip-version-check --only-binary=:all: \
    --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp --abi cp312 \
    -t "$work" psycopg[binary] pymysql

  ( cd "$work" && zip -r -q "$OUT_DIR/sync_lead_assignments.zip" . )
  rm -rf "$work"
  echo "-> $OUT_DIR/sync_lead_assignments.zip"
}

case "${1:-all}" in
  assign_leads) build_assign_leads ;;
  sync_lead_assignments) build_sync_lead_assignments ;;
  all) build_assign_leads; build_sync_lead_assignments ;;
  *) echo "Usage: $0 [assign_leads|sync_lead_assignments]" >&2; exit 1 ;;
esac
