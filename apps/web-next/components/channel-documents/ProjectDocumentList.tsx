'use client';

import { FileText } from 'lucide-react';
import { ProjectDocumentReferenceButton } from '@/components/project/ProjectDocumentReferenceButton';
import type {
  ChannelDocumentDto,
  ProjectReferenceSelectionRequestDto,
} from '@agentbean/contracts';

const REVISION_SOURCE_LABEL: Record<ChannelDocumentDto['currentRevision']['source'], string> = {
  attachment: '附件',
  run: 'Agent 运行',
  edit: '人工编辑',
  restore: '恢复历史版本',
};

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 逻辑产物板中的 Server 版本化频道文档入口。
 *
 * ChannelDocument 不会被伪装成 ProjectArtifactCollection；这里仅保留既有的
 * documentId + expectedRevisionId 稳定引用与版本化 Markdown 打开能力。
 */
export function ProjectDocumentList({
  documents,
  archived,
  selections = [],
  onSelectionChange,
  onOpenDocument,
}: {
  documents: readonly ChannelDocumentDto[];
  archived: boolean;
  selections?: readonly ProjectReferenceSelectionRequestDto[];
  onSelectionChange: (selection: ProjectReferenceSelectionRequestDto | null, documentId: string) => void;
  onOpenDocument?: (documentId: string) => void;
}) {
  if (documents.length === 0) return null;

  return (
    <section data-smoke="project-documents" className="mb-4 border border-neutral-300 bg-white">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
        <FileText size={14} className="text-neutral-500" />
        <h3 className="text-xs font-semibold tracking-wide text-neutral-900">频道文档</h3>
        <span className="text-xs text-neutral-400">{documents.length} 个</span>
        {archived && <span className="ml-auto text-xs text-neutral-400">频道已归档，只读</span>}
      </header>
      <ul>
        {documents.map((document) => {
          const selected = selections.some((selection) =>
            selection.kind === 'document'
            && selection.documentId === document.id
            && selection.expectedRevisionId === document.currentRevisionId);
          return (
            <li
              key={document.id}
              data-smoke="project-document"
              data-document-id={document.id}
              className="flex items-center gap-3 border-b border-neutral-200 px-3 py-2 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onOpenDocument?.(document.id)}
                disabled={!onOpenDocument}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
              >
                <span className="block truncate text-sm font-medium text-neutral-900">{document.filename}</span>
                <span className="block truncate text-xs text-neutral-500">
                  document: {document.id} · 当前版本 v{document.currentRevision.revision}
                  {' · '}{REVISION_SOURCE_LABEL[document.currentRevision.source]}
                  {' · '}{formatDateTime(document.updatedAt)}
                </span>
              </button>
              <ProjectDocumentReferenceButton
                documentId={document.id}
                revisionId={document.currentRevisionId}
                selected={selected}
                disabled={archived}
                onChange={(selection) => onSelectionChange(selection, document.id)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
