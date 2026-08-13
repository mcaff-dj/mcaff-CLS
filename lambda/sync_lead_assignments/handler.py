"""Lambda entrypoint for the daily calling-CRM -> MySQL sync.

Replaces .github/workflows/sync-lead-assignments.yml's daily 3:30 UTC cron. Runs both
of that workflow's steps in order: the lead-assignments sync first (the workflow marked
this one `continue-on-error: true` so a transient DB hiccup here doesn't block the
presence-log sync below it - reproduced here with its own try/except), then the agent
presence-log sync.

Directory layout this expects at the Lambda task root (see ../build.sh):
    handler.py
    scripts/sync_lead_assignments_to_mysql.py, sync_agent_presence_log_to_mysql.py, mysql_lib.py
Neither script reads anything under api/_lib, so unlike assign_leads this package
doesn't need that directory at all.
"""
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import sync_lead_assignments_to_mysql  # noqa: E402
import sync_agent_presence_log_to_mysql  # noqa: E402


def handler(event, context):
    print("sync-lead-assignments: starting daily run")
    try:
        sync_lead_assignments_to_mysql.main()
    except Exception:
        # continue-on-error, same as the assign-leads-to-mysql step in the old workflow -
        # a hiccup here shouldn't also block the unrelated presence-log sync below.
        print("sync_lead_assignments_to_mysql failed (continuing to presence-log sync):")
        traceback.print_exc()

    sync_agent_presence_log_to_mysql.main()
    return {"ok": True}
