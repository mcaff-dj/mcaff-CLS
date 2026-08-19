// The MOM (project tracker) API surface - one dynamic-action handler, same shape as
// api/escalation/[action].js and api/admin/[action].js.
//
// Actions: boards | board | members | columns | statuses | tasks | reorder
//
// Two-layer access control: the 'mom' card (checkCardAccess) gates the whole feature, then
// per-board membership (checkBoardAccess) gates everything scoped to one board. For rows keyed
// by a surrogate id (columns, tasks) the board is resolved from the row itself, never trusted
// from the request body - a client could otherwise pass a boardId it IS a member of while
// editing a column/task that actually belongs to a board it is NOT a member of.
const { getSession } = require('../_lib/session');
const db = require('../_lib/db');

const CARD_KEY = 'mom';

function checkCardAccess(session) {
  if (!session) return 'Not authenticated';
  if (!(session.perms || []).includes(CARD_KEY)) return 'You do not have access to MOM.';
  return null;
}

async function checkBoardAccess(session, boardId, { requireOwner } = {}) {
  if (!boardId) return 'boardId is required';
  if (session.isAdmin) return null;
  const role = await db.getMomBoardRole(boardId, session.email);
  if (!role) return 'You are not a member of this board.';
  if (requireOwner && role !== 'owner') return 'Only board owners can do this.';
  return null;
}

const handler = async (req, res) => {
  const session = await getSession(req);
  const denied = checkCardAccess(session);
  if (denied) {
    res.status(session ? 403 : 401).json({ error: denied });
    return;
  }

  const action = (req.query && req.query.action) || '';
  const body = req.body || {};

  try {
    if (action === 'boards') {
      if (req.method === 'GET') {
        const boards = await db.getMomBoardsForUser(session.email, session.isAdmin);
        return res.status(200).json({ boards });
      }
      if (req.method === 'POST') {
        const { name, description } = body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
        const id = await db.createMomBoard(name.trim(), description || '', session.email);
        return res.status(200).json({ board: { id, name: name.trim(), description: description || '', role: 'owner' } });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'board') {
      if (req.method === 'GET') {
        const boardId = Number(req.query.id);
        if (!boardId) return res.status(400).json({ error: 'id is required' });
        const boardDenied = await checkBoardAccess(session, boardId);
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const detail = await db.getMomBoardDetail(boardId);
        if (!detail || detail.board.archived) return res.status(404).json({ error: 'Board not found' });
        const role = session.isAdmin ? 'admin' : await db.getMomBoardRole(boardId, session.email);
        if (role !== 'owner' && !session.isAdmin) detail.members = [];
        return res.status(200).json({ ...detail, myRole: role });
      }
      if (req.method === 'PUT') {
        const { id, name, description } = body;
        if (!id || !name || !name.trim()) return res.status(400).json({ error: 'id and name are required' });
        const boardDenied = await checkBoardAccess(session, id, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.updateMomBoard(id, { name: name.trim(), description: description || '' });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardDenied = await checkBoardAccess(session, id, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.archiveMomBoard(id);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'members') {
      const { boardId } = body;
      if (req.method === 'POST') {
        const { email, role } = body;
        if (!email || !['owner', 'member'].includes(role)) {
          return res.status(400).json({ error: 'email and a valid role (owner|member) are required' });
        }
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.upsertMomBoardMember(boardId, email.trim().toLowerCase(), role);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { email } = body;
        if (!email) return res.status(400).json({ error: 'email is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.removeMomBoardMember(boardId, email.trim().toLowerCase());
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'columns') {
      if (req.method === 'POST') {
        const { boardId, name, type, options } = body;
        const validTypes = ['text', 'number', 'select', 'person', 'date', 'checkbox'];
        if (!name || !name.trim() || !validTypes.includes(type)) {
          return res.status(400).json({ error: `name is required and type must be one of ${validTypes.join(', ')}` });
        }
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const column = await db.createMomColumn(boardId, name.trim(), type, options || null);
        return res.status(200).json({ column });
      }
      if (req.method === 'PUT') {
        const { id, name, options, position } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomColumnBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Column not found' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.updateMomColumn(id, { name, options, position });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: 'id is required' });
        const boardId = await db.getMomColumnBoardId(id);
        if (!boardId) return res.status(404).json({ error: 'Column not found' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        await db.deleteMomColumn(id);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (action === 'statuses') {
      const { boardId } = body;
      if (req.method === 'POST') {
        const { label, color } = body;
        if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        const status = await db.createMomStatus(boardId, label.trim(), color);
        return res.status(200).json({ status });
      }
      if (req.method === 'PUT') {
        const { statusKey, label, color, position } = body;
        if (!statusKey) return res.status(400).json({ error: 'statusKey is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.updateMomStatus(boardId, statusKey, { label, color, position });
        } catch (e) {
          return res.status(404).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const { statusKey } = body;
        if (!statusKey) return res.status(400).json({ error: 'statusKey is required' });
        const boardDenied = await checkBoardAccess(session, boardId, { requireOwner: true });
        if (boardDenied) return res.status(403).json({ error: boardDenied });
        try {
          await db.deleteMomStatus(boardId, statusKey);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    return res.status(404).json({ error: 'Unknown mom route' });
  } catch (e) {
    console.error(`api/mom/${action} error:`, e);
    return res.status(500).json({ error: e.message || 'MOM request failed' });
  }
};

module.exports = handler;
