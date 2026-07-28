'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import confetti from 'canvas-confetti';

// Next.js still server-renders this "use client" component once for the initial HTML,
// where `localStorage` doesn't exist - unlike the old CDN-script version, which only ever
// ran in the browser. Every callsite below already treats a missing/empty value as "no
// stored value yet" (that's what a first-ever page load already looked like), so a no-op
// shim on the server reproduces that exact behavior without touching any callsite.
const localStorage = typeof window !== 'undefined'
  ? window.localStorage
  : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

    const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1Ij6hWgE8ihHn837cqgrhNKFQHIHWMzaXouco76zUpBI/edit?usp=sharing';
    const DEFAULT_SHEET_RANGE = 'Data';

    const HIGH_PRIORITY_RTO_REASONS = [
      'consignee opened the package and refused to accept','consignee refused to accept','customer refused to accept',
      'customer refused to accept:verified','elasticrun_otp_verified','entry refused',
      'kyc|customer refused to share kyc','otp validation successful','otp verified cancellation',
      'prf|receiver refused delivery','refused to accept','refused to accept (no cancellation code)',
      'refused to accept (with cancellation code)','rto pending - otp validated cancellation'
    ];

    // Assignment priority - mirrors scripts/lead_priority.py's priority_tier() exactly, for the
    // Admin "Next to Assign" preview below. Kept in sync manually, not shared code: this is a
    // read-only JS prediction of what that server-side script would do, not the actual writer.
    //   0 = Prepaid (wins outright, regardless of RTO reason)
    //   1 = COD whose RTO reason matches one of these (case-insensitive substring)
    //   2 = every other COD lead
    //   3 = COD matching LOW_PRIORITY_COD_RTO_REASONS - deliberately last
    const HIGH_PRIORITY_COD_RTO_REASONS = [
      'consignee opened the package and refused to accept','consignee refused to accept','customer refused to accept',
      'customer refused to accept:verified','elasticrun_otp_verified','entry refused',
      'kyc|customer refused to share kyc/ ndc/ scd','prf|receiver refused delivery(cir)',
      'refused to accept','refused to accept (no cancellation code)'
    ];
    const LOW_PRIORITY_COD_RTO_REASONS = [
      'otp validation successful','otp verified cancellation',
      'refused to accept (with cancellation code)','rto pending - otp validated cancellation'
    ];
    const ASSIGNMENT_QUOTA = 10; // must match scripts/assign_leads.py's DEFAULT_QUOTA

    function getPriorityTier(t) {
      if (t.paymentMethod === 'Prepaid') return 0;
      const reason = (t.rtoReason || '').toLowerCase();
      if (LOW_PRIORITY_COD_RTO_REASONS.some(r => reason.includes(r))) return 3;
      if (HIGH_PRIORITY_COD_RTO_REASONS.some(r => reason.includes(r))) return 1;
      return 2;
    }

    // Builds a wa.me deep link with a prefilled message for a ticket's customer. Indian
    // numbers are stored as bare 10-digit strings in the sheet, so a missing country code
    // is assumed to be +91 - wa.me requires the full international number with no leading +.
    function buildWaLink(t) {
      const digits = (t.phone || '').replace(/\D/g, '');
      const withCountry = digits.length === 10 ? `91${digits}` : digits;
      const msg = `Hi ${t.customerName}, this is regarding your order ${t.orderNumber}. We tried reaching you for recent order placed with us which has been marked rto unfortunately we were not able to connect do let us know suitable time to connect on same`;
      return `https://wa.me/${withCountry}?text=${encodeURIComponent(msg)}`;
    }

    /* ── Google Sheets access ──────────────────────────
     * The service-account credential used to live here, in client-side JS -
     * anyone opening DevTools could read it. It now lives server-side only,
     * behind /api/rto/sheet (see api/rto/sheet.js), gated by the same
     * session + 'calling' card permission as the rest of this page's data.
     * ──────────────────────────────────────────────────── */
    async function fetchSheet(sid,range='Data'){
      const r=await fetch(`/api/rto/sheet?op=values&sid=${encodeURIComponent(sid)}&range=${encodeURIComponent(range)}`);
      if(!r.ok)throw new Error(`Sheets API ${r.status}`);const d=await r.json();
      if(!d.values||d.values.length<2)throw new Error('No data');return d.values;
    }

    /* ── Live Google Sheets Write-Back Engine ──────────── */
    // A ticket's rawIndex is only as fresh as the last full sync. If the sheet's row order has
    // shifted since then (e.g. the daily import job inserting/removing rows elsewhere), writing
    // blind to `rawIndex + 2` lands on whatever unrelated order now sits at that row and
    // silently corrupts it. This resolves the CURRENT row for a set of order numbers by
    // scanning live Column E (Order ID) once, so callers can verify before writing.
    async function fetchLiveOrderRowMap(sid) {
      try {
        const res = await fetch(`/api/rto/sheet?op=values&sid=${encodeURIComponent(sid)}&range=${encodeURIComponent('Data!E2:E')}`);
        if (!res.ok) return null;
        const data = await res.json();
        const col = data.values || [];
        const map = new Map();
        col.forEach((r, i) => {
          const key = ((r && r[0]) || '').toString().trim().toUpperCase();
          if (key && !map.has(key)) map.set(key, i + 2); // 1-based sheet row number
        });
        return map;
      } catch (e) {
        console.error('fetchLiveOrderRowMap error:', e);
        return null;
      }
    }

    // Same as fetchLiveOrderRowMap but also returns each row's current Column Q value, for
    // callers that need to verify a lead is still actually unassigned in the live sheet right
    // before writing, not just that the row hasn't shifted.
    async function fetchLiveOrderAndAgentMap(sid) {
      try {
        const res = await fetch(`/api/rto/sheet?op=batchGet&sid=${encodeURIComponent(sid)}&ranges=${encodeURIComponent('Data!E2:E')}&ranges=${encodeURIComponent('Data!Q2:Q')}`);
        if (!res.ok) return null;
        const data = await res.json();
        const orderCol = (data.valueRanges?.[0]?.values) || [];
        const agentCol = (data.valueRanges?.[1]?.values) || [];
        const map = new Map();
        orderCol.forEach((r, i) => {
          const key = ((r && r[0]) || '').toString().trim().toUpperCase();
          if (key && !map.has(key)) {
            const agentVal = (agentCol[i] && agentCol[i][0]) || '';
            map.set(key, { row: i + 2, agent: agentVal.toString().trim() });
          }
        });
        return map;
      } catch (e) {
        console.error('fetchLiveOrderAndAgentMap error:', e);
        return null;
      }
    }

    async function writeToSheetRow(orderNumber, sheetRowIndex, updates) {
      try {
        const sid = extractSheetId(DEFAULT_SHEET_URL);
        if (!sid) return;

        let rowNumber = sheetRowIndex + 2; // 1-based index (row 1 is header) - fallback only
        const expected = (orderNumber || '').toString().trim().toUpperCase();
        if (expected) {
          const rowMap = await fetchLiveOrderRowMap(sid);
          if (rowMap) {
            const liveRow = rowMap.get(expected);
            if (!liveRow) {
              console.error(`writeToSheetRow: order ${orderNumber} not found in live sheet - aborting write to avoid corrupting the wrong row.`);
              return;
            }
            rowNumber = liveRow;
          }
          // If the map fetch itself failed (network hiccup), fall back to the cached index
          // rather than blocking the write entirely - degraded but not silently corrupting.
        }
        const valueRanges = [];

        if (updates.assignedAgent !== undefined) {
          valueRanges.push({ range: `Data!Q${rowNumber}`, values: [[updates.assignedAgent]] });
        }
        if (updates.connectedStatus !== undefined) {
          valueRanges.push({ range: `Data!R${rowNumber}`, values: [[updates.connectedStatus]] });
        }
        if (updates.attemptType !== undefined) {
          valueRanges.push({ range: `Data!S${rowNumber}`, values: [[updates.attemptType]] });
        }
        if (updates.disposition !== undefined) {
          valueRanges.push({ range: `Data!T${rowNumber}`, values: [[updates.disposition]] });
        }
        if (updates.remarks !== undefined) {
          valueRanges.push({ range: `Data!U${rowNumber}`, values: [[updates.remarks]] });
        }
        if (updates.newOrderId !== undefined) {
          valueRanges.push({ range: `Data!V${rowNumber}`, values: [[updates.newOrderId]] });
        }
        if (updates.newAddress !== undefined) {
          valueRanges.push({ range: `Data!X${rowNumber}`, values: [[updates.newAddress]] });
        }

        if (valueRanges.length === 0) return;

        const res = await fetch('/api/rto/sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: 'batchUpdate', sid, data: valueRanges })
        });
        if (res.ok) console.log(`Live Sheet row ${rowNumber} updated (Q, R, S, T, U, V, X)`);
      } catch (err) {
        console.error('Sheet write error:', err);
      }
    }

    // Best-effort POST to our own API with one retry after a short delay - Neon's
    // serverless Postgres can auto-suspend when idle and take a few seconds to wake on
    // the next connection, which is long enough to fail a single fire-and-forget request
    // outright (fetch() doesn't reject on a non-2xx status, so a plain `.catch(()=>{})`
    // never even sees it - the write silently vanishes with zero trace). Never blocks the
    // caller's UI; failures are only logged to the console for later debugging.
    async function postJsonWithRetry(url, body, attempts = 2) {
      for (let i = 0; i < attempts; i++) {
        try {
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (resp.ok) return true;
          console.error(`${url} responded ${resp.status}:`, await resp.text().catch(() => ''));
        } catch (e) {
          console.error(`${url} network error:`, e);
        }
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000));
      }
      return false;
    }

    function extractSheetId(i){const m=i.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);return m?m[1]:/^[a-zA-Z0-9_-]{20,}$/.test(i.trim())?i.trim():null;}

    function startOfDay(d){
      if(!d)return null;
      const x=new Date(d);
      if(isNaN(x.getTime()))return null;
      x.setHours(0,0,0,0);
      return x;
    }

    function parseDate(s){
      if(!s||typeof s!=='string')return null;
      const str=s.trim();
      if(!str||str==='—')return null;

      // 1. Try "22 Jul" or "22 July 2026"
      const p=str.split(/\s+/);
      if(p.length>=2){
        const day=parseInt(p[0]);
        const ms=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        const mi=ms.indexOf(p[1].toLowerCase().slice(0,3));
        if(!isNaN(day)&&mi!==-1){
          const year=p.length>=3&&!isNaN(parseInt(p[2]))?parseInt(p[2]):new Date().getFullYear();
          return startOfDay(new Date(year,mi,day));
        }
      }

      // 2. Try "22/07/2026" or "22-07-2026" or "22.07.2026"
      const parts=str.split(/[\/\.-]/);
      if(parts.length===3){
        const p1=parseInt(parts[0]),p2=parseInt(parts[1]),p3=parseInt(parts[2]);
        if(!isNaN(p1)&&!isNaN(p2)&&!isNaN(p3)){
          let year,month,day;
          if(p3>1000){
            year=p3;
            if(p2<=12&&p1<=31){day=p1;month=p2-1;}
            else{day=p2;month=p1-1;}
          }else if(p1>1000){
            year=p1;month=p2-1;day=p3;
          }else{
            year=new Date().getFullYear();
            day=p1;month=p2-1;
          }
          const testDate=new Date(year,month,day);
          if(!isNaN(testDate.getTime()))return startOfDay(testDate);
        }
      }

      // 3. Standard JS Date constructor fallback
      let d=new Date(str);
      if(!isNaN(d.getTime()))return startOfDay(d);
      return null;
    }

    // Parses "RTO Initiated Date" (col B, "DD-MM-YYYY HH:MM") keeping the time-of-day -
    // unlike parseDate() above (used for the day-only date-scope filters), which zeroes
    // it via startOfDay(). Assignment-queue ordering needs the minutes, not just the day.
    function parseRtoInitiatedDate(s){
      if(!s||typeof s!=='string')return null;
      const m=s.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
      if(!m)return null;
      const d=new Date(parseInt(m[3]),parseInt(m[2])-1,parseInt(m[1]),m[4]?parseInt(m[4]):0,m[5]?parseInt(m[5]):0);
      return isNaN(d.getTime())?null:d;
    }

    function isDateInScope(rowDate, scope, customFrom, customTo){
      if(scope==='ALL_TIME')return true;
      if(!rowDate)return true;
      const now=new Date(),today=startOfDay(now),rd=startOfDay(rowDate);
      if(scope==='TODAY')return rd.getTime()===today.getTime();
      if(scope==='YESTERDAY'){const y=new Date(today);y.setDate(y.getDate()-1);return rd.getTime()===y.getTime();}
      if(scope==='7_DAYS')return (now.getTime()-rowDate.getTime())/(1000*3600*24)<=7;
      if(scope==='30_DAYS')return (now.getTime()-rowDate.getTime())/(1000*3600*24)<=30;
      if(scope==='CUSTOM'){
        if(!customFrom&&!customTo)return true;
        if(customFrom&&rd.getTime()<startOfDay(new Date(customFrom)).getTime())return false;
        if(customTo&&rd.getTime()>startOfDay(new Date(customTo)).getTime())return false;
        return true;
      }
      return true;
    }

    /* ── Non-blocking parser ─────────────────────────── */
    async function parseRows(vals, user=null, role='Admin'){
      if(!vals||vals.length<2)return[];
      const[hdr,...rows]=vals;
      const aE=(user?.email||'').toLowerCase(),aP=aE.split('@')[0],aF=(user?.name||'').toLowerCase().split(' ')[0];
      const res=[];
      for(let i=0;i<rows.length;i++){
        const r=rows[i];

        // ── CRITICAL GUARD: Skip rows where Order ID (column E, index 4) is missing or blank ──
        const orderIdRaw = (r[4] || '').trim();
        if (!orderIdRaw) continue; // No order ID = not a valid lead row

        // Also skip rows that are entirely blank (no meaningful data in any cell)
        const hasAnyData = r.some(cell => (cell || '').trim().length > 0);
        if (!hasAnyData) continue;

        const o={};hdr.forEach((h,x)=>{const c=(h||'').trim();if(c)o[c]=(r[x]||'').trim();o[`c${x}`]=(r[x]||'').trim();});

        // A single malformed/unexpected row must never abort the entire sync - that's exactly
        // what silently froze the ticket cache on a stale snapshot before (one row's mapTkt
        // throwing killed parseRows for every row behind it). Skip just the bad row and keep going.
        try {
          res.push(mapTkt(o,i));
        } catch (e) {
          console.error(`parseRows: skipping row ${i} (order ${orderIdRaw}) - mapTkt threw:`, e);
        }
        if(i%5000===4999)await new Promise(r=>setTimeout(r,0));
      }
      return res;
    }

    function mapTkt(r,i){
      const g=(...ks)=>{for(const k of ks){const f=Object.keys(r).find(h=>h.toLowerCase().replace(/[^a-z0-9]/g,'').includes(k.toLowerCase().replace(/[^a-z0-9]/g,'')));if(f&&r[f])return r[f];}return'';};
      const pay=g('Payment Method','Payment Mode','Payment','Type').toUpperCase();
      const amt=g('Order Amount','Amount','Price','Total','Order Value');
      const ord=g('Order Number','Order #','Order ID','OrderNo');
      const agt=g('Agent Name','Agent','Assigned Agent','AgentName','Assigned To','c16')||'Unassigned';
      const rto=g('RTO Reason','c3','Reason','RTOReason')||'Return To Origin';
      const cd=g('Calling Date','CallingDate','c24')||'';
      const rid=r['c1']||''; // RTO Initiated Date (col B) - assignment-queue sort key, NOT Calling Date
      const conn = r['c17'] || '';
      const attempt = r['c18'] || '';
      const disp = r['c19'] || '';
      const remarks = r['c20'] || r['c25'] || r['c29'] || '';
      const newOrderId = r['c21'] || '';
      const newAddress = r['c23'] || '';
      const awbCode = r['c6'] || ''; // AWB Code (col G) - see scripts/lead_priority.py's COL_AWB_CODE

      const isRefunded = disp.toLowerCase().includes('refund') || attempt.toLowerCase().includes('refund');
      const isDisposed = !!(conn || attempt || disp || remarks || newOrderId || newAddress);
      const prep=pay.includes('PREPAID')||pay.includes('ONLINE')||pay.includes('PAYTM')||pay.includes('UPI')||(!pay.includes('COD')&&!pay.includes('CASH'));
      const hp=prep&&HIGH_PRIORITY_RTO_REASONS.some(x=>rto.toLowerCase().includes(x));

      return{id:`T-${ord}-${i}`,orderNumber:ord,customerName:g('Customer Name','Name','Customer','Full Name')||'Customer',
        email:g('Email ID','Email','Customer Email')||'',phone:g('Contact Number','Phone','Mobile','Contact')||'',
        address:g('Address','Street Address','Shipping Address')||'',city:g('City','District','Town')||'',
        state:g('State','Province')||'',pincode:g('Pincode','Zip','Postal Code','Pin Code')||'',
        paymentMethod:pay.includes('COD')||pay.includes('CASH')?'COD':'Prepaid',
        orderAmount:parseFloat(amt.replace(/[^0-9.]/g,''))||0,rtoReason:rto,
        assignedAgent:agt,callingDate:cd||'—',isHighPriority:hp,
        rowDate:parseDate(cd)||parseDate(g('Date','Order Date','c0')),
        rtoInitiatedDate:parseRtoInitiatedDate(rid),rawIndex:i,
        attemptType:attempt,connected:conn,disposition:disp,agentRemarks:remarks,
        newOrderId:newOrderId,newAddress:newAddress,awbCode:awbCode,
        status:isRefunded?'Refunded':isDisposed?'Disposed':'Pending'};
    }

    /* ── SVG Icons ───────────────────────────────────── */
    const SearchIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>;
    const XIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>;
    const CheckIcon = (p) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>;
    const PhoneIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.76.32 1.54.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c1.27.38 2.05.58 2.81.7A2 2 0 0 1 22 16.92z"/></svg>;
    const WhatsAppIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.9-4.45 9.9-9.91C21.96 6.45 17.5 2 12.04 2zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.16 8.16 0 0 1-1.26-4.38c0-4.52 3.68-8.2 8.21-8.2 2.19 0 4.25.86 5.8 2.4a8.15 8.15 0 0 1 2.4 5.8c0 4.53-3.68 8.24-8.16 8.24zm4.5-6.16c-.25-.12-1.46-.72-1.68-.8-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.96-.14.16-.29.18-.53.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.24-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.16.04-.31-.02-.43-.06-.12-.56-1.36-.77-1.86-.2-.49-.41-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.23.24-.85.83-.85 2.04 0 1.2.87 2.36.99 2.52.12.16 1.71 2.6 4.14 3.65.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.46-.6 1.66-1.17.21-.58.21-1.08.15-1.18-.06-.1-.22-.16-.47-.28z"/></svg>;
    const RefreshIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>;
    const ChevronDown = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 9 6 6 6-6"/></svg>;
    const UserIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    const CalendarIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>;
    const CreditCardIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>;
    const ChatIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
    const ShieldIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
    const SparklesIcon = (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/></svg>;

    /* ── Custom Select Component ─────────────────────── */
    function CustomSelect({ value, onChange, options, icon: IconComponent, placeholder, className="" }) {
      const [isOpen, setIsOpen] = useState(false);
      const ref = useRef(null);

      useEffect(() => {
        const handleClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setIsOpen(false); };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }, []);

      const selectedOpt = options.find(o => String(o.value) === String(value)) || options[0];

      return (
        <div className={`relative inline-block ${className}`} ref={ref}>
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="h-8 px-3 py-1 bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded-lg text-[13px] font-medium text-zinc-200 flex items-center justify-between gap-2.5 transition-all shadow-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
          >
            <div className="flex items-center gap-2 truncate">
              {IconComponent && <IconComponent className="text-zinc-400 shrink-0" />}
              <span className="truncate">{selectedOpt ? selectedOpt.label : placeholder}</span>
            </div>
            <ChevronDown className={`text-zinc-500 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
          </button>

          {isOpen && (
            <div className="absolute left-0 mt-1.5 min-w-[160px] w-full max-w-xs bg-[#141417] border border-zinc-800/90 rounded-xl shadow-2xl z-50 overflow-hidden animate-fadeIn py-1 custom-scroll max-h-60 overflow-y-auto">
              {options.map((opt) => {
                const isSelected = String(opt.value) === String(value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { onChange(opt.value); setIsOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-[13px] flex items-center justify-between gap-2 hover:bg-zinc-800/70 transition-colors ${isSelected ? 'bg-indigo-950/40 text-indigo-300 font-semibold' : 'text-zinc-300'}`}
                  >
                    <span className="truncate flex items-center gap-2">
                      {opt.icon && <span>{opt.icon}</span>}
                      {opt.label}
                    </span>
                    {isSelected && <CheckIcon className="text-indigo-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    /* ── Reusable Components ──────────────────────────── */
    function Badge({children, color='zinc'}){
      const c={zinc:'bg-zinc-800/80 text-zinc-300 border-zinc-700/80',blue:'bg-blue-950/60 text-blue-300 border-blue-800/60',amber:'bg-amber-950/50 text-amber-300 border-amber-800/50',green:'bg-emerald-950/50 text-emerald-300 border-emerald-800/50',red:'bg-rose-950/50 text-rose-300 border-rose-800/50',indigo:'bg-indigo-950/50 text-indigo-300 border-indigo-800/50'};
      return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-medium border ${c[color]||c.zinc}`}>{children}</span>;
    }

    function Overlay({children, onClose}){
      return(<div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/70 backdrop-blur-md"/>
        <div className="relative animate-slideUp max-h-[92vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>{children}</div>
      </div>);
    }

    function EmptyState({title, sub}){
      return(<div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-zinc-800/60 flex items-center justify-center mb-4"><SearchIcon className="text-zinc-500 w-8 h-8"/></div>
        <p className="text-sm font-semibold text-zinc-300 mb-1">{title}</p>
        <p className="text-xs text-zinc-500 max-w-xs">{sub}</p>
      </div>);
    }

    /* ── Main Application ─────────────────────────────── */
    function App(){
      const [googleUser, setGoogleUser] = useState(()=>{try{const s=localStorage.getItem('rto_google_user');if(s)return JSON.parse(s);}catch{}return{name:'Vighnesh Patil',email:'vighnesh.patil@mcaffeine.com',picture:'https://api.dicebear.com/7.x/avataaars/svg?seed=vighnesh.patil@mcaffeine.com'};});

      const [userRole, setUserRole] = useState(() => {
        try {
          const saved = localStorage.getItem('rto_active_role');
          if (saved) return saved;
        } catch {}
        return 'Admin';
      });

      const [theme, setTheme] = useState(() => {
        try { return localStorage.getItem('rto_theme') || 'dark'; } catch { return 'dark'; }
      });

      useEffect(() => {
        document.documentElement.className = theme === 'light' ? 'light' : 'dark';
        document.body.className = `font-sans antialiased min-h-screen theme-${theme}`;
        try { localStorage.setItem('rto_theme', theme); } catch {}
      }, [theme]);

      const [agentRoster, setAgentRoster] = useState(()=>{
        try { const s = localStorage.getItem('rto_agent_roster'); if (s) { const p = JSON.parse(s); if (Array.isArray(p) && p.length) return p; } } catch {}
        return [
          {email:'vighnesh.patil@mcaffeine.com',name:'Vighnesh Patil',role:'Admin',maxQuota:10,status:'Online',aht:'2.5m',breakTime:'15m'},
          {email:'vikash.pathak@mcaffeine.com',name:'Vikash Pathak',role:'Admin',maxQuota:10,status:'Online',aht:'3.1m',breakTime:'20m'},
          {email:'bhavesh.solanki@mcaffeine.com',name:'Bhavesh Solanki',role:'Agent',maxQuota:20,status:'Online',aht:'2.8m',breakTime:'45m'},
          {email:'badshasab.pathan@mcaffeine.com',name:'Badshasab Pathan',role:'Agent',maxQuota:20,status:'Online',aht:'3.4m',breakTime:'30m'}
        ];
      });

      const [activityLogs, setActivityLogs] = useState(() => {
        try {
          const s = localStorage.getItem('rto_central_activity_logs_v3');
          if (s) {
            const p = JSON.parse(s);
            if (Array.isArray(p) && p.length) return p;
          }
        } catch {}
        return [
          { time: '03:45 PM', agent: 'bhavesh.solanki@mcaffeine.com', action: 'Disposed ORD-8930809 → Connected — Address Change Requested', type: 'ticket', remarks: 'Customer updated delivery address to Bandra West office' },
          { time: '03:15 PM', agent: 'badshasab.pathan@mcaffeine.com', action: 'Status → On Break', type: 'break' },
          { time: '02:50 PM', agent: 'vikash.pathak@mcaffeine.com', action: 'Disposed HYP38944250 → Refunded ₹1,119', type: 'refund', remarks: 'Prepaid refund processed to Paytm wallet' },
          { time: '02:10 PM', agent: 'vighnesh.patil@mcaffeine.com', action: 'Status → Online', type: 'online' },
          { time: '01:30 PM', agent: 'bhavesh.solanki@mcaffeine.com', action: 'Status → Online', type: 'online' },
          { time: '12:45 PM', agent: 'badshasab.pathan@mcaffeine.com', action: 'Disposed HYP39305890 → Unreachable — Ringing / No Answer', type: 'ticket', remarks: 'No response after 3 rings' }
        ];
      });

      const [agentFilter, setAgentFilter] = useState('ALL');
      const [agentStatus, setAgentStatus] = useState(()=>localStorage.getItem('rto_agent_status')||'Online');
      // Team Roster tab: filters the roster table by an agent's live status (Online /
      // On Break / Offline) - purely a client-side view filter, doesn't touch the server.
      const [rosterStatusFilter, setRosterStatusFilter] = useState('All');

      // Real presence from Postgres (agent_presence table), keyed by lowercase email -
      // {}'d out for non-admin sessions (the GET is admin-only), in which case the
      // roster table just falls back to each agent's local/mock status as before.
      const [serverPresence, setServerPresence] = useState({});
      const fetchServerPresence = useCallback(() => {
        fetch('/api/auth/presence')
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d && d.agents) setServerPresence(d.agents); })
          .catch(() => {});
      }, []);
      useEffect(() => {
        fetchServerPresence();
        const t = setInterval(fetchServerPresence, 30000);
        return () => clearInterval(t);
      }, [fetchServerPresence]);

      const [toast, setToast] = useState(null);
      const showToast = useCallback(m=>{setToast(m);setTimeout(()=>setToast(null),3000);},[]);

      // Role Switch Handler
      const handleSwitchRole = (newRole) => {
        setUserRole(newRole);
        try { localStorage.setItem('rto_active_role', newRole); } catch {}
        setAgentRoster(p => {
          const updated = p.map(a => a.email.toLowerCase() === googleUser.email.toLowerCase() ? { ...a, role: newRole } : a);
          try { localStorage.setItem('rto_agent_roster', JSON.stringify(updated)); } catch {}
          return updated;
        });
        if (newRole === 'Agent') {
          setAgentFilter(googleUser.email);
        } else {
          setAgentFilter('ALL');
        }
        showToast(`Role switched to ${newRole}`);
      };

      // Auth sync
      useEffect(()=>{
        fetch('/api/auth/me').then(r=>r.json()).then(d=>{
          if(d?.authenticated&&d.email){
            const u={name:d.name||d.email.split('@')[0],email:d.email,picture:`https://api.dicebear.com/7.x/avataaars/svg?seed=${d.email}`};
            setGoogleUser(u);
            localStorage.setItem('rto_google_user',JSON.stringify(u));
            const savedRole = localStorage.getItem('rto_active_role');
            if(!savedRole){
              const defaultRole = (d.isAdmin||d.email.toLowerCase().includes('vighnesh')||d.email.toLowerCase().includes('vikash')) ? 'Admin' : 'Agent';
              setUserRole(defaultRole);
            }
          }
        }).catch(()=>{});
      },[]);

      // Cross-Tab & Multi-Client Real-Time Status & Activity Broadcast Sync
      useEffect(() => {
        let channel = null;
        try {
          channel = new BroadcastChannel('rto_crm_sync_channel');
          channel.onmessage = (event) => {
            const data = event.data;
            if (data?.type === 'STATUS_UPDATE' && data.email && data.status) {
              setAgentRoster(p => {
                const u = p.map(a => a.email.toLowerCase() === data.email.toLowerCase() ? { ...a, status: data.status } : a);
                try { localStorage.setItem('rto_agent_roster', JSON.stringify(u)); } catch {}
                return u;
              });
            }
            if (data?.type === 'ACTIVITY_LOG' && data.log) {
              setActivityLogs(p => {
                const u = [data.log, ...p.slice(0, 99)];
                try { localStorage.setItem('rto_central_activity_logs_v3', JSON.stringify(u)); } catch {}
                return u;
              });
            }
          };
        } catch {}

        const handleStorageEvent = (e) => {
          if (e.key === 'rto_agent_roster' && e.newValue) {
            try { setAgentRoster(JSON.parse(e.newValue)); } catch {}
          }
          if (e.key === 'rto_central_activity_logs_v3' && e.newValue) {
            try { setActivityLogs(JSON.parse(e.newValue)); } catch {}
          }
        };

        window.addEventListener('storage', handleStorageEvent);
        return () => {
          window.removeEventListener('storage', handleStorageEvent);
          if (channel) channel.close();
        };
      }, []);

      const [newAgentEmail, setNewAgentEmail] = useState('');
      const [newAgentRole, setNewAgentRole] = useState('Agent');

      // Manually set any single agent's status (Online / On Break / Offline) from the roster
      // table - syncs to the server (agent_presence) for every row, not just your own: the
      // server honors a client-supplied target email only for an admin session (see
      // api/auth/[action].js's presence handler), which is exactly who can reach this table.
      const setAgentStatusManually = (email, newStatus) => {
        const lower = (email || '').toLowerCase();
        if (!lower) return;
        const isSelf = googleUser?.email && googleUser.email.toLowerCase() === lower;

        if (isSelf) {
          setAgentStatus(newStatus);
          try { localStorage.setItem('rto_agent_status', newStatus); } catch {}
          syncPresenceToServer(newStatus, { pendingBox: newStatus === 'Online' ? pend : undefined });
        } else {
          const target = effectiveAgentRoster.find(a => (a.email || '').toLowerCase() === lower);
          syncPresenceToServer(newStatus, { email: lower, name: target?.name });
          // Optimistic - effectiveAgentRoster prefers serverPresence for non-self rows,
          // so without this the row would flicker back to the old status until the next
          // 30s poll catches up with what we just wrote.
          setServerPresence(p => ({ ...p, [lower]: { status: newStatus, updatedAt: null } }));
        }

        setAgentRoster(p => {
          const u = p.map(a => (a.email || '').toLowerCase() === lower ? { ...a, status: newStatus } : a);
          try { localStorage.setItem('rto_agent_roster', JSON.stringify(u)); } catch {}
          return u;
        });
        showToast(`Status set to ${newStatus} for ${email}`);
      };

      // Reports an agent's status to the server (Postgres-backed agent_presence -
      // see api/auth/[action].js's presence handler) - this is what
      // scripts/assign_leads.py reads to decide who's eligible for new leads.
      // Best-effort: a failed sync just means that agent won't show as eligible for
      // the next assignment pass, not a UI error.
      //   opts.pendingBox - this browser's own already-computed "My Active Queue"
      //     count (see `pend` below); passing it when going Online with an empty
      //     queue lets the server trigger an immediate off-cycle assignment run
      //     instead of waiting up to 5 minutes for the next scheduled one.
      //   opts.email/opts.name - set a DIFFERENT agent's status (the roster
      //     table's per-row dropdown) instead of the caller's own; the server only
      //     honors this for an admin session, so a non-admin trying it just ends up
      //     reporting their own status regardless.
      const syncPresenceToServer = (status, opts = {}) => {
        const body = { status };
        if (typeof opts.pendingBox === 'number') body.pendingBox = opts.pendingBox;
        if (opts.email) { body.email = opts.email; body.name = opts.name; }
        postJsonWithRetry('/api/auth/presence', body);
      };

      const handleSetStatus = (s)=>{
        setAgentStatus(s);
        try { localStorage.setItem('rto_agent_status', s); } catch {}
        syncPresenceToServer(s, { pendingBox: s === 'Online' ? pend : undefined });
        const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const newLog = {
          time: t,
          agent: googleUser.email,
          agentName: googleUser.name || googleUser.email.split('@')[0],
          action: `Status → ${s}`,
          type: s === 'Online' ? 'online' : s === 'Busy' ? 'break' : 'offline'
        };

        setActivityLogs(p => {
          const u = [newLog, ...p.slice(0, 99)];
          try { localStorage.setItem('rto_central_activity_logs_v3', JSON.stringify(u)); } catch {}
          return u;
        });

        setAgentRoster(p => {
          const u = p.map(a => a.email.toLowerCase() === googleUser.email.toLowerCase() ? { ...a, status: s } : a);
          try { localStorage.setItem('rto_agent_roster', JSON.stringify(u)); } catch {}
          return u;
        });

        try {
          const channel = new BroadcastChannel('rto_crm_sync_channel');
          channel.postMessage({ type: 'STATUS_UPDATE', email: googleUser.email, status: s });
          channel.postMessage({ type: 'ACTIVITY_LOG', log: newLog });
          channel.close();
        } catch {}
      };

      // Presence heartbeat: push status to the server immediately on sign-in, then
      // every 2 minutes while active, well inside assign_leads.py's 10-minute
      // staleness window - an agent who opens the app and just starts working
      // without ever touching the status dropdown still needs the server to know
      // they're Online. Also passes pendingBox so returning to the app already
      // Online with an empty queue (e.g. a page refresh) still gets the instant-
      // assignment trigger, not just an explicit dropdown change - a stale/low
      // pend reading here (tickets not fully synced yet) only risks one harmless
      // extra assignment pass, same tradeoff as the admin-override path.
      useEffect(() => {
        if (googleUser?.email) syncPresenceToServer(agentStatus, { pendingBox: agentStatus === 'Online' ? pend : undefined });
      }, [googleUser]);

      // Presence heartbeat: keeps this agent's agent_presence row fresh in Postgres every
      // 2 minutes, well inside assign_leads.py's 10-minute staleness window, so someone
      // who's been Online/Busy for a while doesn't silently fall out of the eligible pool.
      // This used to also auto-mark the agent Offline (and release their pending leads
      // back to the pool via unassignMyPendingLeads) after 10 minutes of no
      // mouse/keyboard/scroll activity - removed per instruction: only the agent's own
      // explicit status choice should ever change their status or touch their
      // assignments now, never an idle timer (a long call, a meeting, or just reading
      // something could trigger it for no good reason, silently pulling leads out from
      // under someone who was still actively working them).
      useEffect(() => {
        if (!googleUser?.email) return;
        const t = setInterval(() => {
          if (agentStatus !== 'Offline') {
            syncPresenceToServer(agentStatus);
          }
        }, 2 * 60 * 1000);
        return () => clearInterval(t);
      }, [agentStatus, googleUser]);

      // Data
      const [tickets, setTickets] = useState(()=>{try{const s=localStorage.getItem('rto_cache_v4');if(s){const p=JSON.parse(s);if(Array.isArray(p)&&p.length)return p.map(t=>({...t,rowDate:t.rowDate?new Date(t.rowDate):null,rtoInitiatedDate:t.rtoInitiatedDate?new Date(t.rtoInitiatedDate):null}));}}catch{}return[];});
      const [overrides, setOverrides] = useState(()=>{try{return JSON.parse(localStorage.getItem('rto_ticket_overrides')||'{}');}catch{return{};}});
      const [stats, setStats] = useState(()=>{try{return JSON.parse(localStorage.getItem('rto_agent_stats')||'{}');}catch{return{};}});
      const [isSyncing, setIsSyncing] = useState(false);
      const [lastSync, setLastSync] = useState('—');
      const [syncError, setSyncError] = useState(null);
      const [search, setSearch] = useState('');
      const [adminLogSearch, setAdminLogSearch] = useState('');
      const [adminLogAgent, setAdminLogAgent] = useState('ALL');
      const [adminLogStatus, setAdminLogStatus] = useState('ALL');
      const [tab, setTab] = useState('all');
      const [dateScope, setDateScope] = useState(()=>localStorage.getItem('rto_date_scope')||'ALL_TIME');
      const [customDateFrom, setCustomDateFrom] = useState(()=>localStorage.getItem('rto_custom_date_from')||'');
      const [customDateTo, setCustomDateTo] = useState(()=>localStorage.getItem('rto_custom_date_to')||'');
      const [payFilter, setPayFilter] = useState('ALL');
      const [page, setPage] = useState(1);
      const [perPage, setPerPage] = useState(50);

      // Modals & Disposition State
      const [detailTkt, setDetailTkt] = useState(null);
      const [dispTkt, setDispTkt] = useState(null);
      const [dispConn, setDispConn] = useState(null);
      const [dispReason, setDispReason] = useState('');
      const [alreadyRefunded, setAlreadyRefunded] = useState(null);
      const [newOrder, setNewOrder] = useState(null);
      const [newOrderId, setNewOrderId] = useState('');
      const [addrChange, setAddrChange] = useState(null);
      const [newAddr, setNewAddr] = useState('');
      const [refNotes, setRefNotes] = useState('');
      const [agentRemarks, setAgentRemarks] = useState('');
      const [attemptType, setAttemptType] = useState('');
      const [receiptTkt, setReceiptTkt] = useState(null);
      const [refundProcessing, setRefundProcessing] = useState(false);

      // Explicit Claim & Assign Function for Lead (Column Q Sync)
      const claimLeadForAgent = async (tkt) => {
        if (agentStatus === 'Offline') {
          showToast('⚠️ Cannot claim leads while Offline. Switch status to Online first.');
          return;
        }
        const agentAssignedTag = `${googleUser.email}`;

        const setLocalAssignee = (assignedAgent, assignedEmail) => {
          setOverrides(p => {
            const u = { ...p, [tkt.id]: { ...(p[tkt.id] || {}), assignedAgent, assignedEmail } };
            localStorage.setItem('rto_ticket_overrides', JSON.stringify(u));
            return u;
          });
        };

        const sid = extractSheetId(DEFAULT_SHEET_URL);
        if (!sid) {
          setLocalAssignee(agentAssignedTag, googleUser.email);
          writeToSheetRow(tkt.orderNumber, tkt.rawIndex, { assignedAgent: agentAssignedTag });
          showToast(`Claimed order ${tkt.orderNumber} for ${googleUser.email}`);
          return;
        }

        try {
          // Resolve by order number (not the cached rawIndex, which can drift) and check
          // whether someone else has genuinely already claimed it since this browser's last
          // sync, instead of overwriting them.
          const liveMap = await fetchLiveOrderAndAgentMap(sid);
          const key = (tkt.orderNumber || '').toString().trim().toUpperCase();
          const live = liveMap ? liveMap.get(key) : null;

          if (live && live.agent && live.agent.toLowerCase() !== 'unassigned') {
            setLocalAssignee(live.agent, live.agent);
            showToast(`⚠️ Lead ${tkt.orderNumber} was just claimed by ${live.agent}. Refresh to sync view.`);
            return;
          }

          setLocalAssignee(agentAssignedTag, googleUser.email);
          writeToSheetRow(tkt.orderNumber, tkt.rawIndex, { assignedAgent: agentAssignedTag });
          showToast(`Claimed order ${tkt.orderNumber} for ${googleUser.email} & updated Column Q!`);
        } catch (e) {
          // Live verification itself failed (network hiccup) - still claim locally and let
          // writeToSheetRow's own row-by-order-number resolution do the write safely.
          setLocalAssignee(agentAssignedTag, googleUser.email);
          writeToSheetRow(tkt.orderNumber, tkt.rawIndex, { assignedAgent: agentAssignedTag });
          showToast(`Claimed order ${tkt.orderNumber} for ${googleUser.email} & updated Column Q!`);
        }
      };

      const openDisp = (t)=>{
        if (agentStatus === 'Offline' && userRole !== 'Admin') {
          showToast('⚠️ Cannot process leads while Offline. Switch status to Online first.');
          return;
        }
        // Auto-assign lead to active agent when opening call form if unassigned
        if(!t.assignedAgent || t.assignedAgent === 'Unassigned') {
          claimLeadForAgent(t);
        }

        setDispTkt(t);
        const existing = overrides[t.id];
        setDispConn(existing?.connectedStatus === 'Yes' ? 'YES' : existing?.connectedStatus === 'No' ? 'NO' : null);
        setDispReason(existing?.agentDisposition || '');
        setAlreadyRefunded(existing?.alreadyRefunded === 'Yes' || existing?.agentDisposition === 'Already Refunded' ? 'YES' : existing?.alreadyRefunded === 'No' ? 'NO' : null);
        setNewOrder(existing?.newOrderId ? 'YES' : null);
        setNewOrderId(existing?.newOrderId || '');
        setAddrChange(existing?.newAddress ? 'YES' : null);
        setNewAddr(existing?.newAddress || '');
        setRefNotes(existing?.refundDetails?.notes || '');
        setAgentRemarks(existing?.agentRemarks || '');
        setAttemptType(existing?.attemptType || t.attemptType || '');
      };

      const submitDisp = async ()=>{
        if(!dispTkt)return;
        const isRef=dispReason==='Refund Requested';
        if(isRef && dispTkt.paymentMethod!=='Prepaid'){
          showToast('Refund can only be initiated for Prepaid orders');
          return;
        }

        let gokwik=null;
        if(isRef){
          setRefundProcessing(true);
          try{
            const r=await fetch('/api/refund/gokwik-initiate',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({moid:dispTkt.orderNumber,amount:dispTkt.orderAmount})
            });
            const data=await r.json();
            if(!r.ok||!data.ok){
              setRefundProcessing(false);
              showToast(data?.error||'Refund failed at gateway — order not disposed. Please retry.');
              return;
            }
            gokwik=data;
          }catch(e){
            setRefundProcessing(false);
            showToast('Could not reach refund service — order not disposed. Please retry.');
            return;
          }
          setRefundProcessing(false);
        }

        const st=isRef?'Refunded':dispConn==='YES'?`Connected — ${dispReason}`:`Unreachable — ${dispReason}`;

        // Auto-assign Column Q to active agent's Email ID
        const agentAssignedTag = `${googleUser.email}`;
        const isAlreadyRef = alreadyRefunded === 'YES' || dispReason === 'Already Refunded';

        // Once a lead has a real assigned agent, that assignment must never change - not to
        // blank, not to a different agent - even if someone else (e.g. a Team Lead helping
        // out) is the one submitting the disposition. Live-check Column Q's current value
        // (same pattern as claimLeadForAgent) so a stale/cached local view can't silently
        // steal someone else's lead; only a genuinely still-unassigned lead gets claimed here.
        let finalAssignedAgent = agentAssignedTag;
        let finalAssignedEmail = googleUser.email;
        let claimBlocked = false;
        try {
          const sid = extractSheetId(DEFAULT_SHEET_URL);
          if (sid) {
            const liveMap = await fetchLiveOrderAndAgentMap(sid);
            const key = (dispTkt.orderNumber || '').toString().trim().toUpperCase();
            const live = liveMap ? liveMap.get(key) : null;
            if (live && live.agent && live.agent.toLowerCase() !== 'unassigned' && !live.agent.toLowerCase().includes(googleUser.email.toLowerCase())) {
              finalAssignedAgent = live.agent;
              finalAssignedEmail = live.agent;
              claimBlocked = true;
            }
          }
        } catch (e) {
          console.error('Live assignment check error:', e);
        }

        // Resolve Column S (Attempt) value:
        // - If refund was initiated, auto-set to 'Already Refunded'
        // - If user explicitly selected an attempt type, use that
        // - If disposition is 'Already Refunded', set to 'Already Refunded'
        const resolvedAttempt = isRef ? 'Already Refunded'
          : isAlreadyRef ? 'Already Refunded'
          : dispReason === 'Delivered' ? 'Delivered'
          : attemptType || '';

        const ov={
          status: isAlreadyRef ? 'Refunded' : st,
          connectedStatus: dispConn==='YES'?'Yes':'No',
          agentDisposition: dispReason,
          attemptType: resolvedAttempt,
          alreadyRefunded: isAlreadyRef ? 'Yes' : 'No',
          agentRemarks: agentRemarks.trim(),
          newOrderId: newOrder==='YES'?newOrderId:'',
          newAddress: addrChange==='YES'?newAddr:'',
          disposedAt: new Date().toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}),
          disposedBy: agentAssignedTag,
          assignedAgent: finalAssignedAgent,
          assignedEmail: finalAssignedEmail
        };

        setOverrides(p=>{const u={...p,[dispTkt.id]:ov};localStorage.setItem('rto_ticket_overrides',JSON.stringify(u));return u;});
        if (claimBlocked) {
          showToast(`ℹ️ This lead is assigned to ${finalAssignedAgent} — recorded your disposition without changing the assignment.`);
        }

        // Live Google Sheet Write-Back to Column Q, R, S, T, U, V, X! assignedAgent is only
        // included when this agent already legitimately owns the lead (or it was genuinely
        // unassigned and this claims it) - never to hand a different agent's lead over.
        const sheetUpdates = {
          connectedStatus: dispConn==='YES'?'Yes':'No',
          attemptType: resolvedAttempt,
          disposition: dispReason,
          remarks: (isAlreadyRef ? '[Already Refunded] ' : '') + agentRemarks.trim(),
          newOrderId: newOrder==='YES'?newOrderId:'',
          newAddress: addrChange==='YES'?newAddr:''
        };
        if (!claimBlocked) {
          sheetUpdates.assignedAgent = agentAssignedTag;
        }
        writeToSheetRow(dispTkt.orderNumber, dispTkt.rawIndex, sheetUpdates);

        // Mirror the disposal into Postgres's lead_assignments table (assigned_at's
        // counterpart - see api/_lib/db.js), same submit action as the Sheet write above -
        // awaited (with one retry, see postJsonWithRetry) so a failure is actually visible
        // to the agent instead of vanishing silently. The Sheet write already landed above
        // regardless, so a DB-side failure here is surfaced, not blocking.
        const dbSynced = await postJsonWithRetry('/api/auth/recordDisposition', {
          orderId: dispTkt.orderNumber,
          awbCode: dispTkt.awbCode,
          rtoReason: dispTkt.rtoReason,
          disposition: dispReason,
          agentRemarks: (isAlreadyRef ? '[Already Refunded] ' : '') + agentRemarks.trim(),
          connected: dispConn==='YES'?'Yes':'No',
          attempt: resolvedAttempt,
          refundAmount: (isRef || isAlreadyRef) ? dispTkt.orderAmount : null,
          newOrderId: newOrder==='YES'?newOrderId:'',
        });
        if (!dbSynced) {
          showToast(`⚠️ Disposed ${dispTkt.orderNumber} in the sheet, but the database sync failed — check console.`);
        }

        const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        
        const newLog = {
          time: t,
          agent: googleUser.email,
          action: `Disposed ${dispTkt.orderNumber} → ${dispReason}` + (isAlreadyRef ? ' (Already Refunded)' : ''),
          type: isRef || isAlreadyRef ? 'refund' : 'ticket',
          remarks: agentRemarks.trim()
        };

        setActivityLogs(p=>{
          const u=[newLog, ...p.slice(0,99)];
          localStorage.setItem('rto_central_activity_logs_v3',JSON.stringify(u));
          return u;
        });
        
        if(isRef){
          const gkData=gokwik?.gokwik||{};
          doRefund(dispTkt.id,{
            refundId: gkData.refund_id || gkData.refundId || gkData.id || `RFD-${Date.now().toString().slice(-6)}`,
            amount:dispTkt.orderAmount,
            reason:dispReason,
            date:new Date().toLocaleString(),
            mode:`GoKwik (${gokwik?.vendor||'gateway'})`,
            transactionRef: gkData.transaction_id || gkData.txn_id || gkData.transactionRef || `TXN-${Math.random().toString(36).substring(2,10).toUpperCase()}`,
            processedBy:googleUser.name,
            notes:refNotes,
            gokwikResponse: gkData
          });
        } else {
          showToast(`Disposed ${dispTkt.orderNumber} & refilled fresh lead into box!`);
        }
        setDispTkt(null);
      };

      const doRefund = (id, rec)=>{
        const agentAssignedTag = `${googleUser.email}`;
        // MERGE with existing overrides — do NOT replace all fields!
        setOverrides(p=>{
          const existing = p[id] || {};
          const u = {...p, [id]: {
            ...existing,
            status:'Refunded',
            refundDetails:rec,
            attemptType: 'Already Refunded',
            assignedAgent: existing.assignedAgent || agentAssignedTag,
            assignedEmail: existing.assignedEmail || googleUser.email
          }};
          try { localStorage.setItem('rto_ticket_overrides', JSON.stringify(u)); } catch {}
          return u;
        });
        if(googleUser.email){setStats(p=>{const c=p[googleUser.email]||{resolvedCount:0};const u={...p,[googleUser.email]:{resolvedCount:c.resolvedCount+1,lastResolvedAt:Date.now()}};localStorage.setItem('rto_agent_stats',JSON.stringify(u));return u;});}
        const tgt=tickets.find(t=>t.id===id);
        if(tgt){setReceiptTkt({...tgt,refundDetails:rec});try{confetti({particleCount:60,spread:55,origin:{y:.7}});}catch{}showToast(`₹${rec.amount.toLocaleString('en-IN')} refunded successfully`);}
      };

      // Admin-only: remove an agent's row from the roster entirely (not just clear their
      // leads - the existing "Unassign" button already does that). Blocked while they still
      // hold pending leads, since removing them from agentRoster wouldn't unassign anything.
      // Note: this only removes their entry from the manually-managed agentRoster list - if
      // they still have ANY ticket history (pending or disposed) referencing their email,
      // effectiveAgentRoster's dynamic discovery will re-add them with generic defaults
      // (role: Agent, quota: 10), since the roster is partly derived from the sheet itself,
      // not just this list. An agent with zero ticket history disappears entirely.
      const removeAgentFromRoster = (email, name) => {
        const lower = (email || '').toLowerCase();
        if (!lower) return;
        const prefix = lower.split('@')[0];

        const activeCount = allTickets.filter(t => {
          if (t.status !== 'Pending' || t.disposition || t.agentRemarks) return false;
          const currAgt = (t.assignedAgent || '').toLowerCase();
          return currAgt.includes(lower) || currAgt.includes(prefix);
        }).length;

        if (activeCount > 0) {
          showToast(`Can't remove ${name} — they still have ${activeCount} pending lead(s). Reassign or unassign those first.`);
          return;
        }

        setAgentRoster(p => {
          const u = p.filter(a => (a.email || '').toLowerCase() !== lower);
          try { localStorage.setItem('rto_agent_roster', JSON.stringify(u)); } catch {}
          return u;
        });
        showToast(`Removed ${name} from the roster.`);
      };

      // Admin-only: pre-add a brand-new team member before they've ever logged in or been
      // assigned a lead - effectiveAgentRoster would otherwise only pick them up once one of
      // those happens (see the dynamic-discovery block above), which is too late if you want
      // their role/quota set up in advance.
      const addAgentToRoster = (email, role) => {
        const lower = (email || '').trim().toLowerCase();
        if (!lower || !lower.includes('@')) {
          showToast('Enter a valid email address.');
          return;
        }
        if (effectiveAgentRoster.some(a => (a.email || '').toLowerCase() === lower)) {
          showToast(`${lower} is already on the roster.`);
          return;
        }
        const name = lower.split('@')[0].split('.').map(p => p ? p.charAt(0).toUpperCase() + p.slice(1) : p).join(' ');
        const effectiveRole = role || 'Agent';
        const newAgent = { email: lower, name, role: effectiveRole, maxQuota: effectiveRole === 'Agent' ? 20 : 10, status: 'Offline', aht: '2.8m', breakTime: '15m' };
        setAgentRoster(p => {
          const u = [...p, newAgent];
          try { localStorage.setItem('rto_agent_roster', JSON.stringify(u)); } catch {}
          return u;
        });
        showToast(`Added ${name} (${lower}) as ${role || 'Agent'}.`);
      };

      // Admin Bulk Reassign / Unassign Controls
      // Admin-only: moves every one of sourceAgentEmail's active leads to targetAgentEmail.
      // A lead is never cleared to blank here - once assigned, it always stays assigned to
      // someone; this only ever moves it between two named agents (e.g. offboarding an agent
      // whose leads need a new home), it never unassigns.
      const adminBulkAction = async (sourceAgentEmail, targetAgentEmail) => {
        const sourceEmail = sourceAgentEmail.toLowerCase();
        const sourcePrefix = sourceEmail.split('@')[0];

        // Find all tickets assigned to sourceAgentEmail
        const targetTickets = tickets.filter(t => {
          const currAgt = (overrides[t.id]?.assignedAgent || t.assignedAgent || '').toLowerCase();
          return currAgt.includes(sourceEmail) || currAgt.includes(sourcePrefix);
        });

        if (targetTickets.length === 0) {
          showToast(`No active leads found for ${sourceAgentEmail}`);
          return;
        }

        const newAssignedTag = targetAgentEmail;
        const newOverrides = {};
        targetTickets.forEach(t => {
          newOverrides[t.id] = {
            ...(overrides[t.id] || {}),
            assignedAgent: newAssignedTag,
            assignedEmail: targetAgentEmail
          };
        });

        // Update UI overrides state instantly
        setOverrides(p => {
          const u = { ...p, ...newOverrides };
          try { localStorage.setItem('rto_ticket_overrides', JSON.stringify(u)); } catch {}
          return u;
        });

        // Batch update live Google Sheet Column Q
        try {
          const sid = extractSheetId(DEFAULT_SHEET_URL);
          if (!sid) return;

          // Resolve each ticket's CURRENT row by order number rather than trusting the cached
          // rawIndex, which can drift if the sheet's row order shifted since the last sync.
          const rowMap = await fetchLiveOrderRowMap(sid);
          const valueRanges = [];
          let skipped = 0;
          targetTickets.forEach(t => {
            const key = (t.orderNumber || '').toString().trim().toUpperCase();
            const rowNumber = rowMap ? rowMap.get(key) : (t.rawIndex + 2);
            if (!rowNumber) { skipped++; return; }
            valueRanges.push({ range: `Data!Q${rowNumber}`, values: [[newAssignedTag]] });
          });
          if (skipped > 0) console.warn(`Bulk reassign: skipped ${skipped} lead(s) not found in live sheet.`);

          if (valueRanges.length > 0) {
            const res = await fetch('/api/rto/sheet', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ op: 'batchUpdate', sid, data: valueRanges })
            });
            if (res.ok) {
              showToast(`🔄 Reassigned ${valueRanges.length} leads to ${targetAgentEmail} & updated Google Sheet!`);
            }
          }
        } catch (err) {
          console.error('Bulk reassign error:', err);
        }
      };

      // Sync
      const sync = useCallback(async(silent=false)=>{
        const sid=extractSheetId(DEFAULT_SHEET_URL);if(!sid)return;setIsSyncing(true);
        try{
          const raw=await fetchSheet(sid,DEFAULT_SHEET_RANGE);
          const mapped=await parseRows(raw,googleUser,userRole);
          setTickets(mapped);
          try{localStorage.setItem('rto_cache_v4',JSON.stringify(mapped.slice(0,10000)));}catch{}
          setLastSync(new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
          setSyncError(null);
          if(!silent)showToast(`${mapped.length.toLocaleString('en-IN')} leads synced`);
        } catch(e) {
          // A background sync failure used to fail completely silently (silent=true suppressed
          // the toast, and nothing else surfaced it) - the UI just kept showing whatever stale
          // cached tickets it already had, indefinitely, with zero visible indication anything
          // was wrong. Always log it and keep a persistent on-screen indicator regardless of
          // silent, and retry sooner than the normal 60s cadence instead of leaving the agent
          // on broken data for up to a minute.
          console.error('Sync failed:', e);
          setSyncError(e.message || 'Sync failed');
          if(!silent)showToast(e.message);
          setTimeout(()=>sync(true), 15000);
        } finally {
          setIsSyncing(false);
        }
      },[googleUser,userRole,showToast]);

      useEffect(()=>{sync(true);},[]);
      useEffect(()=>{const t=setInterval(()=>sync(true),60000);return()=>clearInterval(t);},[sync]);

      // Detects when a newer deployment of this page has shipped while this tab has been
      // sitting open. rto-crm.html is a static file with no build step / hot-reload - once
      // loaded, a long-lived tab keeps running that exact JS forever with zero indication a
      // new version exists, which is exactly how some agents' browsers kept running old JS
      // that predated a feature (e.g. Postgres disposition syncing) while others, who'd
      // reloaded more recently, silently got it. Polls the file's own ETag/Last-Modified via
      // a no-store HEAD request rather than requiring a manually-bumped version constant, so
      // this stays accurate with zero upkeep on every future edit to this file.
      const [updateAvailable, setUpdateAvailable] = useState(false);
      const deployedVersionRef = useRef(null);
      useEffect(() => {
        const checkVersion = async () => {
          try {
            const res = await fetch(window.location.pathname, { method: 'HEAD', cache: 'no-store' });
            const v = res.headers.get('etag') || res.headers.get('last-modified');
            if (!v) return;
            if (deployedVersionRef.current === null) {
              deployedVersionRef.current = v;
            } else if (v !== deployedVersionRef.current) {
              setUpdateAvailable(true);
            }
          } catch (e) {
            // Network hiccup - just skip this round, next interval tries again.
          }
        };
        checkVersion();
        const t = setInterval(checkVersion, 3 * 60 * 1000);
        return () => clearInterval(t);
      }, []);

      // Dynamic Roster that automatically includes EVERY unique agent found in Google Sheet tickets or overrides
      const effectiveAgentRoster = useMemo(() => {
        const rosterMap = new Map();
        
        (agentRoster || []).forEach(a => {
          if (a && a.email) rosterMap.set(a.email.toLowerCase(), { ...a });
        });

        if (googleUser && googleUser.email && !rosterMap.has(googleUser.email.toLowerCase())) {
          const email = googleUser.email.toLowerCase();
          const name = googleUser.name || email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
          const isAdmin = email.includes('vighnesh') || email.includes('vikash');
          rosterMap.set(email, {
            email, name, role: isAdmin ? 'Admin' : 'Agent', maxQuota: isAdmin ? 10 : 20, status: 'Online', aht: '2.5m', breakTime: '15m'
          });
        }

        (tickets || []).forEach(t => {
          const agt = (overrides[t.id]?.assignedAgent || t.assignedAgent || '').trim();
          if (agt && agt !== 'Unassigned') {
            let email = agt.toLowerCase();
            let name = agt;
            if (agt.includes('(')) {
              const match = agt.match(/\(([^)]+)\)/);
              if (match) email = match[1].toLowerCase().trim();
              name = agt.split('(')[0].trim();
            } else if (agt.includes('@')) {
              email = agt.toLowerCase().trim();
              const parts = email.split('@')[0].split('.');
              name = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
            } else {
              email = `${agt.toLowerCase().replace(/\s+/g, '.')}@mcaffeine.com`;
              name = agt;
            }
            if (!rosterMap.has(email)) {
              rosterMap.set(email, { email, name, role: 'Agent', maxQuota: 20, status: 'Online', aht: '2.8m', breakTime: '15m' });
            }
          }
        });

        // The signed-in user's own status is authoritative locally (no round-trip lag).
        // Everyone else's status comes from serverPresence (Neon Postgres agent_presence,
        // fetched by fetchServerPresence above) when available, so the roster table shows
        // each agent's real reported status instead of a stale local/seeded default.
        const myEmail = googleUser?.email ? googleUser.email.toLowerCase() : null;
        rosterMap.forEach((a, email) => {
          if (email === myEmail) {
            a.status = agentStatus;
          } else if (serverPresence[email]?.status) {
            a.status = serverPresence[email].status;
          }
        });

        return Array.from(rosterMap.values());
      }, [agentRoster, tickets, overrides, googleUser, agentStatus, serverPresence]);

      // Derived data & STRICT Calling Date (Latest First) Sorting
      const allTickets = useMemo(()=>{
        // 1. Merge overrides with base tickets
        let base = tickets.map(t => {
          const o = overrides[t.id];
          return o ? {
            ...t,
            status: o.status || t.status,
            refundDetails: o.refundDetails,
            connected: o.connectedStatus || t.connected,
            disposition: o.agentDisposition || t.disposition,
            agentRemarks: o.agentRemarks !== undefined ? o.agentRemarks : t.agentRemarks,
            newOrderId: o.newOrderId || t.newOrderId,
            newAddress: o.newAddress || t.newAddress,
            disposedAt: o.disposedAt || t.disposedAt,
            disposedBy: o.disposedBy || t.disposedBy,
            // The sheet's own Column Q is authoritative once it shows a real agent - a stale
            // local override (e.g. this browser's own optimistic self-claim that got beaten by
            // another agent's write in a race) must never permanently mask what the sheet says
            // after a fresh sync. The override only fills the gap while Column Q is still blank.
            assignedAgent: (t.assignedAgent && t.assignedAgent !== 'Unassigned') ? t.assignedAgent : (o.assignedAgent || t.assignedAgent),
            attemptType: o.attemptType || t.attemptType
          } : t;
        });

        // 2. STAGE 1 DEDUPLICATION: Group by orderNumber to ensure NO duplicate Order IDs exist!
        const uniqueOrderMap = new Map();
        base.forEach(t => {
          if (!t.orderNumber) return;
          const key = t.orderNumber.toString().trim().toUpperCase();
          if (!uniqueOrderMap.has(key)) {
            uniqueOrderMap.set(key, t);
          } else {
            // If duplicate row exists, prefer the one that is assigned to an agent, disposed, or has remarks
            const existing = uniqueOrderMap.get(key);
            const isExistingActive = (existing.assignedAgent && existing.assignedAgent !== 'Unassigned') || existing.disposition || existing.agentRemarks || existing.status !== 'Pending';
            const isNewActive = (t.assignedAgent && t.assignedAgent !== 'Unassigned') || t.disposition || t.agentRemarks || t.status !== 'Pending';
            if (isNewActive && !isExistingActive) {
              uniqueOrderMap.set(key, t);
            }
          }
        });
        base = Array.from(uniqueOrderMap.values());

        // 3. STRICT CALLING DATE SORTING: Latest calling date (e.g. 22 Jul, 21 Jul) ALWAYS at the top!
        base.sort((a,b)=>{
          if(a.rowDate && b.rowDate && a.rowDate.getTime() !== b.rowDate.getTime()) {
            return b.rowDate.getTime() - a.rowDate.getTime();
          }
          return b.rawIndex - a.rawIndex;
        });

        // Lead assignment (deciding which unassigned lead goes to which online agent, and
        // writing it to Column Q) now runs server-side only - see scripts/assign_leads.py,
        // scheduled via .github/workflows/assign-leads.yml. This used to also run here,
        // independently, in every agent's browser: each browser's own possibly-stale
        // ticket/roster snapshot could disagree about who "should" get an unassigned lead,
        // and whichever browser's write reached Column Q last silently won, overwriting
        // another agent's legitimate claim. The CRM now just displays whatever Column Q
        // already says (see the 'fresh' tab filter below) - manual single-lead claiming
        // (claimLeadForAgent, triggered by an agent explicitly opening a still-unassigned
        // ticket) is unaffected and still writes directly, since that's a deliberate,
        // one-at-a-time human action rather than a background mass-assignment race.
        return base;
      },[tickets,overrides]);

      // Admin-only read-only preview of what scripts/assign_leads.py's next scheduled run
      // would do: same eligibility (currently-online agents), same quota, same priority-tier
      // + newest-date-first ordering. Nothing here writes anything - it's a forecast, not a
      // trigger. A lead with any value in Column Q already (assigned to anyone, online or
      // not) is permanently exempt - it counts toward that agent's load but is never
      // reassigned, matching the script exactly.
      const predictedAssignments = useMemo(() => {
        const onlineAgents = effectiveAgentRoster
          .filter(a => a.status === 'Online')
          .map(a => a.email.toLowerCase())
          .sort();

        if (onlineAgents.length === 0) {
          return { onlineAgents, rows: [], leftover: 0 };
        }

        const currentLoad = {};
        onlineAgents.forEach(e => { currentLoad[e] = 0; });

        const pool = []; // { ticket, tier }

        allTickets.forEach(t => {
          if (!t.orderNumber) return;
          const isDisposed = !!(t.disposition || t.agentRemarks || t.status !== 'Pending');
          if (isDisposed) return;

          const agt = (t.assignedAgent || '').trim().toLowerCase();
          const isUnassigned = !agt || agt === 'unassigned';
          const tier = getPriorityTier(t);

          if (isUnassigned) {
            pool.push({ ticket: t, tier });
          } else if (Object.prototype.hasOwnProperty.call(currentLoad, agt)) {
            currentLoad[agt] += 1;
          }
          // else: held by someone (online or not) - left alone either way.
        });

        // Tier ascending, then newest RTO Initiated Date first within each tier
        // (NOT Calling Date - see mapTkt's rtoInitiatedDate).
        pool.sort((a, b) => {
          if (a.tier !== b.tier) return a.tier - b.tier;
          const ad = a.ticket.rtoInitiatedDate ? a.ticket.rtoInitiatedDate.getTime() : 0;
          const bd = b.ticket.rtoInitiatedDate ? b.ticket.rtoInitiatedDate.getTime() : 0;
          return bd - ad;
        });

        const needed = {};
        onlineAgents.forEach(e => { needed[e] = Math.max(0, ASSIGNMENT_QUOTA - currentLoad[e]); });

        const rows = [];
        let queuePos = 0;
        let agentCycle = onlineAgents.filter(e => needed[e] > 0);
        while (queuePos < pool.length && agentCycle.length > 0) {
          let progressed = false;
          for (const email of [...agentCycle]) {
            if (queuePos >= pool.length) break;
            if (needed[email] <= 0) { agentCycle = agentCycle.filter(e => e !== email); continue; }
            const item = pool[queuePos];
            rows.push({ ticket: item.ticket, tier: item.tier, predictedAgent: email, rank: rows.length + 1 });
            needed[email] -= 1;
            queuePos += 1;
            progressed = true;
            if (needed[email] <= 0) { agentCycle = agentCycle.filter(e => e !== email); }
          }
          if (!progressed) break;
        }

        return { onlineAgents, rows, leftover: pool.length - rows.length };
      }, [allTickets, effectiveAgentRoster]);

      // Fresh Unassigned Leads Count in Sheet
      const freshUnassignedCount = useMemo(() => {
        return tickets.filter(t => {
          if (!t.orderNumber) return false; // Skip tickets without valid order ID
          const agt = overrides[t.id]?.assignedAgent || t.assignedAgent;
          return !agt || agt === 'Unassigned';
        }).length;
      }, [tickets, overrides]);



      // Same restriction as `filtered` above: an Agent's tab-count badges must only ever
      // reflect their own leads, never every agent's, regardless of agentFilter's value.
      const myScopeEmail = userRole === 'Agent' ? (googleUser?.email || '').toLowerCase() : '';
      const inMyScope = (t) => {
        if (!myScopeEmail) return true;
        const a = (t.assignedAgent || '').toLowerCase();
        return a.includes(myScopeEmail) || myScopeEmail.includes(a);
      };
      const pend=allTickets.filter(t=>inMyScope(t)&&t.status==='Pending'&&!t.disposition&&!t.agentRemarks).length;
      const dispCount=allTickets.filter(t=>inMyScope(t)&&(t.disposition||t.agentRemarks||t.status!=='Pending')).length;
      const freshAssignedCount=allTickets.filter(t=>{
        const agt=(t.assignedAgent||'').trim().toLowerCase();
        return agt&&agt!=='unassigned'&&inMyScope(t)&&t.status==='Pending'&&!t.disposition&&!t.agentRemarks;
      }).length;

      const agents = useMemo(()=>{
        const s=new Set();
        effectiveAgentRoster.forEach(a=>s.add(a.email));
        allTickets.forEach(t=>{if(t.assignedAgent&&t.assignedAgent!=='Unassigned')s.add(t.assignedAgent);});
        return[...s].sort();
      },[effectiveAgentRoster,allTickets]);

      const agentOptions = useMemo(() => [
        { value: 'ALL', label: 'All agents' },
        ...agents.map(a => ({ value: a, label: a.includes('(') ? a.split('(')[0].trim() : (a.includes('@') ? a.split('@')[0] : a) }))
      ], [agents]);

      const dateOptions = [
        { value: 'ALL_TIME', label: 'All time' },
        { value: 'TODAY', label: 'Today' },
        { value: 'YESTERDAY', label: 'Yesterday' },
        { value: '7_DAYS', label: 'Last 7 days' },
        { value: '30_DAYS', label: 'Last 30 days' },
        { value: 'CUSTOM', label: 'Custom range' },
      ];

      const payOptions = [
        { value: 'ALL', label: 'All payments' },
        { value: 'Prepaid', label: 'Prepaid' },
        { value: 'COD', label: 'COD' },
      ];

      const perPageOptions = [
        { value: 25, label: '25 per page' },
        { value: 50, label: '50 per page' },
        { value: 100, label: '100 per page' },
      ];

      const statusOptions = [
        { value: 'Online', label: 'Online', icon: '🟢' },
        { value: 'Busy', label: 'On Break', icon: '🟡' },
        { value: 'Offline', label: 'Offline', icon: '⚪' },
      ];

      // Team Roster tab's status filter - same three live statuses plus an "All" option.
      const rosterStatusOptions = [
        { value: 'All', label: 'All Statuses', icon: '📋' },
        ...statusOptions,
      ];

      const roleOptions = [
        { value: 'Admin', label: 'Role: Admin', icon: '🛡️' },
        { value: 'Team Lead', label: 'Role: Team Lead', icon: '👑' },
        { value: 'Agent', label: 'Role: Agent', icon: '👤' },
      ];

      const themeOptions = [
        { value: 'dark', label: 'Theme: Dark', icon: '🌙' },
        { value: 'light', label: 'Theme: Light', icon: '☀️' },
        { value: 'purple', label: 'Theme: Purple', icon: '🔮' },
      ];

      const connectedOutcomes = [
        { value: 'Customer Agreed to Accept', label: 'Customer Agreed to Accept (Reorder)', icon: '📦', desc: 'Customer agreed to receive shipment / converted reorder' },
        { value: 'Delivered', label: 'Delivered', icon: '✅', desc: 'Shipment has already been delivered to customer' },
        { value: 'Already Refunded', label: 'Already Refunded', icon: '💸', desc: 'Order was already refunded previously' },
        { value: 'Refund Requested', label: 'Refund Requested', icon: '💳', desc: 'Process immediate refund (Prepaid orders only)' },
        { value: 'Product Issue / Exchange', label: 'Product Issue / Exchange', icon: '🔄', desc: 'Customer requested item exchange' },
        { value: 'Address Change Requested', label: 'Address Change Requested', icon: '📍', desc: 'Updated delivery address needed' },
        { value: 'Language Barrier', label: 'Language Barrier', icon: '🗣️', desc: 'Communication issue / regional language barrier' },
        { value: 'Disconnected', label: 'Disconnected', icon: '🔌', desc: 'Call got disconnected during conversation' },
        { value: 'Not Interested', label: 'Not Interested / Cancelled', icon: '🚫', desc: 'Customer refused delivery' },
        { value: 'Wrong Number', label: 'Wrong Number', icon: '📵', desc: 'Incorrect contact information' },
      ];

      const unreachableOutcomes = [
        { value: 'Refund Requested', label: 'Refund Requested (Initiate Refund)', icon: '💳', desc: 'Process immediate refund (Prepaid orders only)' },
        { value: 'Delivered', label: 'Delivered', icon: '✅', desc: 'Shipment has already been delivered to customer' },
        { value: 'Already Refunded', label: 'Already Refunded', icon: '💸', desc: 'Order was already refunded previously' },
        { value: 'Language Barrier', label: 'Language Barrier', icon: '🗣️', desc: 'Communication issue / regional language barrier' },
        { value: 'Disconnected', label: 'Disconnected', icon: '🔌', desc: 'Call got disconnected / line dropped' },
        { value: 'Ringing / No Answer', label: 'Ringing / No Answer', icon: '🔔', desc: 'Phone rang but no response' },
        { value: 'Not Reachable', label: 'Not Reachable', icon: '📡', desc: 'Out of coverage area' },
        { value: 'Switch Off', label: 'Switched Off', icon: '📴', desc: 'Mobile device turned off' },
        { value: 'Line Busy', label: 'Line Busy', icon: '⏳', desc: 'Call waiting or busy line' },
        { value: 'Invalid Number', label: 'Invalid Number', icon: '❌', desc: 'Number does not exist' },
      ];

      // Compute performance metrics for currently selected agent filter (or logged-in agent) & date scope
      const agentPerf = useMemo(() => {
        const targetEmail = userRole === 'Agent' ? (googleUser?.email || '').toLowerCase() : agentFilter.toLowerCase();
        const targetPrefix = targetEmail !== 'all' ? targetEmail.split('@')[0] : '';

        const isTargetAgent = (agt) => {
          if (targetEmail === 'all') return true;
          if (!agt || agt === 'Unassigned') return false;
          const lower = agt.toLowerCase();
          return lower.includes(targetEmail) || (targetPrefix && lower.includes(targetPrefix));
        };

        const inScope = (t) => isDateInScope(t.rowDate, dateScope, customDateFrom, customDateTo);

        const agentLeads = allTickets.filter(t => isTargetAgent(t.assignedAgent) && inScope(t));
        const disposedLeads = agentLeads.filter(t => t.disposition || t.agentRemarks || t.status !== 'Pending');

        const connectedCalls = disposedLeads.filter(t => {
          const ov = overrides[t.id];
          return ov?.connectedStatus === 'Yes' || t.connected === 'Yes';
        }).length;

        const reordersConverted = disposedLeads.filter(t => {
          const ov = overrides[t.id];
          const disp = ov?.agentDisposition || t.disposition;
          return !!(ov?.newOrderId || disp === 'Customer Agreed to Accept' || disp === 'Product Issue / Exchange');
        }).length;

        const alreadyRefundedCount = disposedLeads.filter(t => {
          const ov = overrides[t.id];
          const disp = ov?.agentDisposition || t.disposition;
          return !!(ov?.alreadyRefunded === 'Yes' || disp === 'Already Refunded' || disp === 'Refund Requested' || t.status === 'Refunded');
        }).length;

        const connectRate = disposedLeads.length > 0 ? Math.round((connectedCalls / disposedLeads.length) * 100) : 0;
        const reorderRate = connectedCalls > 0 ? Math.round((reordersConverted / connectedCalls) * 100) : 0;

        return {
          totalAssigned: agentLeads.length,
          disposedCount: disposedLeads.length,
          connectedCalls,
          reordersConverted,
          alreadyRefundedCount,
          connectRate,
          reorderRate
        };
      }, [allTickets, agentFilter, googleUser, userRole, dateScope, customDateFrom, customDateTo, overrides]);

      useEffect(() => {
        setPage(1);
      }, [tab, search, payFilter, agentFilter, dateScope, customDateFrom, customDateTo]);

      const filtered = useMemo(()=>{
        // An Agent must never see another agent's leads regardless of agentFilter's value -
        // agentFilter is an Admin-only "view as this agent" control. It only gets synced to
        // the signed-in agent's own email inside handleSwitchRole's manual toggle, so a plain
        // Agent login that never touches that dropdown left it at its 'ALL' default, and
        // everyone's leads showed up. Force the restriction here instead of trusting that.
        const restrictToEmail = userRole === 'Agent'
          ? (googleUser?.email || '').toLowerCase()
          : (agentFilter !== 'ALL' ? agentFilter.toLowerCase() : '');

        // Fresh Leads Tab: Shows leads ASSIGNED to the current agent/filter that have NOT been disposed yet!
        if (tab === 'fresh') {
          return allTickets.filter(t => {
            const agt = (t.assignedAgent || '').trim();
            const isAssigned = agt && agt.toLowerCase() !== 'unassigned';
            if (!isAssigned) return false;
            if (t.status !== 'Pending' || t.disposition || t.agentRemarks) return false;
            if (restrictToEmail) { const a = agt.toLowerCase(); if (!a.includes(restrictToEmail) && !restrictToEmail.includes(a)) return false; }
            if (payFilter !== 'ALL' && t.paymentMethod !== payFilter) return false;
            if (search.trim()) {
              const q = search.toLowerCase();
              if (![t.orderNumber, t.customerName, t.email, t.phone, t.rtoReason, t.callingDate].some(f => (f || '').toLowerCase().includes(q))) return false;
            }
            return true;
          }).sort((a, b) => {
            if (a.rowDate && b.rowDate && a.rowDate.getTime() !== b.rowDate.getTime()) {
              return b.rowDate.getTime() - a.rowDate.getTime();
            }
            return b.rawIndex - a.rawIndex;
          });
        }

        // All Leads Tab: Shows every lead that has ALREADY been disposed (disposition, remarks, or non-Pending status)
        return allTickets.filter(t=>{
          if(restrictToEmail){const a=(t.assignedAgent||'').toLowerCase();if(!a.includes(restrictToEmail)&&!restrictToEmail.includes(a))return false;}
          if(!t.disposition&&!t.agentRemarks&&t.status==='Pending')return false;
          if(payFilter!=='ALL'&&t.paymentMethod!==payFilter)return false;
          if(search.trim()){const q=search.toLowerCase();if(![t.orderNumber,t.customerName,t.email,t.phone,t.rtoReason,t.callingDate,t.assignedAgent,t.agentRemarks,t.disposition].some(f=>(f||'').toLowerCase().includes(q)))return false;}
          return true;
        });
      },[allTickets,tickets,overrides,agentFilter,tab,payFilter,search,userRole,googleUser]);

      const pages=Math.ceil(filtered.length/perPage)||1;
      const visible=filtered.slice((page-1)*perPage,page*perPage);

      const tabs = [
        { key: 'overview', label: userRole === 'Agent' ? '📊 My Overview & Team Metrics' : '📊 Overview (Agents Data)', count: effectiveAgentRoster.length },
        { key: 'all', label: 'All Leads (Disposed)', count: dispCount },
        { key: 'fresh', label: '⚡ Fresh Leads (Assigned)', count: freshAssignedCount }
      ];
      if (userRole === 'Admin' || userRole === 'Team Lead') {
        tabs.push({ key: 'admin', label: 'Admin Panel & Roster', count: effectiveAgentRoster.length });
      }
      if (userRole === 'Admin') {
        tabs.push({ key: 'predicted', label: '🔮 Next to Assign', count: predictedAssignments.rows.length });
      }

      // Automatically redirect away from Admin-only tabs if role switched to Agent
      useEffect(() => {
        if (userRole === 'Agent' && (tab === 'admin' || tab === 'predicted')) {
          setTab('all');
        }
      }, [userRole, tab]);

      return(
        <div className="min-h-screen flex flex-col bg-[#09090b]">

          {/* ═══ CLEAN TOP UTILITY HEADER ═══ */}
          <header className="sticky top-0 z-30 bg-[#09090b]/95 backdrop-blur-xl border-b border-zinc-800/80">
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 min-h-13 py-2 flex items-center justify-between flex-wrap gap-2 sm:gap-4">

              {/* Header Title & Branding */}
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="w-8 h-8 shrink-0 rounded-xl bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-extrabold text-xs shadow-md shadow-indigo-950/50">
                  RTO
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-extrabold text-zinc-100 tracking-tight flex items-center gap-2 truncate">
                    <span className="truncate">RTO Support Command Center</span>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
                  </h1>
                  <p className="text-[11px] text-zinc-500 font-mono hidden sm:flex items-center gap-1.5">
                    Last sync: {lastSync}
                    {syncError && (
                      <span className="text-rose-400 font-sans font-semibold" title={syncError}>
                        ⚠ Sync failed — showing cached data, retrying…
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {/* Header Controls: Search, Sync, Role Switcher, Status */}
              <div className="flex items-center gap-1.5 sm:gap-2.5 flex-wrap justify-end">
                <div className="relative hidden lg:block">
                  <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"/>
                  <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search orders, remarks…" className="w-48 pl-8 pr-3 py-1.5 text-[13px] bg-zinc-900/90 border border-zinc-800 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"/>
                </div>
                <button onClick={()=>sync(false)} disabled={isSyncing} className="h-8 px-2.5 sm:px-3 flex items-center gap-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-[13px] text-zinc-400 hover:text-white transition-colors disabled:opacity-50 shrink-0" title="Refresh data">
                  <RefreshIcon className={isSyncing?'animate-spin text-indigo-400':''}/>
                  <span className="hidden md:inline">{isSyncing?'Syncing…':'Refresh'}</span>
                </button>

                {/* UI Role Switcher - hidden for genuine Agents, who have no legitimate
                    reason to switch into Admin/Team Lead view (handleSwitchRole is a plain
                    client-side setUserRole with no server-side check, so this is the only
                    gate). Gated on the underlying account (same vighnesh/vikash check used
                    for the initial default role elsewhere), NOT on the current userRole -
                    otherwise a real admin who switches into "Agent" view to preview it would
                    lose the only control that switches them back. */}
                {(googleUser?.email || '').toLowerCase().match(/vighnesh|vikash/) && (
                  <CustomSelect
                    value={userRole}
                    onChange={handleSwitchRole}
                    options={roleOptions}
                    icon={ShieldIcon}
                    className="shrink-0"
                  />
                )}

                {/* Theme Selector (Dark / Light / Purple) */}
                <CustomSelect
                  value={theme}
                  onChange={setTheme}
                  options={themeOptions}
                  className="shrink-0"
                />

                {/* Custom Status Dropdown */}
                <CustomSelect
                  value={agentStatus}
                  onChange={handleSetStatus}
                  options={statusOptions}
                  className="shrink-0"
                />
              </div>
            </div>
          </header>

          {/* ═══ TOAST ═══ */}
          {toast&&<div className="fixed top-16 right-5 z-50 animate-slideUp"><div className="px-4 py-2.5 rounded-xl bg-zinc-800/90 text-zinc-100 border border-zinc-700 text-[13px] shadow-2xl flex items-center gap-2.5 backdrop-blur-md"><CheckIcon className="text-emerald-400 shrink-0"/>{toast}</div></div>}

          {/* ═══ NEW VERSION BANNER — this tab is running stale JS, a newer deploy exists ═══ */}
          {updateAvailable && (
            <div className="bg-amber-950/95 backdrop-blur-xl border-b border-amber-800/60">
              <div className="max-w-[1440px] mx-auto px-5 py-2 flex items-center justify-between gap-3">
                <span className="text-[13px] text-amber-200 font-medium flex items-center gap-2">
                  <RefreshIcon className="text-amber-400 shrink-0" />
                  A newer version of this app is available. Refresh to make sure your leads sync correctly.
                </span>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-amber-950 text-[12px] font-bold transition-colors shadow-xs shrink-0"
                >
                  Refresh Now
                </button>
              </div>
            </div>
          )}

          {/* ═══ MAIN WORKSPACE ═══ */}
          <main className="flex-1 max-w-[1440px] w-full mx-auto px-5 py-5 space-y-5">

            {/* ══════════════════════════════════════════════════════════════════════
               🚀 PROMINENT DEDICATED WORKSPACE NAVIGATION BAR
               ══════════════════════════════════════════════════════════════════════ */}
            <div className="bg-zinc-900/90 border border-zinc-800/90 rounded-2xl p-1.5 shadow-xl backdrop-blur-md flex items-center justify-between flex-wrap gap-2">
              <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar w-full">
                {tabs.map(t => {
                  const isActive = tab === t.key;
                  return (
                    <button
                      key={t.key}
                      onClick={() => setTab(t.key)}
                      className={`relative px-4 py-2 rounded-xl text-[13px] font-bold whitespace-nowrap transition-all flex items-center gap-2.5 ${
                        isActive
                          ? 'text-white bg-indigo-600 shadow-md shadow-indigo-950/50 border border-indigo-500/40'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent'
                      }`}
                    >
                      {t.key === 'fresh' && <span className="text-amber-300">⚡</span>}
                      {t.key === 'overview' && <span className="text-indigo-300">📊</span>}
                      {t.key === 'admin' && <span className="text-emerald-300">🛡️</span>}
                      {t.key === 'all' && <span className="text-sky-300">📦</span>}
                      <span>{t.label}</span>
                      <span className={`text-[11px] tabular-nums px-2 py-0.5 rounded-md font-mono font-bold ${
                        isActive ? 'text-white bg-indigo-950/80 border border-indigo-400/30' : 'text-zinc-400 bg-zinc-800 border border-zinc-700/50'
                      }`}>
                        {t.count.toLocaleString('en-IN')}
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {tab==='overview'?(
              /* ══════════════════════════════════════════════════════════════════════
                 📊 OVERVIEW DASHBOARD: ALL AGENTS DATA & EXECUTIVE ANALYTICS
                 ══════════════════════════════════════════════════════════════════════ */
              <div className="space-y-6 animate-fadeIn">
                {(() => {
                  const inScope = (t) => isDateInScope(t.rowDate, dateScope, customDateFrom, customDateTo);

                  const agentMetrics = effectiveAgentRoster.map(ag => {
                    const email = ag.email.toLowerCase();
                    const prefix = email.split('@')[0];
                    const isMine = (agt) => agt && (agt.toLowerCase().includes(email) || agt.toLowerCase().includes(prefix));

                    const assigned = allTickets.filter(t => isMine(t.assignedAgent) && inScope(t));
                    const disposed = assigned.filter(t => t.disposition || t.agentRemarks || t.status !== 'Pending');
                    const pending = assigned.filter(t => t.status === 'Pending' && !t.disposition && !t.agentRemarks);
                    // allTickets already merges a local override's connectedStatus with the
                    // sheet's own synced value onto t.connected (see the allTickets useMemo
                    // above) - re-deriving from overrides[t.id] alone here skipped that sheet
                    // fallback, so any ticket disposed outside the current browser's local
                    // cache (a different session, or synced straight from the sheet) never
                    // counted as connected, which is why Avg Connect Rate always read ~0%.
                    const connected = disposed.filter(t => t.connected === 'Yes');
                    const unreachable = disposed.filter(t => t.connected === 'No');
                    const refunded = assigned.filter(t => t.status === 'Refunded');
                    const totalRefundAmt = refunded.reduce((s, t) => s + (t.orderAmount || 0), 0);

                    const dispBreakdown = {};
                    disposed.forEach(t => {
                      const ov = overrides[t.id];
                      const key = ov?.agentDisposition || t.disposition || 'Other';
                      dispBreakdown[key] = (dispBreakdown[key] || 0) + 1;
                    });

                    const agentLogs = activityLogs.filter(l => l.agent && l.agent.toLowerCase().includes(prefix));
                    const ticketLogs = agentLogs.filter(l => l.type === 'ticket' || l.type === 'refund');

                    return {
                      ...ag,
                      assigned: assigned.length,
                      disposed: disposed.length,
                      pending: pending.length,
                      connected: connected.length,
                      unreachable: unreachable.length,
                      refunded: refunded.length,
                      totalRefundAmt,
                      connectRate: disposed.length > 0 ? Math.round((connected.length / disposed.length) * 100) : 0,
                      dispBreakdown,
                      agentLogs,
                      ticketLogs,
                      disposedTickets: disposed
                    };
                  });

                  // An Agent's Overview tab must only ever reflect their own performance,
                  // never the whole team's - agentMetrics itself stays computed for every
                  // roster entry (other tabs/blocks below this one, e.g. the Admin panel,
                  // still need everyone), but every number and log entry actually rendered
                  // in this tab is scoped down to just the signed-in agent's own entry first.
                  const myEmailLower = (googleUser?.email || '').toLowerCase();
                  const isMyAgent = (ag) => myEmailLower && (ag.email.toLowerCase() === myEmailLower || ag.email.toLowerCase().includes(myEmailLower.split('@')[0]));
                  const visibleAgentMetrics = userRole === 'Agent' ? agentMetrics.filter(isMyAgent) : agentMetrics;

                  const totalAssigned = visibleAgentMetrics.reduce((s, a) => s + a.assigned, 0);
                  const totalDisposed = visibleAgentMetrics.reduce((s, a) => s + a.disposed, 0);
                  const totalPending = visibleAgentMetrics.reduce((s, a) => s + a.pending, 0);
                  const totalRefunded = visibleAgentMetrics.reduce((s, a) => s + a.refunded, 0);
                  const totalRefundAmt = visibleAgentMetrics.reduce((s, a) => s + a.totalRefundAmt, 0);
                  const avgConnectRate = totalDisposed > 0 ? Math.round(visibleAgentMetrics.reduce((s, a) => s + a.connected, 0) / totalDisposed * 100) : 0;
                  const onlineCount = visibleAgentMetrics.filter(a => a.status === 'Online').length;
                  const freshUnassignedInScope = tickets.filter(t => {
                    const agt = overrides[t.id]?.assignedAgent || t.assignedAgent;
                    return (!agt || agt === 'Unassigned') && inScope(t);
                  }).length;

                  const dispColors = {
                    'Customer Agreed to Accept': { bg: 'bg-emerald-500', text: 'text-emerald-300' },
                    'Refund Requested': { bg: 'bg-violet-500', text: 'text-violet-300' },
                    'Address Change Requested': { bg: 'bg-amber-500', text: 'text-amber-300' },
                    'Product Issue / Exchange': { bg: 'bg-sky-500', text: 'text-sky-300' },
                    'Not Interested': { bg: 'bg-rose-500', text: 'text-rose-300' },
                    'Wrong Number': { bg: 'bg-orange-500', text: 'text-orange-300' },
                    'Ringing / No Answer': { bg: 'bg-zinc-500', text: 'text-zinc-300' },
                    'Not Reachable': { bg: 'bg-zinc-600', text: 'text-zinc-400' },
                    'Switch Off': { bg: 'bg-zinc-600', text: 'text-zinc-400' },
                    'Line Busy': { bg: 'bg-yellow-600', text: 'text-yellow-300' },
                    'Invalid Number': { bg: 'bg-red-600', text: 'text-red-300' },
                  };
                  const getDispColor = (key) => dispColors[key] || { bg: 'bg-indigo-500', text: 'text-indigo-300' };

                  return (
                    <>
                      {/* Header */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                            {userRole === 'Agent' ? '📊 My Performance Overview' : '📊 Executive Overview & Agents Performance'}
                          </h2>
                          <p className="text-[13px] text-zinc-500 mt-0.5">
                            {userRole === 'Agent'
                              ? 'Your own real-time metrics, disposition breakdown, and lead activity.'
                              : `Comprehensive real-time metrics, disposition breakdown, and lead activity across all ${effectiveAgentRoster.length} team members.`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <CustomSelect
                            value={dateScope}
                            onChange={(val) => {
                              setDateScope(val);
                              localStorage.setItem('rto_date_scope', val);
                            }}
                            options={dateOptions}
                            icon={CalendarIcon}
                            placeholder="Date Scope"
                          />
                          {dateScope === 'CUSTOM' && (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="date"
                                value={customDateFrom}
                                onChange={(e) => { setCustomDateFrom(e.target.value); localStorage.setItem('rto_custom_date_from', e.target.value); }}
                                className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                              />
                              <span className="text-zinc-500 text-[12px]">to</span>
                              <input
                                type="date"
                                value={customDateTo}
                                onChange={(e) => { setCustomDateTo(e.target.value); localStorage.setItem('rto_custom_date_to', e.target.value); }}
                                className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                              />
                            </div>
                          )}
                          {userRole !== 'Agent' && (
                            <>
                              <span className="text-[12px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-1 rounded-lg font-mono flex items-center gap-1.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-dot"></span>
                                {onlineCount}/{effectiveAgentRoster.length} Active
                              </span>
                              <span className="text-[12px] text-indigo-400 bg-indigo-950/40 border border-indigo-800/40 px-2.5 py-1 rounded-lg font-mono">
                                {effectiveAgentRoster.length} Total Agents
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Top KPI Stat Cards */}
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Assigned</p>
                          <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{totalAssigned.toLocaleString('en-IN')}</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Across all agents</p>
                        </div>
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Total Disposed</p>
                          <p className="text-2xl font-extrabold text-indigo-400 tabular-nums">{totalDisposed.toLocaleString('en-IN')}</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Actioned leads</p>
                        </div>
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-amber-900/50 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-400 mb-1">Pending Queue</p>
                          <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{totalPending.toLocaleString('en-IN')}</p>
                          <p className="text-[11px] text-amber-400/70 mt-0.5">Awaiting action</p>
                        </div>
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-emerald-900/50 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Avg Connect Rate</p>
                          <p className="text-2xl font-extrabold text-emerald-400 tabular-nums">{avgConnectRate}<span className="text-sm font-normal text-zinc-400">%</span></p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Call success</p>
                        </div>
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-violet-900/50 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1">Refunds</p>
                          <p className="text-2xl font-extrabold text-violet-400 tabular-nums">{totalRefunded}</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">₹{totalRefundAmt.toLocaleString('en-IN')}</p>
                        </div>
                        <div className="bg-zinc-900/70 rounded-xl p-4 border border-zinc-800/80 shadow-xs">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Fresh Unassigned</p>
                          <p className="text-2xl font-extrabold text-zinc-100 tabular-nums">{freshUnassignedInScope.toLocaleString('en-IN')}</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Ready to claim</p>
                        </div>
                      </div>

                      {/* Lead Action Audit Trail */}
                      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                              {userRole === 'Agent' ? '📋 My Action Stream' : '📋 Live Agent Action Stream (All Agents)'}
                            </h3>
                            <p className="text-[12px] text-zinc-500 mt-0.5">Real-time log of customer contacts, remarks, address updates & refunds.</p>
                          </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto custom-scroll space-y-2">
                          {visibleAgentMetrics.flatMap(am =>
                            // t.disposedAt/t.connected/t.disposition/t.agentRemarks already come from
                            // allTickets' merge of the local override with the sheet's own synced value
                            // (see the allTickets useMemo above) - reading overrides[t.id] directly here
                            // would miss tickets disposed outside this browser's local cache, same bug
                            // as the connect-rate KPI fix above.
                            am.disposedTickets.map(t => ({ agent: am, ticket: t, time: t.disposedAt || '' }))
                          ).sort((a, b) => (b.time || '').localeCompare(a.time || '')).slice(0, 40).map((item, idx) => {
                            const { agent: am, ticket: t } = item;
                            const connected = t.connected === 'Yes';
                            return (
                              <div key={idx} className="flex items-start gap-3 p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/70 hover:border-zinc-700/60 transition-colors">
                                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-bold text-[8px] shrink-0 mt-0.5">
                                  {am.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                                </div>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[12px] font-bold text-zinc-200">{am.name}</span>
                                    <span className="text-[10px] text-zinc-500 font-mono">→</span>
                                    <span className="text-[12px] font-mono font-bold text-zinc-300">{t.orderNumber}</span>
                                    <span className="text-[11px] text-zinc-500">({t.customerName})</span>
                                    {t.disposedAt && <span className="text-[10px] text-zinc-600 font-mono ml-auto">{t.disposedAt}</span>}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Badge color={connected ? 'green' : 'red'}>{connected ? '📞 Connected' : '📵 Unreachable'}</Badge>
                                    {t.disposition && <Badge color="indigo">{t.disposition}</Badge>}
                                  </div>
                                  {t.agentRemarks && (
                                    <p className="text-[11px] text-indigo-300 bg-indigo-950/40 border border-indigo-900/40 px-2.5 py-1 rounded-md font-sans">
                                      💬 "{t.agentRemarks}"
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            ):tab==='admin'&&(userRole==='Admin'||userRole==='Team Lead')?(
              /* ══════════════════════════════════════════════════════════════════════
                 🛡️ ADMIN PANEL: TEAM ROSTER & BULK REASSIGNMENT CONTROL
                 ══════════════════════════════════════════════════════════════════════ */
              <div className="space-y-6 animate-fadeIn">
                {(() => {
                  const agentMetrics = effectiveAgentRoster.map(ag => {
                    const email = ag.email.toLowerCase();
                    const prefix = email.split('@')[0];
                    const isMine = (agt) => agt && (agt.toLowerCase().includes(email) || agt.toLowerCase().includes(prefix));

                    const assigned = allTickets.filter(t => isMine(t.assignedAgent));
                    const disposed = assigned.filter(t => t.disposition || t.agentRemarks || t.status !== 'Pending');
                    const pending = assigned.filter(t => t.status === 'Pending' && !t.disposition && !t.agentRemarks);
                    // Same fix as the Overview tab's connect-rate KPI: t.connected already comes
                    // from allTickets' merge of the local override with the sheet's own synced
                    // value, so read it directly instead of re-deriving from overrides[t.id] alone.
                    const connected = disposed.filter(t => t.connected === 'Yes');

                    return {
                      ...ag,
                      assigned: assigned.length,
                      disposed: disposed.length,
                      pending: pending.length,
                      connectRate: disposed.length > 0 ? Math.round((connected.length / disposed.length) * 100) : 0,
                    };
                  });

                  return (
                    <>
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div>
                          <h2 className="text-lg font-bold text-zinc-100">Team Roster & Bulk Lead Reassignment Control</h2>
                          <p className="text-[13px] text-zinc-500 mt-0.5">Manage agent roles, lead capacity limits, reassign active agent boxes, or wipe Column Q in Google Sheet.</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <CustomSelect
                            value={rosterStatusFilter}
                            onChange={setRosterStatusFilter}
                            options={rosterStatusOptions}
                            placeholder="Filter by status"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`Mark all ${agentMetrics.length} agents Offline? This updates each agent's live status on the server.`)) return;
                              agentMetrics.forEach(a => setAgentStatusManually(a.email, 'Offline'));
                              showToast('⚪ All agents marked Offline');
                            }}
                            className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[12px] font-bold transition-all shadow-xs flex items-center gap-2"
                            title="Set every agent's status to Offline (syncs to the server for each row)"
                          >
                            ⚪ Mark All Offline
                          </button>
                        </div>
                      </div>

                      {/* Add a new agent to the roster before they've ever logged in or been
                          assigned a lead - see addAgentToRoster's comment for why this exists. */}
                      <div className="flex items-center gap-2 bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-3">
                        <input
                          type="email"
                          value={newAgentEmail}
                          onChange={(e) => setNewAgentEmail(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              addAgentToRoster(newAgentEmail, newAgentRole);
                              setNewAgentEmail('');
                            }
                          }}
                          placeholder="new.agent@mcaffeine.com"
                          className="flex-1 min-w-0 px-3 py-1.5 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] placeholder-zinc-500 focus:outline-none focus:border-indigo-600"
                        />
                        <CustomSelect
                          value={newAgentRole}
                          onChange={setNewAgentRole}
                          options={[
                            { value: 'Agent', label: 'Agent' },
                            { value: 'Team Lead', label: 'Team Lead' },
                            { value: 'Admin', label: 'Admin' }
                          ]}
                        />
                        <button
                          type="button"
                          onClick={() => { addAgentToRoster(newAgentEmail, newAgentRole); setNewAgentEmail(''); }}
                          className="px-3 py-1.5 rounded-xl bg-indigo-700 hover:bg-indigo-600 text-white text-[12px] font-bold transition-all shadow-xs flex items-center gap-2"
                        >
                          ➕ Add Agent
                        </button>
                      </div>

                      {/* Agent Roster & Reassignment Table */}
                      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 overflow-hidden">
                        <table className="w-full text-[13px]">
                          <thead><tr className="border-b border-zinc-800/80 text-zinc-500">
                            <th className="py-3 px-4 text-left font-medium">Agent</th>
                            <th className="py-3 px-4 text-left font-medium">Role</th>
                            <th className="py-3 px-4 text-left font-medium">Status</th>
                            <th className="py-3 px-4 text-center font-medium">Assigned</th>
                            <th className="py-3 px-4 text-center font-medium">Disposed</th>
                            <th className="py-3 px-4 text-center font-medium">Connect %</th>
                            <th className="py-3 px-4 text-left font-medium">Quota</th>
                            <th className="py-3 px-4 text-right font-medium">Actions</th>
                          </tr></thead>
                          <tbody className="divide-y divide-zinc-800/50">
                            {agentMetrics
                              .filter(a => rosterStatusFilter === 'All' || a.status === rosterStatusFilter)
                              .map(a => (
                              <tr key={a.email} className="hover:bg-zinc-800/30 transition-colors">
                                <td className="py-3 px-4">
                                  <div className="flex items-center gap-2.5">
                                    <div className="relative">
                                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center text-white font-bold text-[11px] shadow">
                                        {a.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                                      </div>
                                      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-900 ${a.status === 'Online' ? 'bg-emerald-500' : a.status === 'Busy' ? 'bg-amber-400' : 'bg-zinc-500'}`}></span>
                                    </div>
                                    <div>
                                      <p className="font-semibold text-zinc-100">{a.name}</p>
                                      <p className="text-zinc-500 text-[11px] font-mono">{a.email}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.role}
                                    onChange={(newRole) => {
                                      setAgentRoster(p => { const u = p.map(x => x.email === a.email ? { ...x, role: newRole } : x); localStorage.setItem('rto_agent_roster', JSON.stringify(u)); return u; });
                                      showToast(`Role updated for ${a.name}`);
                                    }}
                                    options={[
                                      { value: 'Agent', label: 'Agent' },
                                      { value: 'Team Lead', label: 'Team Lead' },
                                      { value: 'Admin', label: 'Admin' }
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.status}
                                    onChange={(newStatus) => setAgentStatusManually(a.email, newStatus)}
                                    options={statusOptions}
                                  />
                                </td>
                                <td className="py-3 px-4 text-center font-bold text-zinc-100 tabular-nums">{a.assigned}</td>
                                <td className="py-3 px-4 text-center font-bold text-indigo-400 tabular-nums">{a.disposed}</td>
                                <td className="py-3 px-4 text-center font-bold text-emerald-400 tabular-nums">{a.connectRate}%</td>
                                <td className="py-3 px-4">
                                  <CustomSelect
                                    value={a.maxQuota}
                                    onChange={(val) => {
                                      setAgentRoster(p => { const u = p.map(x => x.email === a.email ? { ...x, maxQuota: +val } : x); localStorage.setItem('rto_agent_roster', JSON.stringify(u)); return u; });
                                    }}
                                    options={[
                                      { value: 5, label: '5 leads' },
                                      { value: 10, label: '10 leads' },
                                      { value: 15, label: '15 leads' },
                                      { value: 20, label: '20 leads' }
                                    ]}
                                  />
                                </td>
                                <td className="py-3 px-4 text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <CustomSelect
                                      value="REASSIGN"
                                      onChange={(targetAgentEmail) => {
                                        if (targetAgentEmail !== 'REASSIGN') {
                                          adminBulkAction(a.email, targetAgentEmail);
                                        }
                                      }}
                                      options={[
                                        { value: 'REASSIGN', label: '🔄 Reassign…' },
                                        ...effectiveAgentRoster.filter(target => target.email !== a.email).map(target => ({
                                          value: target.email,
                                          label: `➡️ ${target.name}`
                                        }))
                                      ]}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => removeAgentFromRoster(a.email, a.name)}
                                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-red-950/60 text-zinc-400 hover:text-red-300 border border-zinc-700 hover:border-red-800/80 text-[11px] font-bold transition-all shadow-xs"
                                      title="Remove this agent's row from the roster entirely. Blocked while they hold pending leads."
                                    >
                                      🗑️ Remove
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Central Audit Trail */}
                      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                              🕐 Central Team Activity & Break Audit Trail
                            </h3>
                            <p className="text-[12px] text-zinc-500 mt-0.5">Real-time status transitions, break durations, and disposition events for all agents.</p>
                          </div>
                          <span className="text-[12px] text-indigo-400 bg-indigo-950/40 border border-indigo-800/40 px-2.5 py-1 rounded-lg font-mono">
                            {activityLogs.length} Events Recorded
                          </span>
                        </div>

                        <div className="space-y-2 max-h-72 overflow-y-auto custom-scroll pr-1">
                          {activityLogs.map((l, i) => (
                            <div key={l.id || i} className="flex items-start justify-between p-3 rounded-xl bg-zinc-900/80 border border-zinc-800/70 text-[13px] hover:border-zinc-700/80 transition-colors">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2.5">
                                  <span className="text-zinc-400 font-mono text-[12px] font-semibold bg-zinc-800/80 px-2 py-0.5 rounded">{l.time}</span>
                                  <span className="text-zinc-200 font-bold">👤 {l.agentName || (l.agent ? l.agent.split('@')[0] : 'Agent')}</span>
                                  <span className="text-zinc-500 font-mono text-[11px]">({l.agent})</span>
                                </div>
                                <p className="text-zinc-300 font-medium">{l.action}</p>
                                {l.remarks && (
                                  <p className="text-[12px] text-indigo-300 bg-indigo-950/40 border border-indigo-900/40 px-2.5 py-1 rounded-md mt-1 font-sans">
                                    💬 "{l.remarks}"
                                  </p>
                                )}
                              </div>
                              <Badge color={l.type === 'online' ? 'green' : l.type === 'break' ? 'amber' : l.type === 'refund' ? 'green' : 'indigo'}>{l.type}</Badge>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Master Ticket Assignment & Audit Log Table (Admin View) */}
                      <div className="bg-zinc-900/60 rounded-xl border border-zinc-800/80 p-5 space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                          <div>
                            <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                              📋 Master Ticket & Lead Assignment Audit Log
                            </h3>
                            <p className="text-[12px] text-zinc-500 mt-0.5">Comprehensive admin log of all tickets, Column Q assignment tags, Attempt types (Col S), and live disposition records.</p>
                          </div>
                          
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="relative">
                              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500"/>
                              <input
                                value={adminLogSearch}
                                onChange={e => setAdminLogSearch(e.target.value)}
                                placeholder="Search ticket, order, agent…"
                                className="w-44 pl-8 pr-3 py-1 text-[12px] bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                            
                            <CustomSelect
                              value={adminLogAgent}
                              onChange={setAdminLogAgent}
                              options={[
                                { value: 'ALL', label: 'All Agents' },
                                ...agents.map(a => ({ value: a, label: a.includes('@') ? a.split('@')[0] : a }))
                              ]}
                            />

                            <CustomSelect
                              value={adminLogStatus}
                              onChange={setAdminLogStatus}
                              options={[
                                { value: 'ALL', label: 'All Statuses' },
                                { value: 'ASSIGNED', label: 'Assigned' },
                                { value: 'UNASSIGNED', label: 'Unassigned' },
                                { value: 'DISPOSED', label: 'Disposed' },
                                { value: 'REFUNDED', label: 'Refunded' },
                              ]}
                            />
                          </div>
                        </div>

                        {/* Audit Table */}
                        {(() => {
                          const filteredAuditLeads = allTickets.filter(t => {
                            const agt = (t.assignedAgent || '').toLowerCase();
                            const isAssigned = agt && agt !== 'unassigned';
                            if (adminLogAgent !== 'ALL') {
                              const s = adminLogAgent.toLowerCase();
                              if (!agt.includes(s) && !s.includes(agt)) return false;
                            }
                            if (adminLogStatus === 'ASSIGNED' && !isAssigned) return false;
                            if (adminLogStatus === 'UNASSIGNED' && isAssigned) return false;
                            if (adminLogStatus === 'DISPOSED' && (!t.disposition && !t.agentRemarks && t.status === 'Pending')) return false;
                            if (adminLogStatus === 'REFUNDED' && t.status !== 'Refunded') return false;

                            if (adminLogSearch.trim()) {
                              const q = adminLogSearch.toLowerCase();
                              if (![t.orderNumber, t.customerName, t.email, t.phone, t.assignedAgent, t.disposition, t.attemptType, t.agentRemarks].some(f => (f || '').toLowerCase().includes(q))) return false;
                            }
                            return true;
                          });

                          if (filteredAuditLeads.length === 0) {
                            return <p className="text-[12px] text-zinc-500 text-center py-6">No matching ticket assignment logs found.</p>;
                          }

                          return (
                            <div className="overflow-x-auto border border-zinc-800/80 rounded-xl max-h-96 custom-scroll">
                              <table className="w-full text-[12px]">
                                <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 text-zinc-400 font-bold uppercase text-[11px]">
                                  <tr>
                                    <th className="py-2.5 px-3 text-left">Order & Customer</th>
                                    <th className="py-2.5 px-3 text-left">Assigned Agent (Column Q)</th>
                                    <th className="py-2.5 px-3 text-left">Calling Date</th>
                                    <th className="py-2.5 px-3 text-left">Attempt (Col S)</th>
                                    <th className="py-2.5 px-3 text-left">Disposition & Remarks</th>
                                    <th className="py-2.5 px-3 text-center">Status</th>
                                    <th className="py-2.5 px-3 text-right">Audit</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-800/40 text-zinc-300">
                                  {filteredAuditLeads.slice(0, 100).map(t => {
                                    const agtStr = t.assignedAgent || 'Unassigned';
                                    const isUnassigned = !agtStr || agtStr === 'Unassigned';
                                    const nameDisp = agtStr.includes('(') ? agtStr.split('(')[0].trim() : (agtStr.includes('@') ? agtStr.split('@')[0] : agtStr);

                                    return (
                                      <tr key={`audit-${t.id}`} className="hover:bg-zinc-800/30 transition-colors">
                                        <td className="py-2.5 px-3">
                                          <span className="font-mono font-bold text-zinc-100">{t.orderNumber}</span>
                                          <span className="block text-[11px] text-zinc-400">{t.customerName}</span>
                                        </td>
                                        <td className="py-2.5 px-3">
                                          {isUnassigned ? (
                                            <span className="text-zinc-500 font-mono text-[11px] bg-zinc-800 px-2 py-0.5 rounded">⚪ Unassigned</span>
                                          ) : (
                                            <div>
                                              <span className="font-bold text-zinc-200">👤 {nameDisp}</span>
                                              <span className="block text-[10px] text-indigo-400 font-mono">{t.assignedAgent}</span>
                                            </div>
                                          )}
                                        </td>
                                        <td className="py-2.5 px-3 font-mono">{t.callingDate || '—'}</td>
                                        <td className="py-2.5 px-3 font-medium text-violet-300">{t.attemptType || '—'}</td>
                                        <td className="py-2.5 px-3 max-w-[200px]">
                                          {t.disposition && <span className="block font-semibold text-zinc-200 truncate">{t.disposition}</span>}
                                          {t.agentRemarks && <span className="block text-[11px] text-zinc-400 truncate">💬 "{t.agentRemarks}"</span>}
                                          {!t.disposition && !t.agentRemarks && <span className="text-zinc-500 font-mono">—</span>}
                                        </td>
                                        <td className="py-2.5 px-3 text-center">
                                          <Badge color={t.status === 'Refunded' ? 'green' : (t.disposition || t.agentRemarks) ? 'blue' : 'zinc'}>
                                            {t.status === 'Refunded' ? 'Refunded' : (t.disposition || t.agentRemarks) ? 'Disposed' : 'Pending'}
                                          </Badge>
                                        </td>
                                        <td className="py-2.5 px-3 text-right">
                                          <button
                                            type="button"
                                            onClick={() => setDetailTkt(t)}
                                            className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-medium transition-colors border border-zinc-700"
                                          >
                                            🔍 View Audit Log
                                          </button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          );
                        })()}
                      </div>

                    </>
                  );
                })()}
              </div>
            ):tab==='predicted'&&userRole==='Admin'?(
              /* ══════════════════════════════════════════════════════════════════════
                 🔮 NEXT TO ASSIGN: read-only preview of scripts/assign_leads.py's next run
                 ══════════════════════════════════════════════════════════════════════ */
              <div className="space-y-5 animate-fadeIn">
                <div>
                  <h2 className="text-lg font-bold text-zinc-100">Next to Assign</h2>
                  <p className="text-[13px] text-zinc-500 mt-0.5">
                    A live preview of what the next scheduled run of <code className="font-mono text-indigo-300">assign_leads.py</code> would
                    do right now — Prepaid first, then COD with a high-priority reason, then other COD, then COD with a low-priority
                    reason, newest RTO Initiated Date first within each. Nothing on this tab writes anything; it only forecasts.
                  </p>
                </div>

                {predictedAssignments.onlineAgents.length === 0 ? (
                  <EmptyState title="No agents currently online" sub="The next run would find nobody eligible and assign nothing — same as the script itself would report."/>
                ) : predictedAssignments.rows.length === 0 ? (
                  <EmptyState title="Nothing waiting to be assigned" sub="No unassigned pending leads right now."/>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="px-3 py-1.5 rounded-xl bg-zinc-900/70 border border-zinc-800/80 text-[12px] text-zinc-400">
                        <span className="font-bold text-zinc-200">{predictedAssignments.onlineAgents.length}</span> agent{predictedAssignments.onlineAgents.length===1?'':'s'} online
                      </div>
                      <div className="px-3 py-1.5 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-[12px] text-emerald-300">
                        <span className="font-bold">{predictedAssignments.rows.length}</span> would be assigned this run
                      </div>
                      {predictedAssignments.leftover > 0 && (
                        <div className="px-3 py-1.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-[12px] text-amber-300">
                          <span className="font-bold">{predictedAssignments.leftover}</span> left over — everyone online is at quota
                        </div>
                      )}
                    </div>

                    <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/80 overflow-hidden shadow-xs">
                      <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                          <thead><tr className="border-b border-zinc-800/80 text-zinc-500 text-[12px]">
                            <th className="py-3 px-4 text-left font-medium">#</th>
                            <th className="py-3 px-4 text-left font-medium">Order</th>
                            <th className="py-3 px-4 text-left font-medium">Customer</th>
                            <th className="py-3 px-4 text-left font-medium">Priority</th>
                            <th className="py-3 px-4 text-left font-medium">Payment</th>
                            <th className="py-3 px-4 text-left font-medium">RTO Reason</th>
                            <th className="py-3 px-4 text-left font-medium">Calling Date</th>
                            <th className="py-3 px-4 text-right font-medium">Amount</th>
                            <th className="py-3 px-4 text-left font-medium">Predicted Agent</th>
                          </tr></thead>
                          <tbody className="divide-y divide-zinc-800/40">
                            {predictedAssignments.rows.map(row => (
                              <tr key={row.ticket.id} className="hover:bg-zinc-800/25 transition-colors">
                                <td className="py-3 px-4 text-zinc-500 font-mono tabular-nums">{row.rank}</td>
                                <td className="py-3 px-4"><span className="font-mono font-semibold text-zinc-200">{row.ticket.orderNumber}</span></td>
                                <td className="py-3 px-4"><span className="text-zinc-200 font-medium">{row.ticket.customerName}</span></td>
                                <td className="py-3 px-4">
                                  <Badge color={row.tier===0?'blue':row.tier===1?'amber':'zinc'}>
                                    {row.tier===0?'Prepaid':row.tier===1?'COD · Priority':'COD'}
                                  </Badge>
                                </td>
                                <td className="py-3 px-4"><Badge color={row.ticket.paymentMethod==='COD'?'amber':'blue'}>{row.ticket.paymentMethod}</Badge></td>
                                <td className="py-3 px-4 max-w-[220px]"><span className="truncate block text-zinc-300">{row.ticket.rtoReason}</span></td>
                                <td className="py-3 px-4 text-zinc-200 font-semibold font-mono tabular-nums">{row.ticket.callingDate}</td>
                                <td className="py-3 px-4 text-right font-semibold text-zinc-200 tabular-nums">₹{row.ticket.orderAmount.toLocaleString('en-IN')}</td>
                                <td className="py-3 px-4"><span className="font-mono text-indigo-300">{row.predictedAgent}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ):(
              <>
                {/* Stats Header Cards with Date-Scoped Agent Performance */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-500 mb-1 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Connected Calls
                    </p>
                    <p className="text-2xl font-extrabold text-emerald-500 tabular-nums tracking-tight">{agentPerf.connectedCalls.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{agentPerf.connectRate}% connect rate</p>
                  </div>
                  
                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-500 mb-1 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-500"></span> Reorders Converted
                    </p>
                    <p className="text-2xl font-extrabold text-indigo-500 tabular-nums tracking-tight">{agentPerf.reordersConverted.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{agentPerf.reorderRate}% conversion rate</p>
                  </div>

                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-amber-500 mb-1 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500"></span> Already Refunded
                    </p>
                    <p className="text-2xl font-extrabold text-amber-500 tabular-nums tracking-tight">{agentPerf.alreadyRefundedCount.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">Refund remarks recorded</p>
                  </div>

                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400"></span> Active Pending Box
                    </p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums tracking-tight">{pend.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">{userRole === 'Agent' ? 'My Active Queue' : (agentFilter !== 'ALL' ? agentFilter.split('@')[0] : 'All agents')}</p>
                  </div>

                  <div className="bg-zinc-900/70 rounded-2xl p-4 border border-zinc-800/80 shadow-xs flex flex-col justify-between">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400"></span> Fresh Unassigned
                    </p>
                    <p className="text-2xl font-extrabold text-zinc-100 tabular-nums tracking-tight">{freshUnassignedCount.toLocaleString('en-IN')}</p>
                    <p className="text-[11px] text-zinc-500 font-medium mt-1">Ready to claim</p>
                  </div>
                </div>

                {/* Custom Styled Filter Bar */}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Agent Filter: ONLY editable if Admin or Team Lead */}
                    {userRole !== 'Agent' ? (
                      <CustomSelect
                        value={agentFilter}
                        onChange={setAgentFilter}
                        options={agentOptions}
                        icon={UserIcon}
                        placeholder="Agent Filter"
                      />
                    ) : (
                      <div className="h-8 px-3 py-1 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[13px] font-medium text-zinc-300 flex items-center gap-2">
                        <UserIcon className="text-indigo-400 shrink-0" />
                        <span>My Active Queue ({googleUser.email.split('@')[0]})</span>
                      </div>
                    )}

                    <CustomSelect
                      value={dateScope}
                      onChange={(val) => {
                        setDateScope(val);
                        localStorage.setItem('rto_date_scope', val);
                        sync(false);
                      }}
                      options={dateOptions}
                      icon={CalendarIcon}
                      placeholder="Date Scope"
                    />

                    {dateScope === 'CUSTOM' && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="date"
                          value={customDateFrom}
                          onChange={(e) => { setCustomDateFrom(e.target.value); localStorage.setItem('rto_custom_date_from', e.target.value); }}
                          className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                        />
                        <span className="text-zinc-500 text-[12px]">to</span>
                        <input
                          type="date"
                          value={customDateTo}
                          onChange={(e) => { setCustomDateTo(e.target.value); localStorage.setItem('rto_custom_date_to', e.target.value); }}
                          className="h-8 px-2 bg-zinc-900/90 border border-zinc-800 rounded-lg text-[12px] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
                        />
                      </div>
                    )}

                    <CustomSelect
                      value={payFilter}
                      onChange={setPayFilter}
                      options={payOptions}
                      icon={CreditCardIcon}
                      placeholder="Payment Filter"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <CustomSelect
                      value={perPage}
                      onChange={(val) => setPerPage(Number(val))}
                      options={perPageOptions}
                    />
                    <span className="text-[12px] text-zinc-500 tabular-nums font-medium">{filtered.length.toLocaleString('en-IN')} leads</span>
                  </div>
                </div>

                {/* TABLE */}
                {visible.length===0?(
                  <EmptyState title="No leads found" sub="Try adjusting your filters or search query to find what you're looking for."/>
                ):(
                  <div className="bg-zinc-900/50 rounded-xl border border-zinc-800/80 overflow-hidden shadow-xs">
                    {/* Desktop Table (md and up) */}
                    <div className="overflow-x-auto hidden md:block">
                      <table className="w-full text-[13px]">
                        <thead><tr className="border-b border-zinc-800/80 text-zinc-500 text-[12px]">
                          <th className="py-3 px-4 text-left font-medium">Order</th>
                          <th className="py-3 px-4 text-left font-medium">Customer</th>
                          <th className="py-3 px-4 text-left font-medium">Agent Name & Email (Col Q)</th>
                          <th className="py-3 px-4 text-left font-medium">Calling Date</th>
                          <th className="py-3 px-4 text-left font-medium">RTO Reason & Remarks</th>
                          <th className="py-3 px-4 text-left font-medium">Payment</th>
                          <th className="py-3 px-4 text-right font-medium">Amount</th>
                          <th className="py-3 px-4 text-center font-medium">Status</th>
                          <th className="py-3 px-4 text-right font-medium"></th>
                        </tr></thead>
                        <tbody className="divide-y divide-zinc-800/40">
                          {visible.map(t=>{
                            const ref=t.status==='Refunded';
                            const isDisposed = t.disposition || t.agentRemarks || t.status !== 'Pending';
                            const agtStr = t.assignedAgent || 'Unassigned';
                            const isUnassigned = !agtStr || agtStr === 'Unassigned';
                            const hasNameEmail = agtStr.includes('(');
                            const nameDisp = hasNameEmail ? agtStr.split('(')[0].trim() : (agtStr.includes('@') ? agtStr.split('@')[0] : agtStr);
                            const emailDisp = hasNameEmail ? agtStr.match(/\(([^)]+)\)/)?.[1] : (agtStr.includes('@') ? agtStr : (agtStr !== 'Unassigned' ? `${agtStr}@mcaffeine.com` : ''));

                            return(
                              <tr key={t.id} className="hover:bg-zinc-800/25 transition-colors">
                                <td className="py-3 px-4"><span className="font-mono font-semibold text-zinc-200">{t.orderNumber}</span></td>
                                <td className="py-3 px-4"><span className="text-zinc-200 font-medium">{t.customerName}</span><span className="block text-[12px] text-zinc-500 mt-0.5 truncate max-w-[160px]">{t.email||t.phone}</span></td>

                                {/* Column Q: Agent Name + Email ID */}
                                <td className="py-3 px-4">
                                  {isUnassigned ? (
                                    <button
                                      type="button"
                                      onClick={() => claimLeadForAgent(t)}
                                      className="px-2.5 py-1 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 border border-indigo-800/60 text-[11px] font-bold transition-all shadow-xs"
                                    >
                                      👤 Claim Lead (Sync Col Q)
                                    </button>
                                  ) : (
                                    <div className="flex flex-col">
                                      <span className="text-zinc-200 font-semibold flex items-center gap-1.5">
                                        👤 {nameDisp}
                                      </span>
                                      {emailDisp && (
                                        <span className="text-[11px] text-indigo-400 font-mono mt-0.5">
                                          ✉️ {emailDisp}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>

                                <td className="py-3 px-4 text-zinc-200 font-semibold font-mono tabular-nums">{t.callingDate}</td>

                                {/* RTO Reason & Remarks Preview */}
                                <td className="py-3 px-4 max-w-[220px]">
                                  {userRole !== 'Agent' && <span className="truncate block text-zinc-300">{t.rtoReason}</span>}
                                  {t.agentRemarks && (
                                    <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-indigo-300 bg-indigo-950/50 border border-indigo-800/40 px-2 py-0.5 rounded-md truncate max-w-full" title={t.agentRemarks}>
                                      💬 {t.agentRemarks}
                                    </span>
                                  )}
                                  {t.disposition && !t.agentRemarks && (
                                    <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-zinc-400 bg-zinc-800/60 border border-zinc-700/50 px-2 py-0.5 rounded-md truncate max-w-full">
                                      📝 {t.disposition}
                                    </span>
                                  )}
                                </td>

                                <td className="py-3 px-4"><Badge color={t.paymentMethod==='COD'?'amber':'blue'}>{t.paymentMethod}</Badge></td>
                                <td className="py-3 px-4 text-right font-semibold text-zinc-200 tabular-nums">₹{t.orderAmount.toLocaleString('en-IN')}</td>
                                <td className="py-3 px-4 text-center"><Badge color={ref?'green':isDisposed?'blue':'zinc'}>{ref?'Refunded':isDisposed?'Disposed':'Pending'}</Badge></td>
                                <td className="py-3 px-4 text-right"><div className="flex items-center justify-end gap-1.5">
                                  <a href={buildWaLink(t)} target="_blank" rel="noopener noreferrer" onClick={(e)=>e.stopPropagation()} className="px-2.5 py-1 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-800/40 text-[12px] font-semibold flex items-center gap-1.5 transition-colors"><WhatsAppIcon/>WhatsApp</a>
                                  <button onClick={()=>openDisp(t)} className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-semibold flex items-center gap-1.5 transition-colors shadow-xs"><PhoneIcon/>{isUnassigned ? 'Claim & Call' : 'Call'}</button>
                                </div></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile Card List (below md) */}
                    <div className="md:hidden divide-y divide-zinc-800/40">
                      {visible.map(t=>{
                        const ref=t.status==='Refunded';
                        const isDisposed = t.disposition || t.agentRemarks || t.status !== 'Pending';
                        const agtStr = t.assignedAgent || 'Unassigned';
                        const isUnassigned = !agtStr || agtStr === 'Unassigned';
                        const hasNameEmail = agtStr.includes('(');
                        const nameDisp = hasNameEmail ? agtStr.split('(')[0].trim() : (agtStr.includes('@') ? agtStr.split('@')[0] : agtStr);
                        const emailDisp = hasNameEmail ? agtStr.match(/\(([^)]+)\)/)?.[1] : (agtStr.includes('@') ? agtStr : (agtStr !== 'Unassigned' ? `${agtStr}@mcaffeine.com` : ''));

                        return (
                          <div key={t.id} className="p-4 space-y-3 active:bg-zinc-800/25 transition-colors">
                            {/* Order / Customer / Payment / Amount */}
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <span className="font-mono font-semibold text-zinc-200 text-[13px]">{t.orderNumber}</span>
                                <p className="text-zinc-200 font-medium text-[13px] mt-0.5 truncate">{t.customerName}</p>
                                <p className="text-[12px] text-zinc-500 truncate">{t.email||t.phone}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1.5 shrink-0">
                                <Badge color={t.paymentMethod==='COD'?'amber':'blue'}>{t.paymentMethod}</Badge>
                                <span className="font-semibold text-zinc-200 tabular-nums text-[13px]">₹{t.orderAmount.toLocaleString('en-IN')}</span>
                              </div>
                            </div>

                            {/* Agent (Col Q) + Calling Date */}
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                              {isUnassigned ? (
                                <button
                                  type="button"
                                  onClick={() => claimLeadForAgent(t)}
                                  className="px-2.5 py-1 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 border border-indigo-800/60 text-[11px] font-bold transition-all shadow-xs"
                                >
                                  👤 Claim Lead (Sync Col Q)
                                </button>
                              ) : (
                                <div className="flex flex-col min-w-0">
                                  <span className="text-zinc-200 font-semibold flex items-center gap-1.5 truncate">👤 {nameDisp}</span>
                                  {emailDisp && <span className="text-[11px] text-indigo-400 font-mono mt-0.5 truncate">✉️ {emailDisp}</span>}
                                </div>
                              )}
                              <span className="text-zinc-400 font-mono shrink-0">{t.callingDate}</span>
                            </div>

                            {/* RTO Reason & Remarks */}
                            <div>
                              {userRole !== 'Agent' && <span className="block text-zinc-300 text-[13px]">{t.rtoReason}</span>}
                              {t.agentRemarks && (
                                <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-indigo-300 bg-indigo-950/50 border border-indigo-800/40 px-2 py-0.5 rounded-md max-w-full" title={t.agentRemarks}>
                                  💬 {t.agentRemarks}
                                </span>
                              )}
                              {t.disposition && !t.agentRemarks && (
                                <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-zinc-400 bg-zinc-800/60 border border-zinc-700/50 px-2 py-0.5 rounded-md max-w-full">
                                  📝 {t.disposition}
                                </span>
                              )}
                            </div>

                            {/* Status + Actions */}
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <Badge color={ref?'green':isDisposed?'blue':'zinc'}>{ref?'Refunded':isDisposed?'Disposed':'Pending'}</Badge>
                              <div className="flex items-center gap-1.5">
                                <a href={buildWaLink(t)} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-800/40 text-[12px] font-semibold flex items-center gap-1.5 transition-colors"><WhatsAppIcon/>WhatsApp</a>
                                <button onClick={()=>openDisp(t)} className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-semibold flex items-center gap-1.5 transition-colors shadow-xs"><PhoneIcon/>{isUnassigned ? 'Claim & Call' : 'Call'}</button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {pages>1&&(
                      <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-800 text-[13px]">
                        <span className="text-zinc-500 tabular-nums">Page {page} of {pages}</span>
                        <div className="flex gap-1.5"><button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} className="px-3 py-1 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30 font-medium hover:bg-zinc-700 transition-colors">Prev</button><button onClick={()=>setPage(p=>Math.min(pages,p+1))} disabled={page===pages} className="px-3 py-1 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-30 font-medium hover:bg-zinc-700 transition-colors">Next</button></div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </main>

          {/* ═══ HIGH-END CALL DISPOSITION MODAL ═══ */}
          {dispTkt&&(
            <Overlay onClose={()=>setDispTkt(null)}>
              <div className="w-full max-w-xl bg-[#121215] border border-zinc-800/90 rounded-2xl shadow-2xl text-zinc-100 p-6 space-y-6">

                {/* Modal Header */}
                <div className="flex items-start justify-between border-b border-zinc-800/80 pb-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <span className="px-2.5 py-0.5 rounded-md bg-indigo-950/60 text-indigo-300 border border-indigo-800/60 font-mono text-xs font-bold">{dispTkt.orderNumber}</span>
                      <Badge color={dispTkt.paymentMethod==='COD'?'amber':'blue'}>{dispTkt.paymentMethod}</Badge>
                    </div>
                    <h3 className="text-base font-extrabold text-zinc-100 flex items-center gap-2">
                      {dispTkt.customerName}
                    </h3>
                    <p className="text-[12px] text-amber-400/90 font-medium">RTO Reason: {dispTkt.rtoReason}</p>
                  </div>
                  <div className="text-right">
                    <button onClick={()=>setDispTkt(null)} className="p-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors border border-zinc-800"><XIcon/></button>
                    <p className="text-lg font-bold text-zinc-100 font-mono mt-2">₹{dispTkt.orderAmount.toLocaleString('en-IN')}</p>
                  </div>
                </div>

                {/* Assigned Agent Column Q Info */}
                <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-zinc-500 uppercase font-medium">Assigned Agent (Column Q)</p>
                    <span className="text-[10px] font-mono text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-800/40">Sheet Row #{dispTkt.rawIndex + 2}</span>
                  </div>
                  <p className="text-zinc-100 font-bold flex items-center gap-1.5">👤 {dispTkt.assignedAgent}</p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-[13px]">
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Calling Date</p><p className="font-semibold text-zinc-200">{dispTkt.callingDate}</p></div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Attempt (Col S)</p><p className="font-semibold text-violet-300">{dispTkt.attemptType || '—'}</p></div>
                </div>

                {/* Disposed History & Agent Remarks Log Card */}
                <div className="p-4 rounded-xl bg-indigo-950/20 border border-indigo-900/40 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                      <ChatIcon className="text-indigo-400"/> Agent Remarks & Disposition History
                    </span>
                    {dispTkt.disposedAt && <span className="text-[11px] text-zinc-500 font-mono">{dispTkt.disposedAt}</span>}
                  </div>

                  {dispTkt.disposition || dispTkt.agentRemarks ? (
                    <div className="space-y-2">
                      {dispTkt.disposition && (
                        <div className="flex items-center gap-2">
                          <Badge color="blue">{dispTkt.disposition}</Badge>
                          {dispTkt.disposedBy && <span className="text-[11px] text-zinc-400">by {dispTkt.disposedBy}</span>}
                        </div>
                      )}
                      {dispTkt.agentRemarks && (
                        <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 text-[13px] text-zinc-200 leading-relaxed font-sans">
                          <span className="text-indigo-400 font-semibold">Remarks:</span> "{dispTkt.agentRemarks}"
                        </div>
                      )}
                      {dispTkt.newAddress && (
                        <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-900/40 text-[12px] text-amber-200">
                          📍 <strong>New Address:</strong> {dispTkt.newAddress}
                        </div>
                      )}
                      {dispTkt.newOrderId && (
                        <div className="p-2.5 rounded-lg bg-sky-950/30 border border-sky-900/40 text-[12px] text-sky-200">
                          📦 <strong>Replacement Order:</strong> {dispTkt.newOrderId}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-[12px] text-zinc-500 italic">No disposition remarks recorded yet.</p>
                  )}
                </div>

                <div className="text-[13px]"><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Address</p><p className="text-zinc-300">{dispTkt.address}</p><p className="text-zinc-200 font-medium">{dispTkt.city}, {dispTkt.state} — {dispTkt.pincode}</p></div>

                {/* Direct Dial Call & Copy Action Bar */}
                {dispTkt.phone && (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-indigo-950/30 border border-indigo-800/40">
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wider text-indigo-300">Customer Contact</p>
                      <p className="text-sm font-bold font-mono text-zinc-100 mt-0.5">{dispTkt.phone}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <a
                        href={`tel:${dispTkt.phone.replace(/[^0-9+]/g, '')}`}
                        className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[12px] font-bold flex items-center gap-1.5 shadow-md shadow-emerald-950/40 transition-all"
                      >
                        <PhoneIcon/> Call Now
                      </a>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(dispTkt.phone); showToast('Phone number copied!'); }}
                        className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[12px] font-medium transition-colors border border-zinc-700"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-5">

                  {/* Step 1: Was Call Connected? Interactive Cards */}
                  <div>
                    <p className="text-[12px] font-bold uppercase tracking-wider text-zinc-400 mb-2.5">1. Was the call connected with the customer?</p>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={()=>{setDispConn('YES');setDispReason('');}}
                        className={`p-4 rounded-xl border font-semibold text-left transition-all relative overflow-hidden flex flex-col justify-between ${dispConn==='YES'?'bg-emerald-950/30 border-emerald-500/80 text-emerald-200 shadow-lg shadow-emerald-950/40 ring-1 ring-emerald-500/50':'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:border-zinc-700'}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold flex items-center gap-2">📞 Connected</span>
                          {dispConn==='YES' && <CheckIcon className="text-emerald-400"/>}
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-1.5 font-normal">Spoke directly with customer</p>
                      </button>

                      <button
                        type="button"
                        onClick={()=>{setDispConn('NO');setDispReason('');}}
                        className={`p-4 rounded-xl border font-semibold text-left transition-all relative overflow-hidden flex flex-col justify-between ${dispConn==='NO'?'bg-rose-950/30 border-rose-500/80 text-rose-200 shadow-lg shadow-rose-950/40 ring-1 ring-rose-500/50':'bg-zinc-900/80 border-zinc-800 text-zinc-300 hover:border-zinc-700'}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold flex items-center gap-2">📵 Unreachable</span>
                          {dispConn==='NO' && <CheckIcon className="text-rose-400"/>}
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-1.5 font-normal">Ringing, busy, or switched off</p>
                      </button>
                    </div>
                  </div>

                  {/* Already Refunded (Yes / No) Interactive Toggle Panel */}
                  {dispConn && (
                    <div className="bg-zinc-900/80 p-4 rounded-xl border border-zinc-800 space-y-2.5 animate-fadeIn">
                      <p className="text-[12px] font-bold text-zinc-200 flex items-center justify-between">
                        <span>Is this order Already Refunded?</span>
                        <span className="text-[11px] font-mono text-zinc-500 font-normal">Mentioned in sheet remarks</span>
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { setAlreadyRefunded('YES'); if (!dispReason) setDispReason('Already Refunded'); }}
                          className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${alreadyRefunded === 'YES' ? 'bg-amber-600 text-white border-amber-500 shadow-xs' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}
                        >
                          Yes, Already Refunded
                        </button>
                        <button
                          type="button"
                          onClick={() => setAlreadyRefunded('NO')}
                          className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${alreadyRefunded === 'NO' ? 'bg-zinc-800 text-zinc-100 border-zinc-700' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}
                        >
                          No
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Step 2: Outcome Selector */}
                  {dispConn==='YES' && (
                    <div className="space-y-3 animate-fadeIn border-t border-zinc-800/80 pt-4">
                      <p className="text-[12px] font-bold uppercase tracking-wider text-zinc-400">2. Select Call Outcome / Customer Response</p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto custom-scroll pr-1">
                        {connectedOutcomes.map(item => {
                          const isSel = dispReason === item.value;
                          const isRefundLocked = item.value === 'Refund Requested' && dispTkt.paymentMethod !== 'Prepaid';
                          return (
                            <button
                              key={item.value}
                              type="button"
                              disabled={isRefundLocked}
                              title={isRefundLocked ? 'Refund initiation is only available for Prepaid orders' : undefined}
                              onClick={() => { if(!isRefundLocked) setDispReason(item.value); }}
                              className={`p-3 rounded-xl border text-left transition-all flex items-start gap-3 ${isRefundLocked ? 'opacity-40 cursor-not-allowed bg-zinc-900/40 border-zinc-800/60 text-zinc-500' : isSel ? 'bg-indigo-950/40 border-indigo-500 text-indigo-100 shadow-md shadow-indigo-950/30 ring-1 ring-indigo-500/40' : 'bg-zinc-900/70 border-zinc-800/80 text-zinc-300 hover:border-zinc-700'}`}
                            >
                              <span className="text-base shrink-0">{item.icon}</span>
                              <div className="truncate">
                                <p className="text-[13px] font-bold truncate">{item.label}</p>
                                <p className="text-[11px] text-zinc-500 truncate mt-0.5">{isRefundLocked ? 'Prepaid orders only' : item.desc}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Refund Action Card */}
                      {dispReason==='Refund Requested' && dispTkt.paymentMethod==='Prepaid' && (
                        <div className="bg-emerald-950/30 p-4 rounded-xl border border-emerald-800/60 space-y-3 animate-fadeIn mt-3">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-emerald-300 text-sm flex items-center gap-2">
                              💳 Prepaid Instant Refund
                            </span>
                            <span className="font-mono text-xl font-extrabold text-emerald-400">₹{dispTkt.orderAmount.toLocaleString('en-IN')}</span>
                          </div>
                          <p className="text-[12px] text-zinc-400 leading-relaxed">
                            Refund will be credited back to customer original payment gateway source.
                          </p>
                          <input
                            value={refNotes}
                            onChange={e=>setRefNotes(e.target.value)}
                            placeholder="Optional agent notes for refund receipt..."
                            className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg p-2.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      )}

                      {/* Attempt Type Selector (Column S) — Shown for Refund Requested */}
                      {dispReason==='Refund Requested' && (
                        <div className="bg-violet-950/20 p-4 rounded-xl border border-violet-800/50 space-y-2.5 animate-fadeIn mt-3">
                          <p className="text-[12px] font-bold text-violet-200 flex items-center gap-2">
                            📋 Attempt Type <span className="text-[10px] font-mono text-zinc-500 font-normal">(Column S)</span>
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                            {['Fake Attempt','Genuine Attempt','Already Placed','Already Refunded','Delivered','To be refunded','In Transit'].map(opt => (
                              <button
                                key={opt}
                                type="button"
                                onClick={() => setAttemptType(opt)}
                                className={`px-3 py-2 rounded-lg text-[12px] font-bold border transition-all text-left ${
                                  attemptType === opt
                                    ? 'bg-violet-600 text-white border-violet-500 shadow-xs ring-1 ring-violet-400/40'
                                    : 'bg-zinc-900/70 text-zinc-300 border-zinc-800 hover:border-zinc-700'
                                }`}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                          {attemptType && (
                            <p className="text-[11px] text-violet-300 mt-1">Selected: <strong>{attemptType}</strong> → will be written to Column S</p>
                          )}
                        </div>
                      )}

                      {/* New Order Dynamic Panel */}
                      {(dispReason==='Customer Agreed to Accept'||dispReason==='Product Issue / Exchange')&&(
                        <div className="bg-zinc-900/80 p-4 rounded-xl border border-zinc-800 space-y-3 animate-fadeIn mt-3">
                          <p className="text-[12px] font-bold text-zinc-200">Do they require a Replacement / New Order?</p>
                          <div className="flex gap-2">
                            <button type="button" onClick={()=>setNewOrder('YES')} className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${newOrder==='YES'?'bg-indigo-600 text-white border-indigo-500 shadow-xs':'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>Yes, create order</button>
                            <button type="button" onClick={()=>setNewOrder('NO')} className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${newOrder==='NO'?'bg-zinc-800 text-zinc-100 border-zinc-700':'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>No</button>
                          </div>
                          {newOrder==='YES'&&(
                            <input value={newOrderId} onChange={e=>setNewOrderId(e.target.value)} placeholder="Enter New Order ID or SKU Details…" className="w-full bg-zinc-950 border border-zinc-700/80 rounded-lg p-2.5 text-[13px] text-zinc-200 focus:outline-none focus:border-indigo-500 animate-fadeIn"/>
                          )}
                        </div>
                      )}

                      {/* Address Change Dynamic Panel */}
                      {(dispReason==='Customer Agreed to Accept'||dispReason==='Address Change Requested'||dispReason==='Product Issue / Exchange')&&(
                        <div className="bg-zinc-900/80 p-4 rounded-xl border border-zinc-800 space-y-3 animate-fadeIn mt-3">
                          <p className="text-[12px] font-bold text-zinc-200">Is an Address Change required for redelivery?</p>
                          <div className="flex gap-2">
                            <button type="button" onClick={()=>setAddrChange('YES')} className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${addrChange==='YES'?'bg-indigo-600 text-white border-indigo-500 shadow-xs':'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>Yes, update address</button>
                            <button type="button" onClick={()=>setAddrChange('NO')} className={`flex-1 py-2 rounded-lg text-[13px] font-bold border transition-all ${addrChange==='NO'?'bg-zinc-800 text-zinc-100 border-zinc-700':'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>No</button>
                          </div>
                          {addrChange==='YES'&&(
                            <textarea value={newAddr} onChange={e=>setNewAddr(e.target.value)} placeholder="Enter complete new delivery address & pincode…" rows="2" className="w-full bg-zinc-950 border border-zinc-700/80 rounded-lg p-2.5 text-[13px] text-zinc-200 focus:outline-none focus:border-indigo-500 resize-none animate-fadeIn"/>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {dispConn==='NO' && (
                    <div className="space-y-3 animate-fadeIn border-t border-zinc-800/80 pt-4">
                      <p className="text-[12px] font-bold uppercase tracking-wider text-zinc-400">2. Select Unreachable Reason / Outcome</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto custom-scroll pr-1">
                        {unreachableOutcomes.map(item => {
                          const isSel = dispReason === item.value;
                          const isRefundLocked = item.value === 'Refund Requested' && dispTkt.paymentMethod !== 'Prepaid';
                          return (
                            <button
                              key={item.value}
                              type="button"
                              disabled={isRefundLocked}
                              title={isRefundLocked ? 'Refund initiation is only available for Prepaid orders' : undefined}
                              onClick={() => { if(!isRefundLocked) setDispReason(item.value); }}
                              className={`p-3 rounded-xl border text-left transition-all flex items-start gap-3 ${isRefundLocked ? 'opacity-40 cursor-not-allowed bg-zinc-900/40 border-zinc-800/60 text-zinc-500' : isSel ? 'bg-rose-950/40 border-rose-500 text-rose-100 shadow-md ring-1 ring-rose-500/40' : 'bg-zinc-900/70 border-zinc-800/80 text-zinc-300 hover:border-zinc-700'}`}
                            >
                              <span className="text-base shrink-0">{item.icon}</span>
                              <div className="truncate">
                                <p className="text-[13px] font-bold truncate">{item.label}</p>
                                <p className="text-[11px] text-zinc-500 truncate mt-0.5">{isRefundLocked ? 'Prepaid orders only' : item.desc}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Refund Action Card for Unreachable Call */}
                      {dispReason==='Refund Requested' && dispTkt.paymentMethod==='Prepaid' && (
                        <div className="bg-emerald-950/30 p-4 rounded-xl border border-emerald-800/60 space-y-3 animate-fadeIn mt-3">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-emerald-300 text-sm flex items-center gap-2">
                              💳 Prepaid Instant Refund
                            </span>
                            <span className="font-mono text-xl font-extrabold text-emerald-400">₹{dispTkt.orderAmount.toLocaleString('en-IN')}</span>
                          </div>
                          <p className="text-[12px] text-zinc-400 leading-relaxed">
                            Refund will be credited back to customer original payment gateway source.
                          </p>
                          <input
                            value={refNotes}
                            onChange={e=>setRefNotes(e.target.value)}
                            placeholder="Optional agent notes for refund receipt..."
                            className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg p-2.5 text-[13px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      )}

                      {/* Attempt Type Selector (Column S) — Shown for Refund Requested (Unreachable) */}
                      {dispReason==='Refund Requested' && (
                        <div className="bg-violet-950/20 p-4 rounded-xl border border-violet-800/50 space-y-2.5 animate-fadeIn mt-3">
                          <p className="text-[12px] font-bold text-violet-200 flex items-center gap-2">
                            📋 Attempt Type <span className="text-[10px] font-mono text-zinc-500 font-normal">(Column S)</span>
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                            {['Fake Attempt','Genuine Attempt','Already Placed','Already Refunded','Delivered','To be refunded','In Transit'].map(opt => (
                              <button
                                key={opt}
                                type="button"
                                onClick={() => setAttemptType(opt)}
                                className={`px-3 py-2 rounded-lg text-[12px] font-bold border transition-all text-left ${
                                  attemptType === opt
                                    ? 'bg-violet-600 text-white border-violet-500 shadow-xs ring-1 ring-violet-400/40'
                                    : 'bg-zinc-900/70 text-zinc-300 border-zinc-800 hover:border-zinc-700'
                                }`}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                          {attemptType && (
                            <p className="text-[11px] text-violet-300 mt-1">Selected: <strong>{attemptType}</strong> → will be written to Column S</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Step 3: Agent Remarks & Comments Field (Universal) */}
                  {dispConn && (
                    <div className="space-y-2 border-t border-zinc-800/80 pt-4 animate-fadeIn">
                      <label className="block text-[12px] font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                        <ChatIcon className="text-indigo-400"/> Agent Remarks & Disposition Comments
                      </label>
                      <textarea
                        value={agentRemarks}
                        onChange={e => setAgentRemarks(e.target.value)}
                        placeholder="Write detailed remarks (e.g. address change notes, customer callback request, exchange details, etc.)..."
                        rows="3"
                        className="w-full bg-zinc-950 border border-zinc-700/80 rounded-xl p-3 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 resize-none shadow-xs"
                      />
                    </div>
                  )}

                </div>

                {/* Modal Footer */}
                <div className="flex items-center justify-between pt-4 border-t border-zinc-800/80">
                  <button type="button" onClick={()=>setDispTkt(null)} className="px-4 py-2 rounded-xl text-[13px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors">Cancel</button>
                  <button
                    type="button"
                    onClick={submitDisp}
                    disabled={!dispConn || !dispReason || (dispReason==='Refund Requested' && dispTkt.paymentMethod!=='Prepaid') || refundProcessing}
                    className={`px-6 py-2.5 rounded-xl font-bold text-[13px] disabled:opacity-30 transition-all flex items-center gap-2 ${
                      dispReason==='Refund Requested'
                        ?'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50 ring-1 ring-emerald-400/50'
                        :'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-950/50'
                    }`}
                  >
                    {refundProcessing ? '⏳ Processing Refund…' : dispReason==='Refund Requested' ? '💳 Confirm Refund & Save' : '🚀 Save Disposition & Sync Live Sheet'}
                  </button>
                </div>
              </div>
            </Overlay>
          )}

          {/* ═══ DETAIL MODAL WITH REMARKS & DISPOSITION LOG ═══ */}
          {detailTkt&&(
            <Overlay onClose={()=>setDetailTkt(null)}>
              <div className="w-full max-w-md bg-[#121215] border border-zinc-800/90 rounded-2xl shadow-2xl text-zinc-100">
                <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80">
                  <h3 className="text-base font-bold font-mono text-zinc-100">{detailTkt.orderNumber}</h3>
                  <button onClick={()=>setDetailTkt(null)} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400"><XIcon/></button>
                </div>
                <div className="px-6 py-5 space-y-4 max-h-[68vh] overflow-y-auto text-[13px]">
                  
                  {/* Assigned Agent Column Q Info */}
                  <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-zinc-800/80 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-zinc-500 uppercase font-medium">Assigned Agent (Column Q)</p>
                      <span className="text-[10px] font-mono text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-800/40">Sheet Row #{detailTkt.rawIndex + 2}</span>
                    </div>
                    <p className="text-zinc-100 font-bold flex items-center gap-1.5">👤 {detailTkt.assignedAgent}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Calling Date</p><p className="font-semibold text-zinc-200">{detailTkt.callingDate}</p></div>
                    <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Attempt (Col S)</p><p className="font-semibold text-violet-300">{detailTkt.attemptType || '—'}</p></div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Payment Method</p><p className="font-semibold text-zinc-200">{detailTkt.paymentMethod}</p></div>
                    <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Order Amount</p><p className="font-semibold text-zinc-200">₹{detailTkt.orderAmount.toLocaleString('en-IN')}</p></div>
                  </div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">RTO Reason</p><p className="text-zinc-300">{detailTkt.rtoReason}</p></div>

                  {/* Disposed History & Agent Remarks Log Card */}
                  <div className="p-4 rounded-xl bg-indigo-950/20 border border-indigo-900/40 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                        <ChatIcon className="text-indigo-400"/> Agent Remarks & Disposition History
                      </span>
                      {detailTkt.disposedAt && <span className="text-[11px] text-zinc-500 font-mono">{detailTkt.disposedAt}</span>}
                    </div>

                    {detailTkt.disposition || detailTkt.agentRemarks ? (
                      <div className="space-y-2">
                        {detailTkt.disposition && (
                          <div className="flex items-center gap-2">
                            <Badge color="blue">{detailTkt.disposition}</Badge>
                            {detailTkt.disposedBy && <span className="text-[11px] text-zinc-400">by {detailTkt.disposedBy}</span>}
                          </div>
                        )}
                        {detailTkt.agentRemarks && (
                          <div className="p-3 rounded-lg bg-zinc-950/80 border border-zinc-800 text-[13px] text-zinc-200 leading-relaxed font-sans">
                            <span className="text-indigo-400 font-semibold">Remarks:</span> "{detailTkt.agentRemarks}"
                          </div>
                        )}
                        {detailTkt.newAddress && (
                          <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-900/40 text-[12px] text-amber-200">
                            📍 <strong>New Address:</strong> {detailTkt.newAddress}
                          </div>
                        )}
                        {detailTkt.newOrderId && (
                          <div className="p-2.5 rounded-lg bg-sky-950/30 border border-sky-900/40 text-[12px] text-sky-200">
                            📦 <strong>Replacement Order:</strong> {detailTkt.newOrderId}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-[12px] text-zinc-500 italic">No disposition remarks recorded yet.</p>
                    )}
                  </div>

                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Customer</p><p className="text-zinc-200 font-semibold">{detailTkt.customerName}</p><p className="text-zinc-400">{detailTkt.email} · {detailTkt.phone}</p></div>
                  <div><p className="text-[11px] text-zinc-500 uppercase font-medium mb-0.5">Address</p><p className="text-zinc-300">{detailTkt.address}</p><p className="text-zinc-200 font-medium">{detailTkt.city}, {detailTkt.state} — {detailTkt.pincode}</p></div>
                </div>
                <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-zinc-800/80">
                  <button onClick={()=>setDetailTkt(null)} className="px-4 py-2 rounded-xl text-[13px] text-zinc-400">Close</button>
                  <button onClick={()=>{const t=detailTkt;setDetailTkt(null);openDisp(t);}} className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-semibold">Open Call Form</button>
                </div>
              </div>
            </Overlay>
          )}

          {/* ═══ RECEIPT MODAL ═══ */}
          {receiptTkt?.refundDetails&&(
            <Overlay onClose={()=>setReceiptTkt(null)}>
              <div className="w-full max-w-sm bg-[#121215] border border-zinc-800/90 rounded-2xl shadow-2xl p-6 space-y-5 text-zinc-100">
                <div className="flex items-center justify-between"><div className="flex items-center gap-2"><CheckIcon className="text-emerald-400"/><h3 className="text-base font-bold">Refund Receipt</h3></div><button onClick={()=>setReceiptTkt(null)} className="text-zinc-400"><XIcon/></button></div>
                <div id="printable-receipt" className="space-y-4">
                  <div className="text-center py-5 bg-emerald-950/30 border border-emerald-900/40 rounded-xl"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Amount</p><p className="text-3xl font-extrabold text-emerald-400 mt-1">₹{receiptTkt.refundDetails.amount.toLocaleString('en-IN')}</p><p className="text-[11px] text-zinc-500 font-mono mt-1">{receiptTkt.refundDetails.transactionRef}</p></div>
                  <div className="space-y-2 text-[13px]">
                    {[['Customer',receiptTkt.customerName],['Order',receiptTkt.orderNumber],['Payment',receiptTkt.paymentMethod],['Mode',receiptTkt.refundDetails.mode],['Processed by',receiptTkt.refundDetails.processedBy],['Date',receiptTkt.refundDetails.date]].map(([k,v])=>(
                      <div key={k} className="flex justify-between"><span className="text-zinc-500">{k}</span><span className="text-zinc-200 font-medium">{v}</span></div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                  <button onClick={()=>window.print()} className="flex items-center gap-1.5 text-[13px] text-zinc-400 hover:text-zinc-200">Print</button>
                  <button onClick={()=>setReceiptTkt(null)} className="text-[13px] text-zinc-400">Close</button>
                </div>
              </div>
            </Overlay>
          )}

        </div>
      );
    }


export default App;
