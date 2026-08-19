'use client';

import { useEffect, useState } from 'react';
import { fetchJson, postJson, deleteJson } from './momApi';

const PRIORITY_COLORS = { low: '#64748b', medium: '#3b82f6', high: '#f59e0b', urgent: '#ef4444' };

function ManagePanel({ statuses, columns, members, myRole, boardId, onChanged, onClose }) {
  const isOwner = myRole === 'owner' || myRole === 'admin';
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [statusLabel, setStatusLabel] = useState('');
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 mb-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-zinc-100 font-bold text-[14px]">Manage board</div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px]">Close</button>
      </div>
      {error && <div className="text-red-400 text-[12px]">{error}</div>}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Members</div>
          <div className="space-y-1 mb-2">
            {members.map((m) => (
              <div key={m.email} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span>{m.email} <span className="text-zinc-500">({m.role})</span></span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/members', { boardId, email: m.email }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Remove</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder="email"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
              <option value="member">member</option>
              <option value="owner">owner</option>
            </select>
            <button
              disabled={busy || !memberEmail.trim()}
              onClick={() => run(() => postJson('/api/mom/members', { boardId, email: memberEmail.trim().toLowerCase(), role: memberRole }))}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Statuses</div>
          <div className="space-y-1 mb-2">
            {statuses.map((s) => (
              <div key={s.statusKey} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span><span style={{ color: s.color }}>&#9679;</span> {s.label}</span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/statuses', { boardId, statusKey: s.statusKey }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Delete</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={statusLabel} onChange={(e) => setStatusLabel(e.target.value)} placeholder="New status label"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <button
              disabled={busy || !statusLabel.trim()}
              onClick={() => run(async () => { await postJson('/api/mom/statuses', { boardId, label: statusLabel.trim() }); setStatusLabel(''); })}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}

      {isOwner && (
        <div>
          <div className="text-zinc-400 text-[12px] font-bold uppercase mb-2">Custom fields</div>
          <div className="space-y-1 mb-2">
            {columns.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-[13px] text-zinc-300">
                <span>{c.name} <span className="text-zinc-500">({c.type})</span></span>
                <button
                  disabled={busy}
                  onClick={() => run(() => deleteJson('/api/mom/columns', { id: c.id }))}
                  className="text-red-400 hover:text-red-300 text-[11px]"
                >Delete</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={columnName} onChange={(e) => setColumnName(e.target.value)} placeholder="Field name"
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px] flex-1" />
            <select value={columnType} onChange={(e) => setColumnType(e.target.value)}
              className="px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 text-[12px]">
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="date">date</option>
              <option value="checkbox">checkbox</option>
              <option value="person">person</option>
              <option value="select">select</option>
            </select>
            <button
              disabled={busy || !columnName.trim()}
              onClick={() => run(async () => { await postJson('/api/mom/columns', { boardId, name: columnName.trim(), type: columnType }); setColumnName(''); })}
              className="px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white text-[12px] font-bold"
            >Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onDragStart, onOpen }) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onClick={() => onOpen(task)}
      className="bg-zinc-800/80 border border-zinc-700 rounded-lg p-2.5 mb-2 cursor-pointer hover:border-purple-600/60"
    >
      <div className="text-zinc-100 text-[13px] font-medium">{task.title}</div>
      <div className="flex items-center gap-2 mt-1.5 text-[11px]">
        <span style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.medium }}>{task.priority}</span>
        {task.assigneeEmail && <span className="text-zinc-500">{task.assigneeEmail}</span>}
        {task.dueDate && <span className="text-zinc-500">{task.dueDate.slice(0, 10)}</span>}
      </div>
    </div>
  );
}

function KanbanView({ statuses, tasks, onDropTask, onOpenTask }) {
  const byStatus = (key) => tasks.filter((t) => t.statusKey === key);
  const handleDragStart = (e, taskId) => e.dataTransfer.setData('text/plain', String(taskId));
  const handleDrop = (e, statusKey, index) => {
    e.preventDefault();
    const taskId = Number(e.dataTransfer.getData('text/plain'));
    if (taskId) onDropTask(taskId, statusKey, index);
  };

  return (
    <div className="flex gap-3 overflow-x-auto">
      {statuses.map((s) => {
        const columnTasks = byStatus(s.statusKey);
        return (
          <div
            key={s.statusKey}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => handleDrop(e, s.statusKey, columnTasks.length)}
            className="flex-shrink-0 w-64 bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-2"
          >
            <div className="flex items-center gap-2 text-zinc-300 text-[12px] font-bold uppercase px-1 pb-2">
              <span style={{ color: s.color }}>&#9679;</span> {s.label} <span className="text-zinc-600">{columnTasks.length}</span>
            </div>
            {columnTasks.map((t, i) => (
              <div key={t.id} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); handleDrop(e, s.statusKey, i); }}>
                <TaskCard task={t} onDragStart={handleDragStart} onOpen={onOpenTask} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function QuickAddTask({ boardId, statuses, onAdded }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await postJson('/api/mom/tasks', { boardId, title: title.trim(), statusKey: statuses[0] && statuses[0].statusKey });
      setTitle('');
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex gap-2 mb-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Quick add a task…"
        className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] flex-1 max-w-sm placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-[13px] font-bold"
      >Add task</button>
    </form>
  );
}

function TaskPanel({ task, onClose }) {
  if (!task) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex justify-end z-50" onClick={onClose}>
      <div className="w-full max-w-sm h-full bg-zinc-900 border-l border-zinc-800 p-4" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-[12px] mb-3">Close</button>
        <div className="text-zinc-100 font-bold text-[15px]">{task.title}</div>
      </div>
    </div>
  );
}

export default function MomBoard({ boardId, onBack }) {
  const [detail, setDetail] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const [selectedTask, setSelectedTask] = useState(null);

  const load = () => {
    Promise.all([
      fetchJson(`/api/mom/board?id=${boardId}`),
      fetchJson(`/api/mom/tasks?boardId=${boardId}`),
    ])
      .then(([boardData, taskData]) => {
        setDetail(boardData);
        setTasks(taskData.tasks);
      })
      .catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, [boardId]);

  const moveTask = async (taskId, statusKey, position) => {
    setTasks((prev) => {
      const moved = prev.find((t) => t.id === taskId);
      if (!moved) return prev;
      const outside = prev.filter((t) => t.id !== taskId && t.statusKey !== statusKey);
      const sameColumn = prev.filter((t) => t.id !== taskId && t.statusKey === statusKey);
      sameColumn.splice(position, 0, { ...moved, statusKey });
      return [...outside, ...sameColumn];
    });
    try {
      await postJson('/api/mom/reorder', { taskId, statusKey, position });
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  if (error) return <div className="min-h-screen bg-zinc-950 text-red-400 p-6">{error}</div>;
  if (!detail) return <div className="min-h-screen bg-zinc-950 text-zinc-500 p-6">Loading board…</div>;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <button onClick={onBack} className="text-zinc-500 hover:text-zinc-300 text-[12px] mb-1">&larr; All boards</button>
          <h1 className="text-xl font-bold">{detail.board.name}</h1>
          {detail.board.description && <p className="text-zinc-500 text-[13px]">{detail.board.description}</p>}
        </div>
        <button
          onClick={() => setManaging((v) => !v)}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 text-[12px] font-bold"
        >Manage</button>
      </div>

      {managing && (
        <ManagePanel
          statuses={detail.statuses} columns={detail.columns} members={detail.members}
          myRole={detail.myRole} boardId={boardId} onChanged={load} onClose={() => setManaging(false)}
        />
      )}

      <QuickAddTask boardId={boardId} statuses={detail.statuses} onAdded={load} />

      <KanbanView statuses={detail.statuses} tasks={tasks} onDropTask={moveTask} onOpenTask={setSelectedTask} />

      <TaskPanel task={selectedTask} onClose={() => setSelectedTask(null)} />
    </div>
  );
}
