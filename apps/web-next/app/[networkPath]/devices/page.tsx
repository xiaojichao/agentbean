'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Monitor, Circle, Plus, Pencil, Copy, Globe, Terminal, RefreshCw, X, FolderOpen, Paperclip, Image as ImageIcon, Trash2, ExternalLink } from 'lucide-react';
import { authEvents, deviceEvents, agentEvents, getResolvedServerUrl, fetchAgentWorkspace, authedApiUrl } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { daemonVersionDisplay } from '@/lib/daemon-version';
import { canAddCustomAgentToDevice, canManageDeviceForUser } from '@/lib/device-permissions';
import { formatRelative } from '@/lib/format-time';
import type { AgentWorkspaceFile, AgentWorkspaceRun } from '@/lib/schema';

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

const WORKSPACE_RUN_STATUS: Record<string, { label: string; className: string }> = {
  running: { label: '运行中', className: 'bg-blue-50 text-blue-700' },
  succeeded: { label: '成功', className: 'bg-emerald-50 text-emerald-700' },
  failed: { label: '失败', className: 'bg-red-50 text-red-700' },
  cancelled: { label: '已取消', className: 'bg-neutral-100 text-neutral-500' },
};

function formatDaemonVersion(device: Parameters<typeof daemonVersionDisplay>[0]) {
  return daemonVersionDisplay(device).currentLabel;
}

function deviceDisplayName(device: { id: string; name?: string | null; hostname?: string | null; systemInfo?: { hostname?: string } | null }): string {
  return (device.hostname ?? device.name ?? device.systemInfo?.hostname ?? '').trim() || device.id;
}

function deviceOwnerName(device: { ownerId?: string | null; userId?: string | null; ownerName?: string | null; userName?: string | null }): string {
  return (device.ownerName ?? device.userName ?? device.ownerId ?? device.userId ?? '').trim() || '未知用户';
}

function compareDevices(a: { id: string; name?: string | null; hostname?: string | null; networkId?: string; teamId?: string; systemInfo?: { hostname?: string } | null }, b: { id: string; name?: string | null; hostname?: string | null; networkId?: string; teamId?: string; systemInfo?: { hostname?: string } | null }): number {
  return deviceDisplayName(a).localeCompare(deviceDisplayName(b), 'zh-CN', { sensitivity: 'base', numeric: true }) ||
    (a.networkId ?? a.teamId ?? '').localeCompare(b.networkId ?? b.teamId ?? '', 'zh-CN', { sensitivity: 'base', numeric: true }) ||
    a.id.localeCompare(b.id);
}

function compareDeviceOwnerGroups(a: { ownerName: string }, b: { ownerName: string }): number {
  return a.ownerName.localeCompare(b.ownerName, 'zh-CN', { sensitivity: 'base', numeric: true });
}

const DIRECTORY_PICKER_MIN_DAEMON_VERSION = '0.1.27';
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
type EnvRow = { key: string; value: string };
type WorkspaceAgent = { id: string; name: string; adapterKind?: string; cwd?: string | null; runs: AgentWorkspaceRun[] };

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
  if (error === 'DIRECTORY_PICKER_TIMEOUT') return '目录选择超时，请确认目标设备已登录桌面会话，并且 Daemon 是从该桌面用户会话启动的';
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
  const teams = useAgentBeanStore((s) => s.teams);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyDeviceStatus = useAgentBeanStore((s) => s.applyDeviceStatus);
  const upsertDevice = useAgentBeanStore((s) => s.upsertDevice);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const routeDeviceId = typeof params.id === 'string' ? params.id : null;
  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : np;
  const routeTeamId = teams.find((team) => team.path === routeNetworkPath || team.id === routeNetworkPath)?.id;
  const deviceTeamId = routeTeamId ?? (routeNetworkPath === 'default' ? currentTeamId : '');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeDeviceLoading, setRouteDeviceLoading] = useState(false);
  const [routeDeviceError, setRouteDeviceError] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editName, setEditName] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (conn !== 'open' || !deviceTeamId) return;
    deviceEvents().subscribe(deviceTeamId);
    const unsub = deviceEvents().onSnapshot((list) => applyDevicesSnapshot(list));
    const unsubStatus = deviceEvents().onStatus((device) => applyDeviceStatus(device));
    return () => { unsub(); unsubStatus(); };
  }, [conn, deviceTeamId, applyDevicesSnapshot, applyDeviceStatus]);

  const deviceList = useMemo(() => Object.values(devices).sort(compareDevices), [devices]);
  const deviceGroups = useMemo(() => {
    const groups = new Map<string, typeof deviceList>();
    for (const device of deviceList) {
      const ownerName = deviceOwnerName(device);
      const list = groups.get(ownerName) ?? [];
      list.push(device);
      groups.set(ownerName, list);
    }
    return Array.from(groups.entries())
      .map(([ownerName, list]) => ({ ownerName, devices: [...list].sort(compareDevices) }))
      .sort(compareDeviceOwnerGroups);
  }, [deviceList]);

  useEffect(() => {
    if (routeDeviceId) {
      setSelectedId(routeDeviceId);
      setEditName(false);
      setShowDeleteConfirm(false);
    }
  }, [routeDeviceId]);

  const selectedDevice = deviceList.find((d) => d.id === selectedId) ?? null;

  useEffect(() => {
    if (!routeDeviceId || selectedDevice || conn !== 'open' || !deviceTeamId) return;
    let cancelled = false;
    setRouteDeviceLoading(true);
    setRouteDeviceError('');
    deviceEvents().get({ id: routeDeviceId }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.device) {
        const responseTeamId = res.device.networkId ?? res.device.teamId;
        if (!responseTeamId || responseTeamId === deviceTeamId) {
          upsertDevice(res.device);
          return;
        }
        setRouteDeviceError('该设备不属于当前团队');
        return;
      }
      setRouteDeviceError(res.error ?? '设备加载失败');
    }).catch((error) => {
      if (!cancelled) setRouteDeviceError(error instanceof Error ? error.message : '设备加载失败');
    }).finally(() => {
      if (!cancelled) setRouteDeviceLoading(false);
    });
    return () => { cancelled = true; };
  }, [routeDeviceId, selectedDevice, conn, deviceTeamId, upsertDevice]);

  const handleDeviceDeleted = (deviceId: string) => {
    applyDevicesSnapshot(deviceList.filter((device) => device.id !== deviceId));
    setSelectedId(null);
    setEditName(false);
    setShowDeleteConfirm(false);
    setRouteDeviceError('');
    router.replace(`/${np}/devices`);
  };

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
          {deviceGroups.map((group) => (
            <div key={group.ownerName} className="mb-3 last:mb-0">
              <div className="mb-1.5 flex items-center justify-between px-2 text-[11px] font-semibold text-neutral-400">
                <span className="truncate">{group.ownerName}</span>
                <span>{group.devices.length}</span>
              </div>
              {group.devices.map((device) => (
                <button
                  key={device.id}
                  onClick={() => { setSelectedId(device.id); setEditName(false); setShowDeleteConfirm(false); router.push(`/${np}/devices/${device.id}`); }}
                  className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${selectedId === device.id ? 'bg-white shadow-sm ring-1 ring-neutral-200' : 'hover:bg-white/60'}`}
                  data-smoke="device-list-item"
                  data-device-id={device.id}
                  data-device-name={deviceDisplayName(device)}
                  data-device-status={device.status}
                >
                  <div className="relative shrink-0">
                    <Monitor size={16} className="text-neutral-500" />
                    <Circle size={6} className={`absolute -right-0.5 -top-0.5 fill-current ${STATUS_COLORS[device.status] ?? 'text-neutral-300'}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium leading-tight">{deviceDisplayName(device) === device.id ? '未命名设备' : deviceDisplayName(device)}</div>
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
            </div>
          ))}
          {deviceList.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-neutral-400">暂无设备</div>
          )}
        </div>
      </div>

      {/* Right — detail / empty state */}
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">{selectedDevice ? (deviceDisplayName(selectedDevice) === selectedDevice.id ? '未命名设备' : deviceDisplayName(selectedDevice)) : '设备详情'}</div>
        <div className="flex-1 overflow-y-auto">
        {!selectedDevice && <EmptyState loading={routeDeviceLoading} error={routeDeviceError} />}
        {selectedDevice && (
          <DeviceDetail
            device={selectedDevice}
            editName={editName}
            setEditName={setEditName}
            deviceName={deviceName}
            setDeviceName={setDeviceName}
            showDeleteConfirm={showDeleteConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            currentTeamId={deviceTeamId || currentTeamId}
            onDeleted={handleDeviceDeleted}
          />
        )}
        </div>
      </div>

      {/* Add Device Dialog */}
      {showAddDialog && <AddDeviceDialog onClose={() => setShowAddDialog(false)} currentTeamId={deviceTeamId || currentTeamId} />}
    </div>
  );
}

function EmptyState({ loading = false, error = '' }: { loading?: boolean; error?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-neutral-400">
      <Monitor size={48} strokeWidth={1} />
      <div className="mt-3 text-sm">{loading ? '正在加载设备详情...' : error || '选择左侧设备查看详情'}</div>
    </div>
  );
}

function DeviceDetail({ device, editName, setEditName, deviceName, setDeviceName, showDeleteConfirm, setShowDeleteConfirm, currentTeamId, onDeleted }: {
  device: { id: string; ownerId?: string | null; userId?: string | null; ownerName?: string | null; userName?: string | null; canManage?: boolean; isLocal?: boolean; name?: string; hostname?: string; status: string; lastSeenAt: number; agentIds: string[]; runtimes?: any[]; connectCommand?: string | null; latestDaemonVersion?: string | null; daemonUpdateAvailable?: boolean; daemonVersionInfo?: { current: string | null; latest: string | null; updateAvailable: boolean; status: 'current' | 'update-available' | 'unknown' }; systemInfo?: { platform?: string; arch?: string; osVersion?: string; hostname?: string; cpuModel?: string; cpuCores?: number; totalMemoryGB?: number; freeMemoryGB?: number; nodeVersion?: string; daemonVersion?: string } | null };
  editName: boolean;
  setEditName: (v: boolean) => void;
  deviceName: string;
  setDeviceName: (v: string) => void;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  currentTeamId: string | null;
  onDeleted: (deviceId: string) => void;
}) {
  const [inviteCommand, setInviteCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [genError, setGenError] = useState('');
  const [deviceAgents, setDeviceAgents] = useState<any[]>([]);
  const [deviceRuntimes, setDeviceRuntimes] = useState<any[]>(device.runtimes ?? []);
  const [customAgents, setCustomAgents] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [configAgent, setConfigAgent] = useState<any | null>(null);
  const [deleteAgent, setDeleteAgent] = useState<any | null>(null);
  const [deleteAgentSaving, setDeleteAgentSaving] = useState(false);
  const [deleteAgentError, setDeleteAgentError] = useState('');
  const [workspaceAgents, setWorkspaceAgents] = useState<WorkspaceAgent[]>([]);
  const [workspaceScanned, setWorkspaceScanned] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [deviceNameError, setDeviceNameError] = useState('');
  const [deviceDeleteSaving, setDeviceDeleteSaving] = useState(false);
  const [deviceDeleteError, setDeviceDeleteError] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamRole = useAgentBeanStore((s) => s.teams.find((team) => team.id === currentTeamId)?.currentUserRole);
  const upsertDevice = useAgentBeanStore((s) => s.upsertDevice);
  // 切换可见性后同步全局 members store：visible=false 时让共享 store 立即移除该 agent。
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const displayName = deviceDisplayName(device) === device.id ? '未命名设备' : deviceDisplayName(device);
  const ownerName = deviceOwnerName(device);
  const daemonVersion = daemonVersionDisplay(device);
  const deviceOwnerId = device.ownerId ?? device.userId;
  const canManageDevice = canManageDeviceForUser({
    deviceCanManage: device.canManage,
    deviceOwnerId,
    currentUserId: currentUser?.id,
    currentUserRole: currentUser?.role,
    currentTeamRole,
  });
  const isOwnedByCurrentUser = Boolean(currentUser?.id && currentUser.id === deviceOwnerId);
  const isLocalDevice = device.isLocal === true;
  const canAddCustomAgent = canAddCustomAgentToDevice({ canManageDevice, isLocalDevice });

  const refreshDeviceAgents = () => {
    return deviceEvents().agentsList(device.id, currentTeamId).then((res) => {
      if (res.ok && res.agents) {
        setDeviceAgents(res.agents);
        setCustomAgents(res.agents.filter((agent: any) => agent.source === 'custom'));
      }
      if (res.ok && res.runtimes) setDeviceRuntimes(res.runtimes);
    });
  };

  const confirmDeleteDevice = async () => {
    setDeviceDeleteSaving(true);
    setDeviceDeleteError('');
    try {
      const res = await deviceEvents().delete(device.id);
      if (!res.ok) {
        setDeviceDeleteError(res.error ?? '设备删除失败');
        setDeviceDeleteSaving(false);
        return;
      }
      setDeviceDeleteSaving(false);
      onDeleted(device.id);
    } catch (error) {
      setDeviceDeleteError(error instanceof Error ? error.message : '设备删除失败');
      setDeviceDeleteSaving(false);
    }
  };

  const confirmDeleteAgent = async () => {
    if (!deleteAgent) return;
    setDeleteAgentSaving(true);
    setDeleteAgentError('');
    const res = await agentEvents().delete(deleteAgent.id);
    setDeleteAgentSaving(false);
    if (!res.ok) {
      setDeleteAgentError(res.error ?? '删除失败');
      return;
    }
    setDeviceAgents((agents) => agents.filter((agent) => agent.id !== deleteAgent.id));
    setCustomAgents((agents) => agents.filter((agent) => agent.id !== deleteAgent.id));
    if (configAgent?.id === deleteAgent.id) setConfigAgent(null);
    setDeleteAgent(null);
    refreshDeviceAgents();
  };

  // 切换 Agent 对当前团队的可见性：调 setVisibility 后用返回的 agent.visibleTeamIds 乐观更新本地列表
  const handleToggleVisibility = async (agent: any, visible: boolean) => {
    if (!currentTeamId) return;
    const res = await agentEvents().setVisibility(agent.id, currentTeamId, visible);
    if (res.ok && res.agent) {
      setDeviceAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, visibleTeamIds: res.agent!.visibleTeamIds } : a)));
      setCustomAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, visibleTeamIds: res.agent!.visibleTeamIds } : a)));
      // 同步全局 members store：visible=false 时 applyAgentStatus 经 agentVisibleInNetwork
      // 判定不可见，从共享 store 移除该 agent——成员页等读取全局 store 的页面立即消失，
      // 而非因残留旧快照显示为「没消失变不在线」。
      applyAgentStatus(res.agent);
    }
    refreshDeviceAgents();
  };

  useEffect(() => {
    if (!device) return;
    setWorkspaceAgents([]);
    setWorkspaceScanned(false);
    setWorkspaceError('');
    refreshDeviceAgents();
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
  const workspaceCandidates = useMemo(() => {
    const byId = new Map<string, any>();
    for (const agent of [...agentosAgents, ...customAgents]) {
      if (agent?.id) byId.set(agent.id, agent);
    }
    return [...byId.values()];
  }, [agentosAgents, customAgents]);

  const scanWorkspaces = async () => {
    if (!currentTeamId) return;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    try {
      const results = await Promise.all(workspaceCandidates.map(async (agent) => {
        const res = await fetchAgentWorkspace(currentTeamId, agent.id);
        return {
          id: agent.id,
          name: agent.name,
          adapterKind: agent.adapterKind,
          cwd: agent.cwd ?? null,
          runs: res.ok ? res.runs ?? [] : [],
        };
      }));
      setWorkspaceAgents(results.filter((agent) => agent.runs.length > 0));
      setWorkspaceScanned(true);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : '扫描工作区失败');
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const handleEditName = () => {
    setDeviceName(displayName);
    setDeviceNameError('');
    setEditName(true);
  };

  const saveName = async () => {
    const nextName = (renameInputRef.current?.value ?? deviceName).trim();
    if (!nextName || nextName === displayName) { setEditName(false); return; }
    setDeviceNameError('');
    const res = await deviceEvents().rename(device.id, nextName);
    if (!res.ok) {
      setDeviceNameError(res.error ?? '重命名失败');
      return;
    }
    if (res.device) upsertDevice(res.device);
    setEditName(false);
  };

  const generateConnect = async () => {
    setGenError('');
    setInviteCommand('');
    const res = await authEvents().inviteCreate({ networkId: currentTeamId ?? undefined, purpose: 'device' });
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
    <div
      className="p-6"
      data-smoke="device-detail"
      data-device-id={device.id}
      data-device-name={displayName}
      data-device-status={device.status}
    >
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
                  <button
                    onClick={handleEditName}
                    className="text-xs text-neutral-400 hover:text-neutral-700 flex items-center gap-1"
                    data-smoke="device-rename-open"
                  >
                    <Pencil size={10} /> 编辑
                  </button>
                )}
              </div>
              {editName ? (
                <div className="flex items-center gap-2">
                  <input
                    ref={renameInputRef}
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditName(false); }}
                    data-smoke="device-rename-input"
                  />
                  <button onClick={saveName} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-800" data-smoke="device-rename-save">保存</button>
                  <button onClick={() => setEditName(false)} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs hover:bg-neutral-50">取消</button>
                </div>
              ) : (
                <p className="text-sm">{displayName}</p>
              )}
              {deviceNameError && <p className="mt-2 text-xs text-red-600" data-smoke="device-rename-error">{deviceNameError}</p>}
            </div>

            <div className="border-t border-neutral-100 pt-4">
              <div className="grid grid-cols-3 gap-2">
                <InfoCard label="所有者" value={ownerName} />
                <InfoCard label="最后在线" value={new Date(device.lastSeenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} />
                {device.systemInfo && (
                  <>
                  {device.systemInfo.osVersion && <InfoCard label="操作系统" value={device.systemInfo.osVersion} />}
                  {device.systemInfo.arch && <InfoCard label="架构" value={device.systemInfo.arch} />}
                  {device.systemInfo.cpuModel && <InfoCard label="CPU" value={device.systemInfo.cpuModel} />}
                  {device.systemInfo.cpuCores && <InfoCard label="CPU 核心" value={`${device.systemInfo.cpuCores} 核`} />}
                  {device.systemInfo.totalMemoryGB && <InfoCard label="总内存" value={`${device.systemInfo.totalMemoryGB} GB`} />}
                  {device.systemInfo.nodeVersion && <InfoCard label="Node.js" value={device.systemInfo.nodeVersion} />}
                  {(device.systemInfo.daemonVersion || daemonVersion.latestLabel) && (
                    <InfoCard
                      label="Daemon 版本"
                      value={daemonVersion.updateAvailable ? `${daemonVersion.currentLabel}（有更新版本）` : daemonVersion.currentLabel}
                      tone={daemonVersion.updateAvailable ? 'danger' : undefined}
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
        {isOwnedByCurrentUser && device.status === 'offline' && (
          <section className="rounded-lg border border-neutral-200 p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">连接命令</h3>
            {device.connectCommand && (
              <div className="space-y-2">
                <p className="text-xs text-neutral-500">首次接入命令（历史参考，invite code 可能已失效）：</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-neutral-900 px-3 py-2 text-xs text-emerald-400">{device.connectCommand}</code>
                  <button onClick={() => { navigator.clipboard.writeText(device.connectCommand ?? ''); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 flex items-center gap-1">
                    <Copy size={10} /> {copied ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
            )}
            <div className={device.connectCommand ? 'mt-3' : ''}>
              <button onClick={generateConnect} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">
                {device.connectCommand ? '生成新连接命令' : '生成连接命令'}
              </button>
              {inviteCommand && (
                <div className="mt-3 space-y-1">
                  <p className="text-xs text-neutral-500">新连接命令（可用）：</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-neutral-900 px-3 py-2 text-xs text-emerald-400">{inviteCommand}</code>
                    <button onClick={copy} className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 flex items-center gap-1">
                      <Copy size={10} /> {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>
              )}
              {genError && <p className="mt-2 text-sm text-red-600">{genError}</p>}
            </div>
          </section>
        )}

        {/* AGENT GROUPS */}
        <RuntimeGroup
          runtimes={runtimeList}
          scanning={scanning}
          onScan={canManageDevice ? handleScan : undefined}
        />
        <AgentGroup
          smokeKind="agentos"
          title="AgentOS 托管型 Agent"
          subtitle="由 OpenClaw、Hermes 等 AgentOS 网关托管"
          icon={<Globe size={14} className="text-blue-600" />}
          iconBg="bg-blue-50"
          agents={agentosAgents}
          scanning={scanning}
          onScan={canManageDevice ? handleScan : undefined}
          currentTeamId={currentTeamId ?? ''}
          onToggleVisibility={handleToggleVisibility}
          onSelectAgent={setConfigAgent}
          canManageAgents={canManageDevice}
        />
        <AgentGroup
          smokeKind="custom"
          title="自定义 Agent"
          subtitle="使用 Claude Code、Codex CLI、Kimi CLI 等运行时创建"
          icon={<Terminal size={14} className="text-violet-600" />}
          iconBg="bg-violet-50"
          agents={customAgents}
          showAddButton={canAddCustomAgent}
          onAdd={canAddCustomAgent ? () => setShowAddCustom(true) : undefined}
          currentTeamId={currentTeamId ?? ''}
          onToggleVisibility={handleToggleVisibility}
          onSelectAgent={setConfigAgent}
          onDeleteAgent={setDeleteAgent}
          canManageAgents={canManageDevice}
        />
        {isLocalDevice && (
          <DeviceWorkspacesSection
            agents={workspaceAgents}
            scanned={workspaceScanned}
            loading={workspaceLoading}
            error={workspaceError}
            onScan={scanWorkspaces}
          />
        )}

        {/* ACTIONS */}
        {canManageDevice && (
        <section className="rounded-lg border border-red-200 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-500">操作</h3>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-red-700">删除设备</div>
              <div className="text-xs text-red-400">永久删除此设备。需先删除所有 Agent。</div>
            </div>
            <button onClick={() => setShowDeleteConfirm(true)} className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50" data-smoke="device-delete-open">
              删除设备
            </button>
          </div>
          {showDeleteConfirm && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4">
              <p className="mb-3 text-sm text-red-700">确定要删除设备 <strong>{displayName}</strong> 吗？此操作不可撤销。</p>
              {deviceDeleteError && (
                <div className="mb-3 rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-700" data-smoke="device-delete-error">
                  {deviceDeleteError}
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => { setDeviceDeleteError(''); setShowDeleteConfirm(false); }} disabled={deviceDeleteSaving} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50">取消</button>
                <button onClick={confirmDeleteDevice} disabled={deviceDeleteSaving} className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50" data-smoke="device-delete-confirm">
                  {deviceDeleteSaving ? '删除中...' : '确认删除'}
                </button>
              </div>
            </div>
          )}
        </section>
        )}
      </div>

      {configAgent && (
        <AgentConfigDialog
          agent={configAgent}
          device={device}
          runtimes={runtimeList}
          canEditMetadata={canManageDevice || isLocalDevice}
          canEditDeviceSettings={isLocalDevice}
          onClose={() => setConfigAgent(null)}
          onSaved={() => {
            refreshDeviceAgents();
          }}
        />
      )}
      {deleteAgent && (
        <DeleteCustomAgentDialog
          agent={deleteAgent}
          saving={deleteAgentSaving}
          error={deleteAgentError}
          onCancel={() => {
            if (deleteAgentSaving) return;
            setDeleteAgent(null);
            setDeleteAgentError('');
          }}
          onConfirm={confirmDeleteAgent}
        />
      )}
      {showAddCustom && (
        <AddCustomAgentDialog
          deviceId={device.id}
          networkId={currentTeamId}
          daemonVersion={device.systemInfo?.daemonVersion ?? device.daemonVersionInfo?.current ?? null}
          runtimes={runtimeList}
          onClose={() => setShowAddCustom(false)}
          onCreated={() => {
            setShowAddCustom(false);
            refreshDeviceAgents();
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

function InfoCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'danger' }) {
  const containerClass = tone === 'danger'
    ? 'border-red-200 bg-red-50'
    : tone === 'warning'
      ? 'border-amber-200 bg-amber-50'
      : 'border-neutral-100 bg-neutral-50';
  const labelClass = tone === 'danger'
    ? 'text-red-600'
    : tone === 'warning'
      ? 'text-amber-600'
      : 'text-neutral-400';
  const valueClass = tone === 'danger' ? 'text-red-700' : 'text-neutral-800';
  const hintClass = tone === 'danger' ? 'text-red-700' : 'text-amber-700';

  return (
    <div className={`rounded-md border px-3 py-2 ${containerClass}`}>
      <div className={`text-[10px] font-medium uppercase tracking-wider ${labelClass}`}>{label}</div>
      <div className={`mt-0.5 truncate text-sm font-medium ${valueClass}`}>{value}</div>
      {hint && <div className={`mt-0.5 truncate text-[11px] font-medium ${hintClass}`}>{hint}</div>}
    </div>
  );
}

function AddDeviceDialog({ onClose, currentTeamId }: { onClose: () => void; currentTeamId: string | null }) {
  const [inviteCommand, setInviteCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generateCommand = async () => {
    setLoading(true);
    setError('');
    const res = await authEvents().inviteCreate({ networkId: currentTeamId ?? undefined, purpose: 'device' });
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

function AgentGroup({ smokeKind, title, subtitle, icon, iconBg, agents, scanning, onScan, showAddButton, onAdd, currentTeamId, onToggleVisibility, onSelectAgent, onDeleteAgent, canManageAgents = false }: {
  smokeKind: 'agentos' | 'custom';
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  iconBg: string;
  agents: any[];
  scanning?: boolean;
  onScan?: () => void;
  showAddButton?: boolean;
  onAdd?: () => void;
  currentTeamId: string;
  onToggleVisibility: (agent: any, visible: boolean) => void;
  onSelectAgent: (agent: any) => void;
  onDeleteAgent?: (agent: any) => void;
  canManageAgents?: boolean;
}) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4" data-smoke={`device-agent-group-${smokeKind}`}>
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
            <button onClick={onScan} disabled={scanning} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50" data-smoke={`device-agent-scan-${smokeKind}`}>
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
            <AgentRow key={agent.id} agent={agent} smokeKind={smokeKind} icon={icon} iconBg={iconBg} currentTeamId={currentTeamId} onToggleVisibility={onToggleVisibility} onSelectAgent={onSelectAgent} onDeleteAgent={onDeleteAgent} canManage={canManageAgents} />
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
          <button onClick={onScan} disabled={scanning} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50" data-smoke="device-runtime-scan">
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
              data-smoke="device-runtime-item"
              data-runtime-adapter-kind={runtime.adapterKind}
              data-runtime-command={runtime.command ?? ''}
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

function DeviceWorkspacesSection({ agents, scanned, loading, error, onScan }: {
  agents: WorkspaceAgent[];
  scanned: boolean;
  loading: boolean;
  error: string;
  onScan: () => void;
}) {
  const totalRuns = agents.reduce((sum, agent) => sum + agent.runs.length, 0);
  const totalFiles = agents.reduce((sum, agent) => sum + agent.runs.reduce((runSum, run) => runSum + run.files.length, 0), 0);

  return (
    <section className="rounded-lg border border-neutral-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            <FolderOpen size={14} /> Agent Workspaces
          </h3>
          {scanned && agents.length > 0 && (
            <p className="text-[11px] text-neutral-400">{agents.length} 个 Agent，{totalRuns} 条同步记录，{totalFiles} 个文件</p>
          )}
        </div>
        <button onClick={onScan} disabled={loading} className="flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> {scanned ? '重新扫描' : '扫描'}
        </button>
      </div>

      {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {!scanned && !loading ? (
        <div className="text-xs text-neutral-400">点击扫描查看此本机设备上的 Agent 工作区。</div>
      ) : agents.length === 0 ? (
        <div className="text-xs text-neutral-400">{loading ? '正在扫描 Agent 工作区...' : '未发现已同步的 Agent 工作区。'}</div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <DeviceWorkspaceAgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeviceWorkspaceAgentCard({ agent }: { agent: WorkspaceAgent }) {
  const fileCount = agent.runs.reduce((sum, run) => sum + run.files.length, 0);
  const latest = Math.max(...agent.runs.map((run) => run.updatedAt));
  const workspacePath = agent.cwd ? `${agent.cwd}/.agentbean/${agent.name}` : `~/.agentbean/${agent.name}`;
  const np = useCurrentNetworkPath();

  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-800">{agent.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
            <span>{agent.adapterKind ?? 'Agent'}</span>
            <span>{agent.runs.length} 条记录</span>
            <span>{fileCount} 个文件</span>
            <span>{formatRelative(latest)}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">{workspacePath}/</div>
        </div>
      </div>
      <div className="space-y-3">
        {agent.runs.slice(0, 4).map((run) => (
          <div key={run.runId} className="border-t border-neutral-200 pt-3 first:border-t-0 first:pt-0">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${(WORKSPACE_RUN_STATUS[run.status] ?? WORKSPACE_RUN_STATUS.running).className}`}>
                    {(WORKSPACE_RUN_STATUS[run.status] ?? WORKSPACE_RUN_STATUS.running).label}
                  </span>
                  <div className="truncate text-xs font-medium text-neutral-600">Workspace run</div>
                </div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-400">
                  <span>{formatRelative(run.updatedAt)}</span>
                  {run.exitCode !== undefined && <span>exit {run.exitCode}</span>}
                  {run.command && <span className="max-w-[12rem] truncate font-mono">{run.command}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Link
                  href={`/${np}/runs/${run.runId}`}
                  className="inline-flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline"
                >
                  查看详情
                  <ExternalLink size={10} />
                </Link>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] text-neutral-500 ring-1 ring-neutral-200">
                  {run.files.length} 个文件
                </span>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {run.files.slice(0, 6).map((file) => (
                <DeviceWorkspaceFileLink key={file.id} file={file} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeviceWorkspaceFileLink({ file }: { file: AgentWorkspaceFile }) {
  const isImage = file.mimeType.startsWith('image/');
  const sizeKb = Math.max(0.1, file.sizeBytes / 1024).toFixed(1);
  return (
    <a
      href={authedApiUrl(file.downloadUrl)}
      target="_blank"
      rel="noreferrer"
      title={file.relativePath}
      className="group flex min-w-0 items-center gap-2 rounded-md border border-neutral-200 bg-white p-2 text-xs hover:border-neutral-300"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-neutral-200 bg-neutral-50">
        {isImage ? <ImageIcon size={15} className="text-blue-500" /> : <Paperclip size={15} className="text-neutral-400" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-neutral-700 group-hover:text-neutral-950">{file.filename}</div>
        <div className="mt-0.5 truncate text-[11px] text-neutral-400">{file.relativePath}</div>
      </div>
      <span className="shrink-0 text-[11px] text-neutral-400">{sizeKb} KB</span>
    </a>
  );
}

function AgentRow({ agent, smokeKind, icon, iconBg, onSelectAgent, onDeleteAgent, canManage, currentTeamId, onToggleVisibility }: {
  agent: any;
  smokeKind: 'agentos' | 'custom';
  icon: React.ReactNode;
  iconBg: string;
  onSelectAgent: (agent: any) => void;
  onDeleteAgent?: (agent: any) => void;
  canManage: boolean;
  currentTeamId: string;
  onToggleVisibility: (agent: any, visible: boolean) => void;
}) {
  // 对当前团队是否可见：后端以 visibleTeamIds 维护，复选框即代表该集合是否含 currentTeamId
  const visibleInTeam = (agent.visibleTeamIds ?? []).includes(currentTeamId);
  return (
    <div
      onClick={() => onSelectAgent(agent)}
      className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-left hover:bg-white"
      data-smoke="device-agent-item"
      data-agent-id={agent.id}
      data-agent-name={agent.name}
      data-agent-kind={smokeKind}
      data-agent-source={agent.source ?? ''}
      data-agent-category={agent.category ?? ''}
      data-agent-visible={visibleInTeam ? '1' : '0'}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-xs text-neutral-400">{agent.adapterKind}</div>
      </div>
      <Circle size={6} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : 'text-neutral-300'}`} />
      {/* 对当前团队可见复选框：点击事件 stopPropagation，避免触发行选中；canManage 才可改 */}
      <label
        onClick={(e) => e.stopPropagation()}
        className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-neutral-600"
        title="对当前团队可见"
      >
        <input
          type="checkbox"
          checked={visibleInTeam}
          disabled={!canManage}
          onChange={(e) => { e.stopPropagation(); onToggleVisibility(agent, e.target.checked); }}
        />
        可见
      </label>
      {canManage && onDeleteAgent && agent.source === 'custom' && (
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent); }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50"
          title="删除 Agent"
          aria-label={`删除 ${agent.name}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function DeleteCustomAgentDialog({ agent, saving, error, onCancel, onConfirm }: {
  agent: any;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-rose-50 text-rose-600">
            <Trash2 size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-950">删除 {agent.name}</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600">
              这会删除自定义 Agent 配置，并从已发布团队和频道成员中移除；不会删除设备本身。
            </p>
          </div>
        </div>
        {error && <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} disabled={saving} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50">取消</button>
          <button onClick={onConfirm} disabled={saving} className="rounded-md bg-rose-600 px-4 py-2 text-sm text-white hover:bg-rose-700 disabled:opacity-50">
            {saving ? '删除中...' : '确认删除'}
          </button>
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

function EnvironmentVariableEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const updateRow = (index: number, patch: Partial<EnvRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-600">环境变量</label>
      <p className="mb-2 text-[11px] text-neutral-400">创建后会注入到 Coding Agent 运行时环境。</p>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <input value={row.key} onChange={(e) => updateRow(index, { key: e.target.value })} className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="KEY" />
            <input value={row.value} onChange={(e) => updateRow(index, { value: e.target.value })} className="min-w-0 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="value" />
            <button type="button" onClick={() => removeRow(index)} className="rounded-md border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50" aria-label="删除环境变量">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-900">
        <Plus size={12} /> 添加变量
      </button>
    </div>
  );
}

function AgentConfigDialog({ agent, device, runtimes, canEditMetadata, canEditDeviceSettings, onClose, onSaved }: { agent: any; device?: { systemInfo?: { daemonVersion?: string } | null; daemonVersionInfo?: { current: string | null } }; runtimes: any[]; canEditMetadata: boolean; canEditDeviceSettings: boolean; onClose: () => void; onSaved: () => void }) {
  const isCustom = agent.source === 'custom';
  const isAgentOS = agent.category === 'agentos-hosted';
  const editable = isCustom || isAgentOS;
  const canEditMetadataFields = editable && canEditMetadata;
  const canEditRuntimeFields = isCustom && editable && canEditDeviceSettings;
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
    if (!canEditMetadataFields) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('名称为必填项'); return; }
    if (/\s/.test(trimmedName)) { setError('名称不能包含空格，请使用连字符（-）'); return; }
    setSaving(true);
    setError('');
    const payload: { id: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null } = {
      id: agent.id,
      name: trimmedName,
      description: description.trim() || null,
    };
    if (isCustom) {
      if (canEditRuntimeFields) {
        payload.adapterKind = selectedRuntime.adapterKind;
        payload.command = selectedRuntime.command;
        payload.cwd = cwd.trim() || null;
      }
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
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEditMetadataFields} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50" />
            {canEditMetadataFields && <p className="mt-1 text-[11px] text-neutral-400">名称不能包含空格，可使用连字符（-）。</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-600">功能介绍</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEditMetadataFields} rows={3} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 resize-none disabled:bg-neutral-50" placeholder="描述这个 Agent 的用途和能力" />
          </div>
          {isCustom && (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">Code Agent 运行时</label>
              <select value={runtimeIndex} onChange={(e) => setRuntimeIndex(e.target.value)} disabled={!canEditRuntimeFields} className="w-full rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50">
                {runtimeOptions.map((runtime, index) => (
                  <option key={`${runtime.adapterKind}-${runtime.command}-${index}`} value={String(index)}>{runtime.label}</option>
                ))}
              </select>
              {selectedRuntime && (
                <p className="mt-1 text-[11px] text-neutral-400">{selectedRuntime.description}</p>
              )}
            </div>
          )}
          {isCustom ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">项目目录</label>
              <div className="flex gap-2">
                <input value={cwd} onChange={(e) => setCwd(e.target.value)} disabled={!canEditRuntimeFields} className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400 disabled:bg-neutral-50" placeholder="/path/to/project（可选）" />
                {canEditRuntimeFields && (
                  <DirectoryBrowseButton deviceId={agent.deviceId} daemonVersion={device?.systemInfo?.daemonVersion ?? device?.daemonVersionInfo?.current ?? null} onSelect={setCwd} onError={setError} />
                )}
              </div>
              {canEditRuntimeFields && <p className="mt-1 text-[11px] text-neutral-400">Agent 启动时的工作目录，留空则使用默认路径</p>}
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-600">所在目录</label>
              <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 font-mono text-sm text-neutral-700 break-all">
                {cwd.trim() || '未配置'}
              </div>
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">关闭</button>
          {canEditMetadataFields && (
            <button onClick={save} disabled={saving} className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50">
              {saving ? '保存中...' : '保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AddCustomAgentDialog({ deviceId, networkId, daemonVersion, runtimes, onClose, onCreated }: { deviceId: string; networkId?: string | null; daemonVersion?: string | null; runtimes: any[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const runtimeOptions = useMemo(() => buildRuntimeOptions(runtimes), [runtimes]);
  const [runtimeIndex, setRuntimeIndex] = useState('0');
  const [cwd, setCwd] = useState('');
  const [description, setDescription] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
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
    if (!selectedRuntime?.adapterKind || !selectedRuntime?.command?.trim()) {
      setError('Coding Agent 运行时为必填项');
      return;
    }
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setError('项目目录为必填项');
      return;
    }
    const env: Record<string, string> = {};
    for (const row of envRows) {
      const key = row.key.trim();
      const value = row.value;
      if (!key && !value.trim()) continue;
      if (!key || !ENV_KEY_PATTERN.test(key)) {
        setError('环境变量 Key 必须以字母或下划线开头，只能包含字母、数字和下划线');
        return;
      }
      env[key] = value;
    }
    setLoading(true);
    setError('');
    const payload = {
      name: trimmedName,
      adapterKind: selectedRuntime.adapterKind,
      command: selectedRuntime.command,
      category: 'executor-hosted',
      deviceId,
      networkId: networkId ?? undefined,
      cwd: trimmedCwd,
      env: Object.keys(env).length > 0 ? env : undefined,
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
            <label className="mb-1 block text-xs font-medium text-neutral-600">项目目录 <span className="text-red-500">*</span></label>
            <div className="flex gap-2">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} className="flex-1 rounded-md border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-neutral-400" placeholder="/path/to/project" />
              <DirectoryBrowseButton deviceId={deviceId} daemonVersion={daemonVersion} onSelect={setCwd} onError={setError} />
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">Agent 启动时的工作目录</p>
          </div>
          <EnvironmentVariableEditor rows={envRows} onChange={setEnvRows} />
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
