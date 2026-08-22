'use client';
// Upload CSV modal for the RTO CRM - admin-only. Same FileReader -> JSON POST -> result flow as
// app/escalation/EscalationClient.js's own ImportModal, but adapted two ways for this page:
// (1) this feature's refund/punch checks run in a background Lambda (see
// api/rto/upload-start.js and docs/superpowers/specs/2026-08-20-rto-csv-upload-design.md), so
// this polls /api/rto/upload-status for a final answer instead of getting one in the initial
// response; (2) this page's own modals (see the disposition/detail/receipt Overlay usages in
// RtoCrmClient.js) are all Tailwind + the shared <Overlay> from ../_calling/ui, not
// escalation.css's BEM classes (modalOverlay/modalCard/importStat/etc.) - escalation.css is
// scoped to app/escalation and is never loaded on this page, so this reuses RtoCrmClient's own
// dark-card styling instead of names that would render unstyled here.
import { useState, useRef, useEffect } from 'react';
import { Overlay, XIcon } from '../_calling/ui';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed']);

const STAT_TONE = {
  ok: 'bg-emerald-950/50 text-emerald-300 border-emerald-800/50',
  skip: 'bg-amber-950/50 text-amber-300 border-amber-800/50',
  neutral: 'bg-zinc-800/80 text-zinc-300 border-zinc-700/80',
};

function Stat({ tone = 'neutral', children }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-[12px] font-medium border ${STAT_TONE[tone]}`}>
      {children}
    </span>
  );
}

export default function RtoUploadModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startResult, setStartResult] = useState(null); // response from /upload-start
  const [jobStatus, setJobStatus] = useState(null); // latest /upload-status poll
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function readFile(f) {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      setError('Please choose a .csv file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setFile(f); setError(''); setStartResult(null); setJobStatus(null); };
    reader.onerror = () => setError('Could not read file');
    reader.readAsText(f);
  }

  function pollJob(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/rto/upload-status?jobId=${jobId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not fetch status');
        setJobStatus(data);
        if (TERMINAL_STATUSES.has(data.status)) {
          clearInterval(pollRef.current);
          if (data.status === 'done') onDone();
        }
      } catch (e) {
        clearInterval(pollRef.current);
        setError(e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleUpload() {
    if (!csvText.trim()) { setError('No CSV content to upload'); return; }
    setSubmitting(true); setError(''); setStartResult(null); setJobStatus(null);
    try {
      const res = await fetch('/api/rto/upload-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setStartResult(data);
      if (data.jobId) {
        setJobStatus({ status: 'queued', checkedCount: 0, prepaidCount: data.queuedForCheck });
        pollJob(data.jobId);
      } else if (data.queueError) {
        // Non-prepaid rows (if any) already landed - only the prepaid batch failed to queue.
        // Surface it rather than silently calling onDone(), which would read as "all done".
        setError(data.queueError);
      } else if (data.mappingWarning) {
        // The immediate-append rows are already written but failed their post-write AWB
        // check - same reasoning as queueError above, don't call onDone() and let this read
        // as a clean success.
        setError(data.mappingWarning);
      } else {
        onDone(); // nothing prepaid was queued - everything that was going to append already did
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div className="w-full max-w-lg bg-[#121215] border border-zinc-800/90 rounded-2xl shadow-2xl text-zinc-100 p-6 space-y-5" role="dialog" aria-modal="true" aria-label="Upload CSV">
        <div className="flex items-start justify-between border-b border-zinc-800/80 pb-4">
          <h3 className="text-base font-extrabold text-zinc-100">Upload CSV</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors border border-zinc-800">
            <XIcon />
          </button>
        </div>

        <p className="text-[12px] text-zinc-500 leading-relaxed">
          Upload a CSV of new RTO leads. Rows are matched to the sheet&apos;s own columns by
          header name, deduplicated by <strong className="text-zinc-300 font-semibold">AWB Code</strong>,
          and checked for existing GoKwik refunds (prepaid only) and LMD &quot;already
          punched&quot; status before being added.
        </p>

        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]); }}
          className={`rounded-xl border border-dashed p-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-indigo-500 bg-indigo-950/20' : 'border-zinc-700 bg-zinc-900/60 hover:border-zinc-600'}`}
        >
          <div className="text-[13px] font-semibold text-zinc-200">{file ? file.name : 'Click to choose a CSV or drag it here'}</div>
          {file && <div className="text-[11px] text-zinc-500 mt-1">Ready to upload · {(file.size / 1024).toFixed(1)} KB</div>}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            className="hidden"
            onChange={(e) => readFile(e.target.files?.[0])}
          />
        </div>

        {error && (
          <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-900/40 text-[12px] text-rose-300">{error}</div>
        )}

        {startResult && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Stat tone="ok">{startResult.appended} appended immediately</Stat>
              <Stat>{startResult.queuedForCheck} queued for refund/punch check</Stat>
              <Stat tone="skip">{startResult.duplicateInSheet} duplicate in sheet</Stat>
              <Stat tone="skip">{startResult.duplicateInFile} duplicate in file</Stat>
              <Stat tone="skip">{startResult.missingAwb} missing AWB</Stat>
              <Stat>{startResult.total} rows read</Stat>
            </div>
            {startResult.errors?.length > 0 && (
              <div className="max-h-32 overflow-y-auto space-y-1 p-2 rounded-lg bg-zinc-950/60 border border-zinc-800">
                {startResult.errors.map((e, i) => (
                  <div key={i} className="text-[11px] text-rose-400 font-mono">Line {e.line}: {e.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {jobStatus && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Stat>{jobStatus.status}</Stat>
              {jobStatus.prepaidCount != null && (
                <Stat>{jobStatus.checkedCount ?? 0}/{jobStatus.prepaidCount} prepaid checked</Stat>
              )}
              {jobStatus.alreadyRefundedCount != null && (
                <Stat tone="skip">{jobStatus.alreadyRefundedCount} already refunded</Stat>
              )}
              {jobStatus.alreadyPunchedCount != null && (
                <Stat tone="skip">{jobStatus.alreadyPunchedCount} already punched</Stat>
              )}
              {jobStatus.status === 'done' && (
                <Stat tone="ok">{jobStatus.appendedCount} appended</Stat>
              )}
            </div>
            {jobStatus.status === 'failed' && (
              <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-900/40 text-[12px] text-rose-300">{jobStatus.errorMessage}</div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-800/80">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-[13px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors">
            Close
          </button>
          <button
            type="button"
            disabled={!csvText.trim() || submitting || (jobStatus && !TERMINAL_STATUSES.has(jobStatus.status))}
            onClick={handleUpload}
            className="px-5 py-2 rounded-xl font-bold text-[13px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 text-white shadow-lg shadow-indigo-950/50 transition-all"
          >
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
