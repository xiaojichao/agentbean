'use client';

import { useEffect, useMemo, useState } from 'react';
import { Monitor, Circle, Plus, Pencil, Copy, Zap } from 'lucide-react';
import { authEvents, deviceEvents, getResolvedServerUrl, getWebSocket } from '@/lib/socket';
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
  const agents = useAgentBeanStore((s) => s.agents);
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
  const agentList = useMemo(() => Object.values(agents), [agents]);
  const selectedDevice = deviceList.find((d) => d.id === selectedId) ?? null;
  const deviceAgents = selectedDevice ? agentList.filter((a) => a.deviceId === selectedDevice.id) : [];

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
            agents={deviceAgents}
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

function DeviceDetail({ device, agents, editName, setEditName, deviceName, setDeviceName, showDeleteConfirm, setShowDeleteConfirm, currentNetworkId }: {
  device: { id: string; hostname?: string; status: string; tailscaleIp?: string; lastSeenAt: number; agentIds: string[] };
  agents: { id: string; name: string; role: string; adapterKind: string; status: string; category?: string; visibility?: 'public' | 'private' }[];
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
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const updateAgent = useAgentBeanStore((s) => s.updateAgent);

  const displayName = device.hostname ?? device.id;

  const handleEditName = () => {
    setDeviceName(displayName);
    setEditName(true);
  };

  const saveName = () => {
    setEditName(false);
    // TODO: persist name change
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

  const toggleVisibility = (agentId: string, current: 'public' | 'private' | undefined) => {
    if (togglingId) return;
    const next = current === 'public' ? 'private' : 'public';
    setTogglingId(agentId);
    getWebSocket().emit('agent:update', { id: agentId, visibility: next }, (res: { ok: boolean }) => {
      setTogglingId(null);
      if (res.ok) updateAgent(agentId, { visibility: next });
    });
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
            <InfoRow label="Agent 数量" value={`${agents.length}`} />
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

        {/* AGENTS ON THIS DEVICE */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">此设备上的 Agent ({agents.length})</h3>
          </div>
          {agents.length === 0 ? (
            <div className="text-sm text-neutral-400">此设备暂无 Agent</div>
          ) : (
            <div className="space-y-1.5">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                    <Zap size={14} className="text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{agent.name}</div>
                    <div className="text-xs text-neutral-400">{agent.adapterKind}</div>
                  </div>
                  <button
                    onClick={() => toggleVisibility(agent.id, agent.visibility)}
                    disabled={togglingId === agent.id}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      agent.visibility === 'public' ? 'bg-emerald-500' : 'bg-neutral-300'
                    } ${togglingId === agent.id ? 'opacity-50' : ''}`}
                    title={agent.visibility === 'public' ? '公开 — 点击设为私有' : '私有 — 点击设为公开'}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      agent.visibility === 'public' ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </button>
                  <span className={`shrink-0 text-[10px] font-medium ${agent.visibility === 'public' ? 'text-emerald-600' : 'text-neutral-400'}`}>
                    {agent.visibility === 'public' ? '公开' : '私有'}
                  </span>
                  <Circle size={6} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : 'text-neutral-300'}`} />
                </div>
              ))}
            </div>
          )}
        </section>

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
