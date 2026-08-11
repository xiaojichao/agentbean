'use client';

import { AlertCircle, Settings2 } from 'lucide-react';
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
  const hasVisibleEntries = visibleStages.length > 0 || visibleManagedWithoutStage.length > 0;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-neutral-50" data-smoke="channel-project-progress">
      {stages.length > 0 || projectEntries.length > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white px-4 py-3">
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
          <div className="flex-1" />
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
        <div className="grid gap-4 p-4 xl:grid-cols-2">
          {visibleStages.map((stage) => {
            const entry = entriesByTaskId.get(stage.task.id);
            return (
              <button
                key={stage.id}
                type="button"
                aria-label={`打开阶段 ${stage.name}`}
                aria-current={selectedStageId === stage.id ? 'true' : undefined}
                data-smoke="channel-project-stage-card"
                data-stage-id={stage.id}
                data-task-id={stage.task.id}
                onClick={() => onOpenStage(stage.id, stage.task.id)}
                className={`border-2 bg-white p-4 text-left shadow-sm transition focus:outline-none focus:ring-2 focus:ring-amber-400 ${
                  selectedStageId === stage.id ? 'border-amber-500' : 'border-neutral-900 hover:border-amber-500'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-amber-700">{aggregateStatusLabel(stage.aggregateStatus)}</div>
                    <h3 className="mt-1 text-base font-semibold text-neutral-900">{stage.name}</h3>
                    <p className="mt-1 text-sm text-neutral-600">{stage.goal}</p>
                  </div>
                  <span className="border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-medium text-neutral-600">
                    任务状态：{taskStatusText(stage.task.status)}
                  </span>
                </div>

                <div className="mt-3 grid gap-2 text-xs text-neutral-600 sm:grid-cols-2">
                  <div>阶段负责人：{participantName(stage.ownerId, participants)}</div>
                  <div>建议审核人：{stage.reviewerIds.map((id) => participantName(id, participants)).join('、') || '未绑定'}</div>
                  <div>
                    {stage.upstreamStageIds.length > 0
                      ? `前置阶段：${stage.upstreamStageIds.map((id) => stageName(id, overview)).join('、')}`
                      : '无前置阶段'}
                  </div>
                  <div>{stage.dependenciesSatisfied ? '依赖已满足' : '依赖未满足'}</div>
                </div>

                {stage.missingRequiredInputs.length > 0 ? (
                  <div className="mt-3 border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">
                    缺少必需输入：{stage.missingRequiredInputs.map((input) => input.label || input.key).join('、')}
                  </div>
                ) : null}
                {stage.blockingReasons.length > 0 ? (
                  <div className="mt-2 flex items-start gap-1.5 border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">
                    <AlertCircle size={13} className="mt-0.5 shrink-0" />
                    <span>{stage.blockingReasons.map((reason) => blockingReasonLabel(reason.code)).join('；')}</span>
                  </div>
                ) : !stage.executionAllowed ? (
                  <div className="mt-2 border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs text-orange-700">当前阶段不可执行</div>
                ) : null}

                {entry ? (
                  <ChannelTaskFactSummary
                    entry={entry}
                    reviewerLabel={reviewerLabel(entry, participants)}
                    className="mt-3"
                  />
                ) : (
                  <div className="mt-3 border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
                    项目推进事实尚未就绪
                  </div>
                )}
              </button>
            );
          })}

          {visibleManagedWithoutStage.map((entry) => (
            <button
              key={entry.task.id}
              type="button"
              aria-label={`打开受管任务 ${entry.task.title}`}
              data-smoke="channel-managed-task-card"
              data-task-id={entry.task.id}
              onClick={() => onOpenStage(null, entry.task.id)}
              className="border-2 border-neutral-900 bg-white p-4 text-left shadow-sm hover:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-400"
            >
              <div className="text-xs font-medium text-violet-700">未绑定阶段的受管任务</div>
              <h3 className="mt-1 text-base font-semibold text-neutral-900">{entry.task.title}</h3>
              <div className="mt-1 text-xs text-neutral-500">任务状态：{taskStatusText(entry.task.status)}</div>
              <ChannelTaskFactSummary entry={entry} reviewerLabel={reviewerLabel(entry, participants)} className="mt-3" />
            </button>
          ))}
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
        ? 'mx-4 mt-4 flex shrink-0 flex-wrap items-center gap-3 border border-amber-200 bg-amber-50 px-4 py-3'
        : 'm-4 border border-amber-200 bg-gradient-to-br from-amber-50 to-white px-6 py-10 text-center'}
      data-smoke="channel-project-setup-prompt"
    >
      <div className={compact ? 'min-w-0 flex-1' : ''}>
        <h2 className="text-sm font-semibold text-neutral-900">把频道工作组织成阶段推进</h2>
        <p className={`text-xs leading-5 text-neutral-600 ${compact ? 'mt-0.5' : 'mx-auto mt-2 max-w-xl'}`}>
          {ordinaryTaskCount > 0
            ? `已有 ${ordinaryTaskCount} 个普通任务；配置首个阶段时可明确绑定任务、负责人、审核人与验收标准。`
            : '配置首个阶段，明确任务、负责人、审核人与验收标准。'}
          不会根据负责人、标签或状态自动改写历史任务。
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenSettings}
        className={`${compact ? '' : 'mt-5'} inline-flex h-9 items-center gap-1.5 rounded-md bg-neutral-900 px-4 text-xs font-semibold text-white hover:bg-neutral-800`}
      >
        <Settings2 size={14} />
        {archived ? '查看项目设置' : '配置首个项目阶段'}
      </button>
    </section>
  );
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

function aggregateStatusLabel(status: ChannelProjectOverviewDto['stages'][number]['aggregateStatus']): string {
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
