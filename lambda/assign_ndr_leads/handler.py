"""Lambda entrypoint for the NDR lead-assignment job.

Replaces assign-leads.yml's `assign-ndr` job (same `*/5 * * * *` schedule as RTO, just a
separate job in that workflow) - see lambda/README.md for why this and assign_leads both
moved off the self-hosted runner's schedule.

Directory layout this expects at the Lambda task root (see ../build.sh):
    handler.py
    scripts/assign_ndr_leads.py, lib.py, mysql_lib.py
Deliberately minimal - assign_ndr_leads.py is independent of lead_priority.py (see its own
module docstring), so unlike assign_leads this package needs neither that file nor
api/_lib/*.json. It DOES need mysql_lib.py: fetch_online_ndr_agents reads agent_presence
from MySQL now, the same as assign_leads.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import assign_ndr_leads  # noqa: E402


def handler(event, context):
    print("assign-ndr-leads: starting run")
    assign_ndr_leads.main()
    print("assign-ndr-leads: run finished")
    return {"ok": True, "handler_version": 2}
