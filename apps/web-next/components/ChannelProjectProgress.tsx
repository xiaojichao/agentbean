'use client';

import { AlertCircle, ArrowRight, CheckCircle2, Clock3, PackageCheck, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  ChannelProjectOverviewDto,
  ChannelTaskWorkspaceEntryV1,
  ChannelTaskWorkspaceV1,
} from '@agentbean/contracts';

import {
  ChannelTaskFactSummary,
  channelTaskResponsibilityFocusFilterValue,
} from '@/components/ChannelTaskCard';
import { channelTaskEntrySubview } from '@/lib/channel-task-workspace-route';
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
  description: string;
  empty: string;
}[] = [
  { id: 'active', title: '进行中', description: '待触发、执行中与受阻阶段', empty: '暂无进行中的阶段' },
  { id: 'review', title: '待审核', description: '已交付，等待成员给出审核结论', empty: '暂无待审核交付' },
  { id: 'complete', title: '已结束', description: '已完成或已终止；交付与 final 以卡片事实为准', empty: '暂无已结束阶段' },
];

export function ChannelProjectProgress({
  overview,
  workspace,
  participants,
  currentUserId,
  selectedStageId,
  state,
  errorMessage,
  archived,
  onOpenStage,
  onOpenSettings,
}: {
  overview: ChannelProjectOverviewDto | null;
  workspace: ChannelTaskWorkspaceV1 | null;
  participants: Participant[];
  currentUserId?: string;
  selectedStageId?: string | null;
  state: ChannelProjectProgressState;
  errorMessage?: string;
  archived: boolean;
  onOpenStage: (stageId: string | null, taskId: string) => void;
  onOpenSettings: () => void;
}) {
  const [creatorFilter, setCreatorFilter] = useState('all');
  const [focusFilter, setFocusFilter] = useState('all');
  const [reviewerFilter, setReviewerFilter] = useState('all');
  const projectEntries = useMemo(
    () => workspace?.entries.filter((entry) => channelTaskEntrySubview(entry) === 'project') ?? [],
    [workspace],
  );
  const ordinaryTaskCount = useMemo(
    () => workspace?.entries.filter((entry) => channelTaskEntrySubview(entry) === 'plain').length ?? 0,
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
    <section className="min-h-0 flex-1 overflow-y-auto bg-[#f7f6f2]" data-smoke="channel-project-progress">
      {stages.length > 0 || projectEntries.length > 0 ? (
        <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-neutral-900">项目阶段与审核</h2>
                <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  当前视图：阶段状态 + 审核动作
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">责任来自真实执行，审核与 final 分开记录；点击阶段进入交付工作台。</p>
            </div>
            {archived || overview?.archived ? (
              <span className="rounded bg-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600">已归档 · 只读</span>
            ) : null}
            <button
              type="button"
              onClick={onOpenSettings}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              <Settings2 size={13} />
              {archived || overview?.archived ? '查看项目设置' : '项目设置 / 阶段配置'}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="项目任务创建者"
              value={creatorFilter}
              onChange={(event) => setCreatorFilter(event.target.value)}
              className={filterClass}
            >
              <option value="all">全部创建者</option>
              {participants.map((participant) => <option key={participant.id} value={participant.id}>{participant.name}</option>)}
            </select>
            <select
              aria-label="项目任务责任焦点"
              value={focusFilter}
              onChange={(event) => setFocusFilter(event.target.value)}
              className={filterClass}
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
              className={filterClass}
            >
              <option value="all">全部审核事实</option>
              {currentUserId ? <option value="pending-me">待我审核</option> : null}
              {participants.filter((participant) => participant.kind === 'human').flatMap((participant) => [
                <option key={`suggested:${participant.id}`} value={`suggested:${participant.id}`}>建议：{participant.name}</option>,
                <option key={`actual:${participant.id}`} value={`actual:${participant.id}`}>实际：{participant.name}</option>,
              ])}
            </select>
          </div>
        </div>
      ) : null}

      {stages.length === 0 && projectEntries.length === 0 ? (
        <ChannelProjectSetupPrompt
          ordinaryTaskCount={ordinaryTaskCount}
          archived={archived || Boolean(overview?.archived)}
          onOpenSettings={onOpenSettings}
        />
      ) : !hasVisibleEntries ? (
        <div className="m-4 border border-dashed border-neutral-300 bg-white px-6 py-12 text-center text-sm text-neutral-500">
          当前筛选下没有项目任务
        </div>
      ) : (
        <div className="grid min-w-[900px] grid-cols-3 items-start gap-3 p-4" data-smoke="channel-project-lanes">
          {PROJECT_LANES.map((lane) => {
            const laneItems = visibleItems.filter((item) => item.lane === lane.id);
            return (
              <section key={lane.id} className="min-w-0 rounded-lg border border-neutral-200 bg-white/70" data-smoke={`channel-project-lane-${lane.id}`}>
                <div className="border-b border-neutral-200 px-3 py-3">
                  <div className="flex items-center gap-2">
                    <ProjectLaneIcon lane={lane.id} />
                    <h3 className="text-sm font-semibold text-neutral-900">{lane.title}</h3>
                    <span className="ml-auto rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{laneItems.length}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-neutral-500">{lane.description}</p>
                </div>
                <div className="space-y-3 p-2.5">
                  {laneItems.map((item) => (
                    <ProjectWorkCard
                      key={item.key}
                      item={item}
                      overview={overview}
                      participants={participants}
                      selectedStageId={selectedStageId}
                      onOpenStage={onOpenStage}
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

export function ChannelProjectSetupPrompt({
  ordinaryTaskCount,
  archived,
  onOpenSettings,
  compact = false,
}: {
  ordinaryTaskCount: number;
  archived: boolean;
  onOpenSettings: () => void;
  compact?: boolean;
}) {
  return (
    <section
      className={compact
        ? 'mx-4 mt-4 flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3'
        : 'm-4 rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-white px-6 py-8'}
      data-smoke="channel-project-setup-prompt"
    >
      <div className={compact ? 'min-w-0 flex-1' : ''}>
        <div className={compact ? '' : 'mx-auto max-w-2xl text-center'}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">频道即项目空间</div>
          <h2 className="mt-1 text-base font-semibold text-neutral-900">把频道工作组织成阶段推进</h2>
          <p className={`text-xs leading-5 text-neutral-600 ${compact ? 'mt-0.5' : 'mt-2'}`}>
            {ordinaryTaskCount > 0
              ? `已有 ${ordinaryTaskCount} 个普通任务；配置首个阶段时可明确绑定任务、负责人、审核人与验收标准。`
              : '配置首个阶段，明确任务、负责人、审核人与验收标准。'}
            不会根据负责人、标签或状态自动改写历史任务。
          </p>
        </div>
        {!compact ? (
          <div className="mx-auto mt-6 grid max-w-3xl gap-3 text-left md:grid-cols-3">
            <SetupStep number="1" title="绑定阶段任务" detail="从现有普通任务中显式选择，不猜测历史语义。" />
            <SetupStep number="2" title="约定验收责任" detail="设置阶段负责人、建议审核人与验收标准。" />
            <SetupStep number="3" title="从讨论串触发执行" detail="@智能体 后由 Server 回填责任、交付与审核事实。" />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className={`${compact ? 'inline-flex' : 'mx-auto mt-6 flex w-fit'} h-9 items-center gap-1.5 rounded-md bg-neutral-900 px-4 text-xs font-semibold text-white hover:bg-neutral-800`}
      >
        <Settings2 size={14} />
        {archived ? '查看项目设置' : '配置首个项目阶段'}
      </button>
    </section>
  );
}

function ProjectWorkCard({
  item,
  overview,
  participants,
  selectedStageId,
  onOpenStage,
}: {
  item: ProjectProgressItem;
  overview: ChannelProjectOverviewDto | null;
  participants: Participant[];
  selectedStageId?: string | null;
  onOpenStage: (stageId: string | null, taskId: string) => void;
}) {
  const { stage, entry } = item;
  const task = stage?.task ?? entry?.task;
  if (!task) return null;
  const stageId = stage?.id ?? null;
  const selected = Boolean(stage && selectedStageId === stage.id);
  const actionLabel = task.status === 'cancelled'
    ? '查看取消记录'
    : item.lane === 'review'
      ? '打开审核工作台'
      : item.lane === 'complete'
        ? '查看交付与 final'
        : stage?.aggregateStatus === 'pending'
          ? '交给智能体处理'
          : '查看执行与输入';
  return (
    <button
      type="button"
      aria-label={stage ? `打开阶段 ${stage.name}` : `打开受管任务 ${task.title}`}
      aria-current={selected ? 'true' : undefined}
      data-smoke={stage ? 'channel-project-stage-card' : 'channel-managed-task-card'}
      data-stage-id={stage?.id}
      data-task-id={task.id}
      onClick={() => onOpenStage(stageId, task.id)}
      className={`w-full rounded-lg border bg-white p-3 text-left shadow-sm transition focus:outline-none focus:ring-2 focus:ring-amber-400 ${selected ? 'border-amber-500 ring-1 ring-amber-200' : 'border-neutral-300 hover:border-amber-400 hover:shadow-md'}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] font-medium ${item.lane === 'review' ? 'text-amber-700' : item.lane === 'complete' ? 'text-emerald-700' : 'text-violet-700'}`}>
            {stage ? `阶段任务 · ${aggregateStatusLabel(stage.aggregateStatus, task.status)}` : '未绑定阶段的受管任务'}
          </div>
          <h4 className="mt-1 text-sm font-semibold leading-5 text-neutral-900">{stage?.name ?? task.title}</h4>
          {stage ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-600">{stage.goal}</p> : null}
        </div>
        <span className="shrink-0 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
          任务状态：{taskStatusText(task.status)}
        </span>
      </div>

      {stage ? (
        <div className="mt-3 grid gap-1.5 text-[11px] leading-4 text-neutral-600">
          <div><span className="text-neutral-400">阶段负责人</span>　{participantName(stage.ownerId, participants)}</div>
          <div><span className="text-neutral-400">建议审核人</span>　{stage.reviewerIds.map((id) => participantName(id, participants)).join('、') || '未绑定'}</div>
          <div><span className="text-neutral-400">输入与依赖</span>　{stage.upstreamStageIds.length > 0 ? stage.upstreamStageIds.map((id) => stageName(id, overview)).join('、') : '无前置阶段'} · {stage.dependenciesSatisfied ? '已满足' : '未满足'}</div>
        </div>
      ) : null}

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

      {entry ? (
        <ChannelTaskFactSummary
          entry={entry}
          reviewerLabel={reviewerLabel(entry, participants)}
          className="mt-3"
          showGovernance={false}
          showStageBlockers={false}
        />
      ) : (
        <div className="mt-3 rounded border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">项目推进事实尚未就绪</div>
      )}
      <div className="mt-3 flex items-center justify-between text-xs font-semibold text-neutral-700">
        <span>{actionLabel}</span>
        <ArrowRight size={13} />
      </div>
    </button>
  );
}

function ProjectLaneIcon({ lane }: { lane: ProjectLaneId }) {
  if (lane === 'review') return <PackageCheck size={15} className="text-amber-600" />;
  if (lane === 'complete') return <CheckCircle2 size={15} className="text-emerald-600" />;
  return <Clock3 size={15} className="text-violet-600" />;
}

function SetupStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-300 text-[10px] font-bold text-neutral-900">{number}</span>
        <h3 className="text-xs font-semibold text-neutral-900">{title}</h3>
      </div>
      <p className="mt-2 text-[11px] leading-4 text-neutral-500">{detail}</p>
    </div>
  );
}

function projectLane(
  aggregateStatus: ProjectStage['aggregateStatus'] | undefined,
  taskStatus: ChannelTaskWorkspaceEntryV1['task']['status'],
): ProjectLaneId {
  if (taskStatus === 'cancelled') return 'complete';
  if (aggregateStatus === 'in_review' || taskStatus === 'in_review') return 'review';
  if (aggregateStatus === 'complete' || taskStatus === 'done' || taskStatus === 'closed') return 'complete';
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
