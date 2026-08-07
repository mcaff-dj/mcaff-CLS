import { batchUpdateOrders } from '../../../lib/sheets';

// Only statuses that need NO replacement order/AWB can be bulk-applied.
const BULK_ALLOWED = ['Delivered'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { rowNumbers, status } = req.body || {};

  if (!Array.isArray(rowNumbers) || !rowNumbers.length) {
    return res.status(400).json({ error: 'rowNumbers array is required' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }
  if (!BULK_ALLOWED.includes(status)) {
    return res.status(400).json({
      error: `Bulk update only supports statuses that need no replacement: ${BULK_ALLOWED.join(', ')}`,
    });
  }

  try {
    const updated = await batchUpdateOrders(
      rowNumbers.map((rowNumber) => ({ rowNumber, newOrderId: '-', newAwb: '-', newStatus: status }))
    );
    res.status(200).json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
