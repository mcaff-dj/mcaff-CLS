// Vercel serverless function: POST /api/refresh
//
// Lets ANYONE viewing the deployed site trigger a data refresh, without needing
// access to the GitHub repo. It holds a GitHub token server-side (Vercel env var,
// never sent to the browser) and calls GitHub's workflow_dispatch API on the
// visitor's behalf.
//
// Required Vercel env var: GH_DISPATCH_TOKEN
//   A GitHub fine-grained personal access token, scoped ONLY to this repo, with
//   "Actions: Read and write" permission (no other scopes needed).

const OWNER = 'Vikash-P';
const REPO = 'mcaff-CLS';
const WORKFLOW_FILE = 'refresh.yml';
const COOLDOWN_MS = 5 * 60 * 1000; // don't allow re-dispatch within 5 min of the last manual trigger

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mcaff-cls-refresh-button',
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'error', message: 'Use POST' });
    return;
  }

  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    res.status(500).json({ status: 'error', message: 'Server not configured: missing GH_DISPATCH_TOKEN.' });
    return;
  }

  const runsUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`;
  const dispatchUrl = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  try {
    const runsResp = await fetch(runsUrl, { headers: ghHeaders(token) });
    if (runsResp.ok) {
      const data = await runsResp.json();
      const runs = data.workflow_runs || [];

      const active = runs.find((r) => r.status === 'in_progress' || r.status === 'queued');
      if (active) {
        res.status(200).json({
          status: 'already_running',
          message: 'A refresh is already in progress. Check back in a minute or two.',
          run_url: active.html_url,
        });
        return;
      }

      const recentManual = runs.find(
        (r) => r.event === 'workflow_dispatch' && Date.now() - new Date(r.created_at).getTime() < COOLDOWN_MS
      );
      if (recentManual) {
        const waitSec = Math.ceil(
          (COOLDOWN_MS - (Date.now() - new Date(recentManual.created_at).getTime())) / 1000
        );
        res.status(429).json({
          status: 'cooldown',
          message: `A refresh was just triggered. Please wait ~${waitSec}s before trying again.`,
          run_url: recentManual.html_url,
        });
        return;
      }
    }

    const dispatchResp = await fetch(dispatchUrl, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (dispatchResp.status === 204) {
      res.status(200).json({ status: 'started', message: 'Refresh started — this usually takes 2–4 minutes.' });
    } else {
      const detail = await dispatchResp.text().catch(() => '');
      res.status(502).json({ status: 'error', message: `GitHub API error (${dispatchResp.status})`, detail });
    }
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message || String(e) });
  }
};
