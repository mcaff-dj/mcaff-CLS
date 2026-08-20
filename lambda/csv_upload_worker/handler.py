"""Lambda entrypoint for the RTO CSV upload background worker. Invoked fire-and-forget by
api/rto/upload-start.js with event shape {"jobId": <int>} - see
docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md.

Directory layout this expects at the Lambda task root (see ../build.sh), same convention as
lambda/assign_leads/handler.py:
    handler.py
    scripts/process_rto_csv_upload_job.py, assign_leads.py, lead_priority.py, lib.py, mysql_lib.py
    api/_lib/callingProcesses.json, leadAssignmentRules.json
process_rto_csv_upload_job.py imports assign_leads unmodified, so assign_leads.py's own
Item_level_data/LMD/GoKwik logic needs no changes to run here.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import process_rto_csv_upload_job  # noqa: E402


def handler(event, context):
    job_id = event.get("jobId")
    if job_id is None:
        print("csv-upload-worker: no jobId in event, nothing to do")
        return {"ok": False, "error": "missing jobId"}
    print(f"csv-upload-worker: starting job {job_id}")
    process_rto_csv_upload_job.process_job(int(job_id))
    print(f"csv-upload-worker: finished job {job_id}")
    return {"ok": True}
