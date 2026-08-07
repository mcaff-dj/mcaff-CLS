import { CSV_HEADERS, toCSV } from '../../../lib/csv';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const example = [{
    HYP_Parent_OrderID: 'HYP31900000',
    AWB_Number: 'AWB123456789',
    Status_1: 'RTO',
    'New Order ID': 'HYP31999999',
    'New AWB / Tracking': 'AWB987654321',
    Status_2: 'Reshipped',
    Notes: 'Customer confirmed new address',
  }];
  const csv = toCSV(example, CSV_HEADERS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ndr-sample-template.csv"');
  res.status(200).send(csv);
}
