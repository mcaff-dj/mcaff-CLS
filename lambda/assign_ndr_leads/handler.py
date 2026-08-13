"""Lambda entrypoint for the NDR lead-assignment job.

Replaces assign-leads.yml's `assign-ndr` job (same `*/5 * * * *` schedule as RTO, just a
separate job in that workflow) - see lambda/README.md for why this and assign_leads both
moved off the self-hosted runner's schedule.

Directory layout this expects at the Lambda task root (see ../build.sh):
    handler.py
    scripts/assign_ndr_leads.py, lib.py
Deliberately minimal - assign_ndr_leads.py is independent of lead_priority.py/mysql_lib.py
(see its own module docstring), so unlike assign_leads this package needs neither those two
files nor api/_lib/*.json.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import assign_ndr_leads  # noqa: E402


def handler(event, context):
    assign_ndr_leads.main()
    return {"ok": True}
