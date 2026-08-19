'use client';

import { useEffect, useState } from 'react';
import { fetchJson, postJson } from './momApi';
import MomBoard from './MomBoard';

function BoardCard({ board, onOpen }) {
  return (
    <button
      onClick={() => onOpen(board.id)}
      className="text-left bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 hover:border-purple-600/60 transition-all"
    >
      <div className="text-zinc-100 font-bold">{board.name}</div>
      {board.description && <div className="text-zinc-500 text-[13px] mt-1 line-clamp-2">{board.description}</div>}
      <div className="text-zinc-600 text-[11px] mt-2 uppercase tracking-wide">{board.role}</div>
    </button>
  );
}

function NewBoardForm({ onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { board } = await postJson('/api/mom/boards', { name, description });
      setName('');
      setDescription('');
      onCreated(board);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-2 bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3 mb-6">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Board name"
        className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 text-[13px] placeholder-zinc-500 focus:outline-none focus:border-purple-600"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-[13px] font-bold transition-all"
      >
        New board
      </button>
      {error && <div className="text-red-400 text-[12px] w-full">{error}</div>}
    </form>
  );
}

export default function MomClient() {
  const [boards, setBoards] = useState(null);
  const [error, setError] = useState('');
  const [openBoardId, setOpenBoardId] = useState(null);

  const load = () => {
    fetchJson('/api/mom/boards')
      .then((d) => setBoards(d.boards))
      .catch((e) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  if (openBoardId) {
    return <MomBoard boardId={openBoardId} onBack={() => { setOpenBoardId(null); load(); }} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <h1 className="text-xl font-bold mb-4">MOM — Project Tracker</h1>
      <NewBoardForm onCreated={(board) => setOpenBoardId(board.id)} />
      {error && <div className="text-red-400 text-[13px] mb-4">{error}</div>}
      {boards === null ? (
        <div className="text-zinc-500 text-[13px]">Loading boards…</div>
      ) : boards.length === 0 ? (
        <div className="text-zinc-500 text-[13px]">No boards yet — create one above.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {boards.map((b) => <BoardCard key={b.id} board={b} onOpen={setOpenBoardId} />)}
        </div>
      )}
    </div>
  );
}
