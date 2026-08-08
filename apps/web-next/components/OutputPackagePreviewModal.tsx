'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FileText, X } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';
import { getResolvedServerUrl, getStoredAuthToken, projectEvents } from '@/lib/socket';
import { chatArtifactUrl } from '@/lib/chat-artifact-url';
import { reviewStateLabel } from '@/lib/delivery-labels';
import type { Artifact } from '@/lib/schema';
import type {
  ProjectArtifactCollectionDto,
  ProjectArtifactVersionDto,
} from '@agentbean/contracts';
import {
  MarkdownDocumentEditor,
  type MarkdownDocumentSaveResult,
} from './channel-documents/MarkdownDocumentEditor';

/**
 * 原型(2026-07-28)对齐:讨论串文件包的预览/编辑浮窗。
 *
 * 左侧包内文件列表(短编号 + 文件名 + current 版本 + 审核态),右侧复用
 * MarkdownDocumentEditor(split:源文 + 实时预览)。保存走 saveArtifactVersionRevision
 * ——生成新 Server revision、更新 collection.currentVersionId,final 指针不动;
 * revisionBasis.sourceVersionId 指向编辑 base,Server 据此在讨论串投影轻量事件。
 *
 * 冲突(expectedCollectionRevision fence)由编辑器的 conflict 通道展示;
 * 「查看最新版」重新拉取 Server 最新内容。
 */

interface ActiveTarget {
  collection: ProjectArtifactCollectionDto;
  current: ProjectArtifactVersionDto;
}

function isMarkdownFilename(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

export function OutputPackagePreviewModal({
  packageMeta,
  channelId,
  initialVersionId,
  renderPreview,
  onClose,
  onSaved,
}: {
  packageMeta: OutputPackageMeta;
  channelId: string;
  /** 成员行「预览」进入时聚焦的成员(交付冻结版本 id)。 */
  initialVersionId?: string;
  renderPreview: (content: string) => ReactNode;
  onClose: () => void;
  /** 保存成功后通知父级(刷新卡片/library 投影)。 */
  onSaved: () => void;
}) {
  const [collections, setCollections] = useState<ProjectArtifactCollectionDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  // 每次切换成员/保存成功后递增,重挂载编辑器(reset 内部草稿态)。
  const [editorEpoch, setEditorEpoch] = useState(0);

  const loadLibrary = useCallback(async () => {
    const result = await projectEvents().artifactCollections(channelId);
    if (!result.ok || !result.library) {
      setLoadError(result.ok ? '产物库加载失败' : result.message ?? '产物库加载失败');
      return;
    }
    setCollections(result.library.collections);
    setLoadError(null);
  }, [channelId]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  // 初始聚焦成员:initialVersionId 对应 collection,否则第一个成员。
  useEffect(() => {
    if (!collections || activeCollectionId) return;
    const initialMember = initialVersionId
      ? packageMeta.members.find((m) => m.artifactVersionId === initialVersionId)
      : undefined;
    const fallback = initialMember ?? packageMeta.members[0];
    if (fallback) setActiveCollectionId(fallback.collectionId);
  }, [collections, activeCollectionId, initialVersionId, packageMeta.members]);

  const active: ActiveTarget | null = (() => {
    if (!collections || !activeCollectionId) return null;
    const collection = collections.find((c) => c.id === activeCollectionId) ?? null;
    if (!collection) return null;
    const current = collection.versions.find((v) => v.id === collection.currentVersionId) ?? null;
    if (!current) return null;
    return { collection, current };
  })();

  // 加载当前成员内容(Server 最新修订,不信任本地缓存)。
  useEffect(() => {
    if (!active) return;
    const artifact = active.current.artifact as unknown as Artifact;
    if (!isMarkdownFilename(artifact.filename)) {
      setContent(null);
      setContentError(null);
      return;
    }
    const url = chatArtifactUrl(artifact, 'preview', {
      serverUrl: getResolvedServerUrl(),
      token: getStoredAuthToken(),
      ...(artifact.teamId ? { teamId: artifact.teamId } : {}),
    });
    if (!url) {
      setContent(null);
      setContentError('该版本没有可用的在线内容');
      return;
    }
    let cancelled = false;
    setContent(null);
    setContentError(null);
    fetch(url)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setContentError(response.status === 415 ? '该版本不是 UTF-8，仅支持下载' : '版本内容加载失败');
          return;
        }
        setContent(await response.text());
      })
      .catch(() => { if (!cancelled) setContentError('版本内容加载失败'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.collection.id, active?.current.id, editorEpoch]);

  const saveCurrent = useCallback(async (nextContent: string, filename: string): Promise<MarkdownDocumentSaveResult> => {
    if (!active) return { ok: false, conflict: true, message: '未选择成员' };
    const base = active.current;
    const result = await projectEvents().saveArtifactVersionRevision({
      channelId,
      collectionId: active.collection.id,
      baseVersionId: base.id,
      content: nextContent,
      filename,
      expectedCollectionRevision: active.collection.revision,
      revisionBasis: {
        sourceVersionId: base.id,
        packageId: packageMeta.packageId,
      },
      // 每次保存动作为独立幂等键;同一 base+内容重复提交由 Server revision fence 去重。
      idempotencyKey: `pkg-preview-edit:${active.collection.id}:${base.id}:${crypto.randomUUID()}`,
    });
    if (result.ok) {
      const nextVersionNumber = base.versionNumber + 1;
      setSavedNotice(`已保存：Server 生成 ${active.collection.name} v${nextVersionNumber}，当前包 ${shortPkg(packageMeta.packageId)} 的 current projection 已更新；final 未移动。`);
      await loadLibrary();
      setEditorEpoch((n) => n + 1);
      onSaved();
      return { ok: true, revisionId: '' };
    }
    if (result.error === 'CONFLICT' && result.revisionConflict) {
      return {
        ok: false,
        conflict: true,
        message: result.revisionConflict.code === 'revision-basis-stale'
          ? '该版本的审核依据已被更新，请查看最新版后重新修订'
          : `检测到冲突：Server 已有 ${active.collection.name} v${result.revisionConflict.serverCurrentVersionNumber}；请先查看最新版，确认后再保存。`,
      };
    }
    return { ok: false, conflict: true, message: result.message ?? result.error ?? '保存失败' };
  }, [active, channelId, packageMeta.packageId, loadLibrary, onSaved]);

  const loadLatest = useCallback(async () => {
    await loadLibrary();
    setEditorEpoch((n) => n + 1);
    const artifact = active?.current.artifact as unknown as Artifact | undefined;
    return {
      content: content ?? '',
      filename: artifact?.filename ?? 'document.md',
      revisionId: active?.current.id ?? '',
    };
  }, [loadLibrary, active, content]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`预览/编辑 ${shortPkg(packageMeta.packageId)}`}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex h-[min(90vh,900px)] w-full max-w-6xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        {/* header:包名 + 当前文件 + 版本/审核态 chip */}
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5">
          <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
            输出包 {shortPkg(packageMeta.packageId)}
          </span>
          <span className="truncate text-sm font-medium text-neutral-900">
            {active ? `预览 / 编辑：${(active.current.artifact as unknown as Artifact).filename}` : '预览 / 编辑'}
          </span>
          {active && (
            <>
              <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">
                基于 Server v{active.current.versionNumber}
              </span>
              <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600">
                {reviewStateLabel(active.current.reviewState)}
              </span>
            </>
          )}
          <button onClick={onClose} className="ml-auto rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左栏:包内文件列表 */}
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-2">
            {packageMeta.members.map((member) => {
              const info = collections?.find((c) => c.id === member.collectionId);
              const current = info?.versions.find((v) => v.id === info.currentVersionId);
              const isActive = member.collectionId === activeCollectionId;
              return (
                <button
                  key={member.artifactVersionId}
                  type="button"
                  onClick={() => { setActiveCollectionId(member.collectionId); setSavedNotice(null); }}
                  data-smoke="package-preview-member"
                  className={`mb-1 flex w-full items-start gap-1.5 rounded-md border px-2 py-1.5 text-left ${
                    isActive ? 'border-amber-400 bg-amber-50/60' : 'border-transparent hover:bg-white'
                  }`}
                >
                  <FileText size={13} className="mt-0.5 shrink-0 text-neutral-400" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-neutral-800">
                      {member.shortLabel} {member.filename}
                    </span>
                    <span className="block truncate text-[10px] text-neutral-400">
                      {current
                        ? `current v${current.versionNumber} · ${reviewStateLabel(current.reviewState)}`
                        : info ? '读取中…' : '集合不可用'}
                    </span>
                  </span>
                </button>
              );
            })}
            <p className="mt-2 px-1 text-[10px] leading-4 text-neutral-400">
              保存后直接更新该文档的最新 Server 修订；后续引用当前包自动读取这个 current projection。
            </p>
          </aside>

          {/* 右栏:编辑器 / 占位 */}
          <div className="min-w-0 flex-1 p-3">
            {loadError ? (
              <div className="flex h-full items-center justify-center text-sm text-red-600">{loadError}</div>
            ) : !active ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">选择左侧文件</div>
            ) : !isMarkdownFilename((active.current.artifact as unknown as Artifact).filename) ? (
              <NonMarkdownPreview target={active} />
            ) : contentError ? (
              <div className="flex h-full items-center justify-center text-sm text-red-600">{contentError}</div>
            ) : content === null ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">加载内容…</div>
            ) : (
              <MarkdownDocumentEditor
                key={`${active.current.id}:${editorEpoch}`}
                filename={(active.current.artifact as unknown as Artifact).filename}
                initialContent={content}
                onSave={saveCurrent}
                onLoadLatest={loadLatest}
                onClose={onClose}
                renderPreview={renderPreview}
              />
            )}
          </div>
        </div>

        {/* footer:Server 状态栏(原型 modal-foot) */}
        <div className="border-t border-neutral-200 px-4 py-2">
          {savedNotice ? (
            <span className="text-xs text-emerald-700" data-smoke="package-preview-saved">{savedNotice}</span>
          ) : active ? (
            <span className="text-xs text-neutral-500">
              当前编辑基于 <strong>{active.collection.name} v{active.current.versionNumber}</strong>；
              保存会生成 v{active.current.versionNumber + 1}，并替换 current 指针，但不会自动移动 final。
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function shortPkg(packageId: string): string {
  return `PKG-${packageId.slice(0, 8)}`;
}

/** 非 Markdown 成员:图片内嵌预览,其他类型提示仅下载。 */
function NonMarkdownPreview({ target }: { target: ActiveTarget }) {
  const artifact = target.current.artifact as unknown as Artifact;
  const url = chatArtifactUrl(artifact, isImageFilename(artifact.filename) ? 'preview' : 'download', {
    serverUrl: getResolvedServerUrl(),
    token: getStoredAuthToken(),
    ...(artifact.teamId ? { teamId: artifact.teamId } : {}),
  });
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-500">
      {isImageFilename(artifact.filename) && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={artifact.filename} className="max-h-full max-w-full object-contain" />
      ) : (
        <>
          <span>该文件类型不支持在线编辑（仅 Markdown）。</span>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
              下载 {artifact.filename}
            </a>
          )}
        </>
      )}
    </div>
  );
}
