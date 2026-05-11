'use client';

import { FormEvent, useEffect, useState } from 'react';
import { LayoutGrid, List, ChevronDown, User, Tag, Plus, X, Trash2 } from 'lucide-react';
import { useAgentBeanStore } from '@/lib/store';
import { taskEvents } from '@/lib/socket';

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  creatorId: string;
  assigneeId: string | null;
  channelId: string | null;
  tags: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
type ColumnId = TaskStatus;

const COLUMNS: { id: ColumnId; label: string; color: string; headerBg: string }[] = [
  { id: 'todo', label: 'Todo', color: 'text-orange-700', headerBg: 'bg-orange-100 border-orange-200' },
  { id: 'in_progress', label: 'In Progress', color: 'text-cyan-700', headerBg: 'bg-cyan-100 border-cyan-200' },
  { id: 'in_review', label: 'In Review', color: 'text-purple-700', headerBg: 'bg-purple-100 border-purple-200' },
  { id: 'done', label: 'Done', color: 'text-green-700', headerBg: 'bg-green-100 border-green-200' },
];

export default function TasksPage() {
  const channels = useAgentBeanStore((s) => s.channels);
  const [selectedChannel, setSelectedChannel] = useState<string | undefined>(undefined);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [showChannelDrop, setShowChannelDrop] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTags, setNewTags] = useState('');
  const [loading, setLoading] = useState(true);

  // Load tasks
  useEffect(() => {
    setLoading(true);
    taskEvents().list(selectedChannel).then((res) => {
      if (res.ok && res.tasks) setTasks(res.tasks);
    }).finally(() => setLoading(false));
  }, [selectedChannel]);

  const moveTo = async (taskId: string, col: ColumnId) => {
    setTasks((prev) => {
      const colTasks = prev.filter((t) => t.status === col && t.id !== taskId);
      const maxSort = colTasks.reduce((max, t) => Math.max(max, t.sortOrder), 0);
      const updated = prev.map((t) => (t.id === taskId ? { ...t, status: col, sortOrder: maxSort + 1 } : t));
      // Persist both status and sort order
      taskEvents().update({ id: taskId, status: col, sortOrder: maxSort + 1 });
      return updated;
    });
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const tags = newTags.split(',').map(t => t.trim()).filter(Boolean);
    const res = await taskEvents().create({ title: newTitle.trim(), tags, channelId: selectedChannel });
    if (res.ok && res.task) {
      setTasks((prev) => [res.task!, ...prev]);
      setNewTitle('');
      setNewTags('');
      setShowCreate(false);
    }
  };

  const handleDelete = async (id: string) => {
    await taskEvents().delete(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="-m-6 flex h-[calc(100vh-40px)] flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5">
        <div className="relative">
          <button onClick={() => setShowChannelDrop((v) => !v)} className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50">
            <span>{selectedChannel ? channels.find((c) => c.id === selectedChannel)?.name ?? '频道' : '全部任务'}</span>
            <ChevronDown size={14} />
          </button>
          {showChannelDrop && (
            <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border border-neutral-200 bg-white shadow-lg">
              <button onClick={() => { setSelectedChannel(undefined); setShowChannelDrop(false); }} className={`w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 ${!selectedChannel ? 'bg-neutral-100 font-medium' : ''}`}>全部任务</button>
              {channels.map((ch) => (
                <button key={ch.id} onClick={() => { setSelectedChannel(ch.id); setShowChannelDrop(false); }} className={`w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 ${ch.id === selectedChannel ? 'bg-neutral-100 font-medium' : ''}`}>{ch.name}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800">
          <Plus size={12} /> 新建任务
        </button>
        <div className="flex-1" />
        <div className="flex rounded-md border border-neutral-200">
          <button onClick={() => setView('board')} className={`px-2.5 py-1.5 ${view === 'board' ? 'bg-neutral-100' : ''}`}><LayoutGrid size={14} /></button>
          <button onClick={() => setView('list')} className={`px-2.5 py-1.5 ${view === 'list' ? 'bg-neutral-100' : ''}`}><List size={14} /></button>
        </div>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-3">
          <form onSubmit={handleCreate} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-neutral-500">标题</label>
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className="w-full rounded border border-neutral-300 px-2.5 py-1.5 text-sm" placeholder="任务标题" autoFocus />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-neutral-500">标签（逗号分隔）</label>
              <input value={newTags} onChange={(e) => setNewTags(e.target.value)} className="w-full rounded border border-neutral-300 px-2.5 py-1.5 text-sm" placeholder="bug, feature" />
            </div>
            <button type="submit" disabled={!newTitle.trim()} className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">创建</button>
            <button type="button" onClick={() => setShowCreate(false)} className="rounded px-2 py-1.5 text-neutral-500 hover:bg-neutral-200"><X size={14} /></button>
          </form>
        </div>
      )}

      {/* Board view */}
      {view === 'board' ? (
        <div className="flex flex-1 gap-4 overflow-x-auto p-4">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col.id);
            return (
              <div key={col.id} className="flex w-72 shrink-0 flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragId) moveTo(dragId, col.id); setDragId(null); }}>
                <div className={`mb-2 rounded-t-md border px-3 py-2 ${col.headerBg}`}>
                  <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
                  <span className="ml-1.5 text-[10px] text-neutral-400">{colTasks.length}</span>
                </div>
                <div className="flex-1 space-y-2 rounded-b-md border border-t-0 border-neutral-200 bg-neutral-50 p-2">
                  {colTasks.map((t) => (
                    <div key={t.id} draggable onDragStart={() => setDragId(t.id)} className="group cursor-grab rounded-md border border-neutral-200 bg-white p-3 shadow-sm hover:shadow-md active:cursor-grabbing">
                      <div className="flex items-start justify-between">
                        <div className="text-sm font-medium">{t.title}</div>
                        <button onClick={() => handleDelete(t.id)} className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-opacity"><Trash2 size={12} /></button>
                      </div>
                      {t.description && <div className="mt-1 text-xs text-neutral-500 line-clamp-2">{t.description}</div>}
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500">
                        <span className="flex items-center gap-0.5"><User size={10} /> {t.creatorId.slice(0, 8)}</span>
                        {t.assigneeId && <span className="flex items-center gap-0.5"><User size={10} /> {t.assigneeId.slice(0, 8)}</span>}
                      </div>
                      {t.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {t.tags.map((tag) => (
                            <span key={tag} className="flex items-center gap-0.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500"><Tag size={8} />{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {colTasks.length === 0 && <div className="py-4 text-center text-xs text-neutral-400">拖拽任务到此处</div>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-neutral-500">
                <th className="pb-2 pr-4 font-medium">标题</th>
                <th className="pb-2 pr-4 font-medium">状态</th>
                <th className="pb-2 pr-4 font-medium">标签</th>
                <th className="pb-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const col = COLUMNS.find((c) => c.id === t.status);
                return (
                  <tr key={t.id} className="border-b border-neutral-100">
                    <td className="py-2 pr-4 font-medium">{t.title}</td>
                    <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${col?.headerBg ?? ''} ${col?.color ?? ''}`}>{col?.label}</span></td>
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {t.tags.map((tag) => (
                          <span key={tag} className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">{tag}</span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2">
                      <button onClick={() => handleDelete(t.id)} className="text-neutral-400 hover:text-red-500"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
              {tasks.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-neutral-400">{loading ? '加载中...' : '暂无任务'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
