"""Lambda entrypoint for the daily agent-presence-log -> MySQL sync.

Replaces .github/workflows/sync-lead-assignments.yml's daily 3:30 UTC cron. Used to also
run a lead-assignments sync here first (this Lambda/schedule name is a leftover from
that) - retired once lead_assignments moved OFF Postgres onto MySQL CLS_RTO_calling
directly (assign_leads.py and api/_lib/db.js both write/read MySQL now - see
scripts/migrate_cls_rto_calling_schema.py / migrate_lead_assignments_to_cls_rto_calling.py),
leaving nothing for a daily copy to do. Only the presence-log sync remains.

Directory layout this expects at the Lambda task root (see ../build.sh):
    handler.py
    scripts/sync_agent_presence_log_to_mysql.py, mysql_lib.py
Neither script reads anything under api/_lib, so unlike assign_leads this package
doesn't need that directory at all.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import sync_agent_presence_log_to_mysql  # noqa: E402


def handler(event, context):
    print("sync-lead-assignments: starting daily run")
    sync_agent_presence_log_to_mysql.main()
    print("sync-lead-assignments: daily run finished")
    return {"ok": True}
