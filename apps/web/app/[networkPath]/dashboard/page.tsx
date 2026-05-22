'use client';

import { useEffect, useState } from 'react';
import { Globe, Users, Monitor, Bot, Trash2, RefreshCw, X } from 'lucide-react';
import { ConnectionBanner } from '@/components/connection-banner';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

type Tab = 'networks' | 'users' | 'devices' | 'agents';

interface AdminNetwork { id: string; ownerId: string; name: string; path: string | null; visibility: string; createdAt: number; members: { userId: string; role: string; username: string }[]; }
interface AdminUser { id: string; username: string; email: string | null; role: string; createdAt: number; }
interface AdminDevice {
  id: string;
  name: string;
  hostname?: string | null;
  status: string;
  agentCount: number;
  lastSeenAt: number;
  networkId: string;
  networkName?: string;
  userId: string;
  userName: string;
  runtimes?: { name: string; adapterKind: string; command: string; installed: boolean }[];
  connectCommand?: string | null;
  systemInfo?: {
    platform?: string;
    arch?: string;
    osVersion?: string;
    hostname?: string;
    cpuModel?: string;
    cpuCores?: number;
    totalMemoryGB?: number;
    freeMemoryGB?: number;
    nodeVersion?: string;
    daemonVersion?: string;
  } | null;
}
interface AdminAgent {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  status: string;
  visibility?: string;
  networkId?: string;
  networkName?: string;
  deviceId?: string;
  deviceName?: string;
  deviceUserName?: string | null;
  ownerName?: string | null;
  userName?: string | null;
  category?: string;
  source?: string;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  description?: string | null;
  lastSeenAt?: number;
  lastError?: string;
  publishedNetworkIds?: string[];
}

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: 'networks', label: '团队', icon: <Globe size={14} /> },
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
  const [selectedDevice, setSelectedDevice] = useState<AdminDevice | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AdminAgent | null>(null);
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
      {!loading && tab === 'devices' && <DevicesTable devices={devices} networks={networks} onSelect={setSelectedDevice} />}
      {!loading && tab === 'agents' && <AgentsTable agents={agents} networks={networks} onSelect={setSelectedAgent} onDelete={(id) => handleDelete('agent', id)} />}
      {selectedDevice && <DeviceDetailDialog device={selectedDevice} onClose={() => setSelectedDevice(null)} />}
      {selectedAgent && <AgentDetailDialog agent={selectedAgent} onClose={() => setSelectedAgent(null)} />}
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
            {headers.map((h) => <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-neutral-500">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">{children}</tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label = status === 'online' ? '在线' : status === 'busy' ? '忙碌' : status === 'offline' ? '离线' : status === 'error' ? '异常' : status;
  const color = status === 'online'
    ? 'bg-emerald-50 text-emerald-700'
    : status === 'busy'
      ? 'bg-amber-50 text-amber-700'
      : status === 'error'
        ? 'bg-red-50 text-red-700'
        : 'bg-neutral-100 text-neutral-500';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>;
}

function visibilityLabel(visibility?: string) {
  return visibility === 'public' ? '公开' : '私有';
}

function agentTypeLabel(agent: AdminAgent) {
  if (agent.category === 'agentos-hosted') return 'AgentOS 托管型 Agent';
  if (agent.source === 'custom') return '自定义 Agent';
  return 'Agent';
}

function formatDateTime(value?: number | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function formatDaemonVersion(device: AdminDevice) {
  const version = device.systemInfo?.daemonVersion?.trim();
  if (version && version !== 'unknown') return version.startsWith('v') ? version : `v${version}`;
  return device.status === 'offline' ? '离线' : '版本未知';
}

function DialogShell({ title, icon, onClose, children }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl overflow-hidden rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-5">
          <div className="flex min-w-0 items-center gap-2">
            {icon}
            <h2 className="truncate text-sm font-semibold text-neutral-900">{title}</h2>
          </div>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800" title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function DetailGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function DetailItem({ label, value, mono = false }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className="text-[11px] font-medium text-neutral-500">{label}</div>
      <div className={`mt-1 min-h-5 break-words text-sm text-neutral-900 ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value || '—'}</div>
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
  if (networks.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无团队</div>;
  return (
    <div className="space-y-3">
      {networks.map((n) => (
        <div key={n.id} className="rounded-lg border border-neutral-200 overflow-hidden">
          <div className="flex items-center justify-between bg-neutral-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <Globe size={16} className="text-neutral-400" />
              <div>
                <span className="font-medium text-sm">{n.name}</span>
                {n.path && <span className="ml-2 text-xs text-neutral-400">/{n.path}</span>}
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${n.visibility === 'public' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-200 text-neutral-500'}`}>{n.visibility === 'public' ? '公开' : '私有'}</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setExpanded(expanded === n.id ? null : n.id)} className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1">
                <Users size={12} /> {n.members?.length ?? 0} 成员
              </button>
              <DeleteButton onClick={() => onDelete(n.id)} disabled={n.id === 'default'} label="团队" />
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

function DevicesTable({ devices, networks, onSelect }: { devices: AdminDevice[]; networks: AdminNetwork[]; onSelect: (device: AdminDevice) => void }) {
  if (devices.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无设备</div>;
  return (
    <Table headers={['设备名称', '所属用户', '状态', 'Agent 数', '团队', '最后心跳']}>
      {devices.map((d) => (
        <tr key={d.id} className="hover:bg-neutral-50">
          <td className="px-4 py-2.5 text-sm">
            <button onClick={() => onSelect(d)} className="font-medium text-blue-600 hover:text-blue-700 hover:underline">
              {d.name || d.hostname || '未命名设备'}
            </button>
          </td>
          <td className="px-4 py-2.5 text-xs text-neutral-600">{d.userName ?? '未知用户'}</td>
          <td className="px-4 py-2.5"><StatusPill status={d.status} /></td>
          <td className="px-4 py-2.5">{d.agentCount}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{d.networkName ?? networks.find((n) => n.id === d.networkId)?.name ?? '未知团队'}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{formatDateTime(d.lastSeenAt)}</td>
        </tr>
      ))}
    </Table>
  );
}

function AgentsTable({ agents, networks, onSelect, onDelete }: { agents: AdminAgent[]; networks: AdminNetwork[]; onSelect: (agent: AdminAgent) => void; onDelete: (id: string) => void }) {
  if (agents.length === 0) return <div className="py-6 text-center text-sm text-neutral-400">暂无 Agent</div>;
  return (
    <Table headers={['名称', '所属设备', '所属用户', '适配器', '状态', '可见性', '团队', '']}>
      {agents.map((a) => (
        <tr key={a.id} className="hover:bg-neutral-50">
          <td className="px-4 py-2.5">
            <button onClick={() => onSelect(a)} className="font-medium text-blue-600 hover:text-blue-700 hover:underline">
              {a.name}
            </button>
          </td>
          <td className="px-4 py-2.5 text-xs text-neutral-600">{a.deviceName ?? '未分配设备'}</td>
          <td className="px-4 py-2.5 text-xs text-neutral-600">{a.userName ?? a.ownerName ?? a.deviceUserName ?? '未知用户'}</td>
          <td className="px-4 py-2.5 font-mono text-xs text-neutral-500">{a.adapterKind}</td>
          <td className="px-4 py-2.5"><StatusPill status={a.status} /></td>
          <td className="px-4 py-2.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${a.visibility === 'public' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>{visibilityLabel(a.visibility)}</span></td>
          <td className="px-4 py-2.5 text-xs text-neutral-500">{a.networkName ?? networks.find((n) => n.id === a.networkId)?.name ?? '默认团队'}</td>
          <td className="px-4 py-2.5"><DeleteButton onClick={() => onDelete(a.id)} label="Agent" /></td>
        </tr>
      ))}
    </Table>
  );
}

function DeviceDetailDialog({ device, onClose }: { device: AdminDevice; onClose: () => void }) {
  const runtimes = device.runtimes ?? [];
  return (
    <DialogShell title={device.name || device.hostname || '未命名设备'} icon={<Monitor size={17} className="text-neutral-600" />} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
          <div>
            <div className="text-sm font-semibold text-neutral-900">{device.name || device.hostname || '未命名设备'}</div>
            <div className="mt-0.5 text-xs text-neutral-500">{device.userName ?? '未知用户'} · {device.networkName ?? '未知团队'}</div>
          </div>
          <StatusPill status={device.status} />
        </div>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">基本信息</h3>
          <DetailGrid>
            <DetailItem label="设备名称" value={device.name || device.hostname || '未命名设备'} />
            <DetailItem label="所属用户" value={device.userName ?? '未知用户'} />
            <DetailItem label="所属团队" value={device.networkName ?? '未知团队'} />
            <DetailItem label="最后心跳" value={formatDateTime(device.lastSeenAt)} />
            <DetailItem label="Agent 数量" value={`${device.agentCount}`} />
            <DetailItem label="Daemon 版本" value={formatDaemonVersion(device)} />
          </DetailGrid>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">设备信息</h3>
          <DetailGrid>
            <DetailItem label="操作系统" value={device.systemInfo?.osVersion ?? device.systemInfo?.platform} />
            <DetailItem label="架构" value={device.systemInfo?.arch} />
            <DetailItem label="CPU" value={device.systemInfo?.cpuModel} />
            <DetailItem label="CPU 核心" value={device.systemInfo?.cpuCores ? `${device.systemInfo.cpuCores} 核` : undefined} />
            <DetailItem label="总内存" value={device.systemInfo?.totalMemoryGB ? `${device.systemInfo.totalMemoryGB} GB` : undefined} />
            <DetailItem label="Node.js" value={device.systemInfo?.nodeVersion} />
          </DetailGrid>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">检测到的编程智能体运行时</h3>
          {runtimes.length === 0 ? (
            <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-3 text-sm text-neutral-400">暂无运行时信息</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {runtimes.map((runtime) => (
                <span key={`${runtime.adapterKind}-${runtime.command}`} className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs ${runtime.installed ? 'border-neutral-300 bg-white text-neutral-800' : 'border-neutral-200 bg-neutral-50 text-neutral-400'}`}>
                  {runtime.name || runtime.adapterKind}{runtime.installed ? '' : '（未安装）'}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>
    </DialogShell>
  );
}

function AgentDetailDialog({ agent, onClose }: { agent: AdminAgent; onClose: () => void }) {
  return (
    <DialogShell title={agent.name} icon={<Bot size={17} className="text-neutral-600" />} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
          <div>
            <div className="text-sm font-semibold text-neutral-900">{agent.name}</div>
            <div className="mt-0.5 text-xs text-neutral-500">{agentTypeLabel(agent)} · {agent.userName ?? agent.ownerName ?? agent.deviceUserName ?? '未知用户'}</div>
          </div>
          <StatusPill status={agent.status} />
        </div>

        {agent.description && (
          <section>
            <h3 className="mb-2 text-xs font-semibold text-neutral-500">功能介绍</h3>
            <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-3 text-sm leading-6 text-neutral-700">{agent.description}</div>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">基本信息</h3>
          <DetailGrid>
            <DetailItem label="名称" value={agent.name} />
            <DetailItem label="类型" value={agentTypeLabel(agent)} />
            <DetailItem label="所属设备" value={agent.deviceName ?? '未分配设备'} />
            <DetailItem label="所属用户" value={agent.userName ?? agent.ownerName ?? agent.deviceUserName ?? '未知用户'} />
            <DetailItem label="所属团队" value={agent.networkName ?? '默认团队'} />
            <DetailItem label="可见性" value={visibilityLabel(agent.visibility)} />
            <DetailItem label="最后在线" value={formatDateTime(agent.lastSeenAt)} />
            <DetailItem label="发布团队数" value={`${agent.publishedNetworkIds?.length ?? 0}`} />
          </DetailGrid>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">运行配置</h3>
          <DetailGrid>
            <DetailItem label="适配器" value={agent.adapterKind} />
            <DetailItem label="目录" value={agent.cwd} mono />
            <DetailItem label="命令" value={agent.command} mono />
            <DetailItem label="参数" value={agent.args?.length ? agent.args.join(' ') : undefined} mono />
          </DetailGrid>
        </section>

        {agent.lastError && (
          <section>
            <h3 className="mb-2 text-xs font-semibold text-red-500">最近错误</h3>
            <div className="rounded-md border border-red-100 bg-red-50 px-3 py-3 text-sm leading-6 text-red-700">{agent.lastError}</div>
          </section>
        )}
      </div>
    </DialogShell>
  );
}
