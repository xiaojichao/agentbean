'use client';

import { useState } from 'react';
import { LayoutGrid, List, ChevronDown, User, Tag } from 'lucide-react';
import { useAgentBeanStore } from '@/lib/store';

interface Task {
  id: string;
  title: string;
  creator: string;
  assignee?: string;
  tags: string[];
  column: ColumnId;
}

type ColumnId = 'todo' | 'in_progress' | 'in_review' | 'done';

const COLUMNS: { id: ColumnId; label: string; color: string; headerBg: string }[] = [
  { id: 'todo', label: 'Todo', color: 'text-orange-700', headerBg: 'bg-orange-100 border-orange-200' },
  { id: 'in_progress', label: 'In Progress', color: 'text-cyan-700', headerBg: 'bg-cyan-100 border-cyan-200' },
  { id: 'in_review', label: 'In Review', color: 'text-purple-700', headerBg: 'bg-purple-100 border-purple-200' },
  { id: 'done', label: 'Done', color: 'text-green-700', headerBg: 'bg-green-100 border-green-200' },
];

const MOCK_TASKS: Task[] = [
  { id: '1', title: 'Setup CI/CD pipeline', creator: '@alice', assignee: '@bob', tags: ['devops'], column: 'todo' },
  { id: '2', title: 'Design login page', creator: '@alice', tags: ['design'], column: 'in_progress' },
  { id: '3', title: 'Implement auth middleware', creator: '@charlie', assignee: '@alice', tags: ['backend', 'security'], column: 'in_review' },
  { id: '4', title: 'Write API docs', creator: '@bob', tags: ['docs'], column: 'done' },
];

export default function TasksPage() {
  const channels = useAgentBeanStore((s) => s.channels);
  const [selectedChannel, setSelectedChannel] = useState(channels[0]?.id ?? '');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [showChannelDrop, setShowChannelDrop] = useState(false);
  const [tasks, setTasks] = useState<Task[]>(MOCK_TASKS);
  const [dragId, setDragId] = useState<string | null>(null);

  const moveTo = (taskId: string, col: ColumnId) => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, column: col } : t)));
  };

  const clearAll = () => setTasks([]);

  return (
    <div className="-m-6 flex h-[calc(100vh-40px)] flex-col">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2.5">
        <div className="relative">
          <button onClick={() => setShowChannelDrop((v) => !v)} className="flex items-center gap-1.5 rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50">
            <span>{channels.find((c) => c.id === selectedChannel)?.name ?? 'CHANNEL'}</span>
            <ChevronDown size={14} />
          </button>
          {showChannelDrop && (
            <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-md border border-neutral-200 bg-white shadow-lg">
              {channels.map((ch) => (
                <button key={ch.id} onClick={() => { setSelectedChannel(ch.id); setShowChannelDrop(false); }} className={`w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 ${ch.id === selectedChannel ? 'bg-neutral-100 font-medium' : ''}`}>{ch.name}</button>
              ))}
              {channels.length === 0 && <div className="px-3 py-2 text-xs text-neutral-400">暂无频道</div>}
            </div>
          )}
        </div>
        <button onClick={clearAll} className="rounded-md px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100">CLEAR ALL</button>
        <div className="flex-1" />
        <div className="flex rounded-md border border-neutral-200">
          <button onClick={() => setView('board')} className={`px-2.5 py-1.5 ${view === 'board' ? 'bg-neutral-100' : ''}`}><LayoutGrid size={14} /></button>
          <button onClick={() => setView('list')} className={`px-2.5 py-1.5 ${view === 'list' ? 'bg-neutral-100' : ''}`}><List size={14} /></button>
        </div>
      </div>

      {/* Board view */}
      {view === 'board' ? (
        <div className="flex flex-1 gap-4 overflow-x-auto p-4">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t.column === col.id);
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
                    <div key={t.id} draggable onDragStart={() => setDragId(t.id)} className="cursor-grab rounded-md border border-neutral-200 bg-white p-3 shadow-sm hover:shadow-md active:cursor-grabbing">
                      <div className="text-sm font-medium">{t.title}</div>
                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-neutral-500">
                        <span className="flex items-center gap-0.5"><User size={10} /> {t.creator}</span>
                        {t.assignee && <span className="flex items-center gap-0.5"><User size={10} /> {t.assignee}</span>}
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
                <th className="pb-2 pr-4 font-medium">Title</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium">Creator</th>
                <th className="pb-2 font-medium">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const col = COLUMNS.find((c) => c.id === t.column);
                return (
                  <tr key={t.id} className="border-b border-neutral-100">
                    <td className="py-2 pr-4 font-medium">{t.title}</td>
                    <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${col?.headerBg ?? ''} ${col?.color ?? ''}`}>{col?.label}</span></td>
                    <td className="py-2 pr-4 text-neutral-500">{t.creator}</td>
                    <td className="py-2 text-neutral-500">{t.assignee ?? '—'}</td>
                  </tr>
                );
              })}
              {tasks.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-neutral-400">暂无任务</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
