import { batchUpdateOrders, getSheetIndex } from '../../../lib/sheets';
import { parseCSV } from '../../../lib/csv';

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

const norm = (v) => String(v ?? '').trim().toLowerCase();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv text is required' });
  }

  let rows;
  try {
    rows = parseCSV(csv);
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }
  if (!rows.length) {
    return res.status(400).json({ error: 'No data rows found in the CSV' });
  }

  try {
    const { byParent, byParentAwb } = await getSheetIndex();

    const updates = [];
    const errors = [];
    const seenRows = new Set();

    rows.forEach((row, i) => {
      const line = i + 2; // account for header line
      const parent = norm(row.HYP_Parent_OrderID);
      const awb = norm(row.AWB_Number);
      const status = String(row.Status_2 ?? '').trim();

      if (!parent) {
        errors.push({ line, reason: 'Missing HYP_Parent_OrderID' });
        return;
      }
      if (!status) {
        errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Missing Status_2 (nothing to write)' });
        return;
      }

      // Prefer an exact parent+AWB match, fall back to parent only.
      let rowNumber = awb ? byParentAwb.get(`${parent}||${awb}`) : undefined;
      if (rowNumber == null) rowNumber = byParent.get(parent);

      if (rowNumber == null) {
        errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'No matching order in sheet' });
        return;
      }
      if (seenRows.has(rowNumber)) {
        errors.push({ line, order: row.HYP_Parent_OrderID, reason: 'Duplicate row in file (skipped)' });
        return;
      }
      seenRows.add(rowNumber);

      updates.push({
        rowNumber,
        newOrderId: String(row['New Order ID'] ?? '').trim() || '-',
        newAwb: String(row['New AWB / Tracking'] ?? '').trim() || '-',
        newStatus: status,
        notes: String(row.Notes ?? '').trim(),
      });
    });

    let updated = 0;
    if (updates.length) {
      updated = await batchUpdateOrders(updates);
    }

    res.status(200).json({
      ok: true,
      updated,
      skipped: errors.length,
      total: rows.length,
      rowNumbers: updates.map((u) => u.rowNumber),
      errors: errors.slice(0, 50), // cap payload
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
