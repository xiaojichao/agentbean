'use client';

import { useEffect, useState } from 'react';
import { Globe, Users, Monitor, Bot, Trash2, RefreshCw } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

type Tab = 'networks' | 'users' | 'devices' | 'agents';

interface AdminNetwork { id: string; ownerId: string; name: string; path: string | null; visibility: string; createdAt: number; members: { userId: string; role: string; username: string }[]; }
interface AdminUser { id: string; username: string; email: string | null; role: string; createdAt: number; }
interface AdminDevice { id: string; status: string; agentCount: number; lastSeenAt: number; networkId: string; }
interface AdminAgent { id: string; name: string; role: string; adapterKind: string; status: string; visibility?: string; networkId?: string; deviceId?: string; }

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'networks', label: '网络', icon: <Globe size={14} /> },
  { key: 'users', label: '用户', icon: <Users size={14} /> },
  { key: 'devices', label: '设备', icon: <Monitor size={14} /> },
  { key: 'agents', label: 'Agent', icon: <Bot size={14} /> },
];

function emitWithTimeout(socket: any, event: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000);
    socket.emit(event, payload, (res: any) => { clearTimeout(timer); resolve(res); });
  });
}

export default function AdminDashboardPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const [tab, setTab] = useState<Tab>('networks');
  const [networks, setNetworks] = useState<AdminNetwork[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = async (t: Tab) => {
    setLoading(true);
    setError(null);
    const socket = getWebSocket();
    try {
      const res = await emitWithTimeout(socket, `admin:list-${t}`, {});
      if (res?.ok) {
        if (t === 'networks') setNetworks(res.networks ?? []);
        if (t === 'users') setUsers(res.users ?? []);
        if (t === 'devices') setDevices(res.devices ?? []);
        if (t === 'agents') setAgents(res.agents ?? []);
      } else {
        setError(res?.error ?? '加载失败');
      }
    } catch {
      setError('请求超时');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (conn !== 'open') return;
    loadData(tab);
  }, [conn, tab]);

  const handleDelete = async (type: string, id: string) => {
    const socket = getWebSocket();
    const res = await emitWithTimeout(socket, `admin:delete-${type}`, { [`${type}Id`]: id });
    if (res?.ok) {
      loadData(tab as Tab);
    } else {
      setError(res?.error ?? '删除失败');
    }
  };

  if (!currentUser || currentUser.role !== 'admin') {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">仪表盘</div>
        <div className="flex-1 overflow-y-auto p-6">
          <ConnectionBanner />
          <div className="text-sm text-red-600">仅管理员可访问此页面。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">管理仪表盘</div>
      <div className="flex-1 overflow-y-auto p-6">
      <ConnectionBanner />

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">管理仪表盘</h1>
        <button onClick={() => loadData(tab)} disabled={loading} className="inline-flex items-center gap-1.5 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === t.key ? 'bg-white shadow-sm text-neutral-900' : 'text-neutral-500 hover:text-neutral-700'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {/* Content */}
      {loading && <div className="py-8 text-center text-sm text-neutral-400">加载中...</div>}

      {!loading && tab === 'networks' && <NetworksTable networks={networks} onDelete={(id) => handleDelete('network', id)} />}
      {!loading && tab === 'users' && <UsersTable users={users} onDelete={(id) => handleDelete('user', id)} />}
      {!loading && tab === 'devices' && <DevicesTable devices={devices} />}
      {!loading && tab === 'agents' && <AgentsTable agents={agents} onDelete={(id) => handleDelete('agent', id)} />}
      </div>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50">
            {headers.map((h) => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-neutral-500">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">{children}</tbody>
      </table>
    </div>
  );
}

function DeleteButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <div className="flex items-center gap-1">
        <button onClick={() => { onClick(); setConfirm(false); }} className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700">确认</button>
        <button onClick={() => setConfirm(false)} className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50">取消</button>
      </div>
    );
  }
  return (
    <button onClick={() => setConfirm(true)} disabled={disabled} className="rounded border border-neutral-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed" title={`删除${label}`}>
      <Trash2 size={12} />
    </button>
  );
}

function NetworksTable({ networks, onDelete }: { networks: AdminNetwork[]; onDelete: (id: string) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (networks.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无网络</div>;
  return (
    <div className="space-y-3">
      {networks.map((n) => (
        <div key={n.id} className="rounded-lg border border-neutral-200 overflow-hidden">
          <div className="flex items-center justify-between bg-neutral-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <Globe size={16} className="text-neutral-400" />
              <div>
                <span className="font-medium text-sm">{n.name}</span>
                <span className="ml-2 font-mono text-xs text-neutral-400">{n.path ?? n.id}</span>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${n.visibility === 'public' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-200 text-neutral-500'}`}>{n.visibility === 'public' ? '公开' : '私有'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setExpanded(expanded === n.id ? null : n.id)} className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1">
                <Users size={12} /> {n.members?.length ?? 0} 成员
              </button>
              <DeleteButton onClick={() => onDelete(n.id)} disabled={n.id === 'default'} label="网络" />
            </div>
          </div>
          {expanded === n.id && (
            <div className="border-t border-neutral-100 px-4 py-2">
              {(!n.members || n.members.length === 0) ? (
                <div className="py-2 text-xs text-neutral-400">暂无成员</div>
              ) : (
                <div className="divide-y divide-neutral-50">
                  {n.members.map((m) => (
                    <div key={m.userId} className="flex items-center justify-between py-1.5">
                      <span className="text-sm">{m.username}</span>
                      <span className={`text-[10px] rounded-full px-2 py-0.5 font-medium ${m.role === 'owner' ? 'bg-purple-50 text-purple-600' : 'bg-neutral-100 text-neutral-500'}`}>{m.role === 'owner' ? '所有者' : '成员'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function UsersTable({ users, onDelete }: { users: AdminUser[]; onDelete: (id: string) => void }) {
  if (users.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无用户</div>;
  return (
    <Table headers={['用户名', '邮箱', '角色', '创建时间', '']}>
      {users.map((u) => (
        <tr key={u.id} className="hover:bg-neutral-50">
          <td className="px-4 py-2.5 font-medium">{u.username}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{u.email ?? '—'}</td>
          <td className="px-4 py-2.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${u.role === 'admin' ? 'bg-purple-50 text-purple-700' : 'bg-neutral-100 text-neutral-500'}`}>{u.role === 'admin' ? '管理员' : '用户'}</span></td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{new Date(u.createdAt).toLocaleDateString()}</td>
          <td className="px-4 py-2.5"><DeleteButton onClick={() => onDelete(u.id)} disabled={u.username === 'admin' || u.username === 'system'} label="用户" /></td>
        </tr>
      ))}
    </Table>
  );
}

function DevicesTable({ devices }: { devices: AdminDevice[] }) {
  if (devices.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无在线设备</div>;
  return (
    <Table headers={['设备 ID', '状态', 'Agent 数', '网络', '最后心跳']}>
      {devices.map((d) => (
        <tr key={d.id} className="hover:bg-neutral-50">
          <td className="px-4 py-2.5 font-mono text-xs">{d.id.slice(0, 12)}...</td>
          <td className="px-4 py-2.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${d.status === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>{d.status}</span></td>
          <td className="px-4 py-2.5">{d.agentCount}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{d.networkId}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—'}</td>
        </tr>
      ))}
    </Table>
  );
}

function AgentsTable({ agents, onDelete }: { agents: AdminAgent[]; onDelete: (id: string) => void }) {
  if (agents.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无 Agent</div>;
  return (
    <Table headers={['名称', '角色', '适配器', '状态', '可见性', '网络', '']}>
      {agents.map((a) => (
        <tr key={a.id} className="hover:bg-neutral-50">
          <td className="px-4 py-2.5 font-medium">{a.name}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{a.role}</td>
          <td className="px-4 py-2.5 font-mono text-xs text-neutral-500">{a.adapterKind}</td>
          <td className="px-4 py-2.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${a.status === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>{a.status}</span></td>
          <td className="px-4 py-2.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${a.visibility === 'public' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>{a.visibility === 'public' ? '公开' : '私有'}</span></td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{a.networkId ?? 'default'}</td>
          <td className="px-4 py-2.5"><DeleteButton onClick={() => onDelete(a.id)} label="Agent" /></td>
        </tr>
      ))}
    </Table>
  );
}
