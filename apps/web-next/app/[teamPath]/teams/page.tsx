'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { teamEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { TeamSummary } from '@/lib/schema';

export default function TeamsPage() {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const conn = useAgentBeanStore((s) => s.conn);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const setCurrentTeamId = useAgentBeanStore((s) => s.setCurrentTeamId);
  const router = useRouter();

  const fetchTeams = async () => {
    const res = await teamEvents().list();
    if (res.ok && res.teams) {
      setTeams(res.teams);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (conn === 'open') fetchTeams();
  }, [conn]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await teamEvents().create({ name: trimmed, description: description || undefined });
    if (res.ok && res.team) {
      setTeams((prev) => [...prev, res.team!]);
      setName('');
      setDescription('');
    }
  };

  const handleSwitch = async (teamId: string) => {
    const res = await teamEvents().switch(teamId);
    if (res.ok) {
      setCurrentTeamId(teamId);
      const target = res.currentTeam ?? teams.find((team) => team.id === teamId);
      if (target?.path) router.push(`/${target.path}/teams`);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">团队管理</div>
      <div className="flex-1 overflow-y-auto p-6">

      <form onSubmit={handleCreate} className="rounded border border-neutral-200 p-4 mb-6" data-smoke="team-create-form">
        <div className="text-sm font-medium mb-2">创建新团队</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="团队名称"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
            data-smoke="team-create-name"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
            data-smoke="team-create-description"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded bg-neutral-900 text-white text-sm px-3 py-2 disabled:opacity-50"
            data-smoke="team-create-submit"
          >创建</button>
        </div>
      </form>

      {loading ? (
        <div className="text-sm text-neutral-500">加载中...</div>
      ) : teams.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
          还没有团队。
        </div>
      ) : (
        <ul className="space-y-2">
          {teams.map((n) => (
            <li
              key={n.id}
              className={`flex items-center justify-between rounded border px-3 py-2 ${
                n.id === currentTeamId ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50'
              }`}
              data-smoke="team-list-item"
              data-team-id={n.id}
              data-team-name={n.name}
              data-team-path={n.path}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{n.name}</div>
                {n.description && (
                  <div className="text-xs text-neutral-500 truncate max-w-md">{n.description}</div>
                )}
              </div>
              <div className="shrink-0 ml-4">
                {n.id === currentTeamId ? (
                  <span className="text-xs rounded bg-neutral-900 text-white px-2 py-1" data-smoke="team-current-badge">当前团队</span>
                ) : (
                  <button
                    onClick={() => handleSwitch(n.id)}
                    className="text-xs rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                    data-smoke="team-switch"
                    data-team-id={n.id}
                  >切换</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>
    </div>
  );
}
