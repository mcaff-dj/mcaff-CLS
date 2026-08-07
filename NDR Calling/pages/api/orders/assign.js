// Assignment is kept in-memory on the server process.
// For persistence across restarts, move assignmentMap to the Google Sheet or a DB.
const assignmentMap = global._assignmentMap || (global._assignmentMap = {});

export default function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ assignments: assignmentMap });
  }

  if (req.method === 'POST') {
    const { rowNumber, agentId, agentName } = req.body || {};
    if (!rowNumber) return res.status(400).json({ error: 'rowNumber required' });
    if (!agentId) {
      delete assignmentMap[rowNumber];
    } else {
      assignmentMap[rowNumber] = { agentId, agentName: agentName || agentId };
    }
    return res.status(200).json({ ok: true, assignments: assignmentMap });
  }

  res.status(405).json({ error: 'Method not allowed' });
}
