import { getEligibleOrders } from '../../../lib/sheets';
import { CSV_HEADERS, toCSV } from '../../../lib/csv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const orders = await getEligibleOrders();
    const rows = orders.map((o) => ({
      HYP_Parent_OrderID: o.parentOrder,
      AWB_Number: o.awbNumber,
      Status_1: o.statusAsPerAwb,
      'New Order ID': '',
      'New AWB / Tracking': '',
      Status_2: '',
      Notes: '',
    }));
    const csv = toCSV(rows, CSV_HEADERS);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ndr-orders.csv"');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
