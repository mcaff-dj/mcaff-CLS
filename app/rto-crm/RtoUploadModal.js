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
//
// Large files are split into chunks before any of that: /upload-start takes the whole CSV as a
// JSON string body, capped at 5mb by api/_lambda/app.js's express.json limit and, harder still,
// at 10mb by API Gateway itself (not configurable - see that file's own comment on the matching
// 6mb response ceiling). A file anywhere near either cap came back as a bare "Upload failed",
// since API Gateway's own rejection body uses `message`, not the `error` field this modal reads.
// splitCsvIntoChunks keeps every chunk far under both, and chunks upload one at a time, waiting
// for each job to reach a terminal status before starting the next - so each chunk's own
// against-sheet AWB dedup (done server-side, per chunk) sees the previous chunk's rows as already
// appended. A real duplicate AWB that happens to land in two different chunks still gets caught,
// just as "duplicate in sheet" on the second chunk instead of "duplicate in file" - same end
// result as uploading it in one request.
import { useState, useRef, useEffect } from 'react';
import { Overlay, XIcon, Stat } from '../_calling/ui';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['done', 'failed']);
const CHUNK_MAX_ROWS = 2000; // well under the server's own 5000-row MAX_ROWS (api/rto/upload-start.js)
const CHUNK_MAX_BYTES = 3 * 1024 * 1024; // raw CSV text; leaves headroom under the 5mb JSON body limit after quote-escaping overhead

// Quote-aware line scan (CSV fields can contain embedded newlines) - returns raw line substrings,
// untouched, so re-joining a subset of them back into a chunk is byte-identical to the source file.
function splitCsvLines(text) {
  const lines = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    } else if (c === '\n' && !inQuotes) {
      let end = i;
      if (text[end - 1] === '\r') end--;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start).replace(/\r$/, ''));
  return lines.filter((l) => l.length > 0);
}

function splitCsvIntoChunks(text) {
  const lines = splitCsvLines(text);
  if (lines.length < 2) return [text]; // header-only/empty - let the server give its usual error
  const [header, ...dataLines] = lines;
  const encoder = new TextEncoder();
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const line of dataLines) {
    const lineBytes = encoder.encode(line).length + 1;
    if (current.length && (current.length >= CHUNK_MAX_ROWS || currentBytes + lineBytes > CHUNK_MAX_BYTES)) {
      chunks.push([header, ...current].join('\n'));
      current = []; currentBytes = 0;
    }
    current.push(line); currentBytes += lineBytes;
  }
  if (current.length) chunks.push([header, ...current].join('\n'));
  return chunks.length ? chunks : [text];
}

export default function RtoUploadModal({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startResult, setStartResult] = useState(null); // response from /upload-start, for the current chunk
  const [jobStatus, setJobStatus] = useState(null); // latest /upload-status poll, for the current chunk
  const [batchInfo, setBatchInfo] = useState(null); // { index, total } while chunks.length > 1
  const [cumulative, setCumulative] = useState(null); // totals across all chunks processed so far
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
    reader.onload = () => { setCsvText(String(reader.result || '')); setFile(f); setError(''); setStartResult(null); setJobStatus(null); setBatchInfo(null); setCumulative(null); };
    reader.onerror = () => setError('Could not read file');
    reader.readAsText(f);
  }

  // Resolves with the final /upload-status payload once the job hits a terminal status, updating
  // jobStatus on every tick along the way so the existing render block stays live during the wait.
  function pollJobAsync(jobId) {
    return new Promise((resolve, reject) => {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/rto/upload-status?jobId=${jobId}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not fetch status');
          setJobStatus(data);
          if (TERMINAL_STATUSES.has(data.status)) {
            clearInterval(pollRef.current);
            resolve(data);
          }
        } catch (e) {
          clearInterval(pollRef.current);
          reject(e);
        }
      }, POLL_INTERVAL_MS);
    });
  }

  // Runs one chunk through /upload-start (+ /upload-status if it queued a job) and returns its
  // stats for the caller to fold into the running cumulative total. Throws on anything that means
  // this chunk landed nowhere - the caller stops the batch there rather than silently continuing.
  async function uploadChunk(chunkText) {
    const res = await fetch('/api/rto/upload-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: chunkText }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    setStartResult(data);
    if (data.jobId) {
      setJobStatus({ status: 'queued', checkedCount: 0, prepaidCount: data.prepaidQueued });
      const finalJob = await pollJobAsync(data.jobId);
      if (finalJob.status === 'failed') throw new Error(finalJob.errorMessage || 'Upload failed');
      return { start: data, finalJob };
    }
    if (data.queueError) {
      // Nothing is written to the sheet by /upload-start any more, so a queueing failure means
      // this chunk landed nowhere. Surface it rather than silently continuing to the next chunk.
      throw new Error(data.queueError);
    }
    return { start: data, finalJob: null }; // every row in this chunk was a duplicate/reject
  }

  async function handleUpload() {
    if (!csvText.trim()) { setError('No CSV content to upload'); return; }
    setSubmitting(true); setError(''); setStartResult(null); setJobStatus(null); setBatchInfo(null); setCumulative(null);
    const chunks = splitCsvIntoChunks(csvText);
    const isBatch = chunks.length > 1;
    const cum = {
      queuedForCheck: 0, duplicateInSheet: 0, duplicateInFile: 0, missingAwb: 0, scientificAwb: 0, total: 0,
      appendedCount: 0, alreadyRefundedCount: 0, alreadyPunchedCount: 0,
    };
    let idx = 0;
    try {
      for (; idx < chunks.length; idx++) {
        if (isBatch) { setBatchInfo({ index: idx + 1, total: chunks.length }); setStartResult(null); setJobStatus(null); }
        const { start, finalJob } = await uploadChunk(chunks[idx]);
        cum.queuedForCheck += start.queuedForCheck || 0;
        cum.duplicateInSheet += start.duplicateInSheet || 0;
        cum.duplicateInFile += start.duplicateInFile || 0;
        cum.missingAwb += start.missingAwb || 0;
        cum.scientificAwb += start.scientificAwb || 0;
        cum.total += start.total || 0;
        if (finalJob) {
          cum.appendedCount += finalJob.appendedCount || 0;
          cum.alreadyRefundedCount += finalJob.alreadyRefundedCount || 0;
          cum.alreadyPunchedCount += finalJob.alreadyPunchedCount || 0;
        }
        if (isBatch) setCumulative({ ...cum });
      }
      onDone();
    } catch (e) {
      setError(isBatch ? `Stopped at file ${idx + 1} of ${chunks.length}: ${e.message}` : e.message);
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
          header name and deduplicated by <strong className="text-zinc-300 font-semibold">AWB Code</strong> —
          first within the file, then against the sheet. Every surviving row is then checked for
          LMD &quot;already punched&quot; status, and prepaid rows for an existing GoKwik refund,
          before being added. Export the CSV straight from the source: an AWB that arrives as
          <span className="font-mono"> 5.40E+13</span> has already lost its digits and is rejected.
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

        {batchInfo && (
          <div className="text-[12px] text-zinc-400">
            File too big for one request - split into {batchInfo.total} batches. Uploading batch {batchInfo.index} of {batchInfo.total}…
          </div>
        )}

        {cumulative && (
          <div className="flex flex-wrap gap-2">
            <Stat tone="ok">{cumulative.appendedCount} appended so far (all batches)</Stat>
            <Stat>{cumulative.total} rows read so far (all batches)</Stat>
          </div>
        )}

        {startResult && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Stat tone="ok">{startResult.queuedForCheck} queued for punch/refund check</Stat>
              <Stat tone="skip">{startResult.duplicateInSheet} duplicate in sheet</Stat>
              <Stat tone="skip">{startResult.duplicateInFile} duplicate in file</Stat>
              <Stat tone="skip">{startResult.missingAwb} missing AWB</Stat>
              {startResult.scientificAwb > 0 && (
                <Stat tone="skip">{startResult.scientificAwb} unreadable AWB</Stat>
              )}
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
