'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  Monitor,
  FolderOpen,
  Paperclip,
  Loader2,
  AlertCircle,
  Download,
  ExternalLink,
  MessageSquare,
  Copy,
  FileDown,
  WrapText,
} from 'lucide-react';
import { fetchWorkspaceRunDetail, fetchWorkspaceRunLog, authedApiUrl } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { formatRelative } from '@/lib/format-time';
import type { WorkspaceRunDetail, WorkspaceArtifact, WorkspaceRunStatus } from '@/lib/schema';

const STATUS_CONFIG: Record<WorkspaceRunStatus, { bg: string; icon: typeof CheckCircle2; label: string }> = {
  running: { bg: 'bg-blue-50 text-blue-700', icon: Clock, label: '运行中' },
  succeeded: { bg: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2, label: '成功' },
  failed: { bg: 'bg-red-50 text-red-700', icon: XCircle, label: '失败' },
  cancelled: { bg: 'bg-neutral-100 text-neutral-500', icon: AlertCircle, label: '已取消' },
};

const LOG_EXCERPT_MAX_CHARS = 16000;

function formatDuration(start?: number, end?: number): string | null {
  if (!start || !end) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

function artifactDownloadUrl(teamId: string, artifactId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

function artifactPreviewUrl(teamId: string, artifactId: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/artifacts/${encodeURIComponent(artifactId)}/preview`;
}

function artifactPathLabel(artifact: WorkspaceArtifact): string {
  return artifact.relativePath || artifact.filename;
}

function isWorkspaceRunLogArtifact(artifact: WorkspaceArtifact): boolean {
  return artifact.relativePath === 'logs/workspace-run.log' || artifact.filename === 'workspace-run.log';
}

interface ArtifactTreeEntry {
  type: 'dir' | 'file';
  path: string;
  name: string;
  depth: number;
  artifact?: WorkspaceArtifact;
  fileCount?: number;
}

function buildArtifactTreeEntries(artifacts: WorkspaceArtifact[]): ArtifactTreeEntry[] {
  const dirs = new Set<string>();
  for (const artifact of artifacts) {
    const parts = artifactPathLabel(artifact).split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join('/'));
    }
  }

  const dirEntries: ArtifactTreeEntry[] = Array.from(dirs).map((path) => {
    const parts = path.split('/');
    return {
      type: 'dir',
      path,
      name: parts.at(-1) ?? path,
      depth: Math.max(0, parts.length - 1),
      fileCount: artifacts.filter((artifact) => artifactPathLabel(artifact).startsWith(`${path}/`)).length,
    };
  });
  const fileEntries: ArtifactTreeEntry[] = artifacts.map((artifact) => {
    const path = artifactPathLabel(artifact);
    const parts = path.split('/').filter(Boolean);
    return {
      type: 'file',
      path,
      name: parts.at(-1) ?? artifact.filename,
      depth: Math.max(0, parts.length - 1),
      artifact,
    };
  });

  return [...dirEntries, ...fileEntries].sort((a, b) => {
    const pathOrder = a.path.localeCompare(b.path);
    if (pathOrder !== 0) return pathOrder;
    if (a.type === b.type) return 0;
    return a.type === 'dir' ? -1 : 1;
  });
}

export default function RunDetailPage() {
  const params = useParams<{ networkPath: string; runId: string }>();
  const np = useCurrentNetworkPath();
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const teams = useAgentBeanStore((s) => s.teams);
  const agents = useAgentBeanStore((s) => s.agents);
  const dms = useAgentBeanStore((s) => s.dms);

  const [data, setData] = useState<{ workspaceRun: WorkspaceRunDetail; artifacts: WorkspaceArtifact[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedLog, setCopiedLog] = useState(false);
  const [wrapLog, setWrapLog] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [fullLogText, setFullLogText] = useState<string | null>(null);
  const [fullLogLoading, setFullLogLoading] = useState(false);
  const [fullLogError, setFullLogError] = useState<string | null>(null);
  const [fullLogQuery, setFullLogQuery] = useState('');
  const [fullLogMeta, setFullLogMeta] = useState<{
    mode: 'tail' | 'search';
    totalLines: number;
    returnedLines: number;
    matchedLines?: number;
    truncated: boolean;
    query?: string;
  } | null>(null);

  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : np;
  const routeTeamId = teams.find((team) => team.path === routeNetworkPath || team.id === routeNetworkPath)?.id;
  const workspaceTeamId = routeTeamId ?? (routeNetworkPath === 'default' ? currentTeamId : '');
  const runId = params.runId;

  useEffect(() => {
    if (!workspaceTeamId || !runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFullLogText(null);
    setFullLogLoading(false);
    setFullLogError(null);
    setFullLogQuery('');
    setFullLogMeta(null);
    fetchWorkspaceRunDetail(workspaceTeamId, runId)
      .then((res) => {
        if (!cancelled) {
          if (res.ok && res.workspaceRun && res.artifacts) {
            setData({ workspaceRun: res.workspaceRun, artifacts: res.artifacts });
          } else {
            setError(res.error ?? '加载失败');
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceTeamId, runId]);

  useEffect(() => {
    if (!data?.workspaceRun.logExcerpt) {
      setLogOpen(false);
      return;
    }
    setLogOpen(data.workspaceRun.status === 'failed');
    setCopiedLog(false);
    setWrapLog(true);
  }, [data?.workspaceRun.id, data?.workspaceRun.status, data?.workspaceRun.logExcerpt]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
        <span className="ml-2 text-neutral-500">加载中...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-red-50 text-red-700 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">加载失败</p>
            <p className="text-sm mt-1">{error ?? '未找到该运行记录'}</p>
          </div>
        </div>
        <Link
          href={`/${np}/runs`}
          className="mt-4 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" /> 返回执行记录
        </Link>
      </div>
    );
  }

  const { workspaceRun: run, artifacts } = data;
  const statusCfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.running;
  const StatusIcon = statusCfg.icon;
  const agentName = agents[run.agentId]?.name ?? run.agentId;
  const duration = formatDuration(run.startedAt, run.completedAt);
  const sourceRouteKind = dms.some((dm) => dm.id === run.channelId) ? 'dm' : 'channel';
  const sourceMessageId = run.sourceMessageId ?? run.messageId;
  const sourceMessageHref = sourceMessageId
    ? `/${np}/${sourceRouteKind}/${encodeURIComponent(run.channelId)}?message=${encodeURIComponent(`${run.channelId}:${sourceMessageId}`)}`
    : null;
  const logLines = run.logExcerpt?.split(/\r\n|\r|\n/) ?? [];
  const logCharCount = run.logExcerpt?.length ?? 0;
  const logLooksTruncated = logCharCount >= LOG_EXCERPT_MAX_CHARS;
  const fullLogArtifact = artifacts.find(isWorkspaceRunLogArtifact);
  const fullLogMatchCount = fullLogMeta?.matchedLines ?? fullLogMeta?.returnedLines ?? 0;
  const artifactTreeEntries = buildArtifactTreeEntries(artifacts);
  const artifactTreeDirCount = artifactTreeEntries.filter((entry) => entry.type === 'dir').length;

  const copyLogExcerpt = () => {
    if (!run.logExcerpt) return;
    navigator.clipboard.writeText(run.logExcerpt);
    setCopiedLog(true);
    window.setTimeout(() => setCopiedLog(false), 1600);
  };

  const downloadLogExcerpt = () => {
    if (!run.logExcerpt) return;
    const blob = new Blob([run.logExcerpt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `workspace-run-${run.id.slice(0, 8)}-log.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const loadFullLogInline = async (query = '') => {
    if (!fullLogArtifact || fullLogLoading) return;
    setFullLogLoading(true);
    setFullLogError(null);
    const result = await fetchWorkspaceRunLog(workspaceTeamId, run.id, {
      query: query.trim() || undefined,
      tailLines: 200,
    });
    if (result.ok && typeof result.text === 'string') {
      setFullLogText(result.text);
      setFullLogMeta({
        mode: result.mode ?? (query.trim() ? 'search' : 'tail'),
        totalLines: result.totalLines ?? 0,
        returnedLines: result.returnedLines ?? 0,
        ...(result.matchedLines !== undefined ? { matchedLines: result.matchedLines } : {}),
        truncated: Boolean(result.truncated),
        ...(result.query ? { query: result.query } : {}),
      });
    } else {
      setFullLogError(result.error ?? '完整日志加载失败');
    }
    setFullLogLoading(false);
  };

  // Group artifacts by directory
  const artifactsByDir = new Map<string, WorkspaceArtifact[]>();
  for (const a of artifacts) {
    const dir = a.relativePath?.includes('/') ? a.relativePath.substring(0, a.relativePath.lastIndexOf('/')) : '';
    const list = artifactsByDir.get(dir) ?? [];
    list.push(a);
    artifactsByDir.set(dir, list);
  }

  return (
    <div
      className="max-w-4xl mx-auto p-6 space-y-6"
      data-smoke="workspace-run-detail"
      data-run-id={run.id}
      data-run-command={run.command ?? ''}
      data-run-status={run.status}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/${np}/agents/${run.agentId}`} className="text-neutral-400 hover:text-neutral-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-neutral-900">执行详情</h1>
          <p className="text-sm text-neutral-500">
            {run.id.slice(0, 8)}... · {formatRelative(run.createdAt)}
          </p>
        </div>
        {sourceMessageHref && (
          <Link
            href={sourceMessageHref}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
            data-smoke="workspace-run-source-message-link"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            返回消息
          </Link>
        )}
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.bg}`}>
          <StatusIcon className="w-3.5 h-3.5" />
          {statusCfg.label}
        </span>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 bg-white border border-neutral-200 rounded-lg p-4">
        {/* Agent */}
        <div>
          <p className="text-xs text-neutral-500 mb-1">Agent</p>
          <Link
            href={`/${np}/agents/${run.agentId}`}
            className="text-sm font-medium text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            {agentName}
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>

        {/* Device */}
        {run.deviceId && (
          <div>
            <p className="text-xs text-neutral-500 mb-1">设备</p>
            <Link
              href={`/${np}/devices/${run.deviceId}`}
              className="text-sm font-medium text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              <Monitor className="w-3.5 h-3.5" />
              {run.deviceId.slice(0, 8)}...
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        )}

        {/* Status / Exit Code */}
        <div>
          <p className="text-xs text-neutral-500 mb-1">退出码</p>
          <span className="text-sm font-mono">
            {run.exitCode !== undefined ? (
              <span className={run.exitCode === 0 ? 'text-emerald-600' : 'text-red-600'}>
                {run.exitCode}
              </span>
            ) : (
              <span className="text-neutral-400">—</span>
            )}
          </span>
        </div>

        {/* Timing */}
        <div>
          <p className="text-xs text-neutral-500 mb-1">耗时</p>
          <span className="text-sm">
            {duration ?? (
              run.status === 'running' ? (
                <span className="text-blue-600">进行中...</span>
              ) : (
                <span className="text-neutral-400">—</span>
              )
            )}
          </span>
        </div>

        {/* CWD */}
        {run.cwd && (
          <div className="col-span-2">
            <p className="text-xs text-neutral-500 mb-1">工作目录</p>
            <span className="text-sm font-mono text-neutral-700 inline-flex items-center gap-1">
              <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              {run.cwd}
            </span>
          </div>
        )}

        {/* Command */}
        {run.command && (
          <div className="col-span-2 sm:col-span-3">
            <p className="text-xs text-neutral-500 mb-1">命令</p>
            <span
              className="block overflow-x-auto whitespace-pre rounded-md bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-100"
              data-smoke="workspace-run-command"
            >
              {run.command}
            </span>
          </div>
        )}

        {/* Logs */}
        {run.logExcerpt && (
          <div className="col-span-2 sm:col-span-3">
            <details
              open={logOpen}
              onToggle={(event) => setLogOpen(event.currentTarget.open)}
              className="rounded-md border border-neutral-200 bg-neutral-50"
            >
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-700">
                <span className="inline-flex items-center gap-2">
                  日志摘要
                  <span className="font-normal text-neutral-400">
                    {logLines.length} 行 · {logCharCount.toLocaleString()} 字符
                    {logLooksTruncated ? ' · 尾部摘要' : ''}
                  </span>
                </span>
              </summary>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 bg-white px-3 py-2">
                <p className="text-xs text-neutral-500">
                  {logLooksTruncated
                    ? '摘要用于快速排障：当前只展示最近 16,000 字符，完整日志可在下方打开。'
                    : fullLogArtifact
                      ? '摘要用于快速排障，完整日志可在下方打开。'
                      : '当前展示 daemon 上报并经 server 兜底脱敏后的日志摘要。'}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={copyLogExcerpt}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                    title="复制日志"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    {copiedLog ? '已复制' : '复制日志'}
                  </button>
                  <button
                    type="button"
                    onClick={downloadLogExcerpt}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                    title="下载日志"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    下载日志
                  </button>
                  <button
                    type="button"
                    onClick={() => setWrapLog((value) => !value)}
                    className={`inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium ${wrapLog ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
                    title="自动换行"
                  >
                    <WrapText className="h-3.5 w-3.5" />
                    自动换行
                  </button>
                </div>
              </div>
              <pre className={`max-h-96 overflow-auto bg-neutral-950 px-3 py-2 text-xs leading-relaxed text-neutral-100 ${wrapLog ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
                {run.logExcerpt}
              </pre>
            </details>
          </div>
        )}

        {fullLogArtifact && (
          <div className="col-span-2 sm:col-span-3">
            <div
              className="rounded-md border border-blue-100 bg-blue-50"
              data-smoke="workspace-run-full-log"
              data-artifact-id={fullLogArtifact.id}
              data-artifact-path={artifactPathLabel(fullLogArtifact)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-blue-800">完整日志</p>
                  <p className="mt-0.5 truncate text-xs text-blue-700">
                    {artifactPathLabel(fullLogArtifact)} · {formatBytes(fullLogArtifact.sizeBytes)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => loadFullLogInline()}
                    disabled={fullLogLoading}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-white px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                    data-smoke="workspace-run-full-log-load"
                  >
                    {fullLogLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {fullLogText ? '重新载入' : '页面内查看'}
                  </button>
                  <a
                    href={authedApiUrl(artifactPreviewUrl(run.teamId, fullLogArtifact.id))}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-white px-2 text-xs font-medium text-blue-700 hover:bg-blue-50"
                    data-smoke="workspace-run-full-log-preview"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    预览
                  </a>
                  <a
                    href={authedApiUrl(artifactDownloadUrl(run.teamId, fullLogArtifact.id))}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-white px-2 text-xs font-medium text-blue-700 hover:bg-blue-50"
                    data-smoke="workspace-run-full-log-download"
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载
                  </a>
                </div>
              </div>
              {fullLogError && (
                <p className="border-t border-blue-100 bg-white px-3 py-2 text-xs text-red-600">
                  {fullLogError}
                </p>
              )}
              {fullLogText !== null && (
                <div className="border-t border-blue-100 bg-white p-3" data-smoke="workspace-run-full-log-inline">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <input
                      type="search"
                      value={fullLogQuery}
                      onChange={(event) => setFullLogQuery(event.target.value)}
                      placeholder="搜索完整日志"
                      className="h-8 min-w-0 flex-1 rounded-md border border-neutral-200 px-2 text-xs text-neutral-700 outline-none focus:border-blue-300"
                      data-smoke="workspace-run-full-log-search"
                    />
                    <button
                      type="button"
                      onClick={() => loadFullLogInline(fullLogQuery)}
                      disabled={fullLogLoading}
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                      data-smoke="workspace-run-full-log-search-submit"
                    >
                      搜索
                    </button>
                    <span
                      className="text-xs text-neutral-500"
                      data-smoke="workspace-run-full-log-match-count"
                    >
                      {fullLogMeta?.mode === 'search'
                        ? `${fullLogMeta.matchedLines ?? 0} / ${fullLogMeta.totalLines} 行匹配`
                        : `${fullLogMeta?.returnedLines ?? 0} 行${fullLogMeta?.truncated ? ' · tail' : ''}`}
                    </span>
                  </div>
                  <pre
                    className="max-h-96 overflow-auto rounded-md bg-neutral-950 px-3 py-2 text-xs leading-relaxed text-neutral-100 whitespace-pre-wrap break-words"
                    data-smoke="workspace-run-full-log-viewer"
                    data-match-count={String(fullLogMatchCount)}
                  >
                    {fullLogText || (fullLogMeta?.mode === 'search' ? '无匹配日志行' : '')}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Dispatch */}
        <div>
          <p className="text-xs text-neutral-500 mb-1">Dispatch</p>
          <span className="text-xs font-mono text-neutral-500">{run.dispatchId.slice(0, 12)}...</span>
        </div>
      </div>

      {/* Artifacts */}
      <div>
        <h2 className="text-sm font-semibold text-neutral-700 mb-3 flex items-center gap-2">
          <Paperclip className="w-4 h-4" />
          文件 ({artifacts.length})
        </h2>
        {artifacts.length === 0 ? (
          <p className="text-sm text-neutral-400 py-4 text-center">无文件输出</p>
        ) : (
          <div className="space-y-4">
            {fullLogArtifact && (
              <p className="rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
                完整日志已作为文件保存，可从上方日志区直接预览或下载。
              </p>
            )}
            <div
              className="rounded-md border border-neutral-200 bg-white"
              data-smoke="workspace-run-artifact-tree"
              data-artifact-count={artifacts.length}
              data-dir-count={artifactTreeDirCount}
            >
              <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
                <p className="text-xs font-semibold text-neutral-700">Workspace 文件树</p>
                <span className="text-xs text-neutral-400">
                  {artifactTreeDirCount} 个目录 · {artifacts.length} 个文件
                </span>
              </div>
              <div className="divide-y divide-neutral-100">
                {artifactTreeEntries.map((entry) => {
                  const paddingLeft = 12 + entry.depth * 18;
                  if (entry.type === 'dir') {
                    return (
                      <div
                        key={`dir:${entry.path}`}
                        className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-xs text-neutral-600"
                        style={{ paddingLeft }}
                        data-smoke="workspace-run-artifact-tree-dir"
                        data-artifact-path={entry.path}
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                        <span className="truncate font-medium">{entry.name}</span>
                        <span className="ml-auto shrink-0 text-neutral-400">{entry.fileCount} 个文件</span>
                      </div>
                    );
                  }
                  const artifact = entry.artifact!;
                  return (
                    <a
                      key={`file:${artifact.id}`}
                      href={authedApiUrl(artifactDownloadUrl(run.teamId, artifact.id))}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-xs text-neutral-600 hover:bg-blue-50 hover:text-blue-700"
                      style={{ paddingLeft }}
                      data-smoke="workspace-run-artifact-tree-file"
                      data-artifact-id={artifact.id}
                      data-artifact-path={entry.path}
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="shrink-0 text-neutral-400">{formatBytes(artifact.sizeBytes)}</span>
                      <Download className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    </a>
                  );
                })}
              </div>
            </div>
            {Array.from(artifactsByDir.entries()).map(([dir, files]) => (
              <div key={dir || '__root__'}>
                {dir && (
                  <p className="text-xs text-neutral-500 mb-2 flex items-center gap-1">
                    <FolderOpen className="w-3 h-3" />
                    {dir}
                  </p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {files.map((artifact) => (
                    <a
                      key={artifact.id}
                      href={authedApiUrl(artifactDownloadUrl(run.teamId, artifact.id))}
                      target="_blank"
                      rel="noreferrer"
                      className="block border border-neutral-200 rounded-lg p-3 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group"
                      data-smoke="workspace-run-artifact"
                      data-artifact-id={artifact.id}
                      data-artifact-path={artifactPathLabel(artifact)}
                    >
                      <div className="flex items-start gap-2">
                        {isImageMime(artifact.mimeType) ? (
                          <img
                            src={authedApiUrl(artifactPreviewUrl(run.teamId, artifact.id))}
                            alt={artifact.filename}
                            className="w-10 h-10 rounded object-cover bg-neutral-100 shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded bg-neutral-100 flex items-center justify-center shrink-0">
                            <Paperclip className="w-4 h-4 text-neutral-400" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-neutral-800 truncate group-hover:text-blue-700">
                            {artifact.filename}
                          </p>
                          <p className="text-xs text-neutral-400">{formatBytes(artifact.sizeBytes)}</p>
                        </div>
                        <Download className="w-4 h-4 text-neutral-300 group-hover:text-blue-500 shrink-0 mt-0.5" />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
