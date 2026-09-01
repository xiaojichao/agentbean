import type { MessageRecord, ServerNextRepositories } from './repositories.js';
import {
  CHANNEL_COLLABORATION_TASK_TAG,
  type ManagementEventPayloadMapV1,
  type TaskOfferResponseKind,
  type UnixMs,
} from '../../../../packages/contracts/src/index.js';

import type { TaskCoordinationTransactionRepositories } from './task-coordination-unit-of-work.js';
import { appendTaskEvent } from './management/task-coordination-kernel.js';
import { appendValidatedManagementEventInTransaction } from './management/management-kernel.js';
import {
  parsePhase1ManagementEvent,
  parseTaskCoordinationManagementEvent,
} from './management/management-event-validator.js';

export interface ChannelCollaborationAgentCandidate {
  readonly agentId: string;
  readonly agentName: string;
}

export interface ChannelCollaborationPromotionResult {
  readonly rootTaskId: string;
  readonly managementRunId: string;
  readonly subtaskIds: readonly string[];
}

interface PromotionHookContext {
  readonly repositories: TaskCoordinationTransactionRepositories;
  readonly rootTaskId: string;
  readonly managementRunId: string;
  readonly rootMessageId: string;
  readonly now: UnixMs;
}

/**
 * 结构化“频道 Agent 协作”promotion 的确定性 fan-out。
 *
 * fan-out 与 Promotion Gate 共用同一 Team UoW：root Task、每 Agent 一个 targeted
 * subtask、criteria 与 published 事件要么全部提交，要么全部回滚。Offer 的实时投递在
 * commit 后复用 TaskClaimBroker；claim 仍由 Agent acceptance 独立建立。
 */
export function createChannelCollaborationPromotionHooks(input: {
  readonly requesterId: string;
  readonly objective: string;
  readonly candidates: readonly ChannelCollaborationAgentCandidate[];
  readonly ids: { nextId(): string };
}) {
  let result: ChannelCollaborationPromotionResult | undefined;

  const projectExisting = async (context: PromotionHookContext) => {
    await context.repositories.messages.setTaskIdIfAbsent({
      messageId: context.rootMessageId,
      taskId: context.rootTaskId,
    });
    const coordinations = await context.repositories.coordination.coordinations
      .listByManagementRun(context.managementRunId);
    result = {
      rootTaskId: context.rootTaskId,
      managementRunId: context.managementRunId,
      subtaskIds: coordinations
        .filter((coordination) => coordination.nodeKind === 'subtask'
          && coordination.parentTaskId === context.rootTaskId)
        .map((coordination) => coordination.taskId)
        .sort(),
    };
  };

  const onAppliedInTransaction = async (context: PromotionHookContext) => {
    await context.repositories.messages.setTaskIdIfAbsent({
      messageId: context.rootMessageId,
      taskId: context.rootTaskId,
    });
    const rootTask = await context.repositories.tasks.getById(context.rootTaskId);
    if (!rootTask) throw new Error('CHANNEL_COLLABORATION_ROOT_TASK_NOT_FOUND');

    await context.repositories.coordination.criteria.create({
      id: input.ids.nextId(),
      taskId: rootTask.id,
      description: '所有频道 Agent 的定向子任务均已交付并完成验收',
      evidenceRequired: false,
      introducedRevision: rootTask.revision,
      position: 0,
    });

    const subtaskIds: string[] = [];
    const candidates = [...input.candidates].sort((left, right) =>
      left.agentId.localeCompare(right.agentId));
    for (const [index, candidate] of candidates.entries()) {
      const taskId = input.ids.nextId();
      const task = await context.repositories.tasks.create({
        id: taskId,
        teamId: rootTask.teamId,
        title: `${candidate.agentName}：${input.objective}`,
        description: input.objective,
        status: 'todo',
        creatorId: input.requesterId,
        assigneeId: candidate.agentId,
        channelId: rootTask.channelId,
        tags: [CHANNEL_COLLABORATION_TASK_TAG],
        sortOrder: rootTask.sortOrder + index + 1,
        createdAt: context.now,
        updatedAt: context.now,
      });
      await context.repositories.coordination.coordinations.create({
        schemaVersion: 1,
        taskId: task.id,
        teamId: task.teamId,
        managementRunId: context.managementRunId,
        rootTaskId: rootTask.id,
        parentTaskId: rootTask.id,
        nodeKind: 'subtask',
        reviewPolicy: 'manager',
        claimPolicy: 'targeted',
        requiredCapabilities: [],
        requiredSkills: [],
        preferredSkills: [],
        outputSlots: [],
        inputBindings: [],
        atomicityHint: 'decomposable',
        taskRevision: task.revision,
        attempt: 1,
        maxAttempts: 1,
        createdAt: context.now,
        updatedAt: context.now,
      });
      await context.repositories.coordination.criteria.create({
        id: input.ids.nextId(),
        taskId: task.id,
        description: `${candidate.agentName} 已在根消息讨论串提交独立响应`,
        evidenceRequired: false,
        introducedRevision: task.revision,
        position: 0,
      });
      await appendTaskEvent(context.repositories, {
        managementRunId: context.managementRunId,
        type: 'task-created',
        actorKind: 'system',
        actorId: 'system',
        idempotencyKey: `channel-collaboration:task-created:${task.id}`,
        payload: {
          taskId: task.id,
          parentTaskId: rootTask.id,
          taskRevision: task.revision,
        },
      }, context.now, input.ids, `channel-collaboration:task-created:${task.id}`);
      await appendTaskEvent(context.repositories, {
        managementRunId: context.managementRunId,
        type: 'task-published-for-claim',
        actorKind: 'system',
        actorId: 'system',
        idempotencyKey: `channel-collaboration:published:${task.id}`,
        payload: {
          taskId: task.id,
          taskRevision: task.revision,
          requiredCapabilities: [],
        },
      }, context.now, input.ids, `channel-collaboration:published:${task.id}`);
      subtaskIds.push(task.id);
    }
    result = {
      rootTaskId: rootTask.id,
      managementRunId: context.managementRunId,
      subtaskIds,
    };
  };

  return {
    onAppliedInTransaction,
    onConvergedInTransaction: projectExisting,
    getResult: () => result,
  };
}

export interface ChannelCollaborationClaimInput {
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly targetAgentId: string;
}

/**
 * Claim 已提交后的 Server-owned 可见投影。确定性 message id 让重放只产生一条确认，
 * 同一事务也把 root 从 todo 推进到 in_progress，避免子任务已经执行而根任务仍显示未开始。
 */
export async function recordChannelCollaborationClaim(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly claim: ChannelCollaborationClaimInput;
}): Promise<{ readonly message: MessageRecord; readonly created: boolean } | null> {
  const { claim } = input;
  return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
    const [task, coordination, run] = await Promise.all([
      repositories.tasks.getById(claim.taskId),
      repositories.coordination.coordinations.getByTaskId(claim.taskId),
      repositories.management.runs.getById(claim.managementRunId),
    ]);
    if (!task?.tags.includes(CHANNEL_COLLABORATION_TASK_TAG)
      || !coordination || coordination.nodeKind !== 'subtask'
      || coordination.managementRunId !== claim.managementRunId
      || coordination.taskRevision !== claim.taskRevision
      || coordination.attempt !== claim.taskAttempt
      || !run?.rootTaskId) {
      return null;
    }
    const lease = await repositories.coordination.claimLeases.getById(claim.claimLeaseId);
    if (!lease || lease.taskId !== task.id || lease.agentId !== claim.targetAgentId
      || lease.taskRevision !== task.revision || lease.taskAttempt !== coordination.attempt
      || lease.status !== 'active') {
      return null;
    }
    const agent = await input.repositories.agents.getById(claim.targetAgentId);
    const messageId = `channel-collaboration-claim:${claim.claimLeaseId}`;
    let message = await repositories.messages.getById(messageId);
    const created = !message;
    if (!message) {
      message = await repositories.messages.append({
        id: messageId,
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'agent',
        senderId: claim.targetAgentId,
        body: `已认领：${task.title}`,
        createdAt: input.clock.now(),
        meta: {
          kind: 'task-claim-confirmed',
          managementRunId: run.id,
          taskId: task.id,
          claimLeaseId: lease.id,
          agentName: agent?.name ?? claim.targetAgentId,
          replyScope: 'thread',
          parentMessageId: run.rootMessageId,
        },
      });
    }
    const rootTask = await repositories.tasks.getById(run.rootTaskId);
    if (rootTask?.status === 'todo') {
      const now = input.clock.now();
      const updated = await repositories.tasks.update({
        taskId: rootTask.id,
        changes: { status: 'in_progress', updatedAt: now },
      });
      if (!updated) throw new Error('CHANNEL_COLLABORATION_ROOT_TASK_NOT_FOUND');
      await appendTaskEvent(repositories, {
        managementRunId: run.id,
        type: 'task-state-changed',
        actorKind: 'system',
        actorId: 'system',
        idempotencyKey: `channel-collaboration:root-started:${run.id}`,
        payload: {
          taskId: rootTask.id,
          taskRevision: rootTask.revision,
          from: 'todo',
          to: 'in_progress',
        },
      }, now, input.ids, `channel-collaboration:root-started:${run.id}`);
    }
    if (run.status === 'queued') {
      await repositories.management.runs.update({
        ...run,
        status: 'running',
        updatedAt: input.clock.now(),
      });
    }
    return { message, created };
  });
}

type ChannelCollaborationOfferResponseKind = Exclude<TaskOfferResponseKind, 'accepted'>;

export type ChannelCollaborationStatusInput =
  | {
      readonly kind: 'allocation_blocked';
      readonly taskId: string;
      readonly agentId: string;
    }
  | {
      readonly kind: 'offer_response';
      readonly taskId: string;
      readonly agentId: string;
      readonly offerId: string;
      readonly responseKind: ChannelCollaborationOfferResponseKind;
    }
  | {
      readonly kind: 'claim_expired';
      readonly taskId: string;
      readonly agentId: string;
      readonly claimLeaseId: string;
    }
  | {
      readonly kind: 'invocation_failed';
      readonly managementRunId: string;
      readonly taskId: string;
      readonly agentId: string;
      readonly invocationId: string;
      readonly reasonCode: string;
    };

/**
 * 频道协作异常状态的 Server-owned 可见投影。权威 Offer/Lease/Invocation 事实必须先提交；
 * 本 projector 只追加幂等讨论串消息，不推进 root/run，因而单个 Agent 异常不会阻塞
 * 其他 Agent，也不会让根任务提前汇总。
 */
export async function recordChannelCollaborationStatus(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly status: ChannelCollaborationStatusInput;
}): Promise<{ readonly message: MessageRecord; readonly created: boolean } | null> {
  const { status } = input;
  return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
    const task = await repositories.tasks.getById(status.taskId);
    const coordination = await repositories.coordination.coordinations.getByTaskId(status.taskId);
    if (!task?.tags.includes(CHANNEL_COLLABORATION_TASK_TAG)
      || !coordination || coordination.nodeKind !== 'subtask'
      || task.assigneeId !== status.agentId) {
      return null;
    }
    const run = await repositories.management.runs.getById(coordination.managementRunId);
    if (!run?.rootTaskId
      || (status.kind === 'invocation_failed' && status.managementRunId !== run.id)) {
      return null;
    }

    if (status.kind === 'allocation_blocked') {
      const blocked = (await repositories.management.events.list(run.id)).some(({ event }) =>
        event.type === 'allocation-blocked'
        && event.payload.taskId === task.id
        && event.payload.taskRevision === task.revision);
      if (!blocked || task.status !== 'todo') return null;
    } else if (status.kind === 'offer_response') {
      const offer = await repositories.coordination.offers.getById(status.offerId);
      if (!offer || offer.taskId !== task.id || offer.agentId !== status.agentId
        || offer.status !== status.responseKind
        || offer.response?.kind !== status.responseKind || task.status !== 'todo') {
        return null;
      }
    } else if (status.kind === 'claim_expired') {
      const lease = await repositories.coordination.claimLeases.getById(status.claimLeaseId);
      if (!lease || lease.taskId !== task.id || lease.agentId !== status.agentId
        || lease.status !== 'expired' || task.status !== 'todo') {
        return null;
      }
    } else {
      const invocation = await repositories.management.invocations.getById(status.invocationId);
      const taskContext = invocation?.intent.taskContext;
      const claim = taskContext
        ? await repositories.coordination.claimLeases.getById(taskContext.claimLeaseId)
        : null;
      if (!invocation || invocation.managementRunId !== run.id
        || invocation.intent.targetAgentId !== status.agentId
        || !taskContext || taskContext.taskId !== task.id
        || !claim || claim.status !== 'invalidated' || task.status !== 'todo') {
        return null;
      }
    }

    const agent = await input.repositories.agents.getById(status.agentId);
    const agentName = agent?.name ?? status.agentId;
    const projection = channelCollaborationStatusProjection(status, agentName, task.revision);
    let message = await repositories.messages.getById(projection.messageId);
    const created = !message;
    if (!message) {
      message = await repositories.messages.append({
        id: projection.messageId,
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'system',
        senderId: 'system',
        body: projection.body,
        createdAt: input.clock.now(),
        meta: {
          kind: 'channel-collaboration-status',
          status: projection.status,
          recoveryAction: projection.recoveryAction,
          managementRunId: run.id,
          taskId: task.id,
          agentId: status.agentId,
          agentName,
          ...(status.kind === 'allocation_blocked'
            ? {}
            : status.kind === 'offer_response'
            ? { offerId: status.offerId, responseKind: status.responseKind }
            : status.kind === 'claim_expired'
              ? { claimLeaseId: status.claimLeaseId }
              : { invocationId: status.invocationId, reasonCode: status.reasonCode }),
          replyScope: 'thread',
          parentMessageId: run.rootMessageId,
        },
      });
    }
    return { message, created };
  });
}

function channelCollaborationStatusProjection(
  status: ChannelCollaborationStatusInput,
  agentName: string,
  taskRevision: number,
): {
  readonly messageId: string;
  readonly status: string;
  readonly recoveryAction: string;
  readonly body: string;
} {
  if (status.kind === 'allocation_blocked') {
    return {
      messageId: `channel-collaboration-status:allocation-blocked:${status.taskId}:${taskRevision}`,
      status: 'allocation_blocked',
      recoveryAction: 'retry-or-human',
      body: `${agentName} 当前无法认领该子任务，状态为 allocation_blocked；等待其恢复或人工处理，不会静默改派给其他 Agent。`,
    };
  }
  if (status.kind === 'claim_expired') {
    return {
      messageId: `channel-collaboration-status:claim-expired:${status.claimLeaseId}`,
      status: 'claim_expired',
      recoveryAction: 'retry-offer',
      body: `${agentName} 的认领已过期，子任务已重新开放，可重新派发；其他 Agent 继续执行。`,
    };
  }
  if (status.kind === 'invocation_failed') {
    return {
      messageId: `channel-collaboration-status:invocation-failed:${status.invocationId}`,
      status: 'invocation_failed',
      recoveryAction: 'retry-or-human',
      body: `${agentName} 执行失败，子任务已回到待处理，等待重试或人工处理；其他 Agent 继续执行。`,
    };
  }
  const offerCopy = status.responseKind === 'rejected'
    ? '已拒绝认领'
    : status.responseKind === 'needs_info'
      ? '需要补充信息，尚未认领'
      : '提出了调整建议，尚未认领';
  return {
    messageId: `channel-collaboration-status:offer-response:${status.offerId}`,
    status: `offer_${status.responseKind}`,
    recoveryAction: status.responseKind === 'rejected' ? 'retry-offer' : 'review-agent-response',
    body: `${agentName} ${offerCopy}该子任务；其他 Agent 继续执行。`,
  };
}

export interface CompleteChannelCollaborationSubtaskInput {
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly invocationId: string;
  readonly agentId: string;
  readonly deliveryMessageId: string;
  readonly summary: string;
}

/**
 * 协作模式的 completion projector：Agent 的成功回复本身就是当前客观 criterion 的证据。
 * Server 以 PI manager 身份记录 delivery/acceptance；全部叶子完成后在原讨论串写一条
 * 确定性汇总消息，并把 root/run 推进到 in_review，最终接受/打回仍只属于 Human。
 */
export async function completeChannelCollaborationSubtask(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly completion: CompleteChannelCollaborationSubtaskInput;
}): Promise<{ readonly summaryMessage: MessageRecord | null; readonly summaryCreated: boolean }> {
  const { completion } = input;
  return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
    const now = input.clock.now();
    let task = await repositories.tasks.getById(completion.taskId);
    const coordination = await repositories.coordination.coordinations.getByTaskId(completion.taskId);
    const run = await repositories.management.runs.getById(completion.managementRunId);
    if (!task?.tags.includes(CHANNEL_COLLABORATION_TASK_TAG)
      || !coordination || coordination.nodeKind !== 'subtask'
      || coordination.managementRunId !== completion.managementRunId
      || coordination.taskRevision !== completion.taskRevision
      || coordination.attempt !== completion.taskAttempt
      || !run?.rootTaskId) {
      return { summaryMessage: null, summaryCreated: false };
    }
    const claim = await repositories.coordination.claimLeases.getById(completion.claimLeaseId);
    if (!claim || claim.taskId !== task.id || claim.agentId !== completion.agentId
      || claim.taskRevision !== task.revision || claim.taskAttempt !== coordination.attempt) {
      return { summaryMessage: null, summaryCreated: false };
    }
    const invocation = await repositories.management.invocations.getById(completion.invocationId);
    const taskContext = invocation?.intent.taskContext;
    if (!invocation || invocation.managementRunId !== run.id
      || invocation.intent.targetAgentId !== completion.agentId
      || !taskContext || taskContext.taskId !== task.id
      || taskContext.taskRevision !== task.revision
      || taskContext.taskAttempt !== coordination.attempt
      || taskContext.claimLeaseId !== claim.id) {
      return { summaryMessage: null, summaryCreated: false };
    }
    const deliveryMessage = await repositories.messages.getById(completion.deliveryMessageId);
    if (!deliveryMessage || deliveryMessage.teamId !== run.teamId
      || deliveryMessage.channelId !== run.channelId
      || deliveryMessage.threadId !== run.rootMessageId
      || deliveryMessage.senderKind !== 'agent'
      || deliveryMessage.senderId !== completion.agentId) {
      return { summaryMessage: null, summaryCreated: false };
    }
    const deliveryKey = `channel-collaboration:delivery:${completion.invocationId}`;
    let delivery = await repositories.coordination.deliveries.getByIdempotencyKey({
      taskId: task.id,
      idempotencyKey: deliveryKey,
    });
    if (!delivery) {
      if (task.status !== 'in_progress') {
        return { summaryMessage: null, summaryCreated: false };
      }
      delivery = await repositories.coordination.deliveries.create({
        schemaVersion: 1,
        id: input.ids.nextId(),
        teamId: task.teamId,
        taskId: task.id,
        taskRevision: task.revision,
        taskAttempt: coordination.attempt,
        claimLeaseId: claim.id,
        invocationId: completion.invocationId,
        summary: completion.summary.trim() || task.title,
        claims: [{
          statement: completion.summary.trim() || task.title,
          evidenceRefs: [],
        }],
        evidenceRefs: [],
        idempotencyKey: deliveryKey,
        createdAt: now,
      });
      const inReview = await repositories.tasks.update({
        taskId: task.id,
        changes: { status: 'in_review', updatedAt: now },
      });
      if (!inReview) throw new Error('CHANNEL_COLLABORATION_SUBTASK_NOT_FOUND');
      task = inReview;
      await appendChannelCollaborationAgentEvent(repositories, {
        managementRunId: run.id,
        type: 'subtask-delivered',
        actorKind: 'agent',
        actorId: completion.agentId,
        idempotencyKey: deliveryKey,
        payload: {
          deliveryId: delivery.id,
          taskId: task.id,
          taskRevision: task.revision,
          taskAttempt: coordination.attempt,
          claimLeaseId: claim.id,
          invocationId: completion.invocationId,
        },
      }, now, input.ids, deliveryKey);
      await appendChannelCollaborationAgentEvent(repositories, {
        managementRunId: run.id,
        type: 'task-state-changed',
        actorKind: 'agent',
        actorId: completion.agentId,
        idempotencyKey: `${deliveryKey}:in-review`,
        payload: {
          taskId: task.id,
          taskRevision: task.revision,
          from: 'in_progress',
          to: 'in_review',
        },
      }, now, input.ids, `${deliveryKey}:in-review`);
    }

    // 纯文本独立响应可以由 PI 按客观 criterion 自动验收；一旦带文件/OutputPackage，
    // 必须保留既有文件审核门禁，停在 in_review，不能由此 projector 绕过 Human review。
    const deliveryArtifacts = await repositories.artifacts.listByMessage(deliveryMessage.id);
    if (deliveryArtifacts.length > 0 || deliveryMessage.meta?.outputPackageCard) {
      return { summaryMessage: null, summaryCreated: false };
    }

    let acceptance = await repositories.coordination.acceptances.getCanonicalByDelivery(delivery.id);
    if (!acceptance) {
      if (task.status !== 'in_review') {
        return { summaryMessage: null, summaryCreated: false };
      }
      const criteria = (await repositories.coordination.criteria.list(task.id))
        .filter((criterion) => criterion.introducedRevision <= task!.revision
          && (criterion.retiredRevision === undefined || criterion.retiredRevision > task!.revision));
      acceptance = await repositories.coordination.acceptances.create({
        schemaVersion: 1,
        id: input.ids.nextId(),
        teamId: task.teamId,
        taskId: task.id,
        deliveryId: delivery.id,
        expectedTaskRevision: task.revision,
        taskAttempt: coordination.attempt,
        claimLeaseId: claim.id,
        decision: 'accepted',
        criteriaResults: criteria.map((criterion) => ({
          criterionId: criterion.id,
          passed: true,
          evidenceRefs: [],
        })),
        reason: 'Agent 已在根消息讨论串提交独立响应',
        decidedBy: 'manager',
        decidedAt: now,
        decisionVersion: 1,
        canonical: true,
      });
      const done = await repositories.tasks.update({
        taskId: task.id,
        changes: { status: 'done', updatedAt: now },
      });
      if (!done) throw new Error('CHANNEL_COLLABORATION_SUBTASK_NOT_FOUND');
      task = done;
      const acceptanceKey = `channel-collaboration:accepted:${delivery.id}`;
      await appendTaskEvent(repositories, {
        managementRunId: run.id,
        type: 'task-acceptance-decided',
        actorKind: 'manager',
        actorId: 'system',
        idempotencyKey: acceptanceKey,
        payload: {
          taskId: task.id,
          acceptance: {
            schemaVersion: acceptance.schemaVersion,
            taskId: acceptance.taskId,
            deliveryId: acceptance.deliveryId,
            expectedTaskRevision: acceptance.expectedTaskRevision,
            taskAttempt: acceptance.taskAttempt,
            claimLeaseId: acceptance.claimLeaseId,
            decision: acceptance.decision,
            criteriaResults: acceptance.criteriaResults,
            reason: acceptance.reason,
            decidedBy: acceptance.decidedBy,
            decidedAt: acceptance.decidedAt,
          },
        },
      }, now, input.ids, acceptanceKey);
      await appendTaskEvent(repositories, {
        managementRunId: run.id,
        type: 'task-state-changed',
        actorKind: 'manager',
        actorId: 'system',
        idempotencyKey: `${acceptanceKey}:done`,
        payload: {
          taskId: task.id,
          taskRevision: task.revision,
          from: 'in_review',
          to: 'done',
        },
      }, now, input.ids, `${acceptanceKey}:done`);
    }

    const coordinations = (await repositories.coordination.coordinations.listByManagementRun(run.id))
      .filter((candidate) => candidate.nodeKind === 'subtask');
    const subtaskFacts = await Promise.all(coordinations.map(async (candidate) => ({
      coordination: candidate,
      task: await repositories.tasks.getById(candidate.taskId),
      deliveries: await repositories.coordination.deliveries.listByTask(candidate.taskId),
    })));
    if (subtaskFacts.length === 0 || subtaskFacts.some((fact) => fact.task?.status !== 'done')) {
      return { summaryMessage: null, summaryCreated: false };
    }
    const contributingInvocationIds = [...new Set(subtaskFacts.flatMap((fact) =>
      fact.deliveries.map((candidate) => candidate.invocationId)))].sort();
    if (contributingInvocationIds.length !== subtaskFacts.length) {
      return { summaryMessage: null, summaryCreated: false };
    }
    let rootTask = await repositories.tasks.getById(run.rootTaskId);
    if (!rootTask) throw new Error('CHANNEL_COLLABORATION_ROOT_TASK_NOT_FOUND');
    if (rootTask.status === 'todo') {
      const started = await repositories.tasks.update({
        taskId: rootTask.id,
        changes: { status: 'in_progress', updatedAt: now },
      });
      if (!started) throw new Error('CHANNEL_COLLABORATION_ROOT_TASK_NOT_FOUND');
      rootTask = started;
      await appendTaskEvent(repositories, {
        managementRunId: run.id,
        type: 'task-state-changed',
        actorKind: 'system',
        actorId: 'system',
        idempotencyKey: `channel-collaboration:root-started:${run.id}`,
        payload: {
          taskId: rootTask.id,
          taskRevision: rootTask.revision,
          from: 'todo',
          to: 'in_progress',
        },
      }, now, input.ids, `channel-collaboration:root-started:${run.id}`);
    }
    const summaryMessageId = `channel-collaboration-summary:${run.id}`;
    let summaryMessage = await repositories.messages.getById(summaryMessageId);
    const summaryCreated = !summaryMessage;
    if (!summaryMessage) {
      summaryMessage = await repositories.messages.append({
        id: summaryMessageId,
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'system',
        senderId: 'system',
        body: `PI 汇总：${subtaskFacts.length} 个频道 Agent 均已完成定向子任务，独立结果已回到本讨论串，等待你验收。`,
        createdAt: now,
        meta: {
          kind: 'channel-collaboration-summary',
          managementRunId: run.id,
          taskId: rootTask.id,
          contributingInvocationIds,
          replyScope: 'thread',
          parentMessageId: run.rootMessageId,
        },
      });
    }
    if (rootTask.status === 'in_progress') {
      const reviewed = await repositories.tasks.update({
        taskId: rootTask.id,
        changes: { status: 'in_review', updatedAt: now },
      });
      if (!reviewed) throw new Error('CHANNEL_COLLABORATION_ROOT_TASK_NOT_FOUND');
      await appendValidatedManagementEventInTransaction(repositories.management, {
        managementRunId: run.id,
        type: 'root-delivery-submitted',
        actorKind: 'manager',
        actorId: 'system',
        idempotencyKey: `channel-collaboration:root-delivery:${run.id}`,
        payload: { messageId: summaryMessage.id, contributingInvocationIds },
      }, now, input.ids, {
        payloadHash: `channel-collaboration:root-delivery:${run.id}`,
        parseEvent: parsePhase1ManagementEvent,
      });
      await repositories.management.runs.update({
        ...run,
        status: 'in_review',
        updatedAt: now,
      });
    }
    return { summaryMessage, summaryCreated };
  });
}

async function appendChannelCollaborationAgentEvent<
  T extends 'subtask-delivered' | 'task-state-changed',
>(
  repositories: TaskCoordinationTransactionRepositories,
  event: {
    readonly managementRunId: string;
    readonly type: T;
    readonly actorKind: 'agent';
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly payload: ManagementEventPayloadMapV1[T];
  },
  now: number,
  ids: { nextId(): string },
  commandHash: string,
) {
  return appendValidatedManagementEventInTransaction(repositories.management, event, now, ids, {
    payloadHash: commandHash,
    parseEvent: parseTaskCoordinationManagementEvent,
  });
}
