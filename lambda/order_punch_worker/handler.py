"""Lambda entrypoint for the Order Punch background worker. Invoked fire-and-forget by
api/order-punch/start.js with event shape {"jobId": <int>}, and by the worker itself
(process_order_punch_job.invoke_self) to continue a job that outran one invoke's time budget -
see docs/superpowers/specs/2026-08-21-order-punch-design.md.

Directory layout expected at the Lambda task root (see ../build.sh):
    handler.py
    scripts/process_order_punch_job.py, lib.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))
import process_order_punch_job  # noqa: E402


def handler(event, context):
    job_id = event.get("jobId")
    if job_id is None:
        print("order-punch-worker: no jobId in event, nothing to do")
        return {"ok": False, "error": "missing jobId"}
    crash_retries = int(event.get("crashRetries") or 0)
    print(f"order-punch-worker: starting job {job_id}" + (f" (crash retry {crash_retries})" if crash_retries else ""))
    process_order_punch_job.process_job(int(job_id), crash_retries=crash_retries)
    print(f"order-punch-worker: finished this invoke for job {job_id}")
    return {"ok": True}
