'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Monitor, Circle, Plus, Pencil, Copy, Globe, Terminal, RefreshCw, X, Check, FolderOpen } from 'lucide-react';
import { authEvents, deviceEvents, agentEvents, getResolvedServerUrl } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { daemonVersionDisplay } from '@/lib/daemon-version';

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

function formatDaemonVersion(device: Parameters<typeof daemonVersionDisplay>[0]) {
  return daemonVersionDisplay(device).currentLabel;
}

function deviceDisplayName(device: { id: string; hostname?: string | null; systemInfo?: { hostname?: string } | null }): string {
  return (device.hostname ?? device.systemInfo?.hostname ?? '').trim() || device.id;
}

function compareDevices(a: { id: string; hostname?: string | null; networkId?: string; systemInfo?: { hostname?: string } | null }, b: { id: string; hostname?: string | null; networkId?: string; systemInfo?: { hostname?: string } | null }): number {
  return deviceDisplayName(a).localeCompare(deviceDisplayName(b), 'zh-CN', { sensitivity: 'base', numeric: true }) ||
    (a.networkId ?? '').localeCompare(b.networkId ?? '', 'zh-CN', { sensitivity: 'base', numeric: true }) ||
    a.id.localeCompare(b.id);
}

const DIRECTORY_PICKER_MIN_DAEMON_VERSION = '0.1.27';

function parseVersionParts(version?: string | null): number[] | null {
  const match = version?.match(/\d+(?:\.\d+)*/);
  if (!match) return null;
  return match[0].split('.').map((part) => Number(part) || 0);
}

function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const current = parseVersionParts(version);
  const required = parseVersionParts(minimum);
  if (!current || !required) return true;
  const len = Math.max(current.length, required.length);
  for (let i = 0; i < len; i += 1) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function directoryFallbackPath(name: string): string {
  return `~/projects/${name}`;
}

function directoryPickerErrorMessage(error?: string): string {
  if (error === 'CANCELLED') return '';
  if (error === 'DEVICE_OFFLINE') return '目标设备不在线，无法在该设备上选择项目目录';
  if (error === 'DAEMON_UPGRADE_REQUIRED') return '该设备的 Daemon 版本过旧，请升级后再使用目录浏览';
  if (error === 'DIRECTORY_PICKER_TIMEOUT') return '目录选择超时，请确认目标设备上已打开选择窗口';
  if (error === 'DEVICE_NOT_IN_TEAM') return '该设备不属于当前团队';
  return error || '无法打开目录浏览窗口';
}

function DirectoryBrowseButton({
  onSelect,
  onError,
  deviceId,
  daemonVersion,
  disabled = false,
}: {
  onSelect: (path: string) => void;
  onError?: (message: string) => void;
  deviceId?: string;
  daemonVersion?: string | null;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const browse = async () => {
    if (browsing) return;
    onError?.('');
    if (daemonVersion && !versionAtLeast(daemonVersion, DIRECTORY_PICKER_MIN_DAEMON_VERSION)) {
      onError?.(`该设备的 Daemon 是 v${daemonVersion.replace(/^v/, '')}，目录浏览需要 v${DIRECTORY_PICKER_MIN_DAEMON_VERSION} 或更高版本。请用连接命令重启/升级 Daemon。`);
      return;
    }
    setBrowsing(true);
    if (deviceId) {
      try {
        const res = await deviceEvents().selectDirectory(deviceId);
        if (res.ok && res.path) {
          onSelect(res.path);
          return;
        }
        const message = directoryPickerErrorMessage(res.error);
        if (message) onError?.(message);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : '无法打开目录浏览窗口');
      } finally {
        setBrowsing(false);
      }
      return;
    }

    const picker = (window as any).showDirectoryPicker as undefined | (() => Promise<{ name?: string }>);
    if (picker) {
      try {
        const handle = await picker();
        if (handle?.name) onSelect(directoryFallbackPath(handle.name));
        return;
      } catch (error: any) {
        if (error?.name === 'AbortError') return;
      } finally {
        setBrowsing(false);
      }
    }
    inputRef.current?.click();
    setBrowsing(false);
  };

  return (
    <>
      <button type="button" disabled={disabled || browsing} onClick={browse} className="shrink-0 flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50">
        <FolderOpen size={12} /> {browsing ? '等待选择...' : '浏览'}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is non-standard
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            const relativePath = (file as any).webkitRelativePath as string | undefined;
            const dirName = relativePath?.split('/')[0] || file.name;
            if (dirName) onSelect(directoryFallbackPath(dirName));
          }
          e.currentTarget.value = '';
          setBrowsing(false);
        }}
      />
    </>
  );
}

export default function DevicesPage() {
  const params = useParams();
  const router = useRouter();
  const np = useCurrentNetworkPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyDeviceStatus = useAgentBeanStore((s) => s.applyDeviceStatus);
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
    const unsubStatus = deviceEvents().onStatus((device) => applyDeviceStatus(device));
    return () => { unsub(); unsubStatus(); };
  }, [conn, applyDevicesSnapshot, applyDeviceStatus]);

  const deviceList = useMemo(() => Object.values(devices).sort(compareDevices), [devices]);

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
            <button key={device.id} onClick={() => { setSelectedId(device.id); setEditName(false); setShowDeleteConfirm(false); router.push(`/${np}/devices/${device.id}`); }} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${selectedId === device.id ? 'bg-white shadow-sm ring-1 ring-neutral-200' : 'hover:bg-white/60'}`}>
              <div className="relative shrink-0">
                <Monitor size={16} className="text-neutral-500" />
                <Circle size={6} className={`absolute -right-0.5 -top-0.5 fill-current ${STATUS_COLORS[device.status] ?? 'text-neutral-300'}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight">{device.hostname ?? '未命名设备'}</div>
                <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span>daemon</span>
                  <span className={device.status === 'online' ? 'text-neutral-600' : ''}>{formatDaemonVersion(device)}</span>
                  {device.daemonUpdateAvailable && (
                    <span className="rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700">可升级</span>
                  )}
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
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">{selectedDevice ? (selectedDevice.hostname ?? '未命名设备') : '设备详情'}</div>
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
  device: { id: string; userId?: string | null; hostname?: string; status: string; lastSeenAt: number; agentIds: string[]; runtimes?: any[]; connectCommand?: string | null; latestDaemonVersion?: string | null; daemonUpdateAvailable?: boolean; daemonVersionInfo?: { current: string | null; latest: string | null; updateAvailable: boolean; status: 'current' | 'update-available' | 'unknown' }; systemInfo?: { platform?: string; arch?: string; osVersion?: string; hostname?: string; cpuModel?: string; cpuCores?: number; totalMemoryGB?: number; freeMemoryGB?: number; nodeVersion?: string; daemonVersion?: string } | null };
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
  const [customAgents, setCustomAgents] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [selectNetworkAgent, setSelectNetworkAgent] = useState<any | null>(null);
  const [configAgent, setConfigAgent] = useState<any | null>(null);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const displayName = device.hostname ?? '未命名设备';
  const daemonVersion = daemonVersionDisplay(device);
  const canManageDevice = currentUser?.role === 'admin' || Boolean(currentUser?.id && currentUser.id === device.userId);

  const refreshDeviceAgents = () => {
    return deviceEvents().agentsList(device.id).then((res) => {
      if (res.ok && res.agents) setDeviceAgents(res.agents);
      if (res.ok && res.runtimes) setDeviceRuntimes(res.runtimes);
    });
  };

  const refreshCustomAgents = () => {
    return agentEvents().listCustom({ deviceId: device.id }).then((res) => {
      if (res.ok && res.agents) setCustomAgents(res.agents);
    });
  };

  useEffect(() => {
    if (!device) return;
    refreshDeviceAgents();
    refreshCustomAgents();
  }, [device?.id]);

  const handleScan = async () => {
    setScanning(true);
    await deviceEvents().scan(device.id);
    setTimeout(() => {
      refreshDeviceAgents().finally(() => setScanning(false));
    }, 2000);
  };

  const agentosAgents = deviceAgents.filter((a) => a.category === 'agentos-hosted');
  const runtimeList = deviceRuntimes;

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

        {/* DEVICE INFO */}
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">设备信息</h3>
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500">名称</span>
                {!editName && canManageDevice && (
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
            </div>

            <div className="border-t border-neutral-100 pt-4">
              <div className="grid grid-cols-3 gap-2">
                <InfoCard label="最后在线" value={new Date(device.lastSeenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} />
                {device.systemInfo && (
                  <>
                  {device.systemInfo.osVersion && <InfoCard label="操作系统" value={device.systemInfo.osVersion} />}
                  {device.systemInfo.arch && <InfoCard label="架构" value={device.systemInfo.arch} />}
                  {device.systemInfo.cpuModel && <InfoCard label="CPU" value={device.systemInfo.cpuModel} />}
                  {device.systemInfo.cpuCores && <InfoCard label="CPU 核心" value={`${device.systemInfo.cpuCores} 核`} />}
                  {device.systemInfo.totalMemoryGB && <InfoCard label="总内存" value={`${device.systemInfo.totalMemoryGB} GB`} />}
                  {device.systemInfo.freeMemoryGB && <InfoCard label="可用内存" value={`${device.systemInfo.freeMemoryGB} GB`} />}
                  {device.systemInfo.nodeVersion && <InfoCard label="Node.js" value={device.systemInfo.nodeVersion} />}
                  {(device.systemInfo.daemonVersion || daemonVersion.latestLabel) && (
                    <InfoCard
                      label="Daemon"
                      value={daemonVersion.currentLabel}
                      hint={daemonVersion.updateAvailable && daemonVersion.latestLabel ? `可升级到 ${daemonVersion.latestLabel}` : undefined}
                      tone={daemonVersion.updateAvailable ? 'warning' : undefined}
                    />
                  )}
                  {device.systemInfo.hostname && <InfoCard label="主机名" value={device.systemInfo.hostname} />}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* CONNECTION */}
        {canManageDevice && (
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
        )}

        {/* AGENT GROUPS */}
        <RuntimeGroup
          runtimes={runtimeList}
          scanning={scanning}
          onScan={canManageDevice ? handleScan : undefined}
        />
        <AgentGroup
          title="AgentOS 托管型 Agent"
          subtitle="由 OpenClaw、Hermes 等 AgentOS 网关托管"
          icon={<Globe size={14} className="text-blue-600" />}
          iconBg="bg-blue-50"
          agents={agentosAgents}
          scanning={scanning}
          onScan={canManageDevice ? handleScan : undefined}
          onSelectNetwork={setSelectNetworkAgent}
          onSelectAgent={setConfigAgent}
          canManageAgents={canManageDevice}
        />
        <AgentGroup
          title="自定义 Agent"
          subtitle="使用 Claude Code、Codex CLI、Kimi CLI 等运行时创建"
          icon={<Terminal size={14} className="text-violet-600" />}
          iconBg="bg-violet-50"
          agents={customAgents}
          showAddButton={canManageDevice}
          onAdd={canManageDevice ? () => setShowAddCustom(true) : undefined}
          onSelectNetwork={setSelectNetworkAgent}
          onSelectAgent={setConfigAgent}
          canManageAgents={canManageDevice}
        />

        {/* ACTIONS */}
        {canManageDevice && (
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
        )}
      </div>

      {selectNetworkAgent && (
        <SelectNetworkDialog
          agent={selectNetworkAgent}
          onClose={() => setSelectNetworkAgent(null)}
        />
      )}
      {configAgent && (
        <AgentConfigDialog
          agent={configAgent}
          device={device}
          runtimes={runtimeList}
          canManage={canManageDevice}
          onClose={() => setConfigAgent(null)}
          onSaved={() => {
            refreshDeviceAgents();
            refreshCustomAgents();
          }}
        />
      )}
      {showAddCustom && (
        <AddCustomAgentDialog
          deviceId={device.id}
          daemonVersion={device.systemInfo?.daemonVersion ?? device.daemonVersionInfo?.current ?? null}
          runtimes={runtimeList}
          onClose={() => setShowAddCustom(false)}
          onCreated={() => {
            setShowAddCustom(false);
            agentEvents().listCustom({ deviceId: device.id }).then((res) => {
              if (res.ok && res.agents) setCustomAgents(res.agents);
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

function InfoCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${tone === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-neutral-100 bg-neutral-50'}`}>
      <div className={`text-[10px] font-medium uppercase tracking-wider ${tone === 'warning' ? 'text-amber-600' : 'text-neutral-400'}`}>{label}</div>
      <div className="mt-0.5 text-sm font-medium text-neutral-800 truncate">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] font-medium text-amber-700">{hint}</div>}
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
        <p className="mt-2 text-sm text-neutral-500">在新设备上运行以下命令，将其连接到当前团队。</p>

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

function AgentGroup({ title, subtitle, icon, iconBg, agents, scanning, onScan, showAddButton, onAdd, onSelectNetwork, onSelectAgent, canManageAgents = false }: {
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
  onSelectAgent: (agent: any) => void;
  canManageAgents?: boolean;
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
            <AgentRow key={agent.id} agent={agent} icon={icon} iconBg={iconBg} onSelectNetwork={onSelectNetwork} onSelectAgent={onSelectAgent} canManage={canManageAgents} />
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
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">检测到的编程智能体运行时</h3>
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
        <div className="flex flex-wrap gap-1.5">
          {runtimes.map((runtime) => (
            <span
              key={`${runtime.adapterKind}-${runtime.command}`}
              title={runtime.command || runtime.adapterKind}
              className={`inline-flex h-6 items-center border px-2 text-[11px] font-medium leading-none ${
                runtime.installed
                  ? 'border-neutral-400 bg-white text-neutral-800'
                  : 'border-neutral-300 bg-neutral-50 text-neutral-500'
              }`}
            >
              {runtimeLabel(runtime)}{runtime.installed ? '' : '（未安装）'}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentRow({ agent, icon, iconBg, onSelectNetwork, onSelectAgent, canManage }: {
  agent: any;
  icon: React.ReactNode;
  iconBg: string;
  onSelectNetwork: (agent: any) => void;
  onSelectAgent: (agent: any) => void;
  canManage: boolean;
}) {
  const publishedCount = agent.publishedNetworkIds?.length ?? 0;
  return (
    <div onClick={() => onSelectAgent(agent)} className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-left hover:bg-white">
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-xs text-neutral-400">{agent.adapterKind}</div>
      </div>
      {publishedCount > 0 && (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          已发布到 {publishedCount} 个团队
        </span>
      )}
      <Circle size={6} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : 'text-neutral-300'}`} />
      {canManage && (
        <button onClick={(e) => { e.stopPropagation(); onSelectNetwork(agent); }} className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50">
          选择团队
        </button>
      )}
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
          <h2 className="text-lg font-semibold">选择团队 — {agent.name}</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        {isCustom && (
          <p className="mt-2 text-xs text-neutral-500">自定义 Agent 使用本机 Coding Agent 运行时，仅可发布到私有团队或您拥有的团队。</p>
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
            <div className="py-4 text-center text-xs text-neutral-400">暂无可选团队</div>
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
  { key: 'claude-code', adapterKind: 'claude-code', command: 'claude', label: 'Claude Code', description: 'Anthropic 官方 CLI，擅长代码生成、调试和重构' },
  { key: 'codex', adapterKind: 'codex', command: 'codex', label: 'Codex CLI', description: 'OpenAI Codex CLI，适合快速代码生成和脚本编写' },
  { key: 'kimi-cli', adapterKind: 'codex', command: 'kimi-cli', label: 'Kimi CLI', description: 'Kimi CLI，适合使用本机 Kimi Coding Agent 运行时' },
];

function normalizeRuntimeKind(value?: string) {
  return (value || '').trim().toLowerCase();
}

function runtimeKey(runtime: any) {
  const kind = normalizeRuntimeKind(runtime.adapterKind);
  const command = (runtime.command || '').toLowerCase();
  const name = (runtime.name || '').toLowerCase();
  if (kind === 'claude-code' || command.includes('/claude') || command === 'claude') return 'claude-code';
  if (kind === 'kimi-cli' || command.includes('kimi-cli') || name.includes('kimi')) return 'kimi-cli';
  if (kind === 'codex' || command.includes('/codex') || command === 'codex') return 'codex';
  return kind || command || name || 'unknown-runtime';
}

function adapterKindForRuntime(runtime: any) {
  const key = runtimeKey(runtime);
  if (key === 'claude-code') return 'claude-code';
  return 'codex';
}

function runtimeLabel(runtime: any) {
  const key = runtimeKey(runtime);
  if (key === 'claude-code') return 'Claude Code';
  if (key === 'codex') return 'Codex CLI';
  if (key === 'kimi-cli') return 'Kimi CLI';
  return runtime.name || runtime.command || runtime.adapterKind || '未知运行时';
}

function buildRuntimeOptions(runtimes: any[]) {
  const discovered = runtimes.map((runtime) => ({
    key: runtimeKey(runtime),
    adapterKind: adapterKindForRuntime(runtime),
    command: runtime.command || runtime.name?.toLowerCase() || 'codex',
    label: runtimeLabel(runtime),
    description: runtime.command || runtime.adapterKind,
  }));
  const merged = [...discovered, ...RUNTIME_OPTIONS];
  const seen = new Set<string>();
  return merged.filter((runtime) => {
    const key = runtime.key || runtimeKey(runtime);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function AgentConfigDialog({ agent, device, runtimes, canManage, onClose, onSaved }: { agent: any; device?: { systemInfo?: { daemonVersion?: string } | null; daemonVersionInfo?: { current: string | null } }; runtimes: any[]; canManage: boolean; onClose: () => void; onSaved: () => void }) {
  const isCustom = agent.source === 'custom';
  const isAgentOS = agent.category === 'agentos-hosted';
  const editable = isCustom || isAgentOS;
  const canEdit = editable && canManage;
  const runtimeOptions = useMemo(() => buildRuntimeOptions(runtimes), [runtimes]);
  const initialRuntimeIndex = Math.max(0, runtimeOptions.findIndex((runtime) => runtime.adapterKind === agent.adapterKind && runtime.command === agent.command));
  const [name, setName] = useState<string>(agent.name ?? '');
  const [description, setDescription] = useState<string>(agent.description ?? '');
  const [runtimeIndex, setRuntimeIndex] = useState(String(initialRuntimeIndex));
  const [cwd, setCwd] = useState<string>(agent.cwd ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedRuntime = runtimeOptions[Number(runtimeIndex)] ?? runtimeOptions[0] ?? RUNTIME_OPTIONS[0];

  const save = async () => {
    if (!canEdit) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('名称为必填项'); return; }
    if (/\s/.test(trimmedName)) { setError('名称不能包含空格，请使用连字符（-）'); return; }
    setSaving(true);
    setError('');
    const payload: { id: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null } = {
      id: agent.id,
      name: trimmedName,
      cwd: cwd.trim() || null,
      description: description.trim() || null,
    };
    if (isCustom) {
      payload.adapterKind = selectedRuntime.adapterKind;
      payload.command = selectedRuntime.command;
    }
    const res = await agentEvents().updateConfig(payload);
    setSaving(false);
    if (res.ok) {
      onSaved();
      onClose();
    } else {
      setError(res.error === 'NAME_HAS_SPACE' ? '名称不能包含空格，请使用连字符（-）' : res.error ?? '保存失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="mx-4 w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{isCustom ? '自定义 Agent 配置' : 'AgentOS Agent 配置'}</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-neutral-100"><X size={16} /></button>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50" />
            {canEdit && <p className="mt-1 text-[11px] text-neutral-400">名称不能包含空格，可使用连字符（-）。</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">功能介绍</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} rows={3} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 resize-none disabled:bg-neutral-50" placeholder="描述这个 Agent 的用途和能力" />
          </div>
          {isCustom && (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Code Agent 运行时</label>
              <select value={runtimeIndex} onChange={(e) => setRuntimeIndex(e.target.value)} disabled={!canEdit} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50">
                {runtimeOptions.map((runtime, index) => (
                  <option key={`${runtime.adapterKind}-${runtime.command}-${index}`} value={String(index)}>{runtime.label}</option>
                ))}
              </select>
              {selectedRuntime && (
                <p className="mt-1 text-[11px] text-neutral-400">{selectedRuntime.description}</p>
              )}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">{isCustom ? '项目目录' : '目录'}</label>
            <div className="flex gap-2">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={!canEdit} className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50" placeholder="/path/to/project（可选）" />
              {canEdit && (
                <DirectoryBrowseButton deviceId={agent.deviceId} daemonVersion={device?.systemInfo?.daemonVersion ?? device?.daemonVersionInfo?.current ?? null} onSelect={setCwd} onError={setError} />
              )}
            </div>
            {canEdit && <p className="mt-1 text-[11px] text-neutral-400">{isCustom ? 'Agent 启动时的工作目录，留空则使用默认路径' : 'AgentOS Agent 所在目录，留空则保持未配置状态'}</p>}
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">关闭</button>
          {canEdit && (
            <button onClick={save} disabled={saving} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
              {saving ? '保存中...' : '保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddCustomAgentDialog({ deviceId, daemonVersion, runtimes, onClose, onCreated }: { deviceId: string; daemonVersion?: string | null; runtimes: any[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const runtimeOptions = useMemo(() => buildRuntimeOptions(runtimes), [runtimes]);
  const [runtimeIndex, setRuntimeIndex] = useState('0');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const selectedRuntime = runtimeOptions[Number(runtimeIndex)] ?? runtimeOptions[0] ?? RUNTIME_OPTIONS[0];

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('名称为必填项');
      return;
    }
    if (/\s/.test(trimmedName)) {
      setError('名称不能包含空格，请使用连字符（-）');
      return;
    }
    setLoading(true);
    setError('');
    const payload = {
      name: trimmedName,
      adapterKind: selectedRuntime.adapterKind,
      command: selectedRuntime.command,
      category: 'executor-hosted',
      deviceId,
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
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="my-agent" />
            <p className="mt-1 text-[11px] text-neutral-400">名称不能包含空格，可使用连字符（-）。</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">功能介绍</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 resize-none" placeholder="描述这个 Agent 的用途和能力（可选）" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">Code Agent 运行时 <span className="text-red-500">*</span></label>
            <select value={runtimeIndex} onChange={(e) => setRuntimeIndex(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400">
              {runtimeOptions.map((r, index) => (
                <option key={`${r.adapterKind}-${r.command}-${index}`} value={String(index)}>{r.label}</option>
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
              <DirectoryBrowseButton deviceId={deviceId} daemonVersion={daemonVersion} onSelect={setCwd} onError={setError} />
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">Agent 启动时的工作目录，留空则使用默认路径</p>
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
