'use client';

import { useEffect, useMemo, useState } from 'react';
import { Monitor, Circle, Plus, Pencil, Copy, Zap, Globe, Terminal, Server, RefreshCw, X, Check } from 'lucide-react';
import { authEvents, deviceEvents, agentEvents, getResolvedServerUrl } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

const STATUS_COLORS: Record<string, string> = {
  online: 'text-emerald-500',
  busy: 'text-amber-500',
  offline: 'text-neutral-300',
  error: 'text-red-500',
  connecting: 'text-blue-500',
};

const STATUS_BG: Record<string, string> = {
  online: 'bg-emerald-50 text-emerald-700',
  busy: 'bg-amber-50 text-amber-700',
  offline: 'bg-neutral-100 text-neutral-500',
  error: 'bg-red-50 text-red-700',
  connecting: 'bg-blue-50 text-blue-700',
};

export default function DevicesPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editName, setEditName] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (conn !== 'open') return;
    deviceEvents().subscribe();
    const unsub = deviceEvents().onSnapshot((list) => applyDevicesSnapshot(list));
    return () => { unsub(); };
  }, [conn, applyDevicesSnapshot]);

  const deviceList = useMemo(() => Object.values(devices), [devices]);
  const selectedDevice = deviceList.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="-m-6 flex h-[calc(100vh-40px)]">
      {/* Left — device list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
        <div className="border-b border-neutral-200 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">设备</span>
              <span className="text-xs text-neutral-400">{deviceList.length}</span>
            </div>
            <button onClick={() => setShowAddDialog(true)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700 transition-colors" title="添加设备">
              <Plus size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {deviceList.map((device) => (
            <button key={device.id} onClick={() => { setSelectedId(device.id); setEditName(false); setShowDeleteConfirm(false); }} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${selectedId === device.id ? 'bg-white shadow-sm ring-1 ring-neutral-200' : 'hover:bg-white/60'}`}>
              <div className="relative shrink-0">
                <Monitor size={16} className="text-neutral-500" />
                <Circle size={6} className={`absolute -right-0.5 -top-0.5 fill-current ${STATUS_COLORS[device.status] ?? 'text-neutral-300'}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight">{device.hostname ?? device.id}</div>
                <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span>daemon</span>
                  <span className={device.status === 'online' ? 'text-neutral-600' : ''}>{device.status === 'online' ? 'v0.44.2' : '离线'}</span>
                </div>
              </div>
            </button>
          ))}
          {deviceList.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-neutral-400">暂无设备</div>
          )}
        </div>
      </div>

      {/* Right — detail / empty state */}
      <div className="flex-1 overflow-y-auto">
        {!selectedDevice && <EmptyState />}
        {selectedDevice && (
          <DeviceDetail
            device={selectedDevice}
            editName={editName}
            setEditName={setEditName}
            deviceName={deviceName}
            setDeviceName={setDeviceName}
            showDeleteConfirm={showDeleteConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            currentNetworkId={currentNetworkId}
          />
        )}
      </div>

      {/* Add Device Dialog */}
      {showAddDialog && <AddDeviceDialog onClose={() => setShowAddDialog(false)} currentNetworkId={currentNetworkId} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-neutral-400">
      <Monitor size={48} strokeWidth={1} />
      <div className="mt-3 text-sm">选择左侧设备查看详情</div>
    </div>
  );
}

function DeviceDetail({ device, editName, setEditName, deviceName, setDeviceName, showDeleteConfirm, setShowDeleteConfirm, currentNetworkId }: {
  device: { id: string; hostname?: string; status: string; tailscaleIp?: string; lastSeenAt: number; agentIds: string[] };
  editName: boolean;
  setEditName: (v: boolean) => void;
  deviceName: string;
  setDeviceName: (v: string) => void;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  currentNetworkId: string | null;
}) {
  const [inviteCommand, setInviteCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [genError, setGenError] = useState('');
  const [deviceAgents, setDeviceAgents] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [selectNetworkAgent, setSelectNetworkAgent] = useState<any | null>(null);
  const displayName = device.hostname ?? device.id;

  useEffect(() => {
    if (!device) return;
    deviceEvents().agentsList(device.id).then((res) => {
      if (res.ok && res.agents) setDeviceAgents(res.agents);
    });
  }, [device?.id]);

  const handleScan = async () => {
    setScanning(true);
    await deviceEvents().scan(device.id);
    setTimeout(() => {
      deviceEvents().agentsList(device.id).then((res) => {
        if (res.ok && res.agents) setDeviceAgents(res.agents);
        setScanning(false);
      });
    }, 2000);
  };

  const executorAgents = deviceAgents.filter((a) => a.category === 'executor-hosted');
  const agentosAgents = deviceAgents.filter((a) => a.category === 'agentos-hosted');
  const customAgents = deviceAgents.filter((a) => a.source === 'custom');
  const standaloneAgents = deviceAgents.filter((a) => a.category === 'standalone-cli');

  const handleEditName = () => {
    setDeviceName(displayName);
    setEditName(true);
  };

  const saveName = () => {
    setEditName(false);
  };

  const generateConnect = async () => {
    setGenError('');
    setInviteCommand('');
    const res = await authEvents().inviteCreate({ networkId: currentNetworkId ?? undefined, purpose: 'device' });
    if (res.ok && res.invite?.command) {
      const resolved = getResolvedServerUrl();
      const command = res.invite.command.replace(/--server-url\s+\S+/, `--server-url ${resolved}`);
      setInviteCommand(command);
    } else {
      setGenError(res.error ?? '生成失败');
    }
  };

  const copy = () => {
    navigator.clipboard.writeText(inviteCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-neutral-100">
            <Monitor size={24} className="text-neutral-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">{displayName}</h1>
            <div className="mt-1 flex items-center gap-3">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BG[device.status] ?? 'bg-neutral-100 text-neutral-500'}`}>
                <Circle size={5} className="fill-current" />
                {device.status === 'online' ? '在线' : device.status === 'busy' ? '忙碌' : device.status === 'offline' ? '离线' : device.status}
              </span>
              {device.tailscaleIp && <span className="text-xs text-neutral-400">{device.tailscaleIp}</span>}
            </div>
          </div>
        </div>

        {/* NAME */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">名称</h3>
            {!editName && (
              <button onClick={handleEditName} className="text-xs text-neutral-400 hover:text-neutral-700 flex items-center gap-1">
                <Pencil size={10} /> 编辑
              </button>
            )}
          </div>
          {editName ? (
            <div className="flex items-center gap-2">
              <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditName(false); }} />
              <button onClick={saveName} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-800">保存</button>
              <button onClick={() => setEditName(false)} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50">取消</button>
            </div>
          ) : (
            <p className="text-sm">{displayName}</p>
          )}
        </section>

        {/* INFO */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">信息</h3>
          <div className="space-y-2">
            <InfoRow label="设备 ID" value={device.id} />
            <InfoRow label="最后在线" value={new Date(device.lastSeenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} />
            <InfoRow label="Agent 数量" value={`${deviceAgents.length}`} />
          </div>
        </section>

        {/* CONNECTION */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">连接</h3>
          <button onClick={generateConnect} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">
            生成连接命令
          </button>
          {inviteCommand && (
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-neutral-900 px-3 py-2 text-xs text-emerald-400">{inviteCommand}</code>
              <button onClick={copy} className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 flex items-center gap-1">
                <Copy size={10} /> {copied ? '已复制' : '复制'}
              </button>
            </div>
          )}
          {genError && <p className="mt-2 text-sm text-red-600">{genError}</p>}
        </section>

        {/* AGENT GROUPS */}
        <AgentGroup
          title="运行时 (executor-hosted)"
          subtitle="Coding Agent CLIs"
          icon={<Zap size={14} className="text-amber-600" />}
          iconBg="bg-amber-50"
          agents={executorAgents}
          scanning={scanning}
          onScan={handleScan}
          onSelectNetwork={setSelectNetworkAgent}
        />
        <AgentGroup
          title="AgentOS (agentos-hosted)"
          subtitle="Gateway-managed agents"
          icon={<Globe size={14} className="text-blue-600" />}
          iconBg="bg-blue-50"
          agents={agentosAgents}
          scanning={scanning}
          onScan={handleScan}
          onSelectNetwork={setSelectNetworkAgent}
        />
        <AgentGroup
          title="自定义 Agent"
          subtitle="User-created agents"
          icon={<Terminal size={14} className="text-violet-600" />}
          iconBg="bg-violet-50"
          agents={customAgents}
          showAddButton
          onAdd={() => setShowAddCustom(true)}
          onSelectNetwork={setSelectNetworkAgent}
        />
        <AgentGroup
          title="独立 Agent (standalone-cli)"
          subtitle="Standalone agent apps"
          icon={<Server size={14} className="text-teal-600" />}
          iconBg="bg-teal-50"
          agents={standaloneAgents}
          scanning={scanning}
          onScan={handleScan}
          onSelectNetwork={setSelectNetworkAgent}
        />

        {/* ACTIONS */}
        <section className="rounded-lg border border-red-200 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-500">操作</h3>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-red-700">删除设备</div>
              <div className="text-xs text-red-400">永久删除此设备。需先删除所有 Agent。</div>
            </div>
            <button onClick={() => setShowDeleteConfirm(true)} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50">
              删除设备
            </button>
          </div>
          {showDeleteConfirm && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4">
              <p className="mb-3 text-sm text-red-700">确定要删除设备 <strong>{displayName}</strong> 吗？此操作不可撤销。</p>
              <div className="flex gap-2">
                <button onClick={() => setShowDeleteConfirm(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50">取消</button>
                <button onClick={() => setShowDeleteConfirm(false)} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700">确认删除</button>
              </div>
            </div>
          )}
        </section>
      </div>

      {selectNetworkAgent && (
        <SelectNetworkDialog
          agent={selectNetworkAgent}
          onClose={() => setSelectNetworkAgent(null)}
        />
      )}
      {showAddCustom && (
        <AddCustomAgentDialog
          onClose={() => setShowAddCustom(false)}
          onCreated={() => {
            setShowAddCustom(false);
            deviceEvents().agentsList(device.id).then((res) => {
              if (res.ok && res.agents) setDeviceAgents(res.agents);
            });
          }}
        />
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 py-2 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-800 truncate max-w-[60%]">{value}</span>
    </div>
  );
}

function AddDeviceDialog({ onClose, currentNetworkId }: { onClose: () => void; currentNetworkId: string | null }) {
  const [inviteCommand, setInviteCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generateCommand = async () => {
    setLoading(true);
    setError('');
    const res = await authEvents().inviteCreate({ networkId: currentNetworkId ?? undefined, purpose: 'device' });
    setLoading(false);
    if (res.ok && res.invite?.command) {
      const resolved = getResolvedServerUrl();
      const command = res.invite.command.replace(/--server-url\s+\S+/, `--server-url ${resolved}`);
      setInviteCommand(command);
    } else {
      setError(res.error ?? '生成失败');
    }
  };

  const copy = () => {
    navigator.clipboard.writeText(inviteCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">添加设备</h2>
        <p className="mt-2 text-sm text-neutral-500">在新设备上运行以下命令，将其连接到当前网络。</p>

        {!inviteCommand && (
          <button onClick={generateCommand} disabled={loading} className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
            {loading ? '生成中...' : '生成连接命令'}
          </button>
        )}

        {inviteCommand && (
          <div className="mt-4 space-y-2">
            <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-neutral-900 px-3 py-3 text-xs text-emerald-400">{inviteCommand}</code>
            <button onClick={copy} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-neutral-300 py-2 text-sm hover:bg-neutral-50">
              <Copy size={14} /> {copied ? '已复制到剪贴板' : '复制命令'}
            </button>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">关闭</button>
        </div>
      </div>
    </div>
  );
}

function AgentGroup({ title, subtitle, icon, iconBg, agents, scanning, onScan, showAddButton, onAdd, onSelectNetwork }: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  iconBg: string;
  agents: any[];
  scanning?: boolean;
  onScan?: () => void;
  showAddButton?: boolean;
  onAdd?: () => void;
  onSelectNetwork: (agent: any) => void;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</h3>
          <p className="text-[11px] text-neutral-400">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {showAddButton && onAdd && (
            <button onClick={onAdd} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50">
              <Plus size={12} /> 添加
            </button>
          )}
          {onScan && (
            <button onClick={onScan} disabled={scanning} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
              <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> 扫描
            </button>
          )}
        </div>
      </div>
      {agents.length === 0 ? (
        <div className="py-4 text-center text-xs text-neutral-400">暂无 Agent</div>
      ) : (
        <div className="space-y-1.5">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} icon={icon} iconBg={iconBg} onSelectNetwork={onSelectNetwork} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgentRow({ agent, icon, iconBg, onSelectNetwork }: {
  agent: any;
  icon: React.ReactNode;
  iconBg: string;
  onSelectNetwork: (agent: any) => void;
}) {
  const publishedCount = agent.publishedNetworkIds?.length ?? 0;
  return (
    <div className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-xs text-neutral-400">{agent.adapterKind}</div>
      </div>
      {publishedCount > 0 && (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          已发布到 {publishedCount} 个网络
        </span>
      )}
      <Circle size={6} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : 'text-neutral-300'}`} />
      <button onClick={() => onSelectNetwork(agent)} className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50">
        选择网络
      </button>
    </div>
  );
}

function SelectNetworkDialog({ agent, onClose }: { agent: any; onClose: () => void }) {
  const networks = useAgentBeanStore((s) => s.networks);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const [publishedIds, setPublishedIds] = useState<Set<string>>(new Set(agent.publishedNetworkIds ?? []));
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const isExecutor = agent.category === 'executor-hosted';
  const visibleNetworks = isExecutor
    ? networks.filter((n) => n.visibility === 'private' || n.ownerId === currentUser?.id)
    : networks;

  const toggle = async (networkId: string) => {
    setLoadingId(networkId);
    const isPublished = publishedIds.has(networkId);
    if (isPublished) {
      const res = await agentEvents().unpublish(agent.id, networkId);
      if (res.ok) {
        setPublishedIds((prev) => { const next = new Set(prev); next.delete(networkId); return next; });
      }
    } else {
      const res = await agentEvents().publish(agent.id, networkId);
      if (res.ok) {
        setPublishedIds((prev) => new Set(prev).add(networkId));
      }
    }
    setLoadingId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">选择网络 — {agent.name}</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        {isExecutor && (
          <p className="mt-2 text-xs text-neutral-500">运行时 Agent 仅可发布到私有网络或您拥有的网络。</p>
        )}
        <div className="mt-4 max-h-64 space-y-1 overflow-y-auto">
          {visibleNetworks.map((net) => {
            const checked = publishedIds.has(net.id);
            return (
              <label key={net.id} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-neutral-50">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={loadingId === net.id}
                  onChange={() => toggle(net.id)}
                  className="h-4 w-4 rounded border-neutral-300"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{net.name}</div>
                  <div className="text-[11px] text-neutral-400">{net.visibility === 'private' ? '私有' : '公开'}</div>
                </div>
                {checked && <Check size={14} className="text-emerald-600" />}
              </label>
            );
          })}
          {visibleNetworks.length === 0 && (
            <div className="py-4 text-center text-xs text-neutral-400">暂无可选网络</div>
          )}
        </div>
        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800">完成</button>
        </div>
      </div>
    </div>
  );
}

function AddCustomAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [adapterKind, setAdapterKind] = useState('claude-code');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const categoryMap: Record<string, string> = {
    codex: 'executor-hosted',
    'claude-code': 'executor-hosted',
    hermes: 'agentos-hosted',
    openclaw: 'agentos-hosted',
    standalone: 'standalone-cli',
  };

  const handleSubmit = async () => {
    if (!name.trim() || !command.trim()) {
      setError('名称和命令为必填项');
      return;
    }
    setLoading(true);
    setError('');
    const payload = {
      name: name.trim(),
      adapterKind,
      command: command.trim(),
      args: args.trim() ? args.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      category: categoryMap[adapterKind] ?? 'executor-hosted',
    };
    const res = await agentEvents().create(payload);
    setLoading(false);
    if (res.ok) {
      onCreated();
    } else {
      setError(res.error ?? '创建失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">添加自定义 Agent</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">名称 <span className="text-red-500">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="My Agent" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">适配器</label>
            <select value={adapterKind} onChange={(e) => setAdapterKind(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400">
              <option value="codex">codex</option>
              <option value="claude-code">claude-code</option>
              <option value="hermes">hermes</option>
              <option value="openclaw">openclaw</option>
              <option value="standalone">standalone</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">命令 <span className="text-red-500">*</span></label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="npx codex" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">参数 (逗号分隔)</label>
            <input value={args} onChange={(e) => setArgs(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="--verbose, --port, 3000" />
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">取消</button>
          <button onClick={handleSubmit} disabled={loading} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
            {loading ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
