import { updateOrder } from '../../../lib/sheets';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { rowNumber, newOrderId, newAwb, newStatus, notes } = req.body || {};
  if (!rowNumber || !newOrderId || !newAwb || !newStatus) {
    res.status(400).json({ error: 'rowNumber, newOrderId, newAwb, and newStatus are all required' });
    return;
  }
  try {
    await updateOrder(rowNumber, { newOrderId, newAwb, newStatus, notes: notes || '' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
