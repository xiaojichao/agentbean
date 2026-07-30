'use client';

import { describeWorkspaceRevisionProvenance } from '@/lib/workspace-revision-provenance';
import type { ProjectChannelWorkspaceDto, ProjectChannelWorkspaceRevisionDto } from '@agentbean/contracts';

export interface WorkspaceRevisionPanelProps {
  /** 服务器返回的工作区数据（undefined=加载中，null=无 workspace/错误）。 */
  readonly workspace: ProjectChannelWorkspaceDto | null | undefined;
  /** 服务器返回的错误码。 */
  readonly error?: string;
  /** 当前查看的 revision（默认为 currentRevision）。 */
  readonly viewingRevision?: ProjectChannelWorkspaceRevisionDto;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function WorkspaceRevisionPanel({
  workspace,
  error,
  viewingRevision,
}: WorkspaceRevisionPanelProps) {
  if (workspace === undefined) {
    return (
      <section aria-label="项目文件" className="flex items-center justify-center py-12">
        <span className="mr-2 animate-spin text-neutral-400">⏳</span>
        <span className="text-sm text-neutral-500">加载项目文件...</span>
      </section>
    );
  }

  if (error || workspace === null) {
    const msg = error === 'FORBIDDEN' ? '你没有权限查看此频道的项目文件'
      : error === 'NOT_FOUND' ? '此频道尚未创建项目工作区'
      : error === 'CONFLICT' ? '工作区基线已变化，请刷新后重试'
      : '加载失败，请稍后重试';
    return (
      <section aria-label="项目文件" className="px-4 py-6">
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-6 text-center">
          <span className="text-2xl text-neutral-300">📂</span>
          <p className="mt-2 text-sm text-neutral-500">{msg}</p>
        </div>
      </section>
    );
  }

  const revision = viewingRevision ?? workspace.currentRevision;
  const provenance = describeWorkspaceRevisionProvenance(revision.provenance);

  return (
    <section aria-label="项目文件" className="px-4 py-4">
      {/* Revision header + provenance */}
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-neutral-900">
          项目文件
          <span className="ml-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-normal text-neutral-500">
            v{revision.revision}
          </span>
        </h2>
        <span className="text-xs text-neutral-400">
          {formatTime(revision.createdAt)}
        </span>
        {revision.id !== workspace.currentRevision.id && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            ⏱ 历史版本
          </span>
        )}
      </div>

      {/* Provenance */}
      <div className="mb-4 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        <span className="font-medium text-neutral-700">来源：</span>
        {provenance.label}
        {provenance.kind === 'publish' && provenance.taskId && (
          <span className="ml-2 text-neutral-400">
            · 任务 {provenance.taskId} attempt {provenance.taskAttempt}
          </span>
        )}
      </div>

      {/* File list */}
      {revision.files.length === 0 ? (
        <p className="text-xs text-neutral-400">此版本没有文件</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-neutral-500">
                <th className="px-3 py-2 font-medium">路径</th>
                <th className="px-3 py-2 font-medium">文件名</th>
                <th className="px-3 py-2 font-medium text-right">大小</th>
                <th className="px-3 py-2 font-medium">类型</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {revision.files.map((f) => (
                <tr key={f.path} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-mono text-neutral-700">
                    📄 {f.path}
                  </td>
                  <td className="px-3 py-2 text-neutral-600">{f.filename}</td>
                  <td className="px-3 py-2 text-right text-neutral-400 tabular-nums">
                    {formatSize(f.sizeBytes)}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{f.mimeType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer: total + revision pin */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-400">
        <span>{revision.files.length} 个文件</span>
        {revision.provenance?.kind === 'publish' && 'baselineRevisionId' in revision.provenance && (
          <span>
            基于 {revision.provenance.baselineRevisionId.slice(0, 8)}... 发布
          </span>
        )}
      </div>
    </section>
  );
}
