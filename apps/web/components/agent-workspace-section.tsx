'use client';

import { FolderOpen, Image as ImageIcon, Paperclip } from 'lucide-react';
import { authedApiUrl } from '@/lib/socket';
import { formatRelative } from '@/lib/format-time';
import type { AgentWorkspaceFile, AgentWorkspaceRun } from '@/lib/schema';

export function AgentWorkspaceSection({ runs, loading }: { runs: AgentWorkspaceRun[]; loading: boolean }) {
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
                  <div className="truncate text-xs font-medium text-neutral-600">同步记录</div>
                  <div className="text-[11px] text-neutral-400">{formatRelative(run.updatedAt)}</div>
                </div>
                <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
                  {run.files.length} 个文件
                </span>
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
