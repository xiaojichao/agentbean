'use client';
import { useState } from 'react';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { getWebSocket } from '@/lib/socket';
import { useRouter } from 'next/navigation';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const np = useCurrentNetworkPath();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (selected.size === 0) { setError('请选择至少 1 个 Agent'); return; }
    setPending(true);
    getWebSocket().emit('channel:create', {
      name: name.trim(),
      agentIds: [...selected],
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-[480px] p-5 space-y-4">
        <div className="text-lg font-semibold">新建频道</div>
        <input
          className="w-full border border-neutral-300 rounded px-3 py-2 text-sm"
          placeholder="频道名 (留空则自动命名)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="space-y-2 max-h-72 overflow-auto">
          {agents.length === 0 ? (
            <div className="text-sm text-neutral-500">还没有 Agent。请先启动一个 daemon。</div>
          ) : (
            agents.map((a) => (
              <label key={a.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-100">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-neutral-500">{a.role}</span>
                {a.status !== 'online' && (
                  <span className="ml-auto text-xs text-amber-700">{a.status}</span>
                )}
              </label>
            ))
          )}
        </div>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm rounded border" onClick={onClose}>取消</button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:opacity-50"
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
