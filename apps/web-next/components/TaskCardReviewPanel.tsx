'use client';

/**
 * 原型对齐（2026-07-28 prototype `screen-task` review-panel）：待审核任务卡片内嵌审核面板。
 *
 * - 审核结论（通过审核/要求修改/拒绝此版本）作用于焦点包当前交付版本的待审成员，
 *   走 #1199 批量命令（全有或全无）；
 * - 「通过并设为最终版」逐成员走 #1061 原子命令（审核通过 + finalVersionId 同一事务），
 *   多成员串行提交、部分完成透明展示（final 是 per-collection 指针，Server 无整包原子语义）；
 * - 「回到讨论串继续」只做定位导航，不产生任何 Server 写入（设计文档 §8.6）。
 * 按钮可见性只消费 Server availableActions 投影；不渲染 = 无权限或投影未就绪。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OutputPackageDto,
  PackageMemberAvailableActionsDto,
  PackageReviewAction,
  ProjectArtifactReviewDecision,
} from '@agentbean/contracts';

import {
  mutationErrorCopy,
  nextMutationIdempotencyKey,
  submitPackageBatchReview,
  submitPackageReviewAndFinalizeMember,
} from '@/lib/package-review-actions';
import { projectEvents } from '@/lib/socket';

export interface TaskCardReviewProjection {
  readonly package: OutputPackageDto;
  readonly availableActions: readonly PackageMemberAvailableActionsDto[];
  readonly threadRootMessageId?: string;
}

type BatchDecisionAction = 'review-approved' | 'review-changes-requested' | 'review-rejected';

const BATCH_DECISIONS: Readonly<Record<BatchDecisionAction, ProjectArtifactReviewDecision>> = {
  'review-approved': 'approved',
  'review-changes-requested': 'changes_requested',
  'review-rejected': 'rejected',
};

/** 要求修改/拒绝必须留意见（设计文档 §8.4：审核意见保留）。 */
const COMMENT_REQUIRED_ACTIONS = new Set<BatchDecisionAction>(['review-changes-requested', 'review-rejected']);

export function TaskCardReviewPanel({
  channelId,
  focusPackageId,
  archived,
  onBackToThread,
  onMutationSucceeded,
  onProjection,
}: {
  channelId: string;
  focusPackageId: string | null;
  archived: boolean;
  onBackToThread: (threadRootMessageId: string | undefined) => void;
  onMutationSucceeded: () => void;
  onProjection?: (projection: TaskCardReviewProjection | null) => void;
}) {
  const [projection, setProjection] = useState<TaskCardReviewProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<BatchDecisionAction | 'review-and-finalize' | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const intentKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusPackageId || archived) {
      setProjection(null);
      onProjection?.(null);
      return;
    }
    let alive = true;
    let requestId = 0;
    const load = () => {
      const currentRequestId = ++requestId;
      projectEvents().getOutputPackage({ channelId, packageId: focusPackageId }).then((result) => {
        if (!alive || currentRequestId !== requestId) return;
        if (result.ok && result.package && result.availableActions) {
          const next: TaskCardReviewProjection = {
            package: result.package,
            availableActions: result.availableActions,
            ...(result.threadRootMessageId ? { threadRootMessageId: result.threadRootMessageId } : {}),
          };
          setProjection(next);
          setError(null);
          onProjection?.(next);
        }
        // 投影拉取失败时保留旧投影；卡片摘要仍可用，不阻塞渲染。
      }).catch(() => { /* 同上：软失败 */ });
    };
    load();
    const stopProject = projectEvents().onUpdated(channelId, load);
    const stopArtifacts = projectEvents().onArtifactsUpdated(channelId, load);
    return () => {
      alive = false;
      stopProject();
      stopArtifacts();
    };
  // onProjection 由父级内联传入时引用不稳定，刻意不加入依赖（只在投影变化时回调）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, focusPackageId, archived]);

  const memberActions = (action: PackageReviewAction): readonly PackageMemberAvailableActionsDto[] =>
    projection?.availableActions.filter((entry) => entry.actions.includes(action)) ?? [];

  const targetsFor = (action: BatchDecisionAction) =>
    memberActions(action).map((entry) => ({
      collectionId: entry.collectionId,
      artifactVersionId: entry.versionId,
    }));

  const closeInlineForm = useCallback(() => {
    setPendingAction(null);
    setComment('');
    setError(null);
  }, []);

  const refreshProjection = useCallback(() => {
    if (!focusPackageId) return;
    projectEvents().getOutputPackage({ channelId, packageId: focusPackageId }).then((result) => {
      if (result.ok && result.package && result.availableActions) {
        const next: TaskCardReviewProjection = {
          package: result.package,
          availableActions: result.availableActions,
          ...(result.threadRootMessageId ? { threadRootMessageId: result.threadRootMessageId } : {}),
        };
        setProjection(next);
        onProjection?.(next);
      }
    }).catch(() => { /* 软失败：等待事件刷新 */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, focusPackageId]);

  const submit = useCallback(async () => {
    if (!projection || !pendingAction || busy) return;
    if (COMMENT_REQUIRED_ACTIONS.has(pendingAction as BatchDecisionAction) && !comment.trim()) {
      setError('请填写审核意见');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pendingAction === 'review-and-finalize') {
        const finalizable = memberActions('review-and-finalize');
        const pkg = projection.package;
        let done = 0;
        let lastError: string | null = null;
        for (const entry of finalizable) {
          const result = await submitPackageReviewAndFinalizeMember({
            channelId,
            packageId: pkg.packageId,
            collectionId: entry.collectionId,
            versionId: entry.versionId,
            expectedCollectionRevision: entry.collectionRevision,
            comment: comment.trim() || '卡片通过并设为最终版',
            idempotencyKey: nextMutationIdempotencyKey(`task-card-finalize:${pkg.packageId}`),
          });
          if (result.ok) done += 1;
          else lastError = mutationErrorCopy(result);
        }
        if (done > 0) {
          setNotice(finalizable.length > 1
            ? `已通过并设为最终版 ${done}/${finalizable.length} 个文件版本${lastError ? `；未完成：${lastError}` : ''}`
            : '已通过并设为最终版');
        }
        if (done === 0 && lastError) setError(lastError);
      } else {
        const batchAction = pendingAction as BatchDecisionAction;
        const pkg = projection.package;
        const result = await submitPackageBatchReview(
          {
            channelId,
            packageId: pkg.packageId,
            deliveryId: pkg.deliveryId,
            expectedPackageRevision: pkg.revision,
            targets: targetsFor(batchAction),
            decision: BATCH_DECISIONS[batchAction],
            comment: comment.trim() || '卡片批量通过当前 Server 版本',
          },
          intentKeyRef.current ?? nextMutationIdempotencyKey(`task-card-batch:${pkg.packageId}`),
        );
        intentKeyRef.current = null;
        if (!result.ok) {
          setError(result.rejectedTargets?.length
            ? `部分目标不可执行：${result.rejectedTargets.map((target) => target.reason).join('；')}`
            : mutationErrorCopy(result));
        } else {
          setNotice(`已提交 ${result.reviews?.length ?? targetsFor(batchAction).length} 个文件版本的审核；Task 状态未自动变更。`);
        }
      }
      setPendingAction(null);
      setComment('');
      refreshProjection();
      onMutationSucceeded();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  // memberActions/targetsFor 依赖 projection；刻意以 projection+pendingAction 收敛。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, channelId, comment, onMutationSucceeded, pendingAction, projection, refreshProjection]);

  if (archived || !focusPackageId) return null;

  const hasReviewAuthority = (projection?.availableActions.length ?? 0) > 0;
  const canBatchApprove = memberActions('review-approved').length > 0;
  const canRequestChanges = memberActions('review-changes-requested').length > 0;
  const canReject = memberActions('review-rejected').length > 0;
  const canFinalize = memberActions('review-and-finalize').length > 0;
  // 投影未就绪（加载中/失败）时不渲染面板：卡片摘要仍然完整可用。
  if (!projection) return null;
  if (!hasReviewAuthority && !projection.threadRootMessageId) return null;

  const actionPending = pendingAction !== null;

  return (
    <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5" data-smoke="task-card-review-panel">
      <div className="text-xs font-medium text-amber-800" data-smoke="task-card-review-title">
        任一频道成员都可以审核；实际审核人以点击者为准
      </div>
      <p className="mt-1 text-[11px] leading-4 text-amber-900/80">
        审核动作只处理当前输出版本；接下来由哪个智能体继续执行，在讨论串里通过 @智能体 + @文件包 来决定。
      </p>

      {hasReviewAuthority ? (
        <div className="mt-2 space-y-2">
          <div data-smoke="task-card-review-decision-group">
            <div className="text-[11px] font-semibold text-neutral-700">审核结论</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <button
                type="button"
                data-smoke="task-card-review-action"
                data-action="review-approved"
                disabled={busy || actionPending || !canBatchApprove}
                onClick={() => { intentKeyRef.current = nextMutationIdempotencyKey('task-card-batch'); setPendingAction('review-approved'); setNotice(null); }}
                className="rounded-md bg-sky-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                通过审核
              </button>
              <button
                type="button"
                data-smoke="task-card-review-action"
                data-action="review-changes-requested"
                disabled={busy || actionPending || !canRequestChanges}
                onClick={() => { closeInlineForm(); setPendingAction('review-changes-requested'); setNotice(null); }}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                要求修改
              </button>
              <button
                type="button"
                data-smoke="task-card-review-action"
                data-action="review-rejected"
                disabled={busy || actionPending || !canReject}
                onClick={() => { closeInlineForm(); setPendingAction('review-rejected'); setNotice(null); }}
                className="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                拒绝此版本
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">
              通过审核：把当前版本标为可被后续引用，任务可进入已通过。要求修改：保留版本并回到讨论串填写修改意见。拒绝此版本：标为不可用，需要重新生成或重做。
            </p>
          </div>

          <div data-smoke="task-card-review-finalize-group">
            <div className="text-[11px] font-semibold text-neutral-700">版本选择</div>
            <div className="mt-1">
              <button
                type="button"
                data-smoke="task-card-review-action"
                data-action="review-and-finalize"
                disabled={busy || actionPending || !canFinalize}
                onClick={() => { closeInlineForm(); setPendingAction('review-and-finalize'); setNotice(null); }}
                className="rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                通过并设为最终版
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">
              待审核版本不能直接设 final；这里使用“通过并设为最终版”，一次写入 ArtifactReview 和 finalVersionId。多文件将逐个完成并汇报进度。
            </p>
          </div>
        </div>
      ) : null}

      <div className={hasReviewAuthority ? 'mt-2' : 'mt-2'} data-smoke="task-card-review-continue-group">
        <div className="text-[11px] font-semibold text-neutral-700">继续协作</div>
        <div className="mt-1">
          <button
            type="button"
            data-smoke="task-card-review-back-to-thread"
            disabled={busy}
            onClick={() => onBackToThread(projection.threadRootMessageId)}
            className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            回到讨论串继续
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500">
          不改状态，只定位到当前话题输入框，继续用 @智能体 + @文件包 或 @F1 @F2 指定下一步。
        </p>
      </div>

      {actionPending ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-white p-2" data-smoke="task-card-review-inline-form">
          <label className="text-[11px] font-medium text-neutral-700">
            {COMMENT_REQUIRED_ACTIONS.has(pendingAction as BatchDecisionAction) ? '审核意见（必填）' : '审核意见（可选）'}
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              disabled={busy}
              className="mt-1 min-h-14 w-full rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-800"
              data-smoke="task-card-review-comment"
              aria-label="审核意见"
            />
          </label>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={closeInlineForm}
              className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
              data-smoke="task-card-review-cancel"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { void submit(); }}
              className="rounded-md bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
              data-smoke="task-card-review-confirm"
            >
              {busy ? '提交中…' : '确认提交'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700" data-smoke="task-card-review-error">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700" data-smoke="task-card-review-notice">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
