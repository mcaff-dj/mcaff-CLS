import { getEligibleOrders } from '../../../lib/sheets';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const orders = await getEligibleOrders();
    res.status(200).json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
