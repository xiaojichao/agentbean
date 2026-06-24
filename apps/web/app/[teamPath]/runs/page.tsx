'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Monitor,
  Terminal,
  XCircle,
} from 'lucide-react';
import { agentEvents, channelEvents, deviceEvents, dmEvents, fetchTeamWorkspaceRuns, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { formatRelative } from '@/lib/format-time';
import type { AgentSnapshot, TeamWorkspaceRun, WorkspaceRunStatus } from '@/lib/schema';

const STATUS_CONFIG: Record<WorkspaceRunStatus, { bg: string; icon: typeof CheckCircle2; label: string }> = {
  running: { bg: 'bg-blue-50 text-blue-700', icon: Clock, label: '运行中' },
  succeeded: { bg: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2, label: '成功' },
  failed: { bg: 'bg-red-50 text-red-700', icon: XCircle, label: '失败' },
  cancelled: { bg: 'bg-neutral-100 text-neutral-500', icon: AlertCircle, label: '已取消' },
};

function shortId(id: string): string {
  return `${id.slice(0, 8)}...`;
}

const DATE_BUCKET_LABELS: Record<string, string> = {
  today: '今天',
  yesterday: '昨天',
  'this-week': '本周',
  older: '更早',
};
const DATE_BUCKET_ORDER = ['today', 'yesterday', 'this-week', 'older'];
type RunGroupBy = '' | 'agent' | 'date' | 'status';

function normalizeGroupBy(value: string | null): RunGroupBy {
  if (value === 'agent' || value === 'date' || value === 'status') return value;
  return '';
}

function dateBucketKey(updatedAt: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  if (updatedAt >= todayMs) return 'today';
  if (updatedAt >= todayMs - dayMs) return 'yesterday';
  if (updatedAt >= startOfWeek.getTime()) return 'this-week';
  return 'older';
}

function groupKeyFor(
  run: TeamWorkspaceRun['workspaceRun'],
  groupBy: Exclude<RunGroupBy, ''>,
  agents: Record<string, AgentSnapshot>,
): { key: string; label: string } {
  if (groupBy === 'agent') {
    const agent = agents[run.agentId];
    return { key: run.agentId, label: agent?.name ?? shortId(run.agentId) };
  }
  if (groupBy === 'status') {
    return { key: run.status, label: STATUS_CONFIG[run.status]?.label ?? run.status };
  }
  const bucket = dateBucketKey(run.updatedAt);
  return { key: bucket, label: DATE_BUCKET_LABELS[bucket] ?? bucket };
}

function sourceMessageHref(np: string, channelId: string, messageId: string | undefined, dms: Array<{ id: string }>): string | null {
  if (!messageId) return null;
  const routeKind = dms.some((dm) => dm.id === channelId) ? 'dm' : 'channel';
  return `/${np}/${routeKind}/${encodeURIComponent(channelId)}?message=${encodeURIComponent(`${channelId}:${messageId}`)}`;
}

export default function TeamWorkspaceRunsPage() {
  const np = useCurrentTeamPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const agents = useAgentBeanStore((s) => s.agents);
  const devices = useAgentBeanStore((s) => s.devices);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyDeviceStatus = useAgentBeanStore((s) => s.applyDeviceStatus);

  const [runs, setRuns] = useState<TeamWorkspaceRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const router = useRouter();
  const searchParams = useSearchParams();
  const statusFilter = searchParams.get('status') ?? '';
  const agentFilter = searchParams.get('agentId') ?? '';
  const deviceFilter = searchParams.get('deviceId') ?? '';
  const groupBy = normalizeGroupBy(searchParams.get('groupBy'));
  const hasFilter = Boolean(statusFilter || agentFilter || deviceFilter);
  const updateFilter = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      const query = params.toString();
      router.replace(`/${np}/runs${query ? `?${query}` : ''}`, { scroll: false });
    },
    [np, router, searchParams],
  );

  const filters = useMemo(
    () => ({
      agentId: agentFilter || undefined,
      deviceId: deviceFilter || undefined,
      status: (statusFilter || undefined) as WorkspaceRunStatus | undefined,
    }),
    [agentFilter, deviceFilter, statusFilter],
  );

  useEffect(() => {
    if (conn !== 'open' || !currentTeamId) return;
    const socket = getWebSocket();
    const agentsApi = agentEvents(socket);
    agentsApi.subscribe(currentTeamId);
    channelEvents(socket).subscribe(currentTeamId);
    dmEvents(socket).list().then((res) => {
      if (res.ok && res.dms) applyDmsSnapshot(res.dms);
    });
    deviceEvents(socket).subscribe(currentTeamId);
    const unsubAgents = agentsApi.onSnapshot(applyAgentsSnapshot);
    const unsubAgentStatus = agentsApi.onStatus(applyAgentStatus);
    const unsubDevices = deviceEvents(socket).onSnapshot(applyDevicesSnapshot);
    const unsubDeviceStatus = deviceEvents(socket).onStatus(applyDeviceStatus);
    const unsubDms = dmEvents(socket).onSnapshot(applyDmsSnapshot);
    socket.on('channels:snapshot', applyChannelsSnapshot);
    return () => {
      unsubAgents();
      unsubAgentStatus();
      unsubDevices();
      unsubDeviceStatus();
      unsubDms();
      socket.off('channels:snapshot', applyChannelsSnapshot);
    };
  }, [conn, currentTeamId, applyAgentsSnapshot, applyAgentStatus, applyChannelsSnapshot, applyDmsSnapshot, applyDevicesSnapshot, applyDeviceStatus]);

  useEffect(() => {
    if (!currentTeamId) return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    fetchTeamWorkspaceRuns(currentTeamId, filters)
      .then((res) => {
        if (cancelled || requestVersion.current !== version) return;
        if (res.ok) {
          setRuns(res.runs ?? []);
          setNextCursor(res.nextCursor ?? null);
        } else {
          setError(res.error ?? '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled && requestVersion.current === version) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTeamId, filters]);

  const loadMore = useCallback(() => {
    if (!currentTeamId || !nextCursor || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    fetchTeamWorkspaceRuns(currentTeamId, filters, { cursor: nextCursor })
      .then((res) => {
        if (requestVersion.current !== version) return;
        if (res.ok) {
          setRuns((prev) => [...prev, ...(res.runs ?? [])]);
          setNextCursor(res.nextCursor ?? null);
        }
      })
      .finally(() => {
        if (requestVersion.current === version) setLoadingMore(false);
      });
  }, [currentTeamId, nextCursor, loadingMore, filters]);

  const orderedRuns = useMemo(
    () => [...runs].sort((a, b) => b.workspaceRun.updatedAt - a.workspaceRun.updatedAt),
    [runs],
  );

  const groupedRuns = useMemo(() => {
    if (!groupBy) {
      return [{ key: '__all__', label: '', runs: orderedRuns }];
    }
    const map = new Map<string, { label: string; runs: TeamWorkspaceRun[]; latest: number }>();
    for (const item of orderedRuns) {
      const g = groupKeyFor(item.workspaceRun, groupBy, agents);
      const existing = map.get(g.key);
      if (existing) {
        existing.runs.push(item);
        existing.latest = Math.max(existing.latest, item.workspaceRun.updatedAt);
      } else {
        map.set(g.key, { label: g.label, runs: [item], latest: item.workspaceRun.updatedAt });
      }
    }
    const entries = Array.from(map.entries()).map(([key, value]) => ({ key, ...value }));
    if (groupBy === 'date') {
      entries.sort((a, b) => DATE_BUCKET_ORDER.indexOf(a.key) - DATE_BUCKET_ORDER.indexOf(b.key));
    } else {
      entries.sort((a, b) => b.latest - a.latest);
    }
    return entries;
  }, [orderedRuns, groupBy, agents]);

  const renderRunCard = ({ workspaceRun, artifacts }: TeamWorkspaceRun) => {
    const statusCfg = STATUS_CONFIG[workspaceRun.status] ?? STATUS_CONFIG.running;
    const StatusIcon = statusCfg.icon;
    const agent = agents[workspaceRun.agentId];
    const device = workspaceRun.deviceId ? devices[workspaceRun.deviceId] : undefined;
    const channel = channels.find((item) => item.id === workspaceRun.channelId);
    const dm = dms.find((item) => item.id === workspaceRun.channelId);
    const messageHref = sourceMessageHref(np, workspaceRun.channelId, workspaceRun.messageId, dms);
    const agentLabel = agent?.name ?? shortId(workspaceRun.agentId);
    const deviceLabel = device?.hostname ?? (workspaceRun.deviceId ? shortId(workspaceRun.deviceId) : '未绑定设备');
    const sourceLabel = dm?.name ?? channel?.name ?? shortId(workspaceRun.channelId);
    return (
      <article key={workspaceRun.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${statusCfg.bg}`}>
                <StatusIcon className="h-3.5 w-3.5" />
                {statusCfg.label}
              </span>
              <span className="text-xs text-neutral-400">{formatRelative(workspaceRun.updatedAt)}</span>
              <span className="text-xs font-mono text-neutral-400">{shortId(workspaceRun.id)}</span>
            </div>
            <Link
              href={`/${np}/runs/${workspaceRun.id}`}
              className="block truncate text-sm font-semibold text-neutral-900 hover:text-blue-600"
            >
              {workspaceRun.command || workspaceRun.cwd || workspaceRun.id}
            </Link>
            {workspaceRun.cwd && (
              <p className="mt-1 truncate text-xs font-mono text-neutral-500">{workspaceRun.cwd}</p>
            )}
          </div>
          <Link
            href={`/${np}/runs/${workspaceRun.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            查看详情
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Link href={`/${np}/agents/${workspaceRun.agentId}`} className="min-w-0 rounded-md bg-neutral-50 px-3 py-2 hover:bg-neutral-100">
            <p className="mb-1 text-neutral-400">Agent</p>
            <p className="truncate font-medium text-neutral-700">{agentLabel}</p>
          </Link>
          <Link href={workspaceRun.deviceId ? `/${np}/devices/${workspaceRun.deviceId}` : `/${np}/devices`} className="min-w-0 rounded-md bg-neutral-50 px-3 py-2 hover:bg-neutral-100">
            <p className="mb-1 text-neutral-400">设备</p>
            <p className="flex min-w-0 items-center gap-1.5 font-medium text-neutral-700">
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{deviceLabel}</span>
            </p>
          </Link>
          <div className="min-w-0 rounded-md bg-neutral-50 px-3 py-2">
            <p className="mb-1 text-neutral-400">输出</p>
            <p className="flex items-center gap-1.5 font-medium text-neutral-700">
              <FileText className="h-3.5 w-3.5" />
              {artifacts.length} 个文件
            </p>
          </div>
          <div className="min-w-0 rounded-md bg-neutral-50 px-3 py-2">
            <p className="mb-1 text-neutral-400">退出码</p>
            <p className={`font-mono font-medium ${workspaceRun.exitCode === 0 ? 'text-emerald-600' : workspaceRun.exitCode === undefined ? 'text-neutral-400' : 'text-red-600'}`}>
              {workspaceRun.exitCode ?? '未完成'}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3.5 w-3.5" />
            {sourceLabel}
          </span>
          {messageHref && (
            <Link href={messageHref} className="font-medium text-blue-600 hover:underline">
              返回消息
            </Link>
          )}
        </div>
      </article>
    );
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
        <span className="ml-2 text-sm text-neutral-500">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-start gap-3 rounded-lg bg-red-50 p-4 text-red-700">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">加载失败</p>
            <p className="mt-1 text-sm">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">执行记录</h1>
          <p className="mt-1 text-sm text-neutral-500">Agent 在设备上执行后的状态、日志和输出文件记录</p>
        </div>
        <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
          {orderedRuns.length} 条
        </span>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3">
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <span>状态</span>
          <select
            value={statusFilter}
            onChange={(e) => updateFilter('status', e.target.value)}
            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            <option value="running">运行中</option>
            <option value="succeeded">成功</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <span>Agent</span>
          <select
            value={agentFilter}
            onChange={(e) => updateFilter('agentId', e.target.value)}
            className="max-w-[12rem] rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {Object.values(agents).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <span>设备</span>
          <select
            value={deviceFilter}
            onChange={(e) => updateFilter('deviceId', e.target.value)}
            className="max-w-[12rem] rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">全部</option>
            {Object.values(devices).map((device) => (
              <option key={device.id} value={device.id}>
                {device.hostname ?? device.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <span>分组</span>
          <select
            value={groupBy}
            onChange={(e) => updateFilter('groupBy', e.target.value)}
            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">无</option>
            <option value="agent">Agent</option>
            <option value="date">日期</option>
            <option value="status">状态</option>
          </select>
        </label>
        {hasFilter && (
          <button
            type="button"
            onClick={() => router.replace(`/${np}/runs`, { scroll: false })}
            className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
          >
            清除筛选
          </button>
        )}
      </div>

      {orderedRuns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-10 text-center">
          <Terminal className="mx-auto mb-3 h-8 w-8 text-neutral-300" />
          <p className="text-sm font-medium text-neutral-700">暂无执行记录</p>
          <p className="mt-1 text-sm text-neutral-400">Agent 在设备上完成执行并上报日志或文件后会出现在这里。</p>
        </div>
      ) : groupBy ? (
        <div className="space-y-5">
          {groupedRuns.map((group) => (
            <details key={group.key} open className="rounded-lg border border-neutral-200 bg-white">
              <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-neutral-800">
                {group.label}
                <span className="ml-2 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-normal text-neutral-500">
                  {group.runs.length}
                </span>
              </summary>
              <div className="space-y-3 px-4 pb-4 pt-1">{group.runs.map(renderRunCard)}</div>
            </details>
          ))}
        </div>
      ) : (
        <div className="space-y-3">{orderedRuns.map(renderRunCard)}</div>
      )}

      {nextCursor && !loading && !error && (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {loadingMore ? '加载中...' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
