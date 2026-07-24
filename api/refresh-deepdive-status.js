// Vercel serverless function: GET /api/refresh-deepdive-status
// Same pattern as /api/refresh-status.js, but reports on refresh-deepdive.yml runs
// instead of refresh.yml - see /api/refresh-deepdive.js for why this is separate.

const OWNER = 'Vikash-P';
const REPO = 'mcaff-CLS';
const WORKFLOW_FILE = 'refresh-deepdive.yml';

module.exports = async (req, res) => {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    res.status(500).json({ status: 'error', message: 'Server not configured: missing GH_DISPATCH_TOKEN.' });
    return;
  }
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mcaff-cls-refresh-button',
        },
      }
    );
    if (!resp.ok) {
      res.status(502).json({ status: 'error', message: `GitHub API error (${resp.status})` });
      return;
    }
    const data = await resp.json();
    const run = (data.workflow_runs || [])[0] || null;
    res.status(200).json({
      status: run ? run.status : 'unknown',       // queued | in_progress | completed
      conclusion: run ? run.conclusion : null,      // success | failure | null
      updated_at: run ? run.updated_at : null,
      run_url: run ? run.html_url : null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message || String(e) });
  }
};
