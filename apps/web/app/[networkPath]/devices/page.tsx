'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Monitor, Circle, Plus, Pencil, Copy, Zap, Globe, Terminal, RefreshCw, X, Check, FolderOpen } from 'lucide-react';
import { authEvents, deviceEvents, agentEvents, getResolvedServerUrl } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';

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
  const params = useParams();
  const router = useRouter();
  const np = useCurrentNetworkPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  const routeDeviceId = typeof params.id === 'string' ? params.id : null;

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

  useEffect(() => {
    if (routeDeviceId) {
      setSelectedId(routeDeviceId);
      setEditName(false);
      setShowDeleteConfirm(false);
    }
  }, [routeDeviceId]);

  const selectedDevice = deviceList.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left — device list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
        <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
            <div className="flex items-center gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">设备</span>
              <span className="text-xs text-neutral-400">{deviceList.length}</span>
            </div>
            <button onClick={() => setShowAddDialog(true)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-neutral-200 text-neutral-500 hover:text-neutral-700 transition-colors" title="添加设备">
              <Plus size={16} />
            </button>
          </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {deviceList.map((device) => (
            <button key={device.id} onClick={() => { setSelectedId(device.id); setEditName(false); setShowDeleteConfirm(false); router.push(`/${np}/computer/${device.id}`); }} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${selectedId === device.id ? 'bg-white shadow-sm ring-1 ring-neutral-200' : 'hover:bg-white/60'}`}>
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
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">{selectedDevice ? (selectedDevice.hostname ?? selectedDevice.id) : '设备详情'}</div>
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
  device: { id: string; hostname?: string; status: string; lastSeenAt: number; agentIds: string[]; runtimes?: any[]; connectCommand?: string | null; systemInfo?: { platform?: string; arch?: string; osVersion?: string; hostname?: string; cpuModel?: string; cpuCores?: number; totalMemoryGB?: number; freeMemoryGB?: number; nodeVersion?: string } | null };
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
  const [deviceRuntimes, setDeviceRuntimes] = useState<any[]>(device.runtimes ?? []);
  const [scanning, setScanning] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [selectNetworkAgent, setSelectNetworkAgent] = useState<any | null>(null);
  const displayName = device.hostname ?? device.id;

  useEffect(() => {
    if (!device) return;
    deviceEvents().agentsList(device.id).then((res) => {
      if (res.ok && res.agents) setDeviceAgents(res.agents);
      if (res.ok && res.runtimes) setDeviceRuntimes(res.runtimes);
    });
  }, [device?.id]);

  const handleScan = async () => {
    setScanning(true);
    await deviceEvents().scan(device.id);
    setTimeout(() => {
      deviceEvents().agentsList(device.id).then((res) => {
        if (res.ok && res.agents) setDeviceAgents(res.agents);
        if (res.ok && res.runtimes) setDeviceRuntimes(res.runtimes);
        setScanning(false);
      });
    }, 2000);
  };

  const agentosAgents = deviceAgents.filter((a) => a.category === 'agentos-hosted');
  const customAgents = deviceAgents.filter((a) => a.source === 'custom');
  // Scanned executor-hosted runtimes not already in deviceRuntimes
  const scannedRuntimes = deviceAgents.filter((a) => a.source === 'scanned' && a.category === 'executor-hosted');
  const runtimeList = [...deviceRuntimes, ...scannedRuntimes.filter((sr) => !deviceRuntimes.some((r) => r.name === sr.name || r.command === sr.command))];

  const handleEditName = () => {
    setDeviceName(displayName);
    setEditName(true);
  };

  const saveName = async () => {
    if (!deviceName.trim() || deviceName.trim() === displayName) { setEditName(false); return; }
    await deviceEvents().rename(device.id, deviceName.trim());
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
            <InfoRow label="运行时数量" value={`${deviceRuntimes.length}`} />
            <InfoRow label="Agent 数量" value={`${deviceAgents.length}`} />
          </div>
        </section>

        {/* HARDWARE */}
        {device.systemInfo && (
          <section className="rounded-lg border border-neutral-200 p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">硬件信息</h3>
            <div className="grid grid-cols-2 gap-2">
              {device.systemInfo.osVersion && <InfoCard label="操作系统" value={device.systemInfo.osVersion} />}
              {device.systemInfo.arch && <InfoCard label="架构" value={device.systemInfo.arch} />}
              {device.systemInfo.cpuModel && <InfoCard label="CPU" value={device.systemInfo.cpuModel} />}
              {device.systemInfo.cpuCores && <InfoCard label="CPU 核心" value={`${device.systemInfo.cpuCores} 核`} />}
              {device.systemInfo.totalMemoryGB && <InfoCard label="总内存" value={`${device.systemInfo.totalMemoryGB} GB`} />}
              {device.systemInfo.freeMemoryGB && <InfoCard label="可用内存" value={`${device.systemInfo.freeMemoryGB} GB`} />}
              {device.systemInfo.nodeVersion && <InfoCard label="Node.js" value={device.systemInfo.nodeVersion} />}
              {device.systemInfo.hostname && <InfoCard label="主机名" value={device.systemInfo.hostname} />}
            </div>
          </section>
        )}

        {/* CONNECTION */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">连接命令</h3>
          {device.connectCommand ? (
            <div className="space-y-2">
              <p className="text-xs text-neutral-500">使用以下命令重新启动此设备上的 Daemon：</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-neutral-900 px-3 py-2 text-xs text-emerald-400">{device.connectCommand}</code>
                <button onClick={() => { navigator.clipboard.writeText(device.connectCommand ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 flex items-center gap-1">
                  <Copy size={10} /> {copied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          ) : (
            <div>
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
            </div>
          )}
        </section>

        {/* AGENT GROUPS */}
        <RuntimeGroup
          runtimes={runtimeList}
          scanning={scanning}
          onScan={handleScan}
        />
        <AgentGroup
          title="AgentOS 托管型 Agent"
          subtitle="由 OpenClaw、Hermes 等 AgentOS 网关托管"
          icon={<Globe size={14} className="text-blue-600" />}
          iconBg="bg-blue-50"
          agents={agentosAgents}
          scanning={scanning}
          onScan={handleScan}
          onSelectNetwork={setSelectNetworkAgent}
        />
        <AgentGroup
          title="自定义 Agent"
          subtitle="使用 Claude Code、Codex CLI、Kimi CLI 等运行时创建"
          icon={<Terminal size={14} className="text-violet-600" />}
          iconBg="bg-violet-50"
          agents={customAgents}
          showAddButton
          onAdd={() => setShowAddCustom(true)}
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
                <button onClick={async () => { await deviceEvents().delete(device.id); setShowDeleteConfirm(false); }} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700">确认删除</button>
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

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-neutral-800 truncate">{value}</div>
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

function RuntimeGroup({ runtimes, scanning, onScan }: {
  runtimes: any[];
  scanning?: boolean;
  onScan?: () => void;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Coding Agent 运行时</h3>
          <p className="text-[11px] text-neutral-400">仅作为创建自定义 Agent 的运行环境，不作为 Agent 成员出现</p>
        </div>
        {onScan && (
          <button onClick={onScan} disabled={scanning} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
            <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> 扫描
          </button>
        )}
      </div>
      {runtimes.length === 0 ? (
        <div className="py-4 text-center text-xs text-neutral-400">暂无可用运行时</div>
      ) : (
        <div className="space-y-1.5">
          {runtimes.map((runtime) => (
            <div key={`${runtime.adapterKind}-${runtime.command}`} className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                <Zap size={14} className="text-amber-600" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{runtime.name}</div>
                <div className="truncate text-xs text-neutral-400">{runtime.command || runtime.adapterKind}</div>
              </div>
              <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">Runtime</span>
              <Circle size={6} className={`shrink-0 fill-current ${runtime.installed ? 'text-emerald-500' : 'text-neutral-300'}`} />
            </div>
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

  const isCustom = agent.source === 'custom' || agent.category === 'executor-hosted';
  const visibleNetworks = isCustom
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
        {isCustom && (
          <p className="mt-2 text-xs text-neutral-500">自定义 Agent 使用本机 Coding Agent 运行时，仅可发布到私有网络或您拥有的网络。</p>
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

const RUNTIME_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code', description: 'Anthropic 官方 CLI，擅长代码生成、调试和重构' },
  { value: 'codex', label: 'Codex CLI', description: 'OpenAI Codex CLI，适合快速代码生成和脚本编写' },
];

function AddCustomAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [adapterKind, setAdapterKind] = useState('claude-code');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const selectedRuntime = RUNTIME_OPTIONS.find((r) => r.value === adapterKind);

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
      category: 'executor-hosted',
      cwd: cwd.trim() || undefined,
      description: description.trim() || undefined,
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
      <div className="mx-4 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
            <label className="mb-1 block text-xs font-medium text-neutral-600">Coding Agent 运行时 <span className="text-red-500">*</span></label>
            <select value={adapterKind} onChange={(e) => setAdapterKind(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400">
              {RUNTIME_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {selectedRuntime && (
              <p className="mt-1 text-[11px] text-neutral-400">{selectedRuntime.description}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">项目目录</label>
            <div className="flex gap-2">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="/path/to/project（可选）" />
              <label className="shrink-0 flex items-center gap-1 cursor-pointer rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                <FolderOpen size={12} /> 浏览
                <input
                  type="file"
                  // @ts-expect-error webkitdirectory is non-standard
                  webkitdirectory=""
                  directory=""
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const relativePath = (file as any).webkitRelativePath as string | undefined;
                      if (relativePath) {
                        const dirName = relativePath.split('/')[0];
                        setCwd((prev) => prev || `~/projects/${dirName}`);
                      }
                    }
                  }}
                />
              </label>
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">Agent 启动时的工作目录，留空则使用默认路径</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">命令 <span className="text-red-500">*</span></label>
            <input value={command} onChange={(e) => setCommand(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="claude" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">参数 (逗号分隔)</label>
            <input value={args} onChange={(e) => setArgs(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="--verbose, --port, 3000" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">功能介绍</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 resize-none" placeholder="描述这个 Agent 的用途和能力（可选）" />
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
