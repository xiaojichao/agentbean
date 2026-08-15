'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleDot, History, ListChecks, ShieldCheck, Target } from 'lucide-react';
import type {
  TaskDeliveryOverviewV1,
  TaskLevelAvailableActionDto,
} from '@agentbean/contracts';
import {
  mutationErrorCopy,
  submitDeliveryMutation,
  type DeliveryMutationTarget,
} from '@/lib/package-review-actions';
import { projectEvents, taskEvents } from '@/lib/socket';
// #1065 AC11：与 Chat 卡片/Files 列表共享同一组文本标签。
import { reviewStateLabel, timelineKindLabel } from '@/lib/delivery-labels';

/**
 * #1065 AC3/AC4 Task 交付视图(详情面板内嵌)。
 *
 * 只消费 Server 的 task:delivery-overview 单一投影——stage 目标/依赖、acceptance
 * contract、责任焦点、当前 delivery/package、合法 availableActions 与完整执行链
 * 时间线;web 不自行推断任何状态(AC6/AC9)。卡片视图不显示本面板内容,责任焦点
 * 是唯一跨卡片/详情的共享字段(AC4)。
 *
 * availableActions 只是可发现性投影:按钮点击仍走既有具名 command(或父级导航),
 * Server 提交时完整复验(AC9);客户端不根据角色/按钮可见性推导 authority。
 */

function formatTime(at: number): string {
  const date = new Date(at);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

type FrozenDeliveryAcceptance = {
  readonly channelId?: string;
  readonly target: DeliveryMutationTarget;
};

export function TaskDeliveryOverview({
  teamId,
  channelId,
  taskId,
  onAction,
}: {
  teamId: string;
  channelId?: string;
  taskId: string;
  /** #1065 AC9：可发现性动作的导航回调(delegate/review-package 由父级处理)。 */
  onAction?: (action: TaskLevelAvailableActionDto) => void;
}) {
  const [overview, setOverview] = useState<TaskDeliveryOverviewV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [frozenAcceptance, setFrozenAcceptance] = useState<FrozenDeliveryAcceptance | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const acceptanceTitleId = useId();
  const acceptanceTriggerRef = useRef<HTMLElement | null>(null);
  const currentAcceptance = frozenAcceptance?.target.taskId === taskId
    && frozenAcceptance.channelId === channelId
    ? frozenAcceptance
    : null;
  const acceptanceOpen = currentAcceptance !== null;

  const closeAcceptance = useCallback(() => {
    setFrozenAcceptance(null);
    setAcceptanceError(null);
    const trigger = acceptanceTriggerRef.current;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  useEffect(() => {
    setFrozenAcceptance(null);
    setAcceptanceError(null);
    acceptanceTriggerRef.current = null;
  }, [channelId, taskId]);

  useEffect(() => {
    if (!acceptanceOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !accepting) closeAcceptance();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [acceptanceOpen, accepting, closeAcceptance]);

  useEffect(() => {
    let alive = true;
    let requestId = 0;
    setLoading(true);
    setError(null);
    if (!channelId) {
      setLoading(false);
      return () => { alive = false; };
    }
    const project = projectEvents();
    const load = (showLoading: boolean) => {
      const currentRequestId = ++requestId;
      if (showLoading) setLoading(true);
      return project.queryTaskDeliveryOverview({ channelId, taskId })
      .then((result) => {
        if (!alive || currentRequestId !== requestId) return;
        if (result.ok && result.overview) {
          setOverview(result.overview);
          setError(null);
        } else {
          setError(result.message ?? '交付视图暂不可用');
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive || currentRequestId !== requestId) return;
        setError('交付视图暂不可用');
        setLoading(false);
      });
    };
    void load(true);
    const refresh = () => { void load(false); };
    const stopProject = project.onUpdated(channelId, refresh);
    const stopArtifacts = project.onArtifactsUpdated(channelId, refresh);
    const stopTasks = taskEvents().onSnapshot((tasks) => {
      if (tasks.some((task) => task.id === taskId && task.channelId === channelId)) refresh();
    });
    return () => {
      alive = false;
      stopProject();
      stopArtifacts();
      stopTasks();
    };
  }, [teamId, channelId, taskId, refreshNonce]);

  if (loading) {
    return <div className="text-center text-[11px] text-neutral-400" data-smoke="task-delivery-loading">正在读取交付视图…</div>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800" data-smoke="task-delivery-error">
        {error}
      </div>
    );
  }
  if (!overview) return null;

  const handleAction = (action: TaskLevelAvailableActionDto) => {
    if (action.action !== 'accept-delivery') {
      onAction?.(action);
      return;
    }
    if (action.disabled) return;
    acceptanceTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAcceptanceError(null);
    setFrozenAcceptance({
      channelId,
      target: {
        taskId,
        expectedTaskRevision: overview.acceptanceContract.taskRevision,
        kind: 'accept-delivery',
      },
    });
  };

  const confirmAcceptance = async () => {
    if (accepting || !currentAcceptance) return;
    setAccepting(true);
    setAcceptanceError(null);
    try {
      const result = await submitDeliveryMutation(currentAcceptance.target, { comment: '', rejectReason: '' });
      if (!result.ok) {
        setAcceptanceError(mutationErrorCopy(result));
        return;
      }
      closeAcceptance();
      setRefreshNonce((current) => current + 1);
    } catch (acceptError) {
      setAcceptanceError(acceptError instanceof Error ? acceptError.message : '验收失败，请稍后重试');
    } finally {
      setAccepting(false);
    }
  };

  return (
    <>
      <TaskDeliveryOverviewContent overview={overview} onAction={handleAction} />
      {acceptanceOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget && !accepting) {
              closeAcceptance();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={acceptanceTitleId}
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
            data-smoke="task-delivery-acceptance-dialog"
          >
            <h2 id={acceptanceTitleId} className="text-sm font-semibold text-neutral-900">验收本次交付</h2>
            <p className="mt-2 text-xs leading-5 text-neutral-600">
              确认后，Server 会再次校验验收权限、Task revision 与逐文件审核覆盖；校验通过后 Task 才进入完成态。
            </p>
            {acceptanceError ? (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700" role="alert">
                {acceptanceError}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={accepting}
                onClick={closeAcceptance}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                disabled={accepting}
                onClick={() => { void confirmAcceptance(); }}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              >
                {accepting ? '提交中…' : '确认验收'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 已加载投影的纯展示层，供阶段审核工作区复用而不产生第二次 Query。 */
export function TaskDeliveryOverviewContent({
  overview,
  onAction,
}: {
  overview: TaskDeliveryOverviewV1;
  onAction?: (action: TaskLevelAvailableActionDto) => void;
}) {
  const focus = overview.responsibilityFocus;
  return (
    <div className="space-y-3 rounded-md border border-neutral-200 bg-neutral-50 p-3" data-smoke="task-delivery-overview">
      {/* 当前责任焦点(AC3/AC4：卡片只显示这一条,详情在此展开) */}
      <div className="flex items-start gap-2" data-smoke="task-focus">
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-pink-500" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-neutral-800">当前责任焦点</div>
          <div className="text-xs text-neutral-600" data-smoke="task-focus-detail">
            {focus.detail}
          </div>
          {focus.agentName ? (
            <div className="mt-0.5 text-[11px] text-neutral-500">责任 Agent：{focus.agentName}</div>
          ) : null}
        </div>
      </div>

      {/* ProjectStage 目标/依赖(AC3) */}
      {overview.stage ? (
        <div className="flex items-start gap-2" data-smoke="task-stage">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-neutral-800">阶段目标：{overview.stage.goal}</div>
            {!overview.stage.dependenciesSatisfied ? (
              <div className="mt-1 text-[11px] text-amber-700" data-smoke="task-stage-dependencies">
                前置依赖未全部满足
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-emerald-700">前置依赖已满足</div>
            )}
            {overview.stage.missingRequiredInputs.length > 0 ? (
              <div className="mt-0.5 text-[11px] text-amber-700">
                缺失必需输入：{overview.stage.missingRequiredInputs.map((item) => item.label || item.key).join('、')}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* acceptance contract(AC3：谁验收、review 政策、客观 criteria) */}
      <div className="flex items-start gap-2" data-smoke="task-acceptance-contract">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-neutral-800">验收约定</div>
          <div className="text-[11px] text-neutral-600">
            {overview.acceptanceContract.requiresHumanAcceptance
              ? `需要人类验收(${overview.acceptanceContract.humanAcceptanceAuthorityIds.length} 位预绑定验收人)`
              : '无需人类验收'}
            {' · '}review 政策：{overview.acceptanceContract.reviewPolicy}
            {' · '}attempt {overview.acceptanceContract.attempt}/{overview.acceptanceContract.maxAttempts}
          </div>
          {overview.acceptanceContract.acceptanceCriteria.length > 0 ? (
            <ul className="mt-1 list-disc pl-4 text-[11px] text-neutral-600">
              {overview.acceptanceContract.acceptanceCriteria.map((criterion, index) => (
                <li key={`${criterion}-${index}`}>{criterion}</li>
              ))}
            </ul>
          ) : null}
          {/* #1065 AC3：required review coverage(final 必需成员 vs 已 final,Server 投影)。 */}
          <div className="mt-1 text-[11px]" data-smoke="task-review-coverage">
            {overview.acceptanceContract.requiredReviewCoverage.complete
              ? `最终版覆盖完整(${overview.acceptanceContract.requiredReviewCoverage.finalizedCount}/${overview.acceptanceContract.requiredReviewCoverage.requiredForFinalCount} 个必需成员已设最终版)`
              : `最终版未覆盖完整(${overview.acceptanceContract.requiredReviewCoverage.finalizedCount}/${overview.acceptanceContract.requiredReviewCoverage.requiredForFinalCount} 个必需成员已设最终版)`}
          </div>
        </div>
      </div>

      {/* 当前 delivery/package(与 listOutputPackages 同一组 Server 事实,AC6) */}
      <div className="flex items-start gap-2" data-smoke="task-delivery">
        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-neutral-800">当前交付</div>
          {overview.delivery.packages.length === 0 && overview.delivery.pendingDeliveries.length === 0 ? (
            <div className="text-[11px] text-neutral-500">暂无交付文件包</div>
          ) : (
            <>
              {overview.delivery.packages.map((pkg) => (
                <div key={pkg.packageId} className="text-[11px] text-neutral-600">
                  文件包 {pkg.memberCount} 个文件 · {reviewStateLabel(pkg.reviewState)}
                  {pkg.packageId === overview.delivery.focusPackageId ? ' · 当前焦点' : ''}
                </div>
              ))}
              {overview.delivery.pendingDeliveries.length > 0 ? (
                <div className="text-[11px] text-amber-700">交付处理中：{overview.delivery.pendingDeliveries.length} 批</div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* 合法 availableActions(AC3/AC9：Server 计算的可发现性动作) */}
      <div className="flex flex-wrap items-center gap-1.5" data-smoke="task-available-actions">
        {overview.availableActions.map((action: TaskLevelAvailableActionDto) => (
          <button
            key={action.action}
            type="button"
            disabled={Boolean(action.disabled)}
            onClick={() => onAction?.(action)}
            title={action.disabledReason}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
            data-smoke={`task-action-${action.action}`}
          >
            {action.label}
            {action.disabled && action.disabledReason ? `（${action.disabledReason}）` : null}
          </button>
        ))}
      </div>

      {/* 完整可审计执行链(AC4) */}
      <div className="flex items-start gap-2" data-smoke="task-timeline">
        <History className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-neutral-800">执行链</div>
          {overview.timeline.length === 0 ? (
            <div className="text-[11px] text-neutral-500">暂无活动</div>
          ) : (
            <ol className="mt-1 space-y-1.5">
              {overview.timeline.map((event) => (
                <li key={event.id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="shrink-0 text-neutral-400" title={formatTime(event.at)}>{formatTime(event.at)}</span>
                  <span className="shrink-0 rounded bg-neutral-200 px-1 text-neutral-600">
                    {timelineKindLabel(event.kind)}
                  </span>
                  <span className="text-neutral-700">{event.summary}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
