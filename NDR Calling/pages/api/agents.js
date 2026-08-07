// Static agents list — extend as needed or move to env/DB
const AGENTS = [
  { id: 'agent_1', name: 'Priya Sharma', email: 'priya@company.com', avatar: 'PS' },
  { id: 'agent_2', name: 'Rahul Verma', email: 'rahul@company.com', avatar: 'RV' },
  { id: 'agent_3', name: 'Anita Gupta', email: 'anita@company.com', avatar: 'AG' },
  { id: 'agent_4', name: 'Karan Mehta', email: 'karan@company.com', avatar: 'KM' },
  { id: 'agent_5', name: 'Sneha Pillai', email: 'sneha@company.com', avatar: 'SP' },
];

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.status(200).json({ agents: AGENTS });
}
