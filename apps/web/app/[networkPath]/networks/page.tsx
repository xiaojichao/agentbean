'use client';
import { useEffect, useState } from 'react';
import { getWebSocket, networkEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { NetworkSummary } from '@/lib/schema';

export default function NetworksPage() {
  const [networks, setNetworks] = useState<NetworkSummary[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const conn = useAgentBeanStore((s) => s.conn);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  const setCurrentNetworkId = useAgentBeanStore((s) => s.setCurrentNetworkId);

  const fetchNetworks = async () => {
    const res = await networkEvents().list();
    if (res.ok && res.networks) {
      setNetworks(res.networks);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (conn === 'open') fetchNetworks();
  }, [conn]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await networkEvents().create({ name: trimmed, description: description || undefined });
    if (res.ok && res.network) {
      setNetworks((prev) => [...prev, res.network!]);
      setName('');
      setDescription('');
    }
  };

  const handleSwitch = async (networkId: string) => {
    const res = await networkEvents().switch(networkId);
    if (res.ok) {
      setCurrentNetworkId(networkId);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">网络管理</h1>

      <form onSubmit={handleCreate} className="rounded border border-neutral-200 p-4 mb-6">
        <div className="text-sm font-medium mb-2">创建新网络</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="网络名称"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述（可选）"
            className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded bg-neutral-900 text-white text-sm px-3 py-2 disabled:opacity-50"
          >创建</button>
        </div>
      </form>

      {loading ? (
        <div className="text-sm text-neutral-500">加载中...</div>
      ) : networks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
          还没有网络。
        </div>
      ) : (
        <ul className="space-y-2">
          {networks.map((n) => (
            <li
              key={n.id}
              className={`flex items-center justify-between rounded border px-3 py-2 ${
                n.id === currentNetworkId ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:bg-neutral-50'
              }`}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{n.name}</div>
                {n.description && (
                  <div className="text-xs text-neutral-500 truncate max-w-md">{n.description}</div>
                )}
                <div className="text-xs text-neutral-400">ID: {n.id}</div>
              </div>
              <div className="shrink-0 ml-4">
                {n.id === currentNetworkId ? (
                  <span className="text-xs rounded bg-neutral-900 text-white px-2 py-1">当前网络</span>
                ) : (
                  <button
                    onClick={() => handleSwitch(n.id)}
                    className="text-xs rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100"
                  >切换</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
