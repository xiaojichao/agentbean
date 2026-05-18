'use client';
import { useState } from 'react';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { getWebSocket } from '@/lib/socket';
import { useRouter } from 'next/navigation';
import { Globe, Lock, ChevronRight } from 'lucide-react';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const np = useCurrentNetworkPath();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
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
    if (selectedAgents.size === 0) { setError('请选择至少 1 个 Agent'); return; }
    setPending(true);
    getWebSocket().emit('channel:create', {
      name: name.trim(),
      agentIds: [...selectedAgents],
      userIds: [...selectedUsers],
      visibility,
    }, (res: any) => {
      setPending(false);
      if (res?.ok) {
        onClose();
        router.push(`/${np}/channels/${res.channel.id}`);
      } else {
        setError(res?.error ?? '创建失败');
      }
    });
  };

  // Mock user list — in a real app this would come from members:list
  const mockUsers = currentUser ? [currentUser] : [];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-[520px] p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-semibold">新建频道</div>

        <input
          className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          placeholder="频道名 (留空则自动命名)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {/* Visibility */}
        <div>
          <div className="text-xs font-medium text-neutral-500 mb-1.5">可见性</div>
          <div className="flex gap-2">
            <button
              onClick={() => setVisibility('public')}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${visibility === 'public' ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              <Globe size={14} /> 公开
            </button>
            <button
              onClick={() => setVisibility('private')}
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
          <div className="text-xs font-medium text-neutral-500 mb-1.5">Agent 成员</div>
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
                {mockUsers.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-100 cursor-pointer">
                    <input type="checkbox" checked={selectedUsers.has(u.id)} onChange={() => toggleUser(u.id)} />
                    <span className="font-medium text-sm">{u.username}</span>
                    <span className="text-xs text-neutral-400">{u.role}</span>
                  </label>
                ))}
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
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
