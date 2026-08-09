'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
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
  type MarkdownDocumentEditorState,
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
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [editorState, setEditorState] = useState<MarkdownDocumentEditorState>({
    dirty: false,
    saving: false,
    saveDisabled: true,
  });

  const requestClose = useCallback(() => {
    if (!editorState.dirty || window.confirm('有未保存的修改，确定关闭吗？')) onClose();
  }, [editorState.dirty, onClose]);

  const loadLibrary = useCallback(async () => {
    const result = await projectEvents().artifactCollections(channelId);
    if (!result.ok || !result.library) {
      setLoadError(result.ok ? '产物库加载失败' : result.message ?? '产物库加载失败');
      return null;
    }
    setCollections(result.library.collections);
    setLoadError(null);
    return result.library.collections;
  }, [channelId]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [requestClose]);

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
        // 手动编辑语义:基于当前 current 版本修订,不带 package/delivery——
        // domain 要求 packageId+deliveryId 成对且 source 必须是包冻结成员版本,
        // 而 current 可能已前移;只传 sourceVersionId 才是合法且语义正确的 basis。
        sourceVersionId: base.id,
      },
      // 每次保存动作为独立幂等键;同一 base+内容重复提交由 Server revision fence 去重。
      idempotencyKey: `pkg-preview-edit:${active.collection.id}:${base.id}:${crypto.randomUUID()}`,
    });
    if (result.ok && result.revision) {
      setSavedNotice(`已保存：Server 生成 ${active.collection.name} v${result.revision.versionNumber}，当前包 ${shortPkg(packageMeta.packageId)} 的 current projection 已更新；final 未移动。`);
      await loadLibrary();
      setEditorEpoch((n) => n + 1);
      onSaved();
      return { ok: true, revisionId: result.revision.versionId };
    }
    if (result.ok) {
      return { ok: false, conflict: true, message: 'Server 未返回保存后的版本信息，请重试' };
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
    const latestCollections = await loadLibrary();
    const latestCollection = latestCollections?.find((collection) => collection.id === activeCollectionId);
    const latestVersion = latestCollection?.versions.find((version) => version.id === latestCollection.currentVersionId);
    const artifact = latestVersion?.artifact as unknown as Artifact | undefined;
    if (!latestVersion || !artifact) throw new Error('最新版加载失败');
    const url = chatArtifactUrl(artifact, 'preview', {
      serverUrl: getResolvedServerUrl(),
      token: getStoredAuthToken(),
      ...(artifact.teamId ? { teamId: artifact.teamId } : {}),
    });
    if (!url) throw new Error('最新版没有可用的在线内容');
    const response = await fetch(url);
    if (!response.ok) throw new Error(response.status === 415 ? '最新版不是 UTF-8，仅支持下载' : '最新版加载失败');
    return {
      content: await response.text(),
      filename: artifact.filename,
      revisionId: latestVersion.id,
    };
  }, [loadLibrary, activeCollectionId]);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-neutral-950/35"
      role="dialog"
      aria-modal="true"
      aria-label={`预览/编辑 ${shortPkg(packageMeta.packageId)}`}
      onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div
        className="grid h-[min(740px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] grid-rows-[48px_minmax(0,1fr)_48px] overflow-hidden rounded-lg border border-white/80 bg-white shadow-2xl sm:h-[min(740px,calc(100vh-56px))] sm:w-[min(1120px,calc(100vw-56px))]"
        data-smoke="output-package-preview-modal"
      >
        {/* header:原型顺序为包 + 当前文件标题，右侧展示 Server basis 与审核态。 */}
        <header className="flex min-w-0 items-center gap-2 border-b border-neutral-200 bg-neutral-50/80 px-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">
            {active
              ? `预览 / 编辑：${shortPkg(packageMeta.packageId)} · ${(active.current.artifact as unknown as Artifact).filename}`
              : `预览 / 编辑：${shortPkg(packageMeta.packageId)}`}
          </h2>
          {active && (
            <>
              <span className="shrink-0 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                基于 Server v{active.current.versionNumber}
              </span>
              <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${reviewStateChipClass(active.current.reviewState)}`}>
                {reviewStateLabel(active.current.reviewState)}
              </span>
            </>
          )}
          <button onClick={requestClose} className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="grid min-h-0 grid-cols-[190px_minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)]">
          {/* 左栏:包内文件列表 */}
          <aside className="overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-2.5">
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
                  className={`mb-2 block w-full rounded-lg border px-2 py-2 text-left ${
                    isActive ? 'border-sky-200 bg-sky-50' : 'border-neutral-200 bg-white hover:border-neutral-300'
                  }`}
                >
                  <span className="block truncate text-xs font-semibold text-neutral-800">
                    {member.shortLabel} {member.filename}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-neutral-500">
                    {current && info
                      ? packageMemberSummary(info, current)
                      : info ? '读取中…' : '集合不可用'}
                  </span>
                </button>
              );
            })}
            <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-2 py-2 text-[10px] leading-4 text-sky-700">
              保存后直接更新该文档的最新 Server 修订；后续引用当前包自动读取 current projection。final 不会自动移动。
            </p>
          </aside>

          {/* 右栏:编辑器 / 占位 */}
          <div ref={editorContainerRef} className="min-h-0 min-w-0">
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
                renderPreview={renderPreview}
                presentation="package-preview"
                onStateChange={setEditorState}
              />
            )}
          </div>
        </div>

        {/* footer:Server 状态 + 已有的真实保存动作；不复制原型里的演示按钮。 */}
        <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/80 px-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-600">
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${savedNotice ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>
              {savedNotice ? '已保存' : 'Server source of truth'}
            </span>
            {savedNotice ? (
              <span className="truncate text-emerald-700" data-smoke="package-preview-saved">{savedNotice}</span>
            ) : active ? (
              <span className="truncate">
                当前编辑基于 <strong>{active.collection.name} v{active.current.versionNumber}</strong>；保存会生成 v{active.current.versionNumber + 1}，替换 current 指针，但不会自动移动 final。
              </span>
            ) : null}
          </div>
          {active && isMarkdownFilename((active.current.artifact as unknown as Artifact).filename) ? (
            <button
              type="button"
              onClick={() => editorContainerRef.current?.querySelector<HTMLButtonElement>('[data-markdown-document-save]')?.click()}
              disabled={editorState.saveDisabled}
              className="shrink-0 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-neutral-300 disabled:bg-neutral-300"
              data-smoke="package-preview-save"
            >
              {editorState.saving ? '保存中…' : '保存为 Server 新版本'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function shortPkg(packageId: string): string {
  return `PKG-${packageId.slice(0, 8)}`;
}

function reviewStateChipClass(reviewState: ProjectArtifactVersionDto['reviewState']): string {
  if (reviewState === 'approved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (reviewState === 'changes_requested') return 'border-orange-200 bg-orange-50 text-orange-700';
  if (reviewState === 'rejected') return 'border-red-200 bg-red-50 text-red-700';
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

function packageMemberSummary(
  collection: ProjectArtifactCollectionDto,
  current: ProjectArtifactVersionDto,
): string {
  const source = current.revisionBasis ? '手动修改' : 'Agent 修订';
  const state = collection.finalVersionId === current.id ? 'final' : reviewStateLabel(current.reviewState);
  return `current v${current.versionNumber} · ${source} · ${state}`;
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
