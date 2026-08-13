"""Lambda entrypoint for the RTO lead-assignment job.

Replaces .github/workflows/assign-leads.yml's `*/5 * * * *` cron - that ran the whole
job (checkout + pip install + run) fresh every 5 minutes, which is what actually blew
through the GitHub Actions free minutes quota (~8,640 runs/month, each billed a minimum
of 1 minute). Here the code is already loaded once per warm container; EventBridge
Scheduler just invokes this handler on the same 5-minute cadence, with no GitHub Actions
usage at all.

Directory layout this expects at the Lambda task root (see ../build.sh):
    handler.py
    scripts/assign_leads.py, lib.py, mysql_lib.py, lead_priority.py
    api/_lib/callingProcesses.json, leadAssignmentRules.json
This mirrors the real repo's scripts/ + api/_lib/ layout exactly, unmodified, so
assign_leads.py's own `REPO_ROOT = Path(__file__).resolve().parent.parent` and
lead_priority.py's `_RULES_PATH` resolve correctly with zero code changes to either file.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import assign_leads  # noqa: E402


def handler(event, context):
    print("assign-leads: starting run")
    assign_leads.main()
    print("assign-leads: run finished")
    return {"ok": True}
