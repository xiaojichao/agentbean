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
} from 'lucide-react';
import { fetchWorkspaceRunDetail, authedApiUrl } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { formatRelative } from '@/lib/format-time';
import type { WorkspaceRunDetail, WorkspaceArtifact, WorkspaceRunStatus } from '@/lib/schema';

const STATUS_CONFIG: Record<WorkspaceRunStatus, { bg: string; icon: typeof CheckCircle2; label: string }> = {
  running: { bg: 'bg-blue-50 text-blue-700', icon: Clock, label: '运行中' },
  succeeded: { bg: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2, label: '成功' },
  failed: { bg: 'bg-red-50 text-red-700', icon: XCircle, label: '失败' },
  cancelled: { bg: 'bg-neutral-100 text-neutral-500', icon: AlertCircle, label: '已取消' },
};

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

export default function RunDetailPage() {
  const params = useParams<{ runId: string }>();
  const np = useCurrentNetworkPath();
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const agents = useAgentBeanStore((s) => s.agents);

  const [data, setData] = useState<{ workspaceRun: WorkspaceRunDetail; artifacts: WorkspaceArtifact[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runId = params.runId;

  useEffect(() => {
    if (!currentTeamId || !runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchWorkspaceRunDetail(currentTeamId, runId)
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
  }, [currentTeamId, runId]);

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
          href={`/${np}/agents`}
          className="mt-4 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" /> 返回 Agent 列表
        </Link>
      </div>
    );
  }

  const { workspaceRun: run, artifacts } = data;
  const statusCfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.running;
  const StatusIcon = statusCfg.icon;
  const agentName = agents[run.agentId]?.name ?? run.agentId;
  const duration = formatDuration(run.startedAt, run.completedAt);
  const sourceMessageHref = run.messageId
    ? `/${np}/chat?message=${encodeURIComponent(`${run.channelId}:${run.messageId}`)}`
    : null;

  // Group artifacts by directory
  const artifactsByDir = new Map<string, WorkspaceArtifact[]>();
  for (const a of artifacts) {
    const dir = a.relativePath?.includes('/') ? a.relativePath.substring(0, a.relativePath.lastIndexOf('/')) : '';
    const list = artifactsByDir.get(dir) ?? [];
    list.push(a);
    artifactsByDir.set(dir, list);
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/${np}/agents/${run.agentId}`} className="text-neutral-400 hover:text-neutral-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-neutral-900">Workspace Run</h1>
          <p className="text-sm text-neutral-500">
            {run.id.slice(0, 8)}... · {formatRelative(run.createdAt)}
          </p>
        </div>
        {sourceMessageHref && (
          <Link
            href={sourceMessageHref}
            className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
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
            <span className="block overflow-x-auto whitespace-pre rounded-md bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-100">
              {run.command}
            </span>
          </div>
        )}

        {/* Logs */}
        {run.logExcerpt && (
          <div className="col-span-2 sm:col-span-3">
            <details className="rounded-md border border-neutral-200 bg-neutral-50">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-neutral-700">
                日志摘要
              </summary>
              <pre className="max-h-80 overflow-auto border-t border-neutral-200 bg-neutral-950 px-3 py-2 text-xs leading-relaxed text-neutral-100">
                {run.logExcerpt}
              </pre>
            </details>
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
