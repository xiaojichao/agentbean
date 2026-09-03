'use client';

import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  PackageCheck,
  Settings2,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ChannelProjectOverviewDto,
  ChannelTaskWorkspaceEntryV1,
  ChannelTaskWorkspaceV1,
  TaskLevelAvailableActionDto,
} from '@agentbean/contracts';

import { TaskCardReviewEntryPanel, type TaskCardReviewProjection } from '@/components/TaskCardReviewEntryPanel';
import { channelTaskEntrySubview, channelTaskResponsibilityFocusFilterValue } from '@/lib/channel-task-workspace-route';
import { reviewStateLabel } from '@/lib/delivery-labels';
import { mutationErrorCopy, submitDeliveryMutation, type DeliveryMutationTarget } from '@/lib/package-review-actions';
import { taskStatusText } from '@/lib/task-status';

export type ChannelProjectProgressState = 'loading' | 'not_ready' | 'no_permission' | 'error' | 'ready';

interface Participant {
  readonly id: string;
  readonly name: string;
  readonly kind: 'human' | 'agent';
}

type ProjectStage = ChannelProjectOverviewDto['stages'][number];
type ProjectLaneId = 'active' | 'review' | 'complete';

interface ProjectProgressItem {
  readonly key: string;
  readonly lane: ProjectLaneId;
  readonly stage?: ProjectStage;
  readonly entry?: ChannelTaskWorkspaceEntryV1;
}

const PROJECT_LANES: readonly {
  id: ProjectLaneId;
  title: string;
  empty: string;
}[] = [
  { id: 'active', title: '进行中', empty: '暂无进行中的阶段' },
  { id: 'review', title: '待审核', empty: '暂无待审核交付' },
  { id: 'complete', title: '已结束', empty: '暂无已结束阶段' },
];

export function ChannelProjectProgress({
  overview,
  workspace,
  channelId,
  participants,
  currentUserId,
  selectedStageId,
  state,
  errorMessage,
  archived,
  onBackToThread,
  onReviewDeliveryFiles,
  onViewDeliveryFiles,
  onOpenSettings,
}: {
  overview: ChannelProjectOverviewDto | null;
  workspace: ChannelTaskWorkspaceV1 | null;
  channelId: string;
  participants: Participant[];
  currentUserId?: string;
  selectedStageId?: string | null;
  state: ChannelProjectProgressState;
  errorMessage?: string;
  archived: boolean;
  /** 原型 review-panel「回到讨论串继续」：只定位，不改状态。 */
  onBackToThread: (threadRootMessageId: string | undefined, taskId: string) => void;
  /** 原型待审核卡「审核交付文件」：打开共享预览/编辑浮窗并选中首个待处理版本。 */
  onReviewDeliveryFiles: (packageMeta: TaskCardReviewProjection, versionId: string | undefined) => void;
  /** 原型已结束卡「查看交付与 final」：定位 Files 逻辑产物视图。 */
  onViewDeliveryFiles: (taskId: string) => void;
  onOpenSettings: () => void;
}) {
  const [creatorFilter, setCreatorFilter] = useState('all');
  const [focusFilter, setFocusFilter] = useState('all');
  const [reviewerFilter, setReviewerFilter] = useState('all');
  const projectEntries = useMemo(
    () => workspace?.entries.filter((entry) => channelTaskEntrySubview(entry) === 'project') ?? [],
    [workspace],
  );

  if (state !== 'ready') {
    return <ProjectProgressState state={state} errorMessage={errorMessage} />;
  }

  const stages = overview?.stages ?? [];
  const entriesByTaskId = new Map(projectEntries.map((entry) => [entry.task.id, entry] as const));
  const stageTaskIds = new Set(stages.map((stage) => stage.task.id));
  const matchesFilters = (entry: ChannelTaskWorkspaceEntryV1 | undefined): boolean => {
    if (!entry) return creatorFilter === 'all' && focusFilter === 'all' && reviewerFilter === 'all';
    if (creatorFilter !== 'all' && entry.task.creatorId !== creatorFilter) return false;
    if (focusFilter !== 'all' && channelTaskResponsibilityFocusFilterValue(entry) !== focusFilter) return false;
    if (reviewerFilter === 'pending-me') {
      return Boolean(
        currentUserId
        && entry.review.reviewerIds.includes(currentUserId)
        && entry.delivery.focusReviewState === 'pending',
      );
    }
    if (reviewerFilter.startsWith('suggested:')) {
      return entry.review.reviewerIds.includes(reviewerFilter.slice('suggested:'.length));
    }
    if (reviewerFilter.startsWith('actual:')) {
      return entry.review.latest?.reviewedBy === reviewerFilter.slice('actual:'.length);
    }
    return true;
  };
  const visibleStages = stages.filter((stage) => matchesFilters(entriesByTaskId.get(stage.task.id)));
  const visibleManagedWithoutStage = projectEntries.filter(
    (entry) => !stageTaskIds.has(entry.task.id) && matchesFilters(entry),
  );
  const visibleItems: ProjectProgressItem[] = [
    ...visibleStages.map((stage) => ({
      key: `stage:${stage.id}`,
      lane: projectLane(stage.aggregateStatus, stage.task.status),
      stage,
      entry: entriesByTaskId.get(stage.task.id),
    })),
    ...visibleManagedWithoutStage.map((entry) => ({
      key: `task:${entry.task.id}`,
      lane: projectLane(undefined, entry.task.status),
      entry,
    })),
  ];
  const hasVisibleEntries = visibleItems.length > 0;

  return (
    <section className="min-h-0 flex-1 overflow-auto bg-[#fcfcfb]" data-smoke="channel-project-progress">
      <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
        {/* 三列布局：左归档徽章 / 中筛选下拉（绝对居中）/ 右项目设置入口——空数据频道也渲染完整工作台框架。 */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div>
            {archived || overview?.archived ? (
              <span className="rounded bg-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600">已归档 · 只读</span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-center gap-2">
            <select
              aria-label="项目任务创建者"
              value={creatorFilter}
              onChange={(event) => setCreatorFilter(event.target.value)}
              className={`${filterClass} max-w-44 truncate`}
            >
              <option value="all">全部创建者</option>
              {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
            </select>
            <select
              aria-label="项目任务责任焦点"
              value={focusFilter}
              onChange={(event) => setFocusFilter(event.target.value)}
              className={`${filterClass} max-w-44 truncate`}
            >
              <option value="all">全部责任焦点</option>
              <option value="unassigned">尚未产生责任</option>
              <option value="review_wait">等待审核</option>
              {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
            </select>
            <select
              aria-label="项目任务审核人"
              value={reviewerFilter}
              onChange={(event) => setReviewerFilter(event.target.value)}
              className={`${filterClass} max-w-44 truncate`}
            >
              <option value="all">全部审核事实</option>
              {currentUserId ? <option value="pending-me">待我审核</option> : null}
              {participants.filter((participant) => participant.kind === 'human').flatMap((participant) => [
                <option key={`suggested:${participant.id}`} value={`suggested:${participant.id}`}>建议：{participant.name}</option>,
                <option key={`actual:${participant.id}`} value={`actual:${participant.id}`}>实际：{participant.name}</option>,
              ])}
            </select>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onOpenSettings}
              data-smoke="channel-project-settings-entry"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-xs font-semibold text-white hover:bg-neutral-800"
            >
              <Settings2 size={13} />
              {archived || overview?.archived
                ? '查看项目设置'
                : stages.length > 0 ? '项目设置' : '配置首个项目阶段'}
            </button>
          </div>
        </div>
      </div>

      {!hasVisibleEntries && (stages.length > 0 || projectEntries.length > 0) ? (
        <div className="m-4 border border-dashed border-neutral-300 bg-white px-6 py-12 text-center text-sm text-neutral-500">
          当前筛选下没有项目任务
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-3 p-3.5 pb-24 xl:min-w-[900px] xl:grid-cols-3" data-smoke="channel-project-lanes">
          {PROJECT_LANES.map((lane) => {
            const laneItems = visibleItems.filter((item) => item.lane === lane.id);
            return (
              <section key={lane.id} className="min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-white" data-smoke={`channel-project-lane-${lane.id}`}>
                <div className="border-b border-neutral-200 px-3 py-3">
                  <div className="flex items-center gap-2">
                    <ProjectLaneIcon lane={lane.id} />
                    <h3 className="text-sm font-semibold text-neutral-900">{lane.title}</h3>
                    <span className="ml-auto rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{laneItems.length}</span>
                  </div>
                </div>
                <div className="space-y-2.5 p-2.5">
                  {laneItems.map((item) => (
                    <ProjectWorkCard
                      key={item.key}
                      item={item}
                      overview={overview}
                      channelId={channelId}
                      participants={participants}
                      selectedStageId={selectedStageId}
                      archived={archived}
                      onBackToThread={onBackToThread}
                      onReviewDeliveryFiles={onReviewDeliveryFiles}
                      onViewDeliveryFiles={onViewDeliveryFiles}
                    />
                  ))}
                  {laneItems.length === 0 ? (
                    <div className="flex min-h-24 items-center justify-center rounded-md border border-dashed border-neutral-300 bg-white px-4 text-center text-xs text-neutral-400">
                      {lane.empty}
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectWorkCard({
  item,
  overview,
  channelId,
  participants,
  selectedStageId,
  archived,
  onBackToThread,
  onReviewDeliveryFiles,
  onViewDeliveryFiles,
}: {
  item: ProjectProgressItem;
  overview: ChannelProjectOverviewDto | null;
  channelId: string;
  participants: Participant[];
  selectedStageId?: string | null;
  archived: boolean;
  onBackToThread: (threadRootMessageId: string | undefined, taskId: string) => void;
  onReviewDeliveryFiles: (packageMeta: TaskCardReviewProjection, versionId: string | undefined) => void;
  onViewDeliveryFiles: (taskId: string) => void;
}) {
  const { stage, entry } = item;
  // 焦点包投影（成员清单 + 审核态）由 TaskCardReviewEntryPanel 拉取后上抛；review lane 之外不查询。
  const [reviewProjection, setReviewProjection] = useState<TaskCardReviewProjection | null>(null);
  const task = stage?.task ?? entry?.task;
  if (!task) return null;
  const selected = Boolean(stage && selectedStageId === stage.id);
  const reviewer = entry
    ? reviewerLabel(entry, participants)
    : stage?.reviewerIds.map((id) => participantName(id, participants)).join('、') || '未绑定';
  const reviewerKind = entry?.review.latest ? '实际审核人' : '建议审核人';
  const responsibility = entry?.responsibilityFocus.detail
    ?? (stage ? `阶段负责人：${participantName(stage.ownerId, participants)}` : '尚未产生责任');
  const statusLabel = stage
    ? aggregateStatusLabel(stage.aggregateStatus, task.status)
    : taskStatusText(task.status);
  const delivery = entry?.delivery;
  const deliverySummary = delivery ? projectDeliverySummary(delivery) : '项目推进事实尚未就绪';
  const inputSummary = stage
    ? `${stage.upstreamStageIds.length > 0 ? stage.upstreamStageIds.map((id) => stageName(id, overview)).join('、') : '无前置阶段'} · ${stage.dependenciesSatisfied ? '已满足' : '未满足'}`
    : '来自讨论串中的 Agent 执行';
  const acceptDeliveryAction = entry?.availableActions?.find((action) => action.action === 'accept-delivery');
  return (
    <article
      aria-current={selected ? 'true' : undefined}
      data-smoke={stage ? 'channel-project-stage-card' : 'channel-managed-task-card'}
      data-stage-id={stage?.id}
      data-task-id={task.id}
      className={`rounded-lg border bg-white p-2.5 text-left shadow-[0_1px_0_rgba(36,40,44,0.03)] transition ${selected ? 'border-sky-300 shadow-[0_10px_24px_rgba(36,111,189,0.08)]' : 'border-neutral-300 hover:border-sky-300 hover:shadow-md'}`}
    >
      <div className={`text-[11px] text-neutral-400 ${item.lane === 'review' ? 'text-amber-700' : item.lane === 'complete' ? 'text-emerald-700' : ''}`}>
        {stage ? `阶段任务 · ${statusLabel}` : '未绑定阶段的受管任务'}
      </div>
      <h4 className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-[1.35] text-neutral-900">{stage?.name ?? task.title}</h4>
      {stage?.goal ? <p className="mt-1.5 text-xs leading-5 text-neutral-600">{stage.goal}</p> : null}

      <dl className="mt-2.5 grid grid-cols-[68px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs leading-4" data-smoke="project-card-fact-grid">
        <ProjectCardFact label="负责人" value={responsibility} />
        <ProjectCardFact label={reviewerKind} value={reviewer} />
        <ProjectCardFact
          label={item.lane === 'active' ? '输入' : item.lane === 'review' ? '输出' : '最终版'}
          value={item.lane === 'active'
            ? inputSummary
            : item.lane === 'review'
              ? deliverySummary
              : delivery ? projectFinalSummary(delivery) : '尚未形成 final 事实'}
        />
        <ProjectCardFact label="状态" value={`任务状态：${taskStatusText(task.status)} · ${statusLabel}`} />
      </dl>

      {stage?.missingRequiredInputs.length ? (
        <div className="mt-3 rounded border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">
          缺少必需输入：{stage.missingRequiredInputs.map((input) => input.label || input.key).join('、')}
        </div>
      ) : null}
      {stage?.blockingReasons.length ? (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>{stage.blockingReasons.map((reason) => blockingReasonLabel(reason.code)).join('；')}</span>
        </div>
      ) : stage && !stage.executionAllowed ? (
        <div className="mt-2 rounded border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">当前阶段不可执行</div>
      ) : null}

      {entry && item.lane === 'active' && entry.delivery.packageCount > 0 ? (
        <div className="mt-2.5 rounded-lg border border-sky-200 bg-sky-50/70 p-2 text-xs leading-5 text-neutral-700" data-smoke="project-card-delivery-summary">
          <strong className="block text-sky-800">已有交付事实</strong>
          {deliverySummary}
        </div>
      ) : null}

      {entry && (item.lane === 'review' || (item.lane === 'active' && entry.delivery.focusPackageId)) ? (
        <>
          {item.lane === 'review' ? (
            <div className="mt-2.5 rounded-lg border border-sky-200 bg-sky-50/70 p-2 text-xs leading-5 text-neutral-700" data-smoke="project-card-delivery-summary">
              <strong className="block text-sky-800">待审核输出</strong>
              {projectReviewMemberList(reviewProjection) ?? deliverySummary}
            </div>
          ) : null}
          {/* 审核面板锚定「焦点包有待审动作」这一 Server 事实（availableActions 自决按钮）：
              任务状态推进依赖消息路径（markLinkedTaskInReview），API 直发交付（无消息）
              时任务可能仍处非 in_review——但焦点包成员待审本身即待审核事实，面板照常内嵌。 */}
          <TaskCardReviewEntryPanel
            channelId={channelId}
            focusPackageId={entry.delivery.focusPackageId ?? null}
            archived={archived}
            onViewFiles={() => onViewDeliveryFiles(task.id)}
            onReviewFiles={(versionId) => reviewProjection && onReviewDeliveryFiles(reviewProjection, versionId)}
            onOpenThread={(threadRootMessageId) => onBackToThread(threadRootMessageId, task.id)}
            onProjection={setReviewProjection}
          />
          {item.lane === 'review' && acceptDeliveryAction && entry.taskRevision !== undefined ? (
            <TaskCardDeliveryAcceptance
              action={acceptDeliveryAction}
              taskId={task.id}
              taskRevision={entry.taskRevision}
              archived={archived}
            />
          ) : null}
        </>
      ) : null}

      {item.lane === 'active' ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onBackToThread(undefined, task.id)}
            className="inline-flex h-8 items-center rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-sky-400"
            data-smoke="project-card-view-progress"
          >
            查看执行进度
          </button>
          <button
            type="button"
            onClick={() => onBackToThread(undefined, task.id)}
            className="inline-flex h-8 items-center rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-sky-400"
            data-smoke="project-card-open-thread"
          >
            打开讨论串
          </button>
        </div>
      ) : null}

      {item.lane === 'complete' ? (
        <button
          type="button"
          onClick={() => onViewDeliveryFiles(task.id)}
          className="mt-2.5 inline-flex h-8 items-center rounded-md border border-neutral-300 bg-white px-3 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-sky-400"
          data-smoke="project-card-view-delivery"
        >
          查看交付与 final
        </button>
      ) : null}

      {entry && item.lane !== 'active' ? (
        <div className="mt-3 grid grid-cols-[18px_minmax(0,1fr)] items-start gap-1.5 border-t border-neutral-200 pt-2.5 text-[11px] leading-4 text-neutral-500" data-smoke="project-card-timeline">
          <span className={`mx-auto mt-1 h-2 w-2 rounded-full ${item.lane === 'complete' ? 'bg-emerald-600' : 'bg-sky-700'}`} />
          <span>{projectTimelineSummary(entry, item.lane)}</span>
        </div>
      ) : null}
    </article>
  );
}

function TaskCardDeliveryAcceptance({
  action,
  taskId,
  taskRevision,
  archived,
}: {
  action: TaskLevelAvailableActionDto;
  taskId: string;
  taskRevision: number;
  archived: boolean;
}) {
  const [frozenAcceptance, setFrozenAcceptance] = useState<{
    readonly generation: number;
    readonly target: DeliveryMutationTarget;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const acceptanceGenerationRef = useRef(0);
  const acceptanceIdentityRef = useRef({ taskId, taskRevision });
  const currentAcceptance = frozenAcceptance?.target.taskId === taskId
    && frozenAcceptance.target.expectedTaskRevision === taskRevision
    ? frozenAcceptance
    : null;

  const close = useCallback(() => {
    setFrozenAcceptance(null);
    setError(null);
    const trigger = triggerRef.current;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }, []);

  useLayoutEffect(() => {
    acceptanceIdentityRef.current = { taskId, taskRevision };
    acceptanceGenerationRef.current += 1;
    setFrozenAcceptance(null);
    setSubmitting(false);
    setError(null);
  }, [taskId, taskRevision]);

  useEffect(() => {
    if (!currentAcceptance) return;
    queueMicrotask(() => {
      if (initialFocusRef.current?.isConnected) initialFocusRef.current.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) close();
      if (event.key !== 'Tab') return;
      const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (buttons.length === 0) return;
      const first = buttons[0]!;
      const last = buttons[buttons.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, currentAcceptance, submitting]);

  const confirm = async () => {
    if (!currentAcceptance || submitting) return;
    const submittedAcceptance = currentAcceptance;
    const requestIsCurrent = () => (
      acceptanceGenerationRef.current === submittedAcceptance.generation
      && acceptanceIdentityRef.current.taskId === submittedAcceptance.target.taskId
      && acceptanceIdentityRef.current.taskRevision === submittedAcceptance.target.expectedTaskRevision
    );
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitDeliveryMutation(submittedAcceptance.target, { comment: '', rejectReason: '' });
      if (!requestIsCurrent()) return;
      if (!result.ok) {
        setError(mutationErrorCopy(result));
        return;
      }
      close();
    } catch (acceptError) {
      if (!requestIsCurrent()) return;
      setError(acceptError instanceof Error ? acceptError.message : '验收失败，请稍后重试');
    } finally {
      if (requestIsCurrent()) setSubmitting(false);
    }
  };

  const disabled = archived || Boolean(action.disabled);
  const disabledReason = archived ? '归档频道只读' : action.disabledReason;
  return (
    <>
      <div className="mt-2.5" data-smoke="project-card-delivery-acceptance">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          title={disabledReason}
          onClick={() => {
            if (disabled) return;
            setError(null);
            setFrozenAcceptance({
              generation: ++acceptanceGenerationRef.current,
              target: { taskId, expectedTaskRevision: taskRevision, kind: 'accept-delivery' },
            });
          }}
          className="inline-flex h-8 items-center rounded-md border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          data-smoke="project-card-accept-delivery"
        >
          {action.label}
        </button>
        {disabledReason ? <p className="mt-1 text-[11px] text-neutral-500">{disabledReason}</p> : null}
      </div>

      {currentAcceptance ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget && !submitting) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
            data-smoke="project-card-delivery-acceptance-dialog"
          >
            <h2 id={titleId} className="text-sm font-semibold text-neutral-900">验收本次交付</h2>
            <p className="mt-2 text-xs leading-5 text-neutral-600">
              确认后，Server 会再次校验验收权限、Task revision 与逐文件审核覆盖；校验通过后 Task 才进入完成态。
            </p>
            {error ? (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700" role="alert">
                {error}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={initialFocusRef}
                type="button"
                disabled={submitting}
                onClick={close}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => { void confirm(); }}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
              >
                {submitting ? '提交中…' : '确认验收'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 原型 mini-package：待审核输出按焦点包成员清单展示（投影未就绪回落文字摘要）。 */
function projectReviewMemberList(projection: TaskCardReviewProjection | null) {
  if (!projection || projection.package.members.length === 0) return null;
  const stateByMember = new Map(
    projection.availableActions.map((action) => [`${action.collectionId}:${action.versionId}`, action.reviewState] as const),
  );
  return (
    <ul
      aria-label="待审核输出文件"
      className="mt-1 list-disc space-y-0.5 pl-4 marker:text-sky-700"
      data-smoke="project-card-review-member-list"
    >
      {projection.package.members.map((member) => {
        const state = stateByMember.get(`${member.collectionId}:${member.artifactVersionId}`);
        return (
          <li
            key={`${member.collectionId}:${member.artifactVersionId}`}
            className="min-w-0 pl-0.5"
          >
            <span className="font-medium text-neutral-500">{member.shortLabel}</span>{' '}
            <span className="break-all" title={member.filename}>{member.filename}</span>
            {state ? <span className="text-neutral-500">（{reviewStateLabel(state)}）</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ProjectCardFact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-neutral-700" title={value}>{value}</dd>
    </>
  );
}

function projectDeliverySummary(delivery: ChannelTaskWorkspaceEntryV1['delivery']): string {
  const review = delivery.fileReviewRequiredCount === 0
    ? '文件审核不适用（0 个必需文件）'
    : delivery.fileReviewRequiredCount
      ? `文件审核 ${delivery.fileReviewApprovedCount ?? 0}/${delivery.fileReviewRequiredCount}${delivery.fileReviewComplete ? '（已齐）' : '（待补齐）'}`
      : '文件审核事实尚未投影';
  return `交付包 ${delivery.packageCount} 个 · ${review} · 最终版 ${delivery.finalizedCount}/${delivery.requiredForFinalCount}`;
}

function projectFinalSummary(delivery: ChannelTaskWorkspaceEntryV1['delivery']): string {
  return delivery.requiredForFinalCount > 0
    ? `${delivery.finalizedCount}/${delivery.requiredForFinalCount}${delivery.finalizedCount === delivery.requiredForFinalCount ? '（已齐）' : '（未齐）'}`
    : '无必需 final 文件';
}


function projectTimelineSummary(entry: ChannelTaskWorkspaceEntryV1, lane: ProjectLaneId): string {
  if (lane === 'complete') {
    return `当前状态：任务已结束；${projectDeliverySummary(entry.delivery)}。`;
  }
  const acceptDeliveryAction = entry.availableActions?.find((action) => action.action === 'accept-delivery');
  if (acceptDeliveryAction && !acceptDeliveryAction.disabled && entry.taskRevision !== undefined) {
    return `当前状态：待验收；${projectDeliverySummary(entry.delivery)}。下一步验收本次交付。`;
  }
  if (acceptDeliveryAction?.disabledReason) {
    return `当前状态：待审核；${projectDeliverySummary(entry.delivery)}。下一步：${acceptDeliveryAction.disabledReason}。`;
  }
  return `当前状态：待审核；${projectDeliverySummary(entry.delivery)}。下一步在交付工作台处理当前版本。`;
}

function ProjectLaneIcon({ lane }: { lane: ProjectLaneId }) {
  if (lane === 'review') return <PackageCheck size={15} className="text-amber-600" />;
  if (lane === 'complete') return <CheckCircle2 size={15} className="text-emerald-600" />;
  return <Clock3 size={15} className="text-violet-600" />;
}

function projectLane(
  aggregateStatus: ProjectStage['aggregateStatus'] | undefined,
  taskStatus: ChannelTaskWorkspaceEntryV1['task']['status'],
): ProjectLaneId {
  if (taskStatus === 'cancelled') return 'complete';
  if (aggregateStatus) {
    if (aggregateStatus === 'in_review') return 'review';
    if (aggregateStatus === 'complete') return 'complete';
    return 'active';
  }
  if (taskStatus === 'in_review') return 'review';
  if (taskStatus === 'done' || taskStatus === 'closed') return 'complete';
  return 'active';
}

function ProjectProgressState({
  state,
  errorMessage,
}: {
  state: Exclude<ChannelProjectProgressState, 'ready'>;
  errorMessage?: string;
}) {
  const copy = state === 'loading'
    ? '正在加载项目推进事实…'
    : state === 'not_ready'
      ? '项目推进事实尚未就绪'
      : state === 'no_permission'
        ? '你没有查看该频道项目事实的权限'
        : errorMessage || '项目推进加载失败，请稍后重试';
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-neutral-50 p-6" data-smoke={`channel-project-${state}`}>
      <div className="border border-neutral-200 bg-white px-6 py-5 text-sm text-neutral-600">{copy}</div>
    </div>
  );
}

function participantName(id: string, participants: Participant[]): string {
  return participants.find((participant) => participant.id === id)?.name ?? id;
}

function reviewerLabel(entry: ChannelTaskWorkspaceEntryV1, participants: Participant[]): string {
  const ids = entry.review.latest ? [entry.review.latest.reviewedBy] : entry.review.reviewerIds;
  return ids.length > 0 ? ids.map((id) => participantName(id, participants)).join('、') : '未绑定';
}

function stageName(stageId: string, overview: ChannelProjectOverviewDto | null): string {
  return overview?.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
}

function aggregateStatusLabel(
  status: ChannelProjectOverviewDto['stages'][number]['aggregateStatus'],
  taskStatus: ChannelTaskWorkspaceEntryV1['task']['status'],
): string {
  if (taskStatus === 'cancelled') return '已取消';
  if (status === 'pending') return '待开始';
  if (status === 'active') return '进行中';
  if (status === 'in_review') return '审核中';
  if (status === 'complete') return '已完成';
  return '已阻塞';
}

function blockingReasonLabel(code: ChannelProjectOverviewDto['stages'][number]['blockingReasons'][number]['code']): string {
  const labels: Record<typeof code, string> = {
    task_not_started: '绑定任务尚未开始',
    dependency_incomplete: '依赖任务尚未完成',
    review_pending: '等待审核结论',
    review_rejected: '审核未通过',
    review_needs_human: '需要人工确认',
    stage_dependency_incomplete: '前置阶段尚未完成',
    stage_dependency_unaccepted: '前置阶段产出未通过审核',
    required_input_missing: '缺少必需输入',
  };
  return labels[code];
}

const filterClass = 'h-8 rounded-md border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none focus:border-neutral-500';
