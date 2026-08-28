'use client';
// Upload CSV modal for NDR Calling - admin or ndr process-admin only. Sibling to
// app/rto-crm/RtoUploadModal.js, deliberately NOT a shared component with it: that modal's core
// is a job-polling state machine (RTO's rows wait on a background Lambda for GoKwik/LMD checks),
// while an NDR upload gets its final answer in the response. Merging them would thread an
// `if (jobId)` through every state for no shared behaviour beyond the dropzone. The pieces that
// genuinely are shared - Overlay, XIcon, Stat - come from ../_calling/ui.
import { useState, useRef } from 'react';
import { Overlay, XIcon, Stat } from '../_calling/ui';

export default function NdrUploadModal({ onClose, onDone, teamId = null }) {
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  // Set when the server refuses because the sheet's header row no longer matches what the column
  // map expects, or because the file lacks a required column. Both come back with the real text
  // (sheetHeader / csvHeaders), which is the fastest way to see what actually needs fixing.
  const [headerHint, setHeaderHint] = useState(null);
  const inputRef = useRef(null);

  function readFile(f) {
    if (!f) return;
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      setError('Please choose a .csv file');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsvText(String(reader.result || ''));
      setFile(f);
      setError('');
      setResult(null);
      setHeaderHint(null);
    };
    reader.onerror = () => setError('Could not read file');
    reader.readAsText(f);
  }

  async function handleUpload() {
    setSubmitting(true);
    setError('');
    setHeaderHint(null);
    try {
      const res = await fetch('/api/ndr/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // teamId only matters for a full admin with two or more active teams - see
        // resolveUploadTarget in api/ndr/upload.js, which ignores it for everyone else.
        body: JSON.stringify(teamId != null ? { csv: csvText, teamId } : { csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.sheetHeader || data.csvHeaders) {
          setHeaderHint({
            details: data.details || [],
            sheetHeader: data.sheetHeader || null,
            csvHeaders: data.csvHeaders || null,
          });
        }
        throw new Error(data.error || 'Upload failed');
      }
      setResult(data);
      // Only refresh the lead list if rows actually landed - an upload that was entirely
      // duplicates changed nothing to reload.
      if (data.appended > 0) onDone();
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
          Upload a CSV of new NDR leads. Rows go to fixed columns in the
          <span className="font-mono"> Latest NDR </span>
          sheet and are deduplicated by{' '}
          <strong className="text-zinc-300 font-semibold">AWB Code + Attempt Count</strong> — first
          within the file, then against the sheet. AWB alone is not enough here: one shipment gets
          a new row per failed attempt, so a later attempt is a genuinely new lead. Agent columns
          are left blank so uploaded rows read as unworked. Rows whose AWB the courier has already
          marked delivered are dropped rather than appended, and the Order ID is trimmed at the
          first underscore. Either Shiprocket NDR export works —
          the alternative column names it uses (Courier, Address 1, Pincode, City, State, Payment
          Mode) are recognised, so there is no need to rename headers by hand. Still export straight from the source: an AWB that arrives as{' '}
          <span className="font-mono">5.40E+13</span> is rounded past recovery and rejected, while
          one that kept every digit is expanded and imported.
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

        {headerHint && (
          <div className="space-y-1.5 p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800 text-[11px]">
            {headerHint.details.map((d, i) => (
              <div key={i} className="text-amber-400 font-mono">{d}</div>
            ))}
            {headerHint.sheetHeader && (
              <div className="text-zinc-400">
                <span className="text-zinc-500">Sheet header row: </span>
                <span className="font-mono break-all">{headerHint.sheetHeader.join(' | ')}</span>
              </div>
            )}
            {headerHint.csvHeaders && (
              <div className="text-zinc-400">
                <span className="text-zinc-500">CSV header row: </span>
                <span className="font-mono break-all">{headerHint.csvHeaders.join(' | ')}</span>
              </div>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Stat tone="ok">{result.appended} added</Stat>
              <Stat tone="skip">{result.duplicateInSheet} duplicate in sheet</Stat>
              <Stat tone="skip">{result.duplicateInFile} duplicate in file</Stat>
              <Stat tone="skip">{result.missingAwb} missing AWB</Stat>
              {result.scientificAwb > 0 && (
                <Stat tone="skip">{result.scientificAwb} unreadable AWB</Stat>
              )}
              {result.expandedAwb > 0 && (
                <Stat tone="ok">{result.expandedAwb} AWB expanded</Stat>
              )}
              {result.alreadyDelivered > 0 && (
                <Stat tone="skip">{result.alreadyDelivered} already delivered</Stat>
              )}
              <Stat>{result.total} rows read</Stat>
            </div>
            {result.errors?.length > 0 && (
              <div className="max-h-32 overflow-y-auto space-y-1 p-2 rounded-lg bg-zinc-950/60 border border-zinc-800">
                {result.errors.map((e, i) => (
                  <div key={i} className="text-[11px] text-rose-400 font-mono">Line {e.line}: {e.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-800/80">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-[13px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors">
            Close
          </button>
          <button
            type="button"
            disabled={!csvText.trim() || submitting}
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
