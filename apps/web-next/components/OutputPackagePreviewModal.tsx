'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';
import { getResolvedServerUrl, getStoredAuthToken, projectEvents } from '@/lib/socket';
import { chatArtifactUrl } from '@/lib/chat-artifact-url';
import { reviewStateLabel } from '@/lib/delivery-labels';
import type { Artifact } from '@/lib/schema';
import type {
  OutputPackageDto,
  PackageMemberAvailableActionsDto,
  ProjectArtifactCollectionDto,
  ProjectArtifactVersionDto,
} from '@agentbean/contracts';
import type {
  PackageReturnAgentChoice,
  PackageReturnDecision,
  PackageReturnHandoff,
} from '@/lib/output-package-return-handoff';
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

interface HistoryPreview {
  version: ProjectArtifactVersionDto;
  content: string;
}

const EMPTY_EDITOR_STATE: MarkdownDocumentEditorState = {
  dirty: false,
  saving: false,
  saveDisabled: true,
  conflicted: false,
};

function isMarkdownFilename(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

export interface OutputPackagePreviewModalProps {
  packageMeta: OutputPackageMeta;
  channelId: string;
  /** 成员行「预览」进入时聚焦的成员(交付冻结版本 id)。 */
  initialVersionId?: string;
  renderPreview: (content: string) => ReactNode;
  onClose: () => void;
  /** 保存成功后通知父级(刷新卡片/library 投影)。 */
  onSaved: () => void;
  /** 不可逆退回前按 Server root 拉回原讨论串上下文；失败时不得提交退回事实。 */
  prepareReturnThread: (threadRootMessageId: string) => Promise<boolean>;
  /** 原子退回成功后只把稳定 basis 与审核上下文交给父级预填原讨论串。 */
  onReturnToThread: (handoff: PackageReturnHandoff) => void;
}

export function OutputPackagePreviewModal({
  packageMeta,
  channelId,
  initialVersionId,
  renderPreview,
  onClose,
  onSaved,
  prepareReturnThread,
  onReturnToThread,
}: OutputPackagePreviewModalProps) {
  const [collections, setCollections] = useState<ProjectArtifactCollectionDto[] | null>(null);
  const [availableActions, setAvailableActions] = useState<PackageMemberAvailableActionsDto[] | null>(null);
  const [reviewPackageBasis, setReviewPackageBasis] = useState<OutputPackageDto | null>(null);
  const [reviewThreadRootMessageId, setReviewThreadRootMessageId] = useState<string | null>(
    packageMeta.threadRootMessageId ?? null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<HistoryPreview | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusyVersionId, setHistoryBusyVersionId] = useState<string | null>(null);
  // 每次切换成员/保存成功后递增,重挂载编辑器(reset 内部草稿态)。
  const [editorEpoch, setEditorEpoch] = useState(0);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const saveIntentRef = useRef<'version' | 'approve' | 'approve-final'>('version');
  const [editorState, setEditorState] = useState<MarkdownDocumentEditorState>(EMPTY_EDITOR_STATE);
  const [reviewPanel, setReviewPanel] = useState<'approve' | 'return' | null>(null);
  const [approvalMode, setApprovalMode] = useState<'current' | 'save'>('current');
  const [reviewComment, setReviewComment] = useState('');
  const [returnDecision, setReturnDecision] = useState<PackageReturnDecision>('changes_requested');
  const [returnAgentChoice, setReturnAgentChoice] = useState<PackageReturnAgentChoice>('original');
  const [finalizeAfterApprove, setFinalizeAfterApprove] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [selectedVersionIds, setSelectedVersionIds] = useState<Set<string>>(new Set());
  const [batchPanelOpen, setBatchPanelOpen] = useState(false);
  const [batchDecision, setBatchDecision] = useState<'approved' | 'changes_requested' | 'rejected'>('approved');
  const [batchComment, setBatchComment] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);

  const requestClose = useCallback(() => {
    if (!editorState.dirty || window.confirm('有未保存的修改，确定关闭吗？')) onClose();
  }, [editorState.dirty, onClose]);

  const selectMember = useCallback((collectionId: string) => {
    if (collectionId === activeCollectionId) return;
    if (editorState.dirty && !window.confirm('有未保存的修改，确定放弃并切换文件吗？')) return;
    setEditorState(EMPTY_EDITOR_STATE);
    setActiveCollectionId(collectionId);
    setSavedNotice(null);
    setHistoryOpen(false);
    setHistoryPreview(null);
    setHistoryError(null);
    setReviewPanel(null);
    setApprovalMode('current');
    setReviewComment('');
    setReturnDecision('changes_requested');
    setReturnAgentChoice('original');
    setFinalizeAfterApprove(false);
  }, [activeCollectionId, editorState.dirty]);

  const loadWorkspace = useCallback(async () => {
    const [libraryResult, packageResult] = await Promise.all([
      projectEvents().artifactCollections(channelId),
      projectEvents().getOutputPackage({
        channelId,
        packageId: packageMeta.packageId,
        projection: { policy: 'current' },
      }),
    ]);
    if (!libraryResult.ok || !libraryResult.library) {
      setLoadError(libraryResult.ok ? '产物库加载失败' : libraryResult.message ?? '产物库加载失败');
      return null;
    }
    setCollections(libraryResult.library.collections);
    setLoadError(null);
    if (packageResult.ok && packageResult.package) {
      setAvailableActions(packageResult.availableActions ?? []);
      setReviewPackageBasis(packageResult.package);
      setReviewThreadRootMessageId(packageResult.threadRootMessageId ?? packageMeta.threadRootMessageId ?? null);
      const currentReviewableVersionIds = packageMeta.members.flatMap((member) => {
        const collection = libraryResult.library!.collections.find((candidate) => candidate.id === member.collectionId);
        const currentVersionId = collection?.currentVersionId;
        const actions = packageResult.availableActions?.find((entry) => (
          entry.collectionId === member.collectionId && entry.versionId === currentVersionId
        ));
        return currentVersionId && actions?.actions.some((action) => action.startsWith('review-'))
          ? [currentVersionId]
          : [];
      });
      setSelectedVersionIds((selected) => {
        const stillCurrent = currentReviewableVersionIds.filter((versionId) => selected.has(versionId));
        return new Set(stillCurrent.length > 0 ? stillCurrent : currentReviewableVersionIds);
      });
      setActionError(null);
    } else {
      setAvailableActions(null);
      setReviewPackageBasis(null);
      setReviewThreadRootMessageId(packageMeta.threadRootMessageId ?? null);
      setActionError(packageResult.message ?? '审核动作加载失败，请刷新后重试');
    }
    return libraryResult.library.collections;
  }, [channelId, packageMeta.packageId, packageMeta.threadRootMessageId]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) {
        setHistoryOpen(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [historyOpen, requestClose]);

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
  const activeIsMarkdown = active
    ? isMarkdownFilename((active.current.artifact as unknown as Artifact).filename)
    : false;
  const activeActions = active && availableActions
    ? availableActions.find((entry) => (
      entry.collectionId === active.collection.id && entry.versionId === active.current.id
    )) ?? null
    : null;
  const canRejectDelivery = activeActions?.actions.includes('review-and-reject-delivery') ?? false;
  const canRequestChanges = canRejectDelivery
    || (activeActions?.actions.includes('review-changes-requested') ?? false);
  const canRejectVersion = canRejectDelivery
    || (activeActions?.actions.includes('review-rejected') ?? false);
  const currentPackageTargets = packageMeta.members.flatMap((member) => {
    const collection = collections?.find((candidate) => candidate.id === member.collectionId);
    const current = collection?.versions.find((version) => version.id === collection.currentVersionId);
    return collection && current ? [{ member, collection, current }] : [];
  });
  const selectedBatchTargets = currentPackageTargets.filter(({ current }) => selectedVersionIds.has(current.id));

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
    const saveIntent = saveIntentRef.current;
    // 本次动作使用上面的局部快照；立即复位只为避免异常后污染下一次普通保存。
    saveIntentRef.current = 'version';
    const base = active.current;
    const idempotencyKey = `pkg-preview-${saveIntent}:${active.collection.id}:${base.id}:${crypto.randomUUID()}`;
    const packageBasis = saveIntent === 'version' ? null : reviewPackageBasis;
    if (saveIntent !== 'version' && !packageBasis) {
      return { ok: false, conflict: true, message: '审核包上下文已不可用，请刷新后重试' };
    }
    const revisionBasis = {
      sourceVersionId: base.id,
      ...(activeActions?.latestReviewId ? { basisReviewId: activeActions.latestReviewId } : {}),
      ...(packageBasis ? {
        packageId: packageBasis.packageId,
        deliveryId: packageBasis.deliveryId,
      } : {}),
    };
    const result = saveIntent === 'version'
      ? await projectEvents().saveArtifactVersionRevision({
        channelId,
        collectionId: active.collection.id,
        baseVersionId: base.id,
        content: nextContent,
        filename,
        expectedCollectionRevision: active.collection.revision,
        revisionBasis,
        idempotencyKey,
      })
      : saveIntent === 'approve-final'
        ? await projectEvents().submitPackageReviewAndFinalize({
          channelId,
          packageId: packageMeta.packageId,
          collectionId: active.collection.id,
          versionId: base.id,
          decision: 'approved',
          comment: reviewComment.trim() || '通过保存后的新版本',
          expectedCollectionRevision: active.collection.revision,
          saveRevision: { content: nextContent, filename, revisionBasis },
          idempotencyKey,
        })
        : await projectEvents().submitPackageArtifactReview({
          channelId,
          packageId: packageMeta.packageId,
          collectionId: active.collection.id,
          versionId: base.id,
          decision: 'approved',
          comment: reviewComment.trim() || '通过保存后的新版本',
          expectedCollectionRevision: active.collection.revision,
          saveRevision: { content: nextContent, filename, revisionBasis },
          idempotencyKey,
        });
    if (result.ok && result.revision) {
      setSavedNotice(saveIntent === 'version'
        ? `已保存：Server 生成 ${active.collection.name} v${result.revision.versionNumber}，current 已更新；final 未移动。`
        : saveIntent === 'approve-final'
          ? `已保存并通过：Server v${result.revision.versionNumber} 已成为 current 与 final。`
          : `已保存并通过：审核记录绑定 Server v${result.revision.versionNumber}，final 未移动。`);
      await loadWorkspace();
      setEditorEpoch((n) => n + 1);
      setReviewPanel(null);
      setApprovalMode('current');
      setReviewComment('');
      setFinalizeAfterApprove(false);
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
  }, [active, activeActions?.latestReviewId, channelId, loadWorkspace, onSaved, packageMeta.packageId,
    reviewComment, reviewPackageBasis]);

  const submitCurrentReview = useCallback(async (decision: 'approved') => {
    if (!active || !activeActions || reviewBusy) return;
    const requiredAction = 'review-approved';
    if (!activeActions.actions.includes(requiredAction)) {
      setActionError('该版本的审核动作已不可用，请刷新后重试');
      return;
    }
    if (editorState.dirty
      && !window.confirm(`当前有未保存草稿。将只审核 Server v${active.current.versionNumber}，草稿不会提交。继续吗？`)) {
      return;
    }
    if (finalizeAfterApprove
      && !activeActions.actions.includes('review-and-finalize')) {
      setActionError('“通过并设为最终版”动作已不可用，请刷新后重试');
      return;
    }
    setReviewBusy(true);
    setActionError(null);
    try {
      const common = {
        channelId,
        packageId: packageMeta.packageId,
        collectionId: active.collection.id,
        versionId: active.current.id,
        decision,
        comment: reviewComment.trim() || '通过当前 Server 版本',
        idempotencyKey: `pkg-preview-review:${active.collection.id}:${active.current.id}:${crypto.randomUUID()}`,
      };
      const result = finalizeAfterApprove
        ? await projectEvents().submitPackageReviewAndFinalize({
          ...common,
          decision: 'approved',
          expectedCollectionRevision: active.collection.revision,
        })
        : await projectEvents().submitPackageArtifactReview(common);
      if (!result.ok || !result.review) {
        setActionError(result.message ?? result.error ?? '审核提交失败');
        return;
      }
      setSavedNotice(finalizeAfterApprove
        ? `已通过：Server v${active.current.versionNumber} 已设为 final。`
        : `已通过：审核记录绑定 Server v${active.current.versionNumber}，final 未移动。`);
      setReviewPanel(null);
      setReviewComment('');
      setFinalizeAfterApprove(false);
      await loadWorkspace();
      onSaved();
    } finally {
      setReviewBusy(false);
    }
  }, [active, activeActions, channelId, editorState.dirty, finalizeAfterApprove, loadWorkspace,
    onSaved, packageMeta.packageId, reviewBusy, reviewComment]);

  const submitCurrentReturn = useCallback(async () => {
    if (!active || !activeActions || !reviewPackageBasis || reviewBusy) return;
    const rejectDelivery = activeActions.actions.includes('review-and-reject-delivery');
    const requiredReviewAction = returnDecision === 'rejected'
      ? 'review-rejected'
      : 'review-changes-requested';
    if (!rejectDelivery && !activeActions.actions.includes(requiredReviewAction)) {
      setActionError('当前版本的负面审核动作已不可用，请刷新后重试');
      return;
    }
    const comment = reviewComment.trim();
    if (!comment) {
      setActionError('退回修改时请填写审核意见');
      return;
    }
    if (rejectDelivery && reviewPackageBasis.taskRevision === undefined) {
      setActionError('当前文件包没有可校验的 Task revision，无法安全退回');
      return;
    }
    if (editorState.dirty
      && !window.confirm(`当前有未保存草稿。退回只会审核 Server v${active.current.versionNumber}，草稿不会提交。继续吗？`)) {
      return;
    }
    setReviewBusy(true);
    setActionError(null);
    try {
      if (!rejectDelivery) {
        const result = await projectEvents().submitPackageArtifactReview({
          channelId,
          packageId: reviewPackageBasis.packageId,
          collectionId: active.collection.id,
          versionId: active.current.id,
          decision: returnDecision,
          comment,
          idempotencyKey: `pkg-preview-review:${active.collection.id}:${active.current.id}:${crypto.randomUUID()}`,
        });
        if (!result.ok || !result.review) {
          setActionError(result.message ?? result.error ?? '文件审核提交失败');
          return;
        }
        setSavedNotice(`已记录：Server v${active.current.versionNumber} ${returnDecision === 'rejected' ? '已拒绝' : '要求修改'}，Task delivery 未变更。`);
        setReviewPanel(null);
        setReviewComment('');
        await loadWorkspace();
        onSaved();
        return;
      }
      if (!reviewThreadRootMessageId) {
        setActionError('无法定位原讨论串，尚未退回 Task delivery');
        return;
      }
      const threadReady = await prepareReturnThread(reviewThreadRootMessageId).catch(() => false);
      if (!threadReady) {
        setActionError('原讨论串上下文加载失败，尚未退回 Task delivery');
        return;
      }
      const result = await projectEvents().submitPackageReviewAndRejectDelivery({
        channelId,
        packageId: reviewPackageBasis.packageId,
        collectionId: active.collection.id,
        versionId: active.current.id,
        decision: returnDecision,
        comment,
        expectedTaskRevision: reviewPackageBasis.taskRevision,
        expectedTaskAttempt: reviewPackageBasis.taskAttempt,
        rejectReason: comment,
        idempotencyKey: `pkg-preview-return:${active.collection.id}:${active.current.id}:${crypto.randomUUID()}`,
      });
      if (!result.ok || !result.review || !result.task) {
        setActionError(result.message ?? result.error ?? '退回提交失败');
        return;
      }
      onSaved();
      onReturnToThread({
        packageId: reviewPackageBasis.packageId,
        threadRootMessageId: reviewThreadRootMessageId,
        taskId: reviewPackageBasis.taskId,
        ...(packageMeta.taskTitle ? { taskTitle: packageMeta.taskTitle } : {}),
        originalAgentId: reviewPackageBasis.agentId,
        ...(packageMeta.agentName ? { originalAgentName: packageMeta.agentName } : {}),
        collectionId: active.collection.id,
        versionId: active.current.id,
        filename: (active.current.artifact as unknown as Artifact).filename,
        versionNumber: active.current.versionNumber,
        decision: returnDecision,
        comment,
        agentChoice: returnAgentChoice,
        taskRevision: result.task.taskRevision,
        taskAttempt: result.task.taskAttempt,
      });
    } finally {
      setReviewBusy(false);
    }
  }, [active, activeActions, channelId, editorState.dirty, loadWorkspace, onReturnToThread, onSaved,
    packageMeta.agentName, packageMeta.taskTitle, prepareReturnThread, returnAgentChoice, returnDecision,
    reviewBusy, reviewComment, reviewPackageBasis, reviewThreadRootMessageId]);

  const submitBatchReview = useCallback(async () => {
    if (!reviewPackageBasis || selectedBatchTargets.length === 0 || batchBusy) return;
    if (batchDecision !== 'approved' && !batchComment.trim()) {
      setActionError(batchDecision === 'rejected' ? '全部拒绝时请填写统一意见' : '全部要求修改时请填写统一意见');
      return;
    }
    const requiredAction = batchDecision === 'approved'
      ? 'review-approved'
      : batchDecision === 'changes_requested' ? 'review-changes-requested' : 'review-rejected';
    const unavailable = selectedBatchTargets.some(({ collection, current }) => {
      const actions = availableActions?.find((entry) => (
        entry.collectionId === collection.id && entry.versionId === current.id
      ));
      return !actions?.actions.includes(requiredAction);
    });
    if (unavailable) {
      setActionError('选中版本中存在已不可执行的审核动作，请刷新后重试');
      return;
    }
    setBatchBusy(true);
    setActionError(null);
    try {
      const result = await projectEvents().submitPackageArtifactReviews({
        channelId,
        packageId: reviewPackageBasis.packageId,
        deliveryId: reviewPackageBasis.deliveryId,
        expectedPackageRevision: reviewPackageBasis.revision,
        targets: selectedBatchTargets.map(({ collection, current }) => ({
          collectionId: collection.id,
          artifactVersionId: current.id,
        })),
        decision: batchDecision,
        comment: batchComment.trim() || '批量通过当前 Server 版本',
        idempotencyKey: `pkg-preview-batch-review:${reviewPackageBasis.deliveryId}:${crypto.randomUUID()}`,
      });
      if (!result.ok || !result.reviews) {
        const reasons = result.rejectedTargets?.map((failure) => {
          const target = selectedBatchTargets.find(({ current }) => current.id === failure.artifactVersionId);
          const filename = target ? (target.current.artifact as unknown as Artifact).filename : '整批请求';
          return `${filename}：${batchFailureLabel(failure.reason)}`;
        });
        setActionError(reasons?.length ? reasons.join('；') : result.message ?? result.error ?? '批量审核提交失败');
        return;
      }
      setSavedNotice(`已批量${batchDecisionLabel(batchDecision)} ${result.reviews.length} 个文件版本；Task 状态未自动变更。`);
      setBatchPanelOpen(false);
      setBatchComment('');
      await loadWorkspace();
      onSaved();
    } catch (error) {
      setActionError(error instanceof Error ? `批量审核提交失败：${error.message}` : '批量审核提交失败，请重试');
    } finally {
      setBatchBusy(false);
    }
  }, [availableActions, batchBusy, batchComment, batchDecision, channelId, loadWorkspace, onSaved,
    reviewPackageBasis, selectedBatchTargets]);

  const loadLatest = useCallback(async () => {
    const latestCollections = await loadWorkspace();
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
  }, [loadWorkspace, activeCollectionId]);

  const previewHistoryVersion = useCallback(async (version: ProjectArtifactVersionDto) => {
    const artifact = version.artifact as unknown as Artifact;
    const url = chatArtifactUrl(artifact, 'preview', {
      serverUrl: getResolvedServerUrl(),
      token: getStoredAuthToken(),
      ...(artifact.teamId ? { teamId: artifact.teamId } : {}),
    });
    if (!url) {
      setHistoryError('该历史版本没有可用的在线内容');
      return;
    }
    setHistoryBusyVersionId(version.id);
    setHistoryError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(response.status === 415 ? '该历史版本不是 UTF-8，仅支持下载' : '历史版本加载失败');
      }
      setHistoryPreview({ version, content: await response.text() });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '历史版本加载失败');
    } finally {
      setHistoryBusyVersionId(null);
    }
  }, []);

  const triggerEditorSave = useCallback((intent: 'version' | 'approve' | 'approve-final') => {
    saveIntentRef.current = intent;
    editorContainerRef.current?.querySelector<HTMLButtonElement>('[data-markdown-document-save]')?.click();
  }, []);

  const handleEditorStateChange = useCallback((next: MarkdownDocumentEditorState) => {
    setEditorState(next);
    if (next.dirty) setApprovalMode('save');
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-neutral-950/35"
      role="dialog"
      aria-modal="true"
      aria-label={`预览/编辑 ${shortPkg(packageMeta.packageId)}`}
      onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
    >
      <div
        className="relative grid h-[min(740px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] grid-rows-[48px_minmax(0,1fr)_56px] overflow-hidden rounded-lg border border-white/80 bg-white shadow-2xl sm:h-[min(740px,calc(100vh-56px))] sm:w-[min(1120px,calc(100vw-56px))]"
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
                <div key={member.artifactVersionId} className={`mb-2 flex rounded-lg border ${
                  isActive ? 'border-sky-200 bg-sky-50' : 'border-neutral-200 bg-white hover:border-neutral-300'
                }`}>
                  <label className="flex shrink-0 items-start px-2 pt-2.5" title="加入批量审核">
                    <input
                      type="checkbox"
                      checked={Boolean(current && selectedVersionIds.has(current.id))}
                      disabled={!current}
                      onChange={(event) => {
                        if (!current) return;
                        setSelectedVersionIds((selected) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(current.id); else next.delete(current.id);
                          return next;
                        });
                      }}
                      aria-label={`选择 ${member.filename} 当前版本参与批量审核`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => selectMember(member.collectionId)}
                    data-smoke="package-preview-member"
                    className="min-w-0 flex-1 px-1 pb-2 pr-2 pt-2 text-left"
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
                </div>
              );
            })}
          </aside>

          {/* 右栏:编辑器 / 占位 */}
          <div ref={editorContainerRef} className="min-h-0 min-w-0">
            {loadError ? (
              <div className="flex h-full items-center justify-center text-sm text-red-600">{loadError}</div>
            ) : !active ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">选择左侧文件</div>
            ) : !activeIsMarkdown ? (
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
                simulateConflictMessage={`模拟冲突：假设 Server 已有 ${active.collection.name} v${active.current.versionNumber + 1}；你的草稿仍保留，请先查看最新版再手工合并。`}
                onStateChange={handleEditorStateChange}
              />
            )}
          </div>
        </div>

        {historyOpen && active && (
          <section
            className="absolute inset-0 z-20 grid grid-rows-[48px_minmax(0,1fr)] bg-white"
            role="dialog"
            aria-modal="true"
            aria-label={`${active.collection.name} 版本历史`}
            data-smoke="package-preview-history"
          >
            <header className="flex items-center border-b border-neutral-200 bg-neutral-50/80 px-3">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-neutral-900">版本历史 · {active.collection.name}</h3>
                <p className="truncate text-[10px] text-neutral-500">历史版本只读预览；下载不会改变 current 或 final。</p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                title="关闭版本历史"
              >
                <X size={16} />
              </button>
            </header>
            <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)]">
              <ol className="min-h-0 space-y-2 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-3">
                {[...active.collection.versions]
                  .sort((left, right) => right.versionNumber - left.versionNumber)
                  .map((version) => {
                    const artifact = version.artifact as unknown as Artifact;
                    const downloadUrl = chatArtifactUrl(artifact, 'download', {
                      serverUrl: getResolvedServerUrl(),
                      token: getStoredAuthToken(),
                      ...(artifact.teamId ? { teamId: artifact.teamId } : {}),
                    });
                    const isCurrent = active.collection.currentVersionId === version.id;
                    const isFinal = active.collection.finalVersionId === version.id;
                    return (
                      <li key={version.id} className="rounded-lg border border-neutral-200 bg-white p-2.5 text-xs">
                        <div className="flex items-center gap-1.5">
                          <strong className="text-neutral-900">v{version.versionNumber}</strong>
                          {isCurrent && <span className="rounded bg-sky-50 px-1 py-0.5 text-[10px] text-sky-700">current</span>}
                          {isFinal && <span className="rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-700">final</span>}
                          <span className="ml-auto text-[10px] text-neutral-500">{reviewStateLabel(version.reviewState)}</span>
                        </div>
                        <p className="mt-1 truncate text-neutral-700">{artifact.filename}</p>
                        <p className="mt-1 text-[10px] text-neutral-500">
                          {version.revisionBasis ? '手动修改' : 'Agent 修订'} · {new Date(version.createdAt).toLocaleString('zh-CN')}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            disabled={historyBusyVersionId !== null || !isMarkdownFilename(artifact.filename)}
                            onClick={() => void previewHistoryVersion(version)}
                            className="rounded border border-neutral-300 px-2 py-1 text-[10px] text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`预览 v${version.versionNumber}`}
                          >
                            {historyBusyVersionId === version.id ? '加载中…' : '预览'}
                          </button>
                          {downloadUrl && (
                            <a
                              href={downloadUrl}
                              download
                              className="rounded border border-neutral-300 px-2 py-1 text-[10px] text-neutral-700 hover:bg-neutral-50"
                              aria-label={`下载 v${version.versionNumber}`}
                            >
                              下载
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ol>
              <div className="min-h-0 overflow-y-auto p-5">
                {historyError ? (
                  <div role="alert" className="text-sm text-red-600">{historyError}</div>
                ) : historyPreview ? (
                  <article data-smoke="package-preview-history-rendered">
                    <p className="mb-3 text-xs font-semibold text-neutral-500">v{historyPreview.version.versionNumber} 只读预览</p>
                    {renderPreview(historyPreview.content)}
                  </article>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-neutral-400">选择左侧版本进行预览</div>
                )}
              </div>
            </div>
          </section>
        )}

        {reviewPanel && active && activeActions && (
          <section
            className="absolute bottom-14 right-3 z-10 w-[min(390px,calc(100%-24px))] rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
            aria-label={reviewPanel === 'approve' ? '通过审核' : '退回修改'}
            data-smoke="package-preview-review-panel"
          >
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-sm font-semibold text-neutral-900">
                {reviewPanel === 'approve' ? '通过当前文件版本' : '退回修改'}
              </h3>
              <button type="button" onClick={() => setReviewPanel(null)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100" title="关闭审核面板">
                <X size={14} />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">
              审核对象：{(active.current.artifact as unknown as Artifact).filename} · Server v{active.current.versionNumber}
            </p>
            {reviewPanel === 'approve' && activeIsMarkdown && (
              <fieldset className="mt-3 space-y-2 text-xs text-neutral-700">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="package-preview-approval-mode"
                    checked={approvalMode === 'current'}
                    onChange={() => setApprovalMode('current')}
                  />
                  <span>通过当前已保存的 Server v{active.current.versionNumber}</span>
                </label>
                <label className={`flex items-start gap-2 ${editorState.dirty ? '' : 'text-neutral-400'}`}>
                  <input
                    type="radio"
                    name="package-preview-approval-mode"
                    checked={approvalMode === 'save'}
                    disabled={!editorState.dirty}
                    onChange={() => setApprovalMode('save')}
                  />
                  <span>保存编辑稿为新版本，然后通过新版本</span>
                </label>
              </fieldset>
            )}
            {reviewPanel === 'return' && (
              <fieldset className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-700">
                <legend className="sr-only">退回结论</legend>
                <label className={`rounded-md border p-2 ${!canRequestChanges ? 'text-neutral-400 opacity-60' : ''} ${
                  returnDecision === 'changes_requested' ? 'border-orange-300 bg-orange-50' : 'border-neutral-200'
                }`}>
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="package-preview-return-decision"
                      checked={returnDecision === 'changes_requested'}
                      disabled={!canRequestChanges}
                      onChange={() => setReturnDecision('changes_requested')}
                    />
                    <span><strong className="block">要求修改</strong>方向基本可用，基于当前版本继续改。</span>
                  </span>
                </label>
                <label className={`rounded-md border p-2 ${!canRejectVersion ? 'text-neutral-400 opacity-60' : ''} ${
                  returnDecision === 'rejected' ? 'border-rose-300 bg-rose-50' : 'border-neutral-200'
                }`}>
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="package-preview-return-decision"
                      checked={returnDecision === 'rejected'}
                      disabled={!canRejectVersion}
                      onChange={() => setReturnDecision('rejected')}
                    />
                    <span><strong className="block">拒绝</strong>当前版本不可作为正式输入，需要重做或大改。</span>
                  </span>
                </label>
              </fieldset>
            )}
            <label className="mt-3 block text-xs font-medium text-neutral-700">
              审核意见{reviewPanel === 'return' ? '（必填）' : '（可选）'}
              <textarea
                value={reviewComment}
                onChange={(event) => setReviewComment(event.target.value)}
                rows={3}
                placeholder={reviewPanel === 'return' ? '说明需要修改或重做的内容' : '补充通过依据'}
                className="mt-1 w-full resize-none rounded-md border border-neutral-300 px-2.5 py-2 text-xs outline-none focus:border-sky-400"
              />
            </label>
            {reviewPanel === 'approve' && activeActions.actions.includes('review-and-finalize') && (
              <label className="mt-2 flex items-center gap-2 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={finalizeAfterApprove}
                  onChange={(event) => setFinalizeAfterApprove(event.target.checked)}
                />
                同时设为当前文档的最终版（不验收 Task）
              </label>
            )}
            {reviewPanel === 'return' && canRejectDelivery && (
              <fieldset className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-700">
                <legend className="sr-only">下一步处理方式</legend>
                <label className={`rounded-md border p-2 ${
                  returnAgentChoice === 'original' ? 'border-sky-300 bg-sky-50' : 'border-neutral-200'
                }`}>
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="package-preview-return-agent"
                      checked={returnAgentChoice === 'original'}
                      onChange={() => setReturnAgentChoice('original')}
                    />
                    <span><strong className="block">让原智能体修改</strong>回讨论串时预填原智能体。</span>
                  </span>
                </label>
                <label className={`rounded-md border p-2 ${
                  returnAgentChoice === 'select' ? 'border-violet-300 bg-violet-50' : 'border-neutral-200'
                }`}>
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="package-preview-return-agent"
                      checked={returnAgentChoice === 'select'}
                      onChange={() => setReturnAgentChoice('select')}
                    />
                    <span><strong className="block">换一个智能体处理</strong>不指定具体智能体，回讨论串后选择。</span>
                  </span>
                </label>
              </fieldset>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setReviewPanel(null)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50">
                取消
              </button>
              <button
                type="button"
                disabled={reviewBusy || (reviewPanel === 'return' && !reviewComment.trim())
                  || (reviewPanel === 'approve' && approvalMode === 'save' && editorState.saveDisabled)}
                onClick={() => {
                  if (reviewPanel === 'return') {
                    void submitCurrentReturn();
                    return;
                  }
                  if (approvalMode === 'save') {
                    triggerEditorSave(finalizeAfterApprove ? 'approve-final' : 'approve');
                    return;
                  }
                  void submitCurrentReview('approved');
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-neutral-300 ${
                  reviewPanel === 'return' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {reviewBusy || editorState.saving
                  ? '提交中…'
                  : reviewPanel === 'return'
                    ? canRejectDelivery ? '回讨论串继续' : '确认文件审核'
                    : '确认通过'}
              </button>
            </div>
          </section>
        )}

        {batchPanelOpen && (
          <section
            className="absolute bottom-14 right-3 z-20 w-[min(460px,calc(100%-24px))] rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
            aria-label="批量审核文件版本"
            data-smoke="package-preview-batch-review-panel"
          >
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-sm font-semibold text-neutral-900">批量逐文件审核</h3>
              <button type="button" onClick={() => setBatchPanelOpen(false)} className="rounded p-1 text-neutral-400 hover:bg-neutral-100" title="关闭批量审核面板">
                <X size={14} />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">将为以下 {selectedBatchTargets.length} 个 Server current 版本分别写入审核记录：</p>
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-[11px] text-neutral-700">
              {selectedBatchTargets.map(({ current }) => (
                <li key={current.id} className="flex justify-between gap-2">
                  <span className="truncate">{(current.artifact as unknown as Artifact).filename}</span>
                  <span className="shrink-0 text-neutral-500">Server v{current.versionNumber}</span>
                </li>
              ))}
            </ul>
            <fieldset className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-700">
              {([
                ['approved', '全部通过'],
                ['changes_requested', '全部要求修改'],
                ['rejected', '全部拒绝'],
              ] as const).map(([decision, label]) => (
                <label key={decision} className="flex items-center gap-1.5">
                  <input type="radio" name="package-batch-review-decision" checked={batchDecision === decision} onChange={() => setBatchDecision(decision)} />
                  {label}
                </label>
              ))}
            </fieldset>
            <label className="mt-3 block text-xs font-medium text-neutral-700">
              统一意见{batchDecision === 'approved' ? '（可选）' : '（必填）'}
              <textarea
                value={batchComment}
                onChange={(event) => setBatchComment(event.target.value)}
                rows={3}
                placeholder={batchDecision === 'approved' ? '补充批量通过依据' : '说明需要修改或拒绝的原因'}
                className="mt-1 w-full resize-none rounded-md border border-neutral-300 px-2.5 py-2 text-xs outline-none focus:border-sky-400"
              />
            </label>
            <p className="mt-2 text-[10px] text-neutral-500">任一版本过期、无权限、重复或不属于当前交付时，整批不会写入。批量通过不会自动验收 Task。</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setBatchPanelOpen(false)} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50">取消</button>
              <button
                type="button"
                disabled={batchBusy || selectedBatchTargets.length === 0 || (batchDecision !== 'approved' && !batchComment.trim())}
                onClick={() => void submitBatchReview()}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
              >
                {batchBusy ? '提交中…' : `确认${batchDecisionLabel(batchDecision)}`}
              </button>
            </div>
          </section>
        )}

        {/* footer:保存沿用版本编辑能力；审核按钮只消费 Server availableActions。 */}
        <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-neutral-200 bg-neutral-50/80 px-3">
          <div className="flex min-w-0 items-center gap-2 text-xs text-neutral-600">
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
              actionError ? 'border-red-200 bg-red-50 text-red-700'
                : savedNotice ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-sky-200 bg-sky-50 text-sky-700'
            }`}>
              {actionError ? '动作不可用' : savedNotice ? '已更新' : 'Server source of truth'}
            </span>
            {actionError ? (
              <span className="truncate text-red-700" role="alert">{actionError}</span>
            ) : savedNotice ? (
              <span className="truncate text-emerald-700" data-smoke="package-preview-saved">{savedNotice}</span>
            ) : availableActions && (!activeActions || activeActions.actions.length === 0) ? (
              <span className="truncate text-neutral-500">当前版本没有可执行的审核动作</span>
            ) : null}
          </div>
          {active ? (
            <div
              className="flex min-w-0 max-w-full items-center gap-1.5 overflow-x-auto [&>*]:shrink-0"
              data-smoke="package-preview-actions"
            >
              <button
                type="button"
                disabled={selectedBatchTargets.length === 0 || batchBusy}
                onClick={() => {
                  setActionError(null);
                  setReviewPanel(null);
                  setBatchPanelOpen(true);
                }}
                className="rounded-md border border-neutral-400 bg-white px-2.5 py-1.5 text-xs font-semibold text-neutral-800 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                data-smoke="package-preview-batch-review"
              >
                批量审核（{selectedBatchTargets.length}）…
              </button>
              {activeIsMarkdown && (
                <button
                  type="button"
                  onClick={() => editorContainerRef.current?.querySelector<HTMLButtonElement>('[data-markdown-document-simulate-conflict]')?.click()}
                  disabled={!editorState.dirty || editorState.saving || editorState.conflicted}
                  title="仅演示冲突处理，不写入 Server"
                  className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                  data-smoke="package-preview-simulate-conflict"
                >
                  模拟冲突
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setHistoryPreview(null);
                  setHistoryError(null);
                  setHistoryOpen(true);
                }}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                data-smoke="package-preview-history-open"
              >
                查看版本历史
              </button>
              {activeIsMarkdown && (
                <>
                  <button
                    type="button"
                    onClick={() => triggerEditorSave('version')}
                    disabled={editorState.saveDisabled}
                    className="rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-neutral-300 disabled:bg-neutral-300"
                    data-smoke="package-preview-save"
                  >
                    {editorState.saving ? '保存中…' : '保存为 Server 新版本'}
                  </button>
                </>
              )}
              {(canRequestChanges || canRejectVersion) && (
                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setReviewPanel('return');
                    setReturnDecision(canRequestChanges ? 'changes_requested' : 'rejected');
                    setReturnAgentChoice('original');
                    setFinalizeAfterApprove(false);
                  }}
                  className="rounded-md border border-orange-300 bg-orange-50 px-3 py-1.5 text-xs font-semibold text-orange-800 hover:bg-orange-100"
                  data-smoke="package-preview-request-changes"
                >
                  退回修改…
                </button>
              )}
              {(activeActions?.actions.includes('review-approved')
                || activeActions?.actions.includes('review-and-finalize')) && (
                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setApprovalMode(editorState.dirty ? 'save' : 'current');
                    setReviewPanel('approve');
                  }}
                  className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                  data-smoke="package-preview-approve"
                >
                  通过
                </button>
              )}
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

function shortPkg(packageId: string): string {
  return `PKG-${packageId.slice(0, 8)}`;
}

function batchDecisionLabel(decision: 'approved' | 'changes_requested' | 'rejected'): string {
  if (decision === 'approved') return '通过';
  if (decision === 'changes_requested') return '要求修改';
  return '拒绝';
}

function batchFailureLabel(reason: string): string {
  const labels: Record<string, string> = {
    'delivery-revision-stale': '当前交付已变化',
    'package-revision-stale': '输出包 revision 已变化',
    'version-not-current': '文件版本已不是 current',
    'duplicate-target': '目标重复',
    'version-not-in-package': '不属于当前输出包',
    'version-not-in-collection': '文件版本与集合不匹配',
    'actor-not-authorized': '无审核权限',
  };
  return labels[reason] ?? reason;
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
