'use client';

import { AlertTriangle, ArrowLeft, FileSearch, PackageCheck, PencilLine } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  ConsistencyTokenV1,
  ProjectReferenceSelectionRequestDto,
  StageDeliveryReviewBlockerV1,
  StageDeliveryReviewMemberV1,
  StageDeliveryReviewVersionIdentityV1,
  StageDeliveryReviewWorkspaceV1,
  TaskLevelAvailableActionDto,
} from '@agentbean/contracts';

import { TaskDeliveryOverviewContent } from '@/components/TaskDeliveryOverview';
import { reviewStateLabel } from '@/lib/delivery-labels';
import type { OutputPackageMeta } from '@/lib/output-package';
import { buildPackageMembersSelection } from '@/lib/output-package-reference';
import {
  mutationErrorCopy,
  mutationLockKey,
  packageMutationActionLabel,
  submitDeliveryMutation,
  validateDeliveryMutationDraft,
  type DeliveryMutationTarget,
  type MutationDialogDraft,
} from '@/lib/package-review-actions';
import { projectEvents, taskEvents } from '@/lib/socket';

type DetailState = 'loading' | 'not_ready' | 'no_permission' | 'error' | 'ready';

/**
 * #1178：阶段交接动作（web 本地类型，不进合同）。
 * 点击只产生本地预填导航——发送前不创建 Message/Offer/claim/Invocation 事实；
 * 引用选择随发送由 Server 事务内冻结为具体 artifactVersionId。
 */
export interface StageHandoffAction {
  readonly action: 'delegate-to-agent' | 'continue-after-changes';
  /**
   * 预填引用选择：delegate 为 current 整包投影（带逐成员 revision fence）；
   * continue-after-changes 为 delivered 成员版本的 package_members 显式选择。
   * 无交付包或投影未就绪时为空（父级只预填意图文案）。
   */
  readonly selection?: ProjectReferenceSelectionRequestDto;
  /** 绑定讨论串根消息；为空时父级回落主 composer。 */
  readonly threadRootMessageId?: string;
}

type PendingDialog = {
  readonly kind: 'delivery';
  readonly target: DeliveryMutationTarget;
  readonly lockKey: string;
};

export interface StageDeliveryReviewWorkspaceProps {
  readonly teamId: string;
  readonly channelId: string;
  readonly stageId: string;
  readonly taskId: string;
  readonly minimumConsistency?: ConsistencyTokenV1;
  /** 当前人类用户 id；用于 Task delivery 验收按钮的本地发现门禁（仍由 Server 复验 authority）。 */
  readonly currentUserId?: string;
  readonly participantName?: (id: string) => string;
  readonly onOpenThread?: (rootMessageId: string) => void;
  readonly onViewAssetSource?: (packageId: string) => void;
  /** Task 与 Files/讨论串共用同一文件包预览审核弹窗。 */
  readonly onOpenPackagePreview?: (packageMeta: OutputPackageMeta, versionId?: string, readOnly?: boolean) => void;
  readonly onAction?: (action: TaskLevelAvailableActionDto) => void;
  /** #1178：阶段交接入口（交给智能体处理/要求修改后继续）携带焦点包引用与绑定 Thread 上抛。 */
  readonly onStageHandoff?: (action: StageHandoffAction) => void;
  /** 审核/验收成功后通知父级刷新 Tasks 列表等；工作区自身会重读 Server projection。 */
  readonly onMutationSucceeded?: () => void;
}

export function StageDeliveryReviewWorkspace({
  teamId,
  channelId,
  stageId,
  taskId,
  minimumConsistency,
  currentUserId,
  participantName = (id) => id,
  onOpenThread,
  onViewAssetSource,
  onOpenPackagePreview,
  onAction,
  onStageHandoff,
  onMutationSucceeded,
}: StageDeliveryReviewWorkspaceProps) {
  const [workspace, setWorkspace] = useState<StageDeliveryReviewWorkspaceV1 | null>(null);
  const [state, setState] = useState<DetailState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [draft, setDraft] = useState<MutationDialogDraft>({ comment: '', rejectReason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeLockKey, setActiveLockKey] = useState<string | null>(null);
  const latestConsistency = useRef(minimumConsistency);
  const hasReadyProjectionRef = useRef(false);
  const skipInitialConsistencyRefresh = useRef(true);
  const refreshRef = useRef<(() => void) | null>(null);
  const restoreFocusSelectorRef = useRef<string | null>(null);

  // identity 变化时全量重载；minimumConsistency 水位只软刷新，不拆掉进行中对话框。
  useEffect(() => {
    let alive = true;
    let requestId = 0;
    latestConsistency.current = minimumConsistency;
    hasReadyProjectionRef.current = false;
    skipInitialConsistencyRefresh.current = true;
    setWorkspace(null);
    setState('loading');
    setErrorMessage(null);
    setPendingDialog(null);
    setSubmitError(null);
    setActiveLockKey(null);
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
          hasReadyProjectionRef.current = true;
          setWorkspace(result.workspace);
          setState('ready');
          setErrorMessage(null);
          return;
        }
        // 软刷新失败时保留已有 ready 投影，避免冲掉进行中的 mutation 对话框。
        if (!showLoading && hasReadyProjectionRef.current) return;
        hasReadyProjectionRef.current = false;
        setWorkspace(null);
        setState(detailStateForError(result.error));
        setErrorMessage(result.message ?? null);
      }).catch(() => {
        if (!alive || currentRequestId !== requestId) return;
        if (!showLoading && hasReadyProjectionRef.current) return;
        hasReadyProjectionRef.current = false;
        setWorkspace(null);
        setState('error');
        setErrorMessage('阶段交付审核工作区加载失败，请稍后重试');
      });
    };
    void load(true).finally(() => {
      // identity 全量加载完成后，允许后续 minimumConsistency 水位触发软刷新。
      if (alive) skipInitialConsistencyRefresh.current = false;
    });
    const refresh = () => { void load(false); };
    refreshRef.current = refresh;
    const stopProject = project.onUpdated(channelId, refresh);
    const stopArtifacts = project.onArtifactsUpdated(channelId, refresh);
    const stopTasks = taskEvents().onSnapshot((tasks) => {
      if (tasks.some((task) => task.id === taskId && task.channelId === channelId)) refresh();
    });
    return () => {
      alive = false;
      refreshRef.current = null;
      stopProject();
      stopArtifacts();
      stopTasks();
    };
  }, [teamId, channelId, stageId, taskId]);

  useEffect(() => {
    latestConsistency.current = minimumConsistency;
    // identity 全量加载期间忽略水位软刷新，避免挂载时双请求/冲掉 loading。
    if (skipInitialConsistencyRefresh.current) return;
    // 水位推进时软刷新；不重置 loading/dialog。
    refreshRef.current?.();
  }, [minimumConsistency]);
  const closeDialog = useCallback((restoreFocus: boolean) => {
    const selector = restoreFocusSelectorRef.current;
    setPendingDialog(null);
    setDraft({ comment: '', rejectReason: '' });
    setSubmitError(null);
    setSubmitting(false);
    setActiveLockKey(null);
    if (restoreFocus && selector) {
      queueMicrotask(() => {
        const node = document.querySelector<HTMLElement>(selector);
        node?.focus();
      });
    }
    restoreFocusSelectorRef.current = null;
  }, []);

  const openDeliveryDialog = useCallback((kind: 'accept-delivery' | 'reject-delivery') => {
    if (!workspace || workspace.archived) return;
    const expectedTaskRevision = workspace.taskOverview.acceptanceContract.taskRevision;
    const lockKey = mutationLockKey({ kind: 'delivery', taskId, action: kind });
    const focusSelector = `[data-smoke="stage-delivery-action"][data-action="${kind}"]`;
    restoreFocusSelectorRef.current = focusSelector;
    setDraft({ comment: '', rejectReason: '' });
    setSubmitError(null);
    setPendingDialog({
      kind: 'delivery',
      target: { taskId, expectedTaskRevision, kind },
      lockKey,
    });
  }, [taskId, workspace]);

  const confirmMutation = useCallback(async () => {
    if (!pendingDialog || submitting) return;
    const validation = validateDeliveryMutationDraft(pendingDialog.target.kind, draft);
    if (validation) {
      setSubmitError(validation);
      return;
    }
    setSubmitting(true);
    setActiveLockKey(pendingDialog.lockKey);
    setSubmitError(null);
    try {
      const result = await submitDeliveryMutation(pendingDialog.target, draft);
      if (!result.ok) {
        setSubmitError(mutationErrorCopy(result));
        setSubmitting(false);
        setActiveLockKey(null);
        return;
      }
      closeDialog(true);
      refreshRef.current?.();
      onMutationSucceeded?.();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '操作失败，请稍后重试');
      setSubmitting(false);
      setActiveLockKey(null);
    }
  }, [closeDialog, draft, onMutationSucceeded, pendingDialog, submitting]);

  if (state !== 'ready') {
    return <StageDeliveryReviewState state={state} errorMessage={errorMessage} />;
  }
  if (!workspace) {
    return <StageDeliveryReviewState state="error" errorMessage="阶段交付审核工作区未返回可用投影" />;
  }

  const focusPackage = workspace.focusPackage;
  const hasPackageReviewActions = !workspace.archived && (focusPackage?.members.some(
    (member) => (member.availableActions?.actions.length ?? 0) > 0,
  ) ?? false);
  const packageMeta: OutputPackageMeta | undefined = focusPackage ? {
    kind: 'output-package',
    packageId: focusPackage.package.packageId,
    ...(workspace.threadRootMessageId ? { threadRootMessageId: workspace.threadRootMessageId } : {}),
    taskId: workspace.taskId,
    taskTitle: workspace.stage.task.title,
    agentId: focusPackage.package.agentId,
    agentName: participantName(focusPackage.package.agentId),
    memberCount: focusPackage.package.memberCount,
    members: focusPackage.package.members.map((member) => ({
      shortLabel: member.shortLabel,
      filename: member.filename,
      artifactVersionId: member.artifactVersionId,
      collectionId: member.collectionId,
    })),
    workspaceRevisionId: focusPackage.package.workspaceRevisionId,
    publishId: focusPackage.package.publishId,
    createdAt: focusPackage.package.createdAt,
  } : undefined;
  // Task delivery 按钮不是 package availableActions；在 Server 未投影 delivery action 前，
  // 仅当当前用户落在预绑定 humanAcceptanceAuthorityIds 时展示（仍由 Command 复验）。
  // nodeKind 必须为 root：accept/rejectRootDelivery 对子任务一律 TASK_ROOT_REQUIRED，
  // 不同步这道门禁会向子任务审核者展示必然失败的按钮。
  const acceptanceIds = workspace.taskOverview.acceptanceContract.humanAcceptanceAuthorityIds;
  const canMutateDelivery = !workspace.archived
    && workspace.taskOverview.task.status === 'in_review'
    && workspace.taskOverview.acceptanceContract.nodeKind === 'root'
    && workspace.taskOverview.acceptanceContract.requiresHumanAcceptance
    && Boolean(currentUserId)
    && acceptanceIds.includes(currentUserId!);

  // #1178：交接预填引用。current 是指针策略——发送时 Server 要求逐成员 collection
  // revision fence（缺/不符即 revision_stale fail closed），fence 取自焦点包 current
  // 投影的 Server 事实。current 投影未就绪时不造 fence：发送由 Server 返回
  // memberBlockers 结构化拒绝，预填保留在 composer，用户可改选 final/delivered。
  const delegateHandoffSelection = (): ProjectReferenceSelectionRequestDto | undefined => {
    if (!focusPackage) return undefined;
    if (focusPackage.projections.current.status === 'ready') {
      return {
        kind: 'package_projection',
        packageId: focusPackage.package.packageId,
        policy: 'current',
        expectedMemberRevisions: focusPackage.projections.current.members.map((member) => ({
          collectionId: member.collectionId,
          revision: member.collectionRevision,
        })),
      };
    }
    return { kind: 'package_projection', packageId: focusPackage.package.packageId, policy: 'current' };
  };

  // #1178 AC6（设计修正）：「要求修改后继续」引用 delivered 成员版本的 package_members
  // 显式选择——reject-delivery 写入 changes_requested/rejected review 后，delivered
  // 指针解析出的版本会被 REVIEW_BASIS_BLOCKED 挡住（只豁免显式选择、不豁免指针），
  // 显式版本才是合法交付依据。成员版本取自 Server delivered 投影（冻结事实）；
  // delivered 投影 not_ready（成员不可见/缺失无法枚举版本）时不造选择，
  // 父级只预填意图文案。
  const continueHandoffSelection = (): ProjectReferenceSelectionRequestDto | undefined => {
    if (!focusPackage) return undefined;
    const delivered = focusPackage.projections.delivered;
    if (delivered.status !== 'ready' || delivered.members.length === 0) return undefined;
    return buildPackageMembersSelection(
      focusPackage.package.packageId,
      delivered.members.map((member) => ({ collectionId: member.collectionId, versionId: member.versionId })),
    ) ?? undefined;
  };

  // #1178 AC6：「要求修改后继续」可见性纯由 Server 事实推导——焦点包存在、任一成员
  // 最新审核为「要求修改/已拒绝」（覆盖交付被退回：reject-delivery 前置要求
  // changes_requested/rejected 审核决策，review 记录 append-only 保留）、
  // Task 非终态、频道未归档。
  const handoffTaskStatus = workspace.taskOverview.task.status;
  const hasRevisionBasis = focusPackage?.members.some(
    (member) => member.review.state === 'changes_requested' || member.review.state === 'rejected',
  ) ?? false;
  const canContinueAfterChanges = Boolean(focusPackage)
    && hasRevisionBasis
    && handoffTaskStatus !== 'done' && handoffTaskStatus !== 'closed' && handoffTaskStatus !== 'cancelled'
    && !workspace.archived;

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
              <div className="mt-1 text-[11px] text-neutral-500" data-smoke="stage-review-package-basis">
                Task revision {focusPackage.package.taskRevision ?? '—'}
                {focusPackage.package.taskAttempt !== undefined ? ` · attempt ${focusPackage.package.taskAttempt}` : ''}
                {' · '}delivery {focusPackage.package.deliveryId}
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
              <PackageMemberDetail
                key={member.collectionId}
                member={member}
                participantName={participantName}
                canReview={!workspace.archived && (member.availableActions?.actions.length ?? 0) > 0}
                onOpenPreview={packageMeta && onOpenPackagePreview
                  ? () => onOpenPackagePreview(packageMeta, member.artifactVersionId, workspace.archived)
                  : undefined}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-xs text-neutral-500" data-smoke="stage-delivery-no-delivery">
          当前阶段尚无交付文件包
        </div>
      )}

      <StageReviewBlockers blockers={workspace.blockers} />

      {canMutateDelivery ? (
        <section className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3" data-smoke="stage-delivery-acceptance">
          <div className="text-xs font-semibold text-neutral-900">Task 交付验收</div>
          <p className="mt-1 text-[11px] text-neutral-600">
            验收与文件包审核是独立事实。按钮仅表示可发现性；提交时 Server 仍复验 acceptance authority。
          </p>
          <div className="mt-1 text-[11px] text-neutral-500">
            expected Task revision {workspace.taskOverview.acceptanceContract.taskRevision}
            {' · '}attempt {workspace.taskOverview.acceptanceContract.attempt}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-smoke="stage-delivery-action"
              data-action="accept-delivery"
              disabled={Boolean(activeLockKey)}
              onClick={() => openDeliveryDialog('accept-delivery')}
              className={actionButtonClass('accept')}
            >
              验收本次交付
            </button>
            <button
              type="button"
              data-smoke="stage-delivery-action"
              data-action="reject-delivery"
              disabled={Boolean(activeLockKey)}
              onClick={() => openDeliveryDialog('reject-delivery')}
              className={actionButtonClass('reject')}
            >
              退回交付
            </button>
          </div>
        </section>
      ) : null}

      <TaskDeliveryOverviewContent
        overview={workspace.taskOverview}
        onAction={(action) => {
          if (action.action === 'accept-delivery' && !action.disabled) {
            openDeliveryDialog('accept-delivery');
            return;
          }
          // #1178：阶段上下文的「交给智能体处理」携带焦点包引用与绑定 Thread 上抛
          // （父级做本地预填）；父级未接 onStageHandoff 时保持原 action 直通。
          if (action.action === 'delegate-to-agent' && onStageHandoff) {
            const selection = delegateHandoffSelection();
            onStageHandoff({
              action: 'delegate-to-agent',
              ...(selection ? { selection } : {}),
              ...(workspace.threadRootMessageId ? { threadRootMessageId: workspace.threadRootMessageId } : {}),
            });
            return;
          }
          onAction?.(action);
        }}
      />

      <div className="flex flex-wrap gap-2" data-smoke="stage-review-navigation">
        <button
          type="button"
          disabled={!workspace.threadRootMessageId || !onOpenThread}
          onClick={() => workspace.threadRootMessageId && onOpenThread?.(workspace.threadRootMessageId)}
          className={navigationButtonClass}
        >
          <ArrowLeft size={13} />
          打开讨论串
        </button>
        {canContinueAfterChanges ? (
          <button
            type="button"
            data-smoke="stage-review-continue-handoff"
            disabled={!workspace.threadRootMessageId || !onStageHandoff}
            onClick={() => {
              if (!workspace.threadRootMessageId) return;
              const selection = continueHandoffSelection();
              onStageHandoff?.({
                action: 'continue-after-changes',
                ...(selection ? { selection } : {}),
                threadRootMessageId: workspace.threadRootMessageId,
              });
            }}
            className={navigationButtonClass}
          >
            <PencilLine size={13} />
            要求修改后继续
          </button>
        ) : null}
        <button
          type="button"
          disabled={!focusPackage || !onViewAssetSource}
          onClick={() => focusPackage && onViewAssetSource?.(focusPackage.package.packageId)}
          className={navigationButtonClass}
        >
          <FileSearch size={13} />
          查看交付文件
        </button>
        <button
          type="button"
          data-smoke="stage-review-open-package-preview"
          disabled={!packageMeta || !onOpenPackagePreview || !hasPackageReviewActions}
          onClick={() => packageMeta && hasPackageReviewActions && onOpenPackagePreview?.(packageMeta)}
          className={navigationButtonClass}
        >
          <PackageCheck size={13} />
          审核交付文件
        </button>
      </div>

      {pendingDialog ? (
        <MutationConfirmDialog
          pending={pendingDialog}
          draft={draft}
          submitting={submitting}
          error={submitError}
          participantName={participantName}
          onDraftChange={setDraft}
          onCancel={() => closeDialog(true)}
          onConfirm={() => { void confirmMutation(); }}
        />
      ) : null}
    </div>
  );
}

function PackageMemberDetail({
  member,
  participantName,
  canReview,
  onOpenPreview,
}: {
  member: StageDeliveryReviewMemberV1;
  participantName: (id: string) => string;
  canReview: boolean;
  onOpenPreview?: () => void;
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
            {' · '}审核人 {participantName(review.reviewedBy)}
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
        {onOpenPreview ? (
          <button
            type="button"
            data-smoke="stage-review-member-preview"
            data-collection-id={member.collectionId}
            data-version-id={member.artifactVersionId}
            onClick={onOpenPreview}
            className="mt-2 rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50"
          >
            {canReview ? '预览并审核此文件' : '预览此文件'}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function MutationConfirmDialog({
  pending,
  draft,
  submitting,
  error,
  participantName,
  onDraftChange,
  onCancel,
  onConfirm,
}: {
  pending: PendingDialog;
  draft: MutationDialogDraft;
  submitting: boolean;
  error: string | null;
  participantName: (id: string) => string;
  onDraftChange: (draft: MutationDialogDraft) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const title = packageMutationActionLabel(pending.target.kind);
  const needsRejectReason = pending.target.kind === 'reject-delivery';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, submitting]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
      role="presentation"
      data-smoke="stage-review-mutation-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
      >
        <h2 id={titleId} className="text-sm font-semibold text-neutral-900">{title}</h2>
        <div className="mt-2 space-y-1 text-[11px] text-neutral-600" data-smoke="stage-review-mutation-target">
          <div>Task：{pending.target.taskId}</div>
          <div>expected revision：{pending.target.expectedTaskRevision}</div>
          <div>
            影响：{pending.target.kind === 'accept-delivery'
              ? '在合法 acceptance authority 下验收当前 delivery，将 Task 推进到完成态。'
              : '退回当前 delivery，保留旧 delivery/review 事实并产生新的合法 revision/attempt。'}
          </div>
          <div className="text-neutral-500">当前操作者身份由 Server 复验；界面可见不代表已获授权。</div>
          <div className="sr-only">{participantName('self')}</div>
        </div>

        {needsRejectReason ? (
          <label className="mt-3 block text-[11px] text-neutral-700">
            退回理由
            <textarea
              value={draft.rejectReason}
              onChange={(event) => onDraftChange({ ...draft, rejectReason: event.target.value })}
              disabled={submitting}
              className="mt-1 min-h-16 w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-800"
              data-smoke="stage-review-reject-reason"
              aria-label="退回理由"
            />
          </label>
        ) : null}

        {error ? (
          <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700" data-smoke="stage-review-mutation-error">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            data-smoke="stage-review-mutation-cancel"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onConfirm}
            className="rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
            data-smoke="stage-review-mutation-confirm"
          >
            {submitting ? '提交中…' : '确认提交'}
          </button>
        </div>
      </div>
    </div>
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

function actionButtonClass(action: string): string {
  if (action === 'review-and-finalize' || action === 'set-final' || action === 'accept') {
    return 'rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40';
  }
  if (action === 'review-rejected' || action === 'review-and-reject-delivery' || action === 'reject' || action === 'reject-delivery') {
    return 'rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-800 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40';
  }
  if (action === 'review-changes-requested') {
    return 'rounded-md border border-orange-300 bg-orange-50 px-2 py-1 text-[11px] font-medium text-orange-800 hover:bg-orange-100 disabled:cursor-not-allowed disabled:opacity-40';
  }
  return 'rounded-md border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40';
}

const navigationButtonClass = 'inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40';
