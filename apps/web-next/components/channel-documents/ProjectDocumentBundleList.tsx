'use client';

import { useCallback, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Package } from 'lucide-react';
import type {
  ProjectDocumentBundleDetailDto,
  ProjectDocumentBundleDto,
  ProjectDocumentBundleMemberViewDto,
  ProjectReferenceSelectionRequestDto,
} from '@agentbean/contracts';

const REVISION_SOURCE_LABEL: Record<ProjectDocumentBundleMemberCurrent['source'], string> = {
  attachment: '附件',
  run: 'Agent 运行',
  edit: '人工编辑',
  restore: '恢复历史版本',
};

type ProjectDocumentBundleMemberCurrent = NonNullable<ProjectDocumentBundleMemberViewDto['current']>;

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/**
 * #825：文件库里的文档包区块。
 * 展示来源、固定成员、成员当前 revision 及其修改来源与时间；
 * 展开详情始终向 Server 重新取投影，不从本地列表推断成员正文事实。
 */
export function ProjectDocumentBundleList({
  bundles,
  archived,
  onLoadDetail,
  onOpenDocument,
  selections = [],
  onSelectionChange,
}: {
  bundles: ProjectDocumentBundleDto[];
  archived: boolean;
  onLoadDetail: (bundleId: string) => Promise<ProjectDocumentBundleDetailDto | null>;
  onOpenDocument?: (documentId: string) => void;
  selections?: readonly ProjectReferenceSelectionRequestDto[];
  onSelectionChange?: (selection: ProjectReferenceSelectionRequestDto | null, bundleId: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ProjectDocumentBundleDetailDto>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const toggle = useCallback(async (bundleId: string) => {
    if (expandedId === bundleId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(bundleId);
    setErrorId(null);
    setLoadingId(bundleId);
    try {
      const detail = await onLoadDetail(bundleId);
      if (detail) {
        setDetails((previous) => ({ ...previous, [bundleId]: detail }));
      } else {
        setErrorId(bundleId);
      }
    } finally {
      setLoadingId((current) => (current === bundleId ? null : current));
    }
  }, [expandedId, onLoadDetail]);

  const loadDetail = useCallback(async (bundleId: string) => {
    const cached = details[bundleId];
    if (cached) return cached;
    const detail = await onLoadDetail(bundleId);
    if (detail) setDetails((previous) => ({ ...previous, [bundleId]: detail }));
    return detail;
  }, [details, onLoadDetail]);

  if (bundles.length === 0) return null;

  return (
    <section data-smoke="project-document-bundles" className="mb-4 border border-neutral-300 bg-white">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2">
        <Package size={14} className="text-neutral-500" />
        <h3 className="text-xs font-semibold tracking-wide text-neutral-900">文档包</h3>
        <span className="text-xs text-neutral-400">{bundles.length} 个</span>
        {archived && <span className="ml-auto text-xs text-neutral-400">频道已归档，只读</span>}
      </header>
      <ul>
        {bundles.map((bundle) => {
          const expanded = expandedId === bundle.id;
          const detail = details[bundle.id];
          const selection = selections.find((candidate) =>
            (candidate.kind === 'bundle_all' || candidate.kind === 'bundle_subset')
            && candidate.bundleId === bundle.id);
          const selectAll = async () => {
            if (!onSelectionChange || archived) return;
            if (selection?.kind === 'bundle_all') {
              onSelectionChange(null, bundle.id);
              return;
            }
            const current = await loadDetail(bundle.id);
            if (!current) return;
            onSelectionChange({
              kind: 'bundle_all',
              bundleId: bundle.id,
              expectedRevisions: current.members.flatMap((member) => member.current
                ? [{ documentId: member.documentId, revisionId: member.current.revisionId }]
                : []),
            }, bundle.id);
          };
          return (
            <li key={bundle.id} data-smoke="project-document-bundle" data-bundle-id={bundle.id} className="border-b border-neutral-200 last:border-b-0">
              <div className="flex items-center gap-2 px-3 py-2 hover:bg-amber-50">
                <button
                  onClick={() => void toggle(bundle.id)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {expanded ? <ChevronDown size={14} className="shrink-0 text-neutral-400" /> : <ChevronRight size={14} className="shrink-0 text-neutral-400" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-neutral-900">{bundle.name}</span>
                    <span className="block truncate text-xs text-neutral-500">
                      {bundle.memberCount} 个文档 · 来源运行 {bundle.source.workspaceRunId}
                      {bundle.source.invocationId ? ` · Invocation ${bundle.source.invocationId}` : ''}
                      {bundle.source.taskId ? ` · 任务 ${bundle.source.taskId}` : ''}
                      {' · '}{formatDateTime(bundle.createdAt)}
                    </span>
                  </span>
                </button>
                {onSelectionChange && (
                  <button
                    type="button"
                    data-smoke="project-reference-bundle-all"
                    onClick={() => void selectAll()}
                    disabled={archived}
                    className={`shrink-0 border px-2 py-1 text-[11px] font-medium disabled:opacity-40 ${selection?.kind === 'bundle_all'
                      ? 'border-amber-500 bg-amber-100 text-amber-900'
                      : 'border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900'}`}
                  >
                    {selection?.kind === 'bundle_all' ? '已引用整包' : '引用整包'}
                  </button>
                )}
              </div>
              {expanded && (
                <div className="border-t border-neutral-100 bg-neutral-50 px-3 py-2">
                  {loadingId === bundle.id && !detail && (
                    <p className="text-xs text-neutral-400">加载文档包内容…</p>
                  )}
                  {errorId === bundle.id && !detail && (
                    <p className="text-xs text-red-600">无法读取文档包内容，请稍后重试。</p>
                  )}
                  {detail && (
                    <ul className="space-y-2">
                      {detail.members.map((member) => (
                        <li key={member.documentId} data-smoke="project-document-bundle-member" data-document-id={member.documentId} className="text-xs">
                          <div className="flex items-center gap-2">
                            {onSelectionChange && (
                              <button
                                type="button"
                                data-smoke="project-reference-member-toggle"
                                aria-pressed={selection?.kind === 'bundle_all'
                                  || selection?.kind === 'bundle_subset' && selection.documentIds.includes(member.documentId)}
                                disabled={archived || !member.current}
                                onClick={() => {
                                  if (!member.current) return;
                                  const selectedIds = selection?.kind === 'bundle_all'
                                    ? detail.members.filter((item) => item.current).map((item) => item.documentId)
                                    : selection?.kind === 'bundle_subset' ? [...selection.documentIds] : [];
                                  const nextIds = selectedIds.includes(member.documentId)
                                    ? selectedIds.filter((id) => id !== member.documentId)
                                    : [...selectedIds, member.documentId];
                                  if (nextIds.length === 0) {
                                    onSelectionChange(null, bundle.id);
                                    return;
                                  }
                                  const available = detail.members.filter((item) => item.current);
                                  onSelectionChange(nextIds.length === available.length
                                    ? {
                                      kind: 'bundle_all',
                                      bundleId: bundle.id,
                                      expectedRevisions: available.map((item) => ({
                                        documentId: item.documentId,
                                        revisionId: item.current!.revisionId,
                                      })),
                                    }
                                    : {
                                      kind: 'bundle_subset',
                                      bundleId: bundle.id,
                                      documentIds: nextIds,
                                      expectedRevisions: available
                                        .filter((item) => nextIds.includes(item.documentId))
                                        .map((item) => ({
                                          documentId: item.documentId,
                                          revisionId: item.current!.revisionId,
                                        })),
                                    }, bundle.id);
                                }}
                                className={`flex h-4 w-4 shrink-0 items-center justify-center border ${selection?.kind === 'bundle_all'
                                  || selection?.kind === 'bundle_subset' && selection.documentIds.includes(member.documentId)
                                  ? 'border-amber-500 bg-amber-500 text-white'
                                  : 'border-neutral-300 bg-white text-transparent'}`}
                              >
                                <Check size={11} />
                              </button>
                            )}
                            {onOpenDocument
                              ? (
                                <button
                                  onClick={() => onOpenDocument(member.documentId)}
                                  className="truncate font-medium text-neutral-900 underline decoration-neutral-300 hover:decoration-neutral-900"
                                >
                                  {member.current?.filename ?? member.initialFilename}
                                </button>
                              )
                              : <span className="truncate font-medium text-neutral-900">{member.current?.filename ?? member.initialFilename}</span>}
                            {member.current?.changedSinceJoin && (
                              <span data-smoke="bundle-member-changed" className="shrink-0 border border-amber-400 bg-amber-50 px-1 text-[10px] text-amber-700">
                                加入后已修改
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-neutral-500">
                            加入时版本 v{member.initialRevisionNumber}
                            {member.current
                              ? ` · 当前版本 v${member.current.revisionNumber} · ${REVISION_SOURCE_LABEL[member.current.source]} · ${formatDateTime(member.current.createdAt)}`
                              : ' · 当前版本不可读'}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
