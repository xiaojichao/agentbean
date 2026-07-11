'use client';
import { useEffect, useState } from 'react';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { channelEvents, memberEvents } from '@/lib/socket';
import { useRouter } from 'next/navigation';
import { Globe, Lock, ChevronRight } from 'lucide-react';

export function NewChannelDialog({ onClose, teamId, teamPath }: { onClose: () => void; teamId?: string; teamPath?: string }) {
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const currentTeamPath = useCurrentTeamPath();
  const np = teamPath ?? currentTeamPath;
  const channelTeamId = teamId ?? currentTeamId;
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [teamHumans, setTeamHumans] = useState<Array<{ userId: string; username: string; role: string }>>([]);

  useEffect(() => {
    if (!channelTeamId) return;
    memberEvents().list({ teamId: channelTeamId }).then((res) => {
      if (res.ok && res.humans) setTeamHumans(res.humans);
    });
  }, [channelTeamId]);
  const router = useRouter();

  const toggleAgent = (id: string) => {
    setSelectedAgents((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleUser = (id: string) => {
    setSelectedUsers((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = () => {
    setPending(true);
    setError(null);
    channelEvents().create({
      teamId: channelTeamId,
      name: name.trim(),
      agentMemberIds: [...selectedAgents],
      humanMemberIds: [...selectedUsers],
      visibility,
    }).then((res) => {
      setPending(false);
      if (res?.ok) {
        onClose();
        router.push(`/${np}/channels/${res.channel!.id}`);
      } else {
        setError(res?.error ?? '创建失败');
      }
    });
  };


  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[520px] p-5 space-y-4" onClick={(e) => e.stopPropagation()} data-smoke="channel-create-dialog">
        <div className="text-lg font-semibold">新建频道</div>

        <input
          className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          placeholder="频道名 (留空则自动命名)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-smoke="channel-create-name"
        />

        {/* Visibility */}
        <div>
          <div className="text-xs font-medium text-neutral-500 mb-1.5">可见性</div>
          <div className="flex gap-2">
            <button
              onClick={() => setVisibility('public')}
              data-smoke="channel-create-visibility-public"
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${visibility === 'public' ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              <Globe size={14} /> 公开
            </button>
            <button
              onClick={() => setVisibility('private')}
              data-smoke="channel-create-visibility-private"
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${visibility === 'private' ? 'border-purple-400 bg-purple-50 text-purple-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              <Lock size={14} /> 私有
            </button>
          </div>
          <div className="text-[11px] text-neutral-400 mt-1">
            {visibility === 'public' ? '团队所有用户可见' : '仅被邀请的用户可见'}
          </div>
        </div>

        {/* Agent selection */}
        <div>
          <div className="text-xs font-medium text-neutral-500 mb-1.5">Agent 成员（可选）</div>
          <div className="space-y-1 max-h-40 overflow-auto rounded-md border border-neutral-200 p-2">
            {agents.length === 0 ? (
              <div className="text-sm text-neutral-500 py-2 text-center">还没有 Agent</div>
            ) : (
              agents.map((a) => (
                <label key={a.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-100 cursor-pointer">
                  <input type="checkbox" checked={selectedAgents.has(a.id)} onChange={() => toggleAgent(a.id)} />
                  <span className="font-medium text-sm">{a.name}</span>
                  <span className="text-xs text-neutral-500">{a.role}</span>
                  {a.status !== 'online' && <span className="ml-auto text-xs text-amber-700">{a.status}</span>}
                </label>
              ))
            )}
          </div>
        </div>

        {/* User selection (for private channels) */}
        {visibility === 'private' && (
          <div>
            <button onClick={() => setShowUsers(!showUsers)} className="flex items-center gap-1 text-xs font-medium text-neutral-500 mb-1.5 hover:text-neutral-700">
              <ChevronRight size={12} className={`transition-transform ${showUsers ? 'rotate-90' : ''}`} />
              用户成员 ({selectedUsers.size})
            </button>
            {showUsers && (
              <div className="space-y-1 max-h-32 overflow-auto rounded-md border border-neutral-200 p-2">
                {teamHumans.filter((u) => u.userId !== currentUser?.id).length === 0 ? (
                  <div className="text-sm text-neutral-500 py-2 text-center">暂无其他成员</div>
                ) : (
                  teamHumans.filter((u) => u.userId !== currentUser?.id).map((u) => (
                    <label key={u.userId} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-100 cursor-pointer">
                      <input type="checkbox" checked={selectedUsers.has(u.userId)} onChange={() => toggleUser(u.userId)} />
                      <span className="font-medium text-sm">{u.username}</span>
                      <span className="text-xs text-neutral-400">{u.role === 'owner' ? '所有者' : u.role === 'admin' ? '管理员' : '成员'}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {error && <div className="text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 hover:bg-neutral-50" onClick={onClose}>取消</button>
          <button
            className="px-3 py-1.5 text-sm rounded-md bg-neutral-900 text-white disabled:opacity-50 hover:bg-neutral-800"
            onClick={submit}
            disabled={pending}
            data-smoke="channel-create-submit"
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
