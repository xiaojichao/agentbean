'use client';

import Link from 'next/link';
import { FolderOpen, Image as ImageIcon, Paperclip, ExternalLink, CheckCircle2, XCircle, Clock, AlertCircle } from 'lucide-react';
import { authedApiUrl } from '@/lib/socket';
import { useCurrentNetworkPath } from '@/lib/store';
import { formatRelative } from '@/lib/format-time';
import type { AgentWorkspaceFile, AgentWorkspaceRun, WorkspaceRunStatus } from '@/lib/schema';

const RUN_STATUS: Record<WorkspaceRunStatus, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  running: { label: '运行中', className: 'bg-blue-50 text-blue-700', icon: Clock },
  succeeded: { label: '成功', className: 'bg-emerald-50 text-emerald-700', icon: CheckCircle2 },
  failed: { label: '失败', className: 'bg-red-50 text-red-700', icon: XCircle },
  cancelled: { label: '已取消', className: 'bg-neutral-100 text-neutral-500', icon: AlertCircle },
};

export function AgentWorkspaceSection({ runs, loading }: { runs: AgentWorkspaceRun[]; loading: boolean }) {
  const np = useCurrentNetworkPath();
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
          <FolderOpen size={14} />工作区
        </h3>
        {loading && <span className="text-xs text-neutral-400">正在加载</span>}
      </div>
      {runs.length === 0 ? (
        <div className="text-xs text-neutral-400">暂无已同步的 Agent 产物。</div>
      ) : (
        <div className="space-y-3">
          {runs.slice(0, 8).map((run) => (
            <div key={run.runId} className="border-t border-neutral-100 pt-3 first:border-t-0 first:pt-0">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <RunStatusPill status={run.status} />
                    <div className="truncate text-xs font-medium text-neutral-600">Workspace run</div>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-400">
                    <span>{formatRelative(run.updatedAt)}</span>
                    {run.exitCode !== undefined && <span>exit {run.exitCode}</span>}
                    {run.command && <span className="max-w-[16rem] truncate font-mono">{run.command}</span>}
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
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
                    {run.files.length} 个文件
                  </span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {run.files.map((file) => (
                  <WorkspaceFileLink key={file.id} file={file} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RunStatusPill({ status }: { status: WorkspaceRunStatus }) {
  const config = RUN_STATUS[status] ?? RUN_STATUS.running;
  const Icon = config.icon;
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium ${config.className}`}>
      <Icon size={11} />
      {config.label}
    </span>
  );
}

function WorkspaceFileLink({ file }: { file: AgentWorkspaceFile }) {
  const isImage = file.mimeType.startsWith('image/');
  const sizeKb = Math.max(0.1, file.sizeBytes / 1024).toFixed(1);
  return (
    <a
      href={authedApiUrl(file.downloadUrl)}
      target="_blank"
      rel="noreferrer"
      className="group min-w-0 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs hover:bg-white"
      title={file.relativePath}
    >
      {isImage ? (
        <img
          src={authedApiUrl(file.previewUrl)}
          alt={file.filename}
          className="mb-2 aspect-video w-full rounded border border-neutral-200 object-contain bg-white"
        />
      ) : (
        <div className="mb-2 flex aspect-video items-center justify-center rounded border border-neutral-200 bg-white text-neutral-400">
          <Paperclip size={18} />
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        {isImage ? <ImageIcon size={13} className="shrink-0 text-blue-500" /> : <Paperclip size={13} className="shrink-0 text-neutral-400" />}
        <span className="truncate font-medium text-neutral-700 group-hover:text-neutral-950">{file.filename}</span>
      </div>
      <div className="mt-1 truncate text-[11px] text-neutral-400">{file.relativePath}</div>
      <div className="mt-1 text-[11px] text-neutral-400">{sizeKb} KB</div>
    </a>
  );
}
