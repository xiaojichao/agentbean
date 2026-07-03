# 执行记录迁移至设置页「执行记录诊断」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「执行记录」从侧边栏一级入口移除，降级为设置页第 5 个 tab「执行记录诊断」，顺带消除 runs 列表页的 overflow bug。

**Architecture:** 新建 `RunsPanel` 组件（从 `runs/page.tsx` 迁移列表主体，过滤器从 URL state 改为 local state），嵌入设置页 tab 体系；`runs/page.tsx` 改为 redirect 到设置页；侧边栏删除「诊断」分组；同步更新 smoke 脚本（`scripts/smoke-agentbean-next-browser.mjs`）和就绪检查脚本（`scripts/check-agentbean-next-readiness.mjs`）这两个 `data-smoke` 消费者。

**Tech Stack:** Next.js 14 App Router（`apps/web-next`）、React 18、TypeScript、Tailwind、vitest、自研浏览器 smoke 脚本。

## Global Constraints

- 生产前端是 `apps/web-next`（动态段 `[networkPath]`），不是 legacy `apps/web`。
- URL 策略 A：设置页 tab 维持纯前端 `useState`，切换不改 URL；旧 `/{np}/runs` 列表地址 redirect 到 `/{np}/settings`。
- `data-smoke="..."` 是跨包契约，被 `scripts/smoke-agentbean-next-browser.mjs`（UI smoke）和 `scripts/check-agentbean-next-readiness.mjs`（就绪检查）消费——迁移标识位置时必须同步这两个消费者。
- 详情路由 `/{np}/runs/{runId}` 保留不动；后端 API、cursor 分页机制不动。
- 所有 UI 文案用中文。
- 多会话共享 main 分支：执行前用 `superpowers:using-git-worktrees` 建隔离 worktree。

## 偏离 spec 的一处决策（已分析，需知会用户）

spec「数据流不变」指的是 `fetchTeamWorkspaceRuns` API 调用不变。但 runs 页过滤器当前绑在 URL（`useSearchParams`），RunsPanel 进设置页后 URL 过滤器会把用户 navigate 出设置页。故 Task 1 把过滤器从 URL state 改为 local state——与方案 A「tab 不在 URL」一致。原 `/runs?status=succeeded` 可分享性随 redirect 消失（方案 A 已接受代价）。

---

### Task 1: 创建 RunsPanel 组件（含过滤器 URL→local 重构）

**Files:**
- Create: `apps/web-next/app/[networkPath]/settings/RunsPanel.tsx`

**Interfaces:**
- Consumes: `@/lib/socket`（`fetchTeamWorkspaceRuns` 等）、`@/lib/store`（`useAgentBeanStore`、`useCurrentNetworkPath`）、`@/lib/format-time`、`@/lib/schema`
- Produces: 命名导出 `RunsPanel()`（无 props），供 Task 2 的 `settings/page.tsx` 渲染

- [ ] **Step 1: 创建 RunsPanel.tsx，迁移 + 重构**

把 `runs/page.tsx` 的全部常量/helper（第 1-81 行 `STATUS_CONFIG`、`shortId`、`DATE_BUCKET_*`、`normalizeGroupBy`、`dateBucketKey`、`groupKeyFor`、`sourceMessageHref`）和组件主体迁过来，做三处实质改动：

1. 导出改为 `export function RunsPanel()`（去掉 `default`、去掉 `useSearchParams`/`useRouter` import）。
2. 过滤器改 local state（替换原 105-134 行的 URL 逻辑）。
3. 最外层外壳去掉 `p-6`（设置页内容区已有 `p-6`），保留 `mx-auto max-w-5xl` 和 `data-smoke="workspace-runs-page"`。

完整目标文件内容：

```tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
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

function normalizeGroupBy(value: string): RunGroupBy {
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

export function RunsPanel() {
  const np = useCurrentNetworkPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const teams = useAgentBeanStore((s) => s.teams);
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
  const params = useParams();

  // 过滤器改为本地 state（原 runs/page.tsx 用 URL searchParams，进设置页 tab 后会 navigate 走，故改 local）
  const [statusFilter, setStatusFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [groupBy, setGroupBy] = useState<RunGroupBy>('');

  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : np;
  const routeTeamId = teams.find((team) => team.path === routeNetworkPath || team.id === routeNetworkPath)?.id;
  const workspaceTeamId = routeTeamId ?? (routeNetworkPath === 'default' ? currentTeamId : '');
  const hasFilter = Boolean(statusFilter || agentFilter || deviceFilter);

  const clearFilters = useCallback(() => {
    setStatusFilter('');
    setAgentFilter('');
    setDeviceFilter('');
    setGroupBy('');
  }, []);

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
    if (!workspaceTeamId) return;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    fetchTeamWorkspaceRuns(workspaceTeamId, filters)
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
  }, [workspaceTeamId, filters]);

  const loadMore = useCallback(() => {
    if (!workspaceTeamId || !nextCursor || loadingMore) return;
    const version = requestVersion.current;
    setLoadingMore(true);
    fetchTeamWorkspaceRuns(workspaceTeamId, filters, { cursor: nextCursor })
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
  }, [workspaceTeamId, nextCursor, loadingMore, filters]);

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
    const hasFullLogArtifact = artifacts.some((artifact) =>
      artifact.relativePath === 'logs/workspace-run.log' || artifact.filename === 'workspace-run.log'
    );
    return (
      <article
        key={workspaceRun.id}
        className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
        data-smoke="workspace-run-card"
        data-run-id={workspaceRun.id}
        data-run-command={workspaceRun.command ?? ''}
        data-run-status={workspaceRun.status}
        data-run-has-full-log={hasFullLogArtifact ? 'true' : 'false'}
      >
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
              data-smoke="workspace-run-detail-link"
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
            data-smoke="workspace-run-detail-link"
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
              <span>{artifacts.length} 个文件</span>
              {hasFullLogArtifact && (
                <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                  完整日志
                </span>
              )}
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
      <div className="mx-auto max-w-3xl">
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
    <div className="mx-auto max-w-5xl" data-smoke="workspace-runs-page">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900">执行记录</h1>
          <p className="mt-1 text-sm text-neutral-500">Agent 在设备上执行后的状态、日志和输出文件记录</p>
        </div>
        <span
          className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600"
          data-smoke="workspace-runs-count"
        >
          {orderedRuns.length} 条
        </span>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3">
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <span>状态</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
            data-smoke="workspace-runs-filter-status"
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
            onChange={(e) => setAgentFilter(e.target.value)}
            className="max-w-[12rem] rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
            data-smoke="workspace-runs-filter-agent"
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
            onChange={(e) => setDeviceFilter(e.target.value)}
            className="max-w-[12rem] rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
            data-smoke="workspace-runs-filter-device"
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
            onChange={(e) => setGroupBy(normalizeGroupBy(e.target.value))}
            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-sm"
            data-smoke="workspace-runs-filter-group"
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
            onClick={clearFilters}
            className="ml-auto rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
            data-smoke="workspace-runs-filter-clear"
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
            <details
              key={group.key}
              open
              className="rounded-lg border border-neutral-200 bg-white"
              data-smoke="workspace-runs-group"
              data-group-key={group.key}
              data-group-label={group.label}
            >
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
            data-smoke="workspace-runs-load-more"
          >
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
            {loadingMore ? '加载中...' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd apps/web-next && npx tsc --noEmit -p tsconfig.json`
Expected: 无报错（RunsPanel 独立存在、未接入，但能编译通过）。若报 contracts 类型缺失，先 `npm run build:packages` 生成 `@agentbean/contracts` 类型。

- [ ] **Step 3: 提交**

```bash
git add apps/web-next/app/[networkPath]/settings/RunsPanel.tsx
git commit -m "新增 RunsPanel 组件（从 runs 页迁移，过滤器改 local state）"
```

---

### Task 2: 设置页接入「执行记录诊断」tab

**Files:**
- Modify: `apps/web-next/app/[networkPath]/settings/page.tsx`（第 1-26 行 import/TABS、第 36-67 行 SettingsPage）

**Interfaces:**
- Consumes: Task 1 的 `RunsPanel`
- Produces: 设置页第 5 个 tab「执行记录诊断」，点击切换渲染 RunsPanel

- [ ] **Step 1: 改 Tab 类型与 TABS 数组**

`page.tsx` 第 19 行 `type Tab` 加 `'runs'`：
```ts
type Tab = 'account' | 'browser' | 'server' | 'runs' | 'releases';
```

第 21-26 行 `TABS` 数组，在 `server` 之后、`releases` 之前插入 runs 项：
```ts
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'account', label: '账号', icon: <User size={16} /> },
  { id: 'browser', label: '浏览器', icon: <Globe size={16} /> },
  { id: 'server', label: '团队', icon: <Server size={16} /> },
  { id: 'runs', label: '执行记录诊断', icon: <Terminal size={16} /> },
  { id: 'releases', label: '更新日志', icon: <FileText size={16} /> },
];
```

第 5 行 import 增加 `Terminal`（若尚未引入）。第 4 行 lucide-react import 行追加 `Terminal`：
```ts
import { User, Globe, Server, FileText, LogOut, Check, Copy, Trash2, Bell, Volume2, Keyboard, PanelRight, RotateCcw, Terminal } from 'lucide-react';
```

- [ ] **Step 2: import RunsPanel 并在内容区渲染**

在 `page.tsx` 顶部 import 区（第 9 行 `useParams, useRouter` 之后）加：
```ts
import { RunsPanel } from './RunsPanel';
```

第 59-62 行内容区条件渲染块，加一行 runs 分支（与其他 panel 并列）：
```tsx
        <ConnectionBanner />
        {tab === 'account' && <AccountPanel />}
        {tab === 'browser' && <BrowserPanel />}
        {tab === 'server' && <ServerPanel />}
        {tab === 'runs' && <RunsPanel />}
        {tab === 'releases' && <ReleasesPanel />}
```

- [ ] **Step 3: typecheck**

Run: `cd apps/web-next && npx tsc --noEmit -p tsconfig.json`
Expected: 无报错。

- [ ] **Step 4: 手动验证设置页新 tab（本地 dev）**

Run: `cd apps/web-next && npm run dev`（端口 4101），浏览器开 `http://localhost:4101/<team-path>/settings`，点「执行记录诊断」tab。
Expected: tab 切换到 RunsPanel；列表能正常加载、**可上下滚动到底部**（overflow bug 在此容器内消失）、「加载更多」可见可点；切回其他 tab 正常。

- [ ] **Step 5: 提交**

```bash
git add apps/web-next/app/[networkPath]/settings/page.tsx
git commit -m "设置页新增「执行记录诊断」tab 渲染 RunsPanel"
```

---

### Task 3: runs/page.tsx 改为 redirect 到设置页

**Files:**
- Modify: `apps/web-next/app/[networkPath]/runs/page.tsx`（整文件替换为薄 redirect）

**Interfaces:**
- Consumes: 无（纯 redirect）
- Produces: `GET /{np}/runs` 永远 302 到 `/{np}/settings`

- [ ] **Step 1: 用 redirect 薄壳替换整个 page.tsx**

`runs/page.tsx` 整文件替换为（`redirect` 在 Next.js client 组件渲染期调用会抛出 navigation，被框架捕获执行跳转）：
```tsx
import { redirect } from 'next/navigation';

export default function TeamWorkspaceRunsPage({
  params,
}: {
  params: { networkPath: string };
}) {
  redirect(`/${params.networkPath}/settings`);
}
```

注意：`runs/[runId]/page.tsx` 详情页保持不动。

- [ ] **Step 2: typecheck + 验证 redirect**

Run: `cd apps/web-next && npx tsc --noEmit -p tsconfig.json`
Expected: 无报错（旧 import 全部移除后无悬空引用）。

手动验证（dev 起着）：浏览器开 `http://localhost:4101/<team-path>/runs`。
Expected: 立即跳转到 `/<team-path>/settings`（落在默认 account tab）。

- [ ] **Step 3: 提交**

```bash
git add apps/web-next/app/[networkPath]/runs/page.tsx
git commit -m "runs 列表路由改为 redirect 到设置页"
```

---

### Task 4: 侧边栏删除「诊断」分组与执行记录入口

**Files:**
- Modify: `apps/web-next/components/sidebar.tsx`（第 140-147 行 Bottom 区块）

**Interfaces:**
- Consumes: 无
- Produces: 侧边栏底部只剩「设置」入口

- [ ] **Step 1: 删除诊断分组 + 执行记录 NavItem**

第 140-147 行当前为：
```tsx
      <div className="space-y-2 border-t border-neutral-200 px-2 py-2">
        <div>
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">诊断</p>
          <NavItem href={`/${np}/runs`} icon={<Terminal size={16} />} label="执行记录" active={isActive(`/${np}/runs`)} />
        </div>
        <NavItem href={`/${np}/settings`} icon={<Settings size={16} />} label="设置" active={isActive(`/${np}/settings`)} />
      </div>
```

替换为（移除诊断 div，保留设置）：
```tsx
      <div className="space-y-2 border-t border-neutral-200 px-2 py-2">
        <NavItem href={`/${np}/settings`} icon={<Settings size={16} />} label="设置" active={isActive(`/${np}/settings`)} />
      </div>
```

若 `Terminal` import 此后在该文件无其他使用，从第 5 行 lucide-react import 中移除 `Terminal`（grep 确认无其他引用再删）。

- [ ] **Step 2: typecheck + 手动验证**

Run: `cd apps/web-next && npx tsc --noEmit -p tsconfig.json`
Expected: 无报错（若移除了 Terminal import 却仍被引用会报错，据此判断）。

手动验证（dev）：侧边栏底部只有「设置」，无「诊断」分组、无「执行记录」入口。

- [ ] **Step 3: 提交**

```bash
git add apps/web-next/components/sidebar.tsx
git commit -m "侧边栏移除诊断分组与执行记录入口"
```

---

### Task 5: 更新 smoke 脚本（expectedRoutes 删 runs + runs 业务流改走设置页 tab）

**Files:**
- Modify: `scripts/smoke-agentbean-next-browser.mjs`（第 678-686 行 expectedRoutes、第 1512-1620 行 runs 业务流）

**Interfaces:**
- Consumes: Task 2 的 `data-smoke="settings-tab-runs"`、RunsPanel 保留的 `workspace-runs-*` 标识
- Produces: smoke 脚本匹配新 IA，`webui-runs-business-flow` 仍能通过

- [ ] **Step 1: expectedRoutes 删除 runs 项**

第 678-686 行 `expectedRoutes`，删除 runs 那行（redirect 后 `location.pathname === '/runs'` 断言必挂，故移除）：
```js
  const expectedRoutes = routes ?? [
    { path: `/${networkPath}/dashboard`, label: '仪表盘' },
    { path: `/${networkPath}/chat`, label: '聊天' },
    { path: `/${networkPath}/tasks`, label: '任务' },
    { path: `/${networkPath}/members`, label: '成员' },
    { path: `/${networkPath}/devices`, label: '设备' },
    { path: `/${networkPath}/settings`, label: '设置' },
  ];
```

- [ ] **Step 2: runs 业务流改为走设置页 tab**

第 1512 行起 `await page.navigate(new URL(\`/${networkPath}/runs\`, root).toString());` 改为导航到设置页并点开 runs tab：
```js
    await page.navigate(new URL(`/${networkPath}/settings`, root).toString());
    await page.click('[data-smoke="settings-tab-runs"]');
```

第 1514-1520 行的 `setInputValue('[data-smoke="workspace-runs-filter-..."]')` 保持不变（RunsPanel 保留这些标识，select 仍可驱动 local state）。后续 `workspace-runs-group`、`workspace-run-detail-link` 断言（第 1581、1615 行）保持不变。

第 1615 行 run 详情返回链接断言 `link?.getAttribute('href') === '/' + networkPath + '/runs'`——这是详情页「返回列表」链接。详情页 `runs/[runId]/page.tsx` 不动，该链接仍指向 `/{np}/runs`（会 redirect 回设置页）。断言的是 href 属性值（字符串），redirect 不影响属性，故**保持不变即可通过**。

- [ ] **Step 3: 跑 smoke 脚本的单元守护测试**

Run: `cd apps/server-next && npx vitest run tests/browser-smoke-script.test.ts`
Expected: PASS（该测试在 vitest 里静态校验 smoke 脚本逻辑，不需真实服务）。若该测试有断言依赖旧的 `/runs` 直达导航，按报错同步调整。

- [ ] **Step 4: 提交**

```bash
git add scripts/smoke-agentbean-next-browser.mjs
git commit -m "smoke 脚本适配执行记录迁入设置页"
```

---

### Task 6: 更新就绪检查脚本（检查目标改指 RunsPanel）

**Files:**
- Modify: `scripts/check-agentbean-next-readiness.mjs`（第 41 行文件读取、第 536-542 行标识检查）

**Interfaces:**
- Consumes: RunsPanel 含 `workspace-runs-*` 标识（Task 1 保证）
- Produces: `runs-parity-browser-smoke` 等 readiness check 通过

- [ ] **Step 1: 新增读取 RunsPanel.tsx**

第 41 行后追加读取 RunsPanel（保留原 runs/page.tsx 读取，因 redirect 后该文件仍存在，只是内容变了）：
```js
  const webNextRunsPage = readFileSync(join(root, 'apps/web-next/app/[networkPath]/runs/page.tsx'), 'utf8');
  const webNextRunsPanel = readFileSync(join(root, 'apps/web-next/app/[networkPath]/settings/RunsPanel.tsx'), 'utf8');
```

- [ ] **Step 2: 标识检查改指 RunsPanel**

第 536-542 行把 `webNextRunsPage.includes(...)` 改为 `webNextRunsPanel.includes(...)`（标识已随列表主体迁到 RunsPanel）：
```js
        webNextRunsPanel.includes('data-smoke="workspace-runs-page"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-status"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-agent"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-device"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-group"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-load-more"') &&
        webNextRunsPanel.includes('data-smoke="workspace-run-card"') &&
```

`webNextRunDetailPage.*`（第 543-547 行）保持不变（详情页未动）。

- [ ] **Step 3: 跑就绪检查**

Run: `node scripts/check-agentbean-next-readiness.mjs`
Expected: 所有 check 通过（特别确认含上述标识检查的那条 check 为 Green）。若 `webNextRunsPage` 变量删除/保留导致未使用告警，保留读取即可（无副作用）。

- [ ] **Step 4: 提交**

```bash
git add scripts/check-agentbean-next-readiness.mjs
git commit -m "就绪检查改指 RunsPanel 验证 runs 标识"
```

---

### Task 7: 全量验证与浏览器回归

**Files:** 无（纯验证）

- [ ] **Step 1: 全量 typecheck + build**

Run:
```bash
cd apps/web-next && npx tsc --noEmit -p tsconfig.json
npm run build
```
Expected: typecheck 无报错；`next build` 成功。

- [ ] **Step 2: 全量测试套件**

Run: `cd apps/web-next && npm test`
Expected: vitest 全绿（现有 10 个测试文件不受影响）。

- [ ] **Step 3: smoke + readiness 全绿**

Run:
```bash
cd apps/server-next && npx vitest run tests/browser-smoke-script.test.ts
node scripts/check-agentbean-next-readiness.mjs
```
Expected: 两者全绿。

- [ ] **Step 4: 浏览器手动回归（chrome-devtools）**

本地或预发环境打开 `/<team-path>/settings`，逐项确认 spec 验证清单：
1. 侧边栏无「执行记录」入口，「诊断」分组消失
2. 设置页出现「执行记录诊断」tab，可切换
3. tab 内列表正常显示、**可滚动到底部**、「加载更多」可用（回归原 overflow bug 已修复）
4. 旧地址 `/<team-path>/runs` 自动跳转到 `/<team-path>/settings`
5. 卡片「查看详情」→ `/<team-path>/runs/<runId>` 正常打开
6. 刷新设置页 → 回默认 tab（账号，方案 A 预期行为）

Expected: 6 项全部符合。

- [ ] **Step 5: 更新 plan 勾选 + 收尾**

把本 plan 所有 checkbox 勾选完成；若全程在 worktree，按 `superpowers:finishing-a-development-branch` 决定合并/PR。

---

## Self-Review（写完后自检）

**1. Spec 覆盖：**
- D1 新增 tab → Task 2 ✓
- D2 方案 A → 全局约束 + Task 3 redirect（不改 URL）✓
- D3 redirect /runs → Task 3 ✓；详情页保留 → Task 3 注明不动 ✓
- D4 侧边栏精简 → Task 4 ✓
- D5 RunsPanel 抽组件 → Task 1 ✓
- D6 overflow bug → Task 2 Step 4 验证可滚动 ✓
- 次要决策（tab 位置/图标/标题）→ Task 2（位置: server 后 releases 前、图标 Terminal、panel 标题「执行记录」）✓
- 跨包契约（smoke/readiness）→ Task 5、Task 6 ✓

**2. 占位符扫描：** 无 TBD/TODO；RunsPanel 完整代码已给出；所有改动有精确行号 + 代码。

**3. 类型一致性：** `RunsPanel` 命名导出在 Task 1 定义、Task 2 import 使用，一致；`Tab` 类型加 `'runs'` 与 TABS `id: 'runs'`、`tab === 'runs'` 三处一致；`data-smoke="settings-tab-runs"` 在 Task 2 渲染（隐含于 settings tab 按钮的 `data-smoke={\`settings-tab-${t.id}\`}` 模板，第 46 行既有逻辑自动生成）、Task 5 click 使用，一致。

**4. 已知执行期风险：**
- Next.js 14 中 `params` 在 client 组件是 Promise 与否取决于版本——Task 3 的 redirect page 若 TS 报 params 类型错，改为 `useParams()` 取 networkPath 后 redirect（client 组件用法）。
- `browser-smoke-script.test.ts` 若对 runs 业务流有更深断言，Task 5 Step 3 按报错调整。
