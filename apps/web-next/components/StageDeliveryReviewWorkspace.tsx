'use client';

import { AlertTriangle, ArrowLeft, FileSearch, PackageCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  ConsistencyTokenV1,
  PackageReviewAction,
  StageDeliveryReviewBlockerV1,
  StageDeliveryReviewMemberV1,
  StageDeliveryReviewVersionIdentityV1,
  StageDeliveryReviewWorkspaceV1,
  TaskLevelAction,
} from '@agentbean/contracts';

import { TaskDeliveryOverviewContent } from '@/components/TaskDeliveryOverview';
import { reviewStateLabel } from '@/lib/delivery-labels';
import { projectEvents, taskEvents } from '@/lib/socket';

type DetailState = 'loading' | 'not_ready' | 'no_permission' | 'error' | 'ready';

export interface StageDeliveryReviewWorkspaceProps {
  readonly teamId: string;
  readonly channelId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly minimumConsistency?: ConsistencyTokenV1;
  readonly participantName?: (id: string) => string;
  readonly onOpenThread?: (rootMessageId: string) => void;
  readonly onViewAssetSource?: (packageId: string) => void;
  readonly onAction?: (action: TaskLevelAction) => void;
}

export function StageDeliveryReviewWorkspace({
  teamId,
  channelId,
  stageId,
  taskId,
  minimumConsistency,
  participantName = (id) => id,
  onOpenThread,
  onViewAssetSource,
  onAction,
}: StageDeliveryReviewWorkspaceProps) {
  const [workspace, setWorkspace] = useState<StageDeliveryReviewWorkspaceV1 | null>(null);
  const [state, setState] = useState<DetailState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const latestConsistency = useRef(minimumConsistency);

  useEffect(() => {
    let alive = true;
    let requestId = 0;
    latestConsistency.current = minimumConsistency;
    setWorkspace(null);
    setState('loading');
    setErrorMessage(null);
    const project = projectEvents();
    const load = (showLoading: boolean) => {
      const currentRequestId = ++requestId;
      if (showLoading) setState('loading');
      return project.queryStageDeliveryReviewWorkspace({
        schemaVersion: 1,
        channelId,
        stageId,
        taskId,
        ...(latestConsistency.current ? { minimumConsistency: latestConsistency.current } : {}),
      }).then((result) => {
        if (!alive || currentRequestId !== requestId) return;
        if (result.ok && result.workspace) {
          latestConsistency.current = result.workspace.consistencyToken;
          setWorkspace(result.workspace);
          setState('ready');
          setErrorMessage(null);
          return;
        }
        setWorkspace(null);
        setState(detailStateForError(result.error));
        setErrorMessage(result.message ?? null);
      }).catch(() => {
        if (!alive || currentRequestId !== requestId) return;
        setWorkspace(null);
        setState('error');
        setErrorMessage('阶段交付审核工作区加载失败，请稍后重试');
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
  }, [teamId, channelId, stageId, taskId, minimumConsistency]);

  if (state !== 'ready') {
    return <StageDeliveryReviewState state={state} errorMessage={errorMessage} />;
  }
  if (!workspace) {
    return <StageDeliveryReviewState state="error" errorMessage="阶段交付审核工作区未返回可用投影" />;
  }

  const focusPackage = workspace.focusPackage;
  return (
    <div className="space-y-3" data-smoke="stage-delivery-review-workspace">
      <section className="rounded-md border border-neutral-200 bg-white p-3" data-smoke="stage-review-context">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-neutral-900">阶段交付审核上下文</div>
            <div className="mt-1 text-sm font-medium text-neutral-800">{workspace.stage.name}</div>
            <div className="mt-1 text-xs text-neutral-600">目标：{workspace.stage.goal}</div>
          </div>
          {workspace.archived ? (
            <span className="shrink-0 rounded bg-neutral-200 px-2 py-1 text-[11px] font-medium text-neutral-600">
              已归档 · 只读
            </span>
          ) : null}
        </div>
        <div className="mt-3 grid gap-2 text-[11px] text-neutral-600">
          <div>绑定 Task：{workspace.stage.task.title}（{workspace.taskId}）</div>
          <div>
            验收标准：{workspace.stage.acceptanceCriteria.length > 0
              ? workspace.stage.acceptanceCriteria.join('；')
              : '未配置'}
          </div>
          <div>
            上游阶段：{workspace.stage.upstreamStageIds.length > 0
              ? workspace.stage.upstreamStageIds.join('、')
              : '无'}
          </div>
          <div data-smoke="stage-review-stable-inputs">
            冻结输入：{workspace.stage.advance.stableInputs.length > 0
              ? workspace.stage.advance.stableInputs.map(stableInputLabel).join('；')
              : '暂无冻结输入'}
          </div>
          <div>
            建议审核人：{workspace.suggestedReviewerIds.length > 0
              ? workspace.suggestedReviewerIds.map(participantName).join('、')
              : '未绑定'}
          </div>
          <div>绑定讨论串：{workspace.threadRootMessageId ?? '无关联讨论串'}</div>
        </div>
      </section>

      {focusPackage ? (
        <section className="rounded-md border border-violet-200 bg-violet-50/40 p-3" data-smoke="stage-review-package">
          <div className="flex items-start gap-2">
            <PackageCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-neutral-900">当前 OutputPackage</div>
              <div className="mt-1 break-all text-[11px] text-neutral-600">{focusPackage.package.packageId}</div>
              <div className="mt-1 text-[11px] text-neutral-600">
                来源 Agent {participantName(focusPackage.package.agentId)}
                {focusPackage.package.workspaceRunId ? ` · WorkspaceRun ${focusPackage.package.workspaceRunId}` : ''}
                {focusPackage.package.invocationId ? ` · Invocation ${focusPackage.package.invocationId}` : ''}
              </div>
            </div>
          </div>

          <div className="mt-3 border border-neutral-200 bg-white px-3 py-2 text-[11px] text-neutral-700" data-smoke="stage-review-coverage">
            <div>
              必需成员 {focusPackage.coverage.requiredCount} · 已审核 {focusPackage.coverage.reviewedCount}
              {' · '}已通过 {focusPackage.coverage.approvedCount} · 未覆盖 {focusPackage.coverage.uncoveredCount}
            </div>
            <div className="mt-1">
              实际审核人：{focusPackage.coverage.actualReviewerIds.length > 0
                ? focusPackage.coverage.actualReviewerIds.map(participantName).join('、')
                : '尚无实际审核事实'}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {focusPackage.members.map((member) => (
              <PackageMemberDetail key={member.collectionId} member={member} participantName={participantName} />
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-xs text-neutral-500" data-smoke="stage-delivery-no-delivery">
          当前阶段尚无交付文件包
        </div>
      )}

      <StageReviewBlockers blockers={workspace.blockers} />

      <TaskDeliveryOverviewContent overview={workspace.taskOverview} onAction={onAction} />

      <div className="flex flex-wrap gap-2" data-smoke="stage-review-navigation">
        <button
          type="button"
          disabled={!workspace.threadRootMessageId || !onOpenThread}
          onClick={() => workspace.threadRootMessageId && onOpenThread?.(workspace.threadRootMessageId)}
          className={navigationButtonClass}
        >
          <ArrowLeft size={13} />
          回到讨论串
        </button>
        <button
          type="button"
          disabled={!focusPackage || !onViewAssetSource}
          onClick={() => focusPackage && onViewAssetSource?.(focusPackage.package.packageId)}
          className={navigationButtonClass}
        >
          <FileSearch size={13} />
          查看资产来源
        </button>
      </div>
    </div>
  );
}

function PackageMemberDetail({
  member,
  participantName,
}: {
  member: StageDeliveryReviewMemberV1;
  participantName: (id: string) => string;
}) {
  return (
    <article className="border border-neutral-200 bg-white p-3" data-smoke="stage-review-member" data-collection-id={member.collectionId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-neutral-900">{member.shortLabel} · {member.filename}</div>
          <div className="mt-1 break-all text-[11px] text-neutral-500">artifactVersionId：{member.artifactVersionId}</div>
          <div className="mt-1 break-all text-[11px] text-neutral-500">来源：{member.sourcePath}</div>
        </div>
        <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-[11px] text-neutral-600">
          {member.requiredForFinal ? '必需审核' : '可选成员'}
        </span>
      </div>

      <div className="mt-3 grid gap-1.5 text-[11px] sm:grid-cols-2" data-smoke="stage-review-version-identities">
        <VersionIdentity label="delivered" identity={member.delivered} fallback={member.artifactVersionId} />
        <VersionIdentity label="current" identity={member.current} />
        <VersionIdentity label="final" identity={member.final} emptyLabel="未设置" />
        <VersionIdentity label="specified" identity={member.specified} emptyLabel="未选择" />
      </div>

      {!member.delivered ? (
        <div className="mt-2 border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800" data-smoke="stage-delivery-version-unavailable">
          该交付版本详情当前不可见；仅保留 OutputPackage 冻结身份。
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-neutral-500" data-smoke="stage-review-member-source">
          版本来源：Task {member.delivered.source.taskId} · revision {member.delivered.source.taskRevision}
          {member.delivered.source.workspaceRunId ? ` · WorkspaceRun ${member.delivered.source.workspaceRunId}` : ''}
          {member.delivered.source.invocationId ? ` · Invocation ${member.delivered.source.invocationId}` : ''}
          {member.delivered.source.messageId ? ` · Message ${member.delivered.source.messageId}` : ''}
        </div>
      )}

      <div className="mt-2 border-t border-neutral-100 pt-2 text-[11px] text-neutral-600" data-smoke="stage-review-member-review">
        <div>
          审核状态：{member.review.state ? reviewStateLabel(member.review.state) : '版本不可见'}
          {' · '}{member.review.covered ? '已有审核覆盖' : '尚未审核覆盖'}
        </div>
        <div className="mt-1">
          实际审核人：{member.review.actualReviewerIds.length > 0
            ? member.review.actualReviewerIds.map(participantName).join('、')
            : '无'}
        </div>
        {member.review.records.map((review) => (
          <div key={review.id} className="mt-1 text-neutral-500">
            {reviewStateLabel(review.decision)} · {review.comment || '无备注'} · authority {review.authorityBasis}
          </div>
        ))}
        <div className="mt-1">
          Task 验收：由下方 acceptance contract 决定；Package 审核/最终化不会自动完成 Task。
        </div>
        <div className="mt-1">
          最终化：{member.finalization
            ? `${member.finalization.versionId}（由 ${participantName(member.finalization.finalizedBy)} 确认）`
            : '尚无最终化事实'}
        </div>
        {member.availableActions && member.availableActions.actions.length > 0 ? (
          <div className="mt-1">Server 可发现动作：{member.availableActions.actions.map(packageActionLabel).join('、')}</div>
        ) : null}
      </div>
    </article>
  );
}

function VersionIdentity({
  label,
  identity,
  fallback,
  emptyLabel = '不可用',
}: {
  label: 'delivered' | 'current' | 'final' | 'specified';
  identity?: StageDeliveryReviewVersionIdentityV1;
  fallback?: string;
  emptyLabel?: string;
}) {
  return (
    <div className="border border-neutral-200 bg-neutral-50 px-2 py-1.5" data-version-policy={label}>
      <span className="font-medium text-neutral-700">{label}</span>
      <span className="ml-1 break-all text-neutral-500">
        {identity ? `v${identity.versionNumber} · ${identity.versionId}` : fallback ?? emptyLabel}
      </span>
    </div>
  );
}

function StageReviewBlockers({ blockers }: { blockers: readonly StageDeliveryReviewBlockerV1[] }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white p-3" data-smoke="stage-review-blockers">
      <div className="flex items-center gap-2 text-xs font-semibold text-neutral-800">
        <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
        Server 阻断事实
      </div>
      {blockers.length === 0 ? (
        <div className="mt-2 text-[11px] text-neutral-500">当前没有 Server 阻断事实</div>
      ) : (
        <ul className="mt-2 space-y-1 text-[11px] text-amber-800">
          {blockers.map((blocker, index) => (
            <li key={`${blocker.source}:${blocker.code}:${index}`}>
              {blockerLabel(blocker)} <span className="text-neutral-400">({blocker.code})</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function blockerLabel(blocker: StageDeliveryReviewBlockerV1): string {
  if (blocker.source === 'review') return `必需成员 ${blocker.shortLabel} 尚未产生审核事实`;
  if (blocker.source === 'projection') return `${blocker.policy} 投影未就绪：${blocker.filename ?? blocker.collectionId}`;
  const labels: Record<Extract<StageDeliveryReviewBlockerV1, { source: 'stage' }>['code'], string> = {
    task_not_started: '绑定 Task 尚未开始',
    dependency_incomplete: '依赖 Task 尚未完成',
    review_pending: '等待审核结论',
    review_rejected: '审核未通过',
    review_needs_human: '需要人工确认',
    stage_dependency_incomplete: '前置阶段尚未完成',
    stage_dependency_unaccepted: '前置阶段产出未通过审核',
    required_input_missing: '缺少必需稳定输入',
  };
  return labels[blocker.code];
}

function stableInputLabel(input: StageDeliveryReviewWorkspaceV1['stage']['advance']['stableInputs'][number]): string {
  if (input.kind === 'artifact_version') return `${input.key}: ArtifactVersion ${input.versionId}`;
  return `${input.key}: Document revision ${input.revisionId}`;
}

function packageActionLabel(action: PackageReviewAction | string): string {
  const labels: Partial<Record<PackageReviewAction | string, string>> = {
    'review-approved': '通过审核',
    'review-changes-requested': '要求修改',
    'review-rejected': '拒绝',
    'review-and-finalize': '通过并最终化',
    'review-and-reject-delivery': '审核并退回交付',
    'set-final': '设为最终版',
    'revise-version': '基于此修改',
  };
  return labels[action] ?? action;
}

function detailStateForError(error: string | undefined): DetailState {
  if (error === 'PROJECTION_NOT_READY') return 'not_ready';
  if (error === 'FORBIDDEN' || error === 'UNAUTHENTICATED') return 'no_permission';
  return 'error';
}

function StageDeliveryReviewState({ state, errorMessage }: { state: Exclude<DetailState, 'ready'>; errorMessage: string | null }) {
  const copy = state === 'loading'
    ? '正在加载阶段交付审核上下文…'
    : state === 'not_ready'
      ? '阶段交付投影尚未追上最新一致性水位'
      : state === 'no_permission'
        ? '你没有查看该阶段交付审核上下文的权限'
        : errorMessage || '阶段交付审核工作区加载失败，请稍后重试';
  return (
    <div className="border border-neutral-200 bg-neutral-50 px-4 py-5 text-center text-xs text-neutral-600" data-smoke={`stage-delivery-${state}`}>
      {copy}
    </div>
  );
}

const navigationButtonClass = 'inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40';
