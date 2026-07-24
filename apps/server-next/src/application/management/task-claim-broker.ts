import { createHash, randomBytes } from 'node:crypto';
import type {
  TaskClaimAcquireAckV1,
  TaskClaimAcquireV1,
  TaskClaimAuthorityV1,
  TaskClaimExpiredV1,
  TaskClaimFailureAckV1,
  TaskClaimOfferV1,
  TaskClaimReleaseAckV1,
  TaskClaimReleaseV1,
  TaskClaimRenewAckV1,
  TaskClaimRenewV1,
  TaskOfferResponseKind,
  TaskOfferResponseRecordDto,
  TaskOfferStatus,
} from '../../../../../packages/contracts/src/index.js';
import {
  evaluateOfferAcceptance,
  evaluateOfferDecline,
  evaluateOfferValidity,
  evaluateTaskClaimAcquire,
  evaluateTaskClaimRelease,
  evaluateTaskClaimRenew,
  type OfferInvalidationReason,
  type OfferValidity,
  type TaskClaimLeaseRecord as DomainTaskClaimLeaseRecord,
} from '../../../../../packages/domain/src/index.js';
import type { AgentRecord, ServerNextRepositories } from '../repositories.js';
import type { TaskClaimLeaseRecord, TaskOfferRecord } from '../task-coordination-repositories.js';
import {
  appendValidatedManagementEventInTransaction,
} from './management-kernel.js';
import {
  hashManagementEventPayload,
  parseTaskCoordinationManagementEvent,
} from './management-event-validator.js';

export type TaskClaimCandidateDiagnosticCode =
  | 'AGENT_NOT_VISIBLE'
  | 'AGENT_DELETED'
  | 'AGENT_DEVICE_MISSING'
  | 'DEVICE_OFFLINE'
  | 'AGENT_NOT_READY'
  | 'CAPABILITY_MISSING'
  | 'TASK_CHANNEL_FORBIDDEN'
  | 'DEPENDENCY_NOT_READY'
  | 'DEPENDENCY_CHANNEL_FORBIDDEN'
  | 'ANCESTOR_AGENT_LOOP'
  | 'TARGET_AGENT_MISMATCH';

export interface TaskClaimCandidateDiagnostic {
  readonly agentId: string;
  readonly deviceId?: string;
  readonly eligible: boolean;
  readonly diagnosticCodes: readonly TaskClaimCandidateDiagnosticCode[];
  readonly missingCapabilities: readonly string[];
}

export interface TaskClaimCandidateResolution {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly candidates: readonly TaskClaimCandidateDiagnostic[];
  readonly ancestorAgentIds: readonly string[];
}

/** #712 切片 C-1：Agent 对显式 Task Offer 的响应输入。 */
export interface TaskOfferRespondInput {
  readonly offerId: string;
  readonly agentId: string;
  readonly kind: TaskOfferResponseKind;
  readonly detail?: string | null;
}

/**
 * #712 切片 C-2b-i：组合+持久化一个完整 Task Offer 的输入。
 * objective/deliverables/riskLevel 等从 task/coordination/criteria/manifest 派生（过渡）；
 * decision 的结构化 objective/inputs/constraints 属更底层切片（计划 §6.3 未完成）。
 */
export interface TaskOfferPublishInput {
  readonly taskId: string;
  readonly agentId: string;
  readonly offerTtlMs: number;
  /** 显式 @Agent（AC#8 仅元数据，不强迫接受）。 */
  readonly hardSpecified: boolean;
}

/**
 * #712 切片 C-1：respondToOffer 结果。
 * - claim_granted：accepted 且同事务创建了 Claim/Lease（AC#4）。
 * - overtaken：并发中被抢先获得 Claim（AC#6 败者），不产 Lease。
 * - response_recorded：rejected/needs_info/counter_proposed 记录为终态，不产 Lease（AC#5）。
 * - not_accepted：offer 失效/候选不合格/claim 策略拒绝，不产 Lease。
 */
export type TaskOfferRespondResult =
  | {
      readonly kind: 'claim_granted';
      readonly lease: TaskClaimAuthorityV1 & { readonly acquiredAt: number; readonly expiresAt: number };
      readonly execution: {
        readonly schemaVersion: 1;
        readonly managementRunId: string;
        readonly taskId: string;
        readonly taskRevision: number;
        readonly taskAttempt: number;
        readonly title: string;
        readonly objective: string;
        readonly acceptanceCriteria: readonly unknown[];
        readonly dependencyTaskIds: readonly string[];
        readonly channelId?: string;
      };
    }
  | { readonly kind: 'overtaken' }
  | { readonly kind: 'response_recorded'; readonly status: TaskOfferStatus }
  | {
      readonly kind: 'not_accepted';
      readonly reason: 'offer_invalid' | 'agent_not_qualified' | 'claim_rejected';
      readonly diagnosticCode: string;
    };

export interface TaskClaimBroker {
  resolveCandidates(taskId: string): Promise<TaskClaimCandidateResolution>;
  prepareOffers(taskId: string): Promise<readonly TaskClaimOfferV1[]>;
  acquire(input: TaskClaimAcquireV1): Promise<TaskClaimAcquireAckV1>;
  renew(input: TaskClaimRenewV1): Promise<TaskClaimRenewAckV1>;
  release(input: TaskClaimReleaseV1): Promise<TaskClaimReleaseAckV1>;
  expireClaims(): Promise<readonly TaskClaimExpiredV1[]>;
  disconnectDevice(deviceId: string): void;
  reconnectDevice(deviceId: string): void;
  /** #712 切片 C-1：持久化一个结构化 Task Offer（PI → Agent，状态 open）。 */
  createOffer(record: TaskOfferRecord): Promise<TaskOfferRecord>;
  /**
   * #712 切片 C-2b-i：从 task/coordination/criteria/manifest 派生并持久化完整 Task Offer。
   * 过渡：objective←task.description、deliverables←acceptance criteria、inputs/constraints 暂空、
   * riskLevel 默认 low（decision 结构化字段属后续切片）。为 C-2b-ii daemon 切换提供持久化 substrate。
   */
  publishOffer(input: TaskOfferPublishInput): Promise<TaskOfferRecord>;
  /** #712 切片 C-1：处理 Agent 对 Offer 的显式响应（AC#2/AC#4/AC#5/AC#6）。 */
  respondToOffer(input: TaskOfferRespondInput): Promise<TaskOfferRespondResult>;
}

export interface CreateTaskClaimBrokerInput {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly leaseTokens?: { nextToken(): string };
  readonly offerTtlMs?: number;
  readonly leaseTtlMs?: number;
}

interface StoredOffer extends TaskClaimOfferV1 {
  readonly ancestorAgentIds: readonly string[];
}

export function createTaskClaimBroker(input: CreateTaskClaimBrokerInput): TaskClaimBroker {
  const offerTtlMs = positiveDuration(input.offerTtlMs ?? 15_000, 'TASK_CLAIM_OFFER_TTL_INVALID');
  const leaseTtlMs = positiveDuration(input.leaseTtlMs ?? 60_000, 'TASK_CLAIM_LEASE_TTL_INVALID');
  const leaseTokens = input.leaseTokens ?? { nextToken: () => randomBytes(32).toString('base64url') };
  const offers = new Map<string, StoredOffer>();
  const disconnectedDevices = new Set<string>();
  const taskTails = new Map<string, Promise<void>>();

  // #710：候选硬过滤优先用 Team Agent Exposure 公开 capability（active 能力减去 Team restriction）。
  // 过渡兼容（计划 §8：旧代码先降为兼容层，切片 E 强制前保留）：无 active manifest 时回退到
  // legacy skill 名做匹配——仅用名称，永不引入 sourcePath/工具/权限（AC#6）。
  async function resolveEffectiveCapabilities(teamId: string, agent: AgentRecord): Promise<Set<string>> {
    const exposure = input.repositories.agentExposure;
    const now = input.clock.now();
    const active = await exposure.manifests.getActiveByTeamAgent(teamId, agent.id);
    if (active) {
      if (active.validUntil !== null && active.validUntil <= now) {
        await exposure.manifests.setStatus({ id: active.id, status: 'expired', now });
      } else {
        const restriction = await exposure.restrictions.getByTeamAgent(teamId, agent.id);
        const disabled = restriction && restriction.manifestId === active.id ? restriction.disabledCapabilities : [];
        const disabledSet = new Set(disabled.map((entry) => entry.toLowerCase()));
        return new Set(
          active.capabilities
            .map((capability) => capability.name.toLowerCase())
            .filter((name) => !disabledSet.has(name)),
        );
      }
    }
    return new Set((agent.skills ?? []).map((skill) => skill.name.toLowerCase()));
  }

  async function resolveCandidates(taskId: string): Promise<TaskClaimCandidateResolution> {
    const task = await input.repositories.tasks.getById(taskId);
    if (!task) throw new Error('TASK_CLAIM_TASK_NOT_FOUND');
    const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(taskId);
    if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
    const agents = (await input.repositories.agents.listAll()).filter((agent) =>
      agent.primaryTeamId === task.teamId || agent.visibleTeamIds.includes(task.teamId));
    const devices = new Map((await input.repositories.devices.listByTeam(task.teamId))
      .map((device) => [device.id, device]));
    const dependencies = await input.repositories.taskCoordination.dependencies.list(taskId);
    const dependencyTasks = await Promise.all(dependencies.map((edge) => input.repositories.tasks.getById(edge.dependencyTaskId)));
    const taskChannel = task.channelId ? await input.repositories.channels.getById(task.channelId) : null;
    const dependencyChannels = new Map<string, Awaited<ReturnType<typeof input.repositories.channels.getById>>>();
    for (const dependencyTask of dependencyTasks) {
      if (dependencyTask?.channelId && !dependencyChannels.has(dependencyTask.channelId)) {
        dependencyChannels.set(dependencyTask.channelId, await input.repositories.channels.getById(dependencyTask.channelId));
      }
    }
    const ancestorAgentIds = await collectAncestorAgentIds(taskId, input.repositories, input.clock.now());
    const candidates: TaskClaimCandidateDiagnostic[] = [];
    for (const agent of agents) {
      const diagnostics: TaskClaimCandidateDiagnosticCode[] = [];
      if (!agent.visibleTeamIds.includes(task.teamId)) diagnostics.push('AGENT_NOT_VISIBLE');
      if (agent.deletedAt !== undefined) diagnostics.push('AGENT_DELETED');
      if (!agent.deviceId) diagnostics.push('AGENT_DEVICE_MISSING');
      const device = agent.deviceId ? devices.get(agent.deviceId) : undefined;
      if (agent.deviceId && (!device || device.status !== 'online' || disconnectedDevices.has(agent.deviceId))) {
        diagnostics.push('DEVICE_OFFLINE');
      }
      if (agent.status !== 'online') diagnostics.push('AGENT_NOT_READY');
      const explicitCapabilities = await resolveEffectiveCapabilities(task.teamId, agent);
      const missingCapabilities = coordination.requiredCapabilities
        .filter((capability) => !explicitCapabilities.has(capability.toLowerCase()));
      if (missingCapabilities.length > 0) diagnostics.push('CAPABILITY_MISSING');
      if (task.channelId && (!taskChannel || !channelAllowsAgent(taskChannel, agent.id))) {
        diagnostics.push('TASK_CHANNEL_FORBIDDEN');
      }
      if (dependencyTasks.some((dependency) => !dependency || dependency.status !== 'done')) {
        diagnostics.push('DEPENDENCY_NOT_READY');
      }
      if (dependencyTasks.some((dependency) => dependency?.channelId &&
        (!dependencyChannels.get(dependency.channelId) ||
          !channelAllowsAgent(dependencyChannels.get(dependency.channelId), agent.id)))) {
        diagnostics.push('DEPENDENCY_CHANNEL_FORBIDDEN');
      }
      if (ancestorAgentIds.includes(agent.id)) diagnostics.push('ANCESTOR_AGENT_LOOP');
      if (coordination.claimPolicy === 'targeted' && task.assigneeId !== agent.id) {
        diagnostics.push('TARGET_AGENT_MISMATCH');
      }
      candidates.push({
        agentId: agent.id,
        ...(agent.deviceId ? { deviceId: agent.deviceId } : {}),
        eligible: diagnostics.length === 0,
        diagnosticCodes: diagnostics,
        missingCapabilities,
      });
    }
    return {
      taskId,
      taskRevision: task.revision,
      taskAttempt: coordination.attempt,
      candidates: candidates.sort((left, right) => left.agentId.localeCompare(right.agentId)),
      ancestorAgentIds,
    };
  }

  return {
    resolveCandidates,
    async prepareOffers(taskId) {
      await expireClaims();
      const resolution = await resolveCandidates(taskId);
      const task = await input.repositories.tasks.getById(taskId);
      if (!task || !['todo', 'in_progress'].includes(task.status)) throw new Error('TASK_CLAIM_TASK_NOT_OFFERABLE');
      const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(taskId);
      if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
      const current = await input.repositories.taskCoordination.claimLeases.getCurrent({
        taskId, taskRevision: task.revision, taskAttempt: coordination.attempt,
      });
      if (current && current.expiresAt > input.clock.now()) return [];
      const now = input.clock.now();
      const prepared = resolution.candidates.filter((candidate) => candidate.eligible && candidate.deviceId)
        .map((candidate): StoredOffer => ({
          schemaVersion: 1,
          offerId: input.ids.nextId(),
          deviceId: candidate.deviceId!,
          taskId,
          taskRevision: resolution.taskRevision,
          taskAttempt: resolution.taskAttempt,
          agentId: candidate.agentId,
          requiredCapabilities: [...coordination.requiredCapabilities],
          offerExpiresAt: now + offerTtlMs,
          ancestorAgentIds: resolution.ancestorAgentIds,
        }));
      for (const offer of prepared) offers.set(offer.offerId, offer);
      return prepared.map(({ ancestorAgentIds: _ancestorAgentIds, ...offer }) => offer);
    },
    async acquire(payload) {
      const offer = offers.get(payload.offerId);
      if (!offer || offer.agentId !== payload.agentId) return failure('INVALID_REQUEST', 'TASK_CLAIM_OFFER_INVALID', false);
      if (input.clock.now() >= offer.offerExpiresAt) {
        offers.delete(offer.offerId);
        return failure('UNAVAILABLE', 'TASK_CLAIM_OFFER_EXPIRED', true);
      }
      return withTaskLock(offer.taskId, taskTails, async () => {
        const resolution = await resolveCandidates(offer.taskId);
        const candidate = resolution.candidates.find((item) => item.agentId === offer.agentId);
        if (!candidate?.eligible || candidate.deviceId !== offer.deviceId) {
          return failure('UNAVAILABLE', candidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE', true);
        }
        const leaseToken = leaseTokens.nextToken();
        const leaseTokenHash = hash(leaseToken);
        const leaseFingerprint = leaseTokenHash.slice(0, 16);
        try {
          const result = await input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
            const now = input.clock.now();
            const task = await repositories.tasks.getById(offer.taskId);
            const coordination = await repositories.coordination.coordinations.getByTaskId(offer.taskId);
            if (!task || !coordination || task.revision !== offer.taskRevision ||
                coordination.attempt !== offer.taskAttempt || !['todo', 'in_progress'].includes(task.status)) {
              throw new TaskClaimConflict('TASK_CLAIM_OFFER_STALE');
            }
            const latest = await repositories.coordination.claimLeases.getLatest({
              taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
            });
            if (latest?.status === 'invalidated') throw new TaskClaimConflict('TASK_CLAIM_INVALIDATED');
            const decision = evaluateTaskClaimAcquire({
              current: latest ? toDomainLease(latest) : undefined,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              agentId: offer.agentId,
              leaseTokenHash,
              leaseFingerprint,
              ancestorAgentIds: offer.ancestorAgentIds,
              now,
              ttlMs: leaseTtlMs,
            });
            if (decision.kind === 'rejected') throw new TaskClaimConflict(`TASK_CLAIM_${code(decision.reason)}`);
            if (decision.kind === 'existing') throw new TaskClaimConflict('TASK_CLAIM_ALREADY_HELD');
            if (latest?.status === 'active') {
              const expired = await repositories.coordination.claimLeases.update({
                id: latest.id, expectedStatus: 'active', status: 'expired',
                heartbeatAt: latest.heartbeatAt, expiresAt: latest.expiresAt,
              });
              if (!expired) throw new TaskClaimConflict('TASK_CLAIM_EXPIRE_CONFLICT');
            }
            const leaseId = input.ids.nextId();
            const lease: TaskClaimLeaseRecord = {
              id: leaseId,
              teamId: task.teamId,
              taskId: task.id,
              taskRevision: task.revision,
              taskAttempt: coordination.attempt,
              agentId: offer.agentId,
              leaseTokenHash,
              leaseFingerprint,
              fencingToken: decision.lease.fencingToken,
              status: 'active',
              acquiredAt: decision.lease.acquiredAt,
              heartbeatAt: decision.lease.renewedAt,
              expiresAt: decision.lease.expiresAt,
            };
            await repositories.coordination.claimLeases.create(lease);
            await appendTaskClaimEvent(repositories.management, {
              managementRunId: coordination.managementRunId,
              type: 'task-claimed',
              actorKind: 'agent',
              actorId: offer.agentId,
              idempotencyKey: `task-claimed:${lease.id}`,
              payload: { taskId: task.id, taskRevision: task.revision, agentId: offer.agentId,
                claimLeaseId: lease.id, attempt: coordination.attempt },
            }, now, input.ids);
            if (task.status === 'todo' || task.assigneeId !== offer.agentId) {
              const updated = await repositories.tasks.update({ taskId: task.id,
                changes: { ...(task.status === 'todo' ? { status: 'in_progress' as const } : {}),
                  assigneeId: offer.agentId, updatedAt: now } });
              if (!updated) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
            }
            if (task.status === 'todo') {
              await appendTaskClaimEvent(repositories.management, {
                managementRunId: coordination.managementRunId,
                type: 'task-state-changed',
                actorKind: 'agent', actorId: offer.agentId,
                idempotencyKey: `task-state-changed:${lease.id}`,
                payload: { taskId: task.id, taskRevision: task.revision, from: 'todo', to: 'in_progress' },
              }, now, input.ids);
            }
            const criteria = (await repositories.coordination.criteria.list(task.id))
              .filter((criterion) => criterion.introducedRevision <= task.revision &&
                (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision))
              .sort((left, right) => left.position - right.position)
              .map(({ taskId: _taskId, introducedRevision: _introducedRevision,
                retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion);
            const dependencyTaskIds = (await repositories.coordination.dependencies.list(task.id))
              .map((dependency) => dependency.dependencyTaskId);
            return { lease, task, coordination, criteria, dependencyTaskIds };
          });
          consumeTaskOffers(offers, offer.taskId);
          return {
            schemaVersion: 1,
            ok: true,
            lease: authority(result.lease, leaseToken),
            execution: {
              schemaVersion: 1,
              managementRunId: result.coordination.managementRunId,
              taskId: result.task.id,
              taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt,
              title: result.task.title,
              objective: result.task.description ?? result.task.title,
              acceptanceCriteria: result.criteria,
              dependencyTaskIds: result.dependencyTaskIds,
              ...(result.task.channelId ? { channelId: result.task.channelId } : {}),
            },
          } satisfies TaskClaimAcquireAckV1;
        } catch (error) {
          if (error instanceof TaskClaimConflict) {
            return failure('CONFLICT', error.message, error.message === 'TASK_CLAIM_ACTIVE_CLAIM_HELD');
          }
          throw error;
        }
      });
    },
    async renew(payload) {
      return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
        const lease = await repositories.coordination.claimLeases.getById(payload.claimLeaseId);
        const now = input.clock.now();
        const decision = evaluateTaskClaimRenew({
          lease: lease ? toDomainLease(lease) : undefined,
          proof: proof(payload), now, ttlMs: leaseTtlMs,
        });
        if (decision.kind === 'rejected') return failure('STALE_AUTHORITY', `TASK_CLAIM_${code(decision.reason)}`, false);
        const updated = await repositories.coordination.claimLeases.update({
          id: payload.claimLeaseId, expectedStatus: 'active', status: 'active',
          heartbeatAt: decision.lease.renewedAt, expiresAt: decision.lease.expiresAt,
        });
        return updated
          ? { schemaVersion: 1, ok: true, expiresAt: updated.expiresAt }
          : failure('CONFLICT', 'TASK_CLAIM_RENEW_CONFLICT', true);
      });
    },
    async release(payload) {
      return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
        const lease = await repositories.coordination.claimLeases.getById(payload.claimLeaseId);
        const now = input.clock.now();
        const decision = evaluateTaskClaimRelease({ lease: lease ? toDomainLease(lease) : undefined,
          proof: proof(payload), now });
        if (decision.kind === 'rejected') return failure('STALE_AUTHORITY', `TASK_CLAIM_${code(decision.reason)}`, false);
        if (decision.kind === 'already-released') {
          return { schemaVersion: 1, ok: true, releasedAt: decision.lease.releasedAt! };
        }
        const updated = await repositories.coordination.claimLeases.update({
          id: payload.claimLeaseId, expectedStatus: 'active', status: 'released',
          heartbeatAt: lease!.heartbeatAt, expiresAt: lease!.expiresAt, releasedAt: now,
        });
        return updated
          ? { schemaVersion: 1, ok: true, releasedAt: now }
          : failure('CONFLICT', 'TASK_CLAIM_RELEASE_CONFLICT', true);
      });
    },
    expireClaims,
    disconnectDevice(deviceId) {
      disconnectedDevices.add(deviceId);
      for (const [offerId, offer] of offers) if (offer.deviceId === deviceId) offers.delete(offerId);
    },
    reconnectDevice(deviceId) {
      disconnectedDevices.delete(deviceId);
    },
    async createOffer(record) {
      return input.repositories.taskCoordination.offers.create(record);
    },
    async publishOffer(params) {
      // 输入校验：负/零 TTL 会立即过期（wasteful）；与构造期全局 TTL 同款 positiveDuration。
      positiveDuration(params.offerTtlMs, 'TASK_CLAIM_OFFER_TTL_INVALID');
      const task = await input.repositories.tasks.getById(params.taskId);
      if (!task) throw new Error('TASK_CLAIM_TASK_NOT_FOUND');
      const coordination = await input.repositories.taskCoordination.coordinations.getByTaskId(params.taskId);
      if (!coordination) throw new Error('TASK_CLAIM_COORDINATION_NOT_FOUND');
      // manifestRevision fence：仅向有当前有效 active manifest 的 agent 发 offer（公开契约存在）。
      const activeManifest = await input.repositories.agentExposure.manifests.getActiveByTeamAgent(
        task.teamId, params.agentId,
      );
      const now = input.clock.now();
      if (!activeManifest || (activeManifest.validUntil !== null && activeManifest.validUntil <= now)) {
        throw new Error('TASK_CLAIM_MANIFEST_NOT_ACTIVE');
      }
      // 过滤退休 criterion（#709 修订退休的验收标准不进入新 offer 的 deliverables）。
      const criteria = (await input.repositories.taskCoordination.criteria.list(params.taskId))
        .filter((criterion) => criterion.retiredRevision === undefined);
      const record: TaskOfferRecord = {
        id: input.ids.nextId(),
        teamId: task.teamId,
        taskId: task.id,
        agentId: params.agentId,
        taskRevision: task.revision,
        taskAttempt: coordination.attempt,
        manifestRevision: activeManifest.revision,
        // 过渡派生：decision 的结构化 objective/inputs/constraints 属后续切片（计划 §6.3）。
        objective: {
          objective: task.description ?? task.title,
          inputs: [],
          deliverables: criteria.map((criterion) => criterion.description),
          constraints: [],
          riskLevel: 'low',
          requiredCapabilities: [...coordination.requiredCapabilities],
          requiredSkills: [...(coordination.requiredSkills ?? [])],
          preferredSkills: [...(coordination.preferredSkills ?? [])],
        },
        offerTtlMs: params.offerTtlMs,
        offerExpiresAt: now + params.offerTtlMs,
        hardSpecified: params.hardSpecified,
        status: 'open',
        response: null,
        createdAt: now,
        updatedAt: now,
      };
      return input.repositories.taskCoordination.offers.create(record);
    },
    async respondToOffer(payload) {
      const offerStore = input.repositories.taskCoordination.offers;
      const offer = await offerStore.getById(payload.offerId);
      if (!offer || offer.agentId !== payload.agentId) {
        return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: 'TASK_CLAIM_OFFER_INVALID' };
      }
      const now = input.clock.now();
      const validity = await computeOfferValidity(input.repositories, offer, now);

      // 非接受响应：rejected / needs_info / counter_proposed（AC#5：不产 Lease）
      if (payload.kind !== 'accepted') {
        const decline = evaluateOfferDecline({ kind: payload.kind, validity });
        if (decline.kind === 'not_accepted') {
          const diagnosticCode = !validity.acceptable
            ? offerValidityCode(validity.reason) : 'TASK_CLAIM_OFFER_INVALID';
          return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode };
        }
        const response: TaskOfferResponseRecordDto = {
          offerId: offer.id, agentId: offer.agentId, kind: payload.kind,
          detail: payload.detail ?? null, respondedAt: now,
        };
        const updated = await offerStore.updateStatus({
          id: offer.id, expectedStatus: 'open', status: payload.kind, response, now,
        });
        // decline 路径无「并发赢家」语义；CAS 失败=offer 已被他者置终态 → not_accepted。
        return updated
          ? { kind: 'response_recorded', status: payload.kind }
          : { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: 'TASK_CLAIM_OFFER_NOT_OPEN' };
      }

      // accepted
      if (!validity.acceptable) {
        return { kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: offerValidityCode(validity.reason) };
      }
      return withTaskLock(offer.taskId, taskTails, async () => {
        const resolution = await resolveCandidates(offer.taskId);
        const candidate = resolution.candidates.find((item) => item.agentId === offer.agentId);
        if (!candidate?.eligible) {
          return { kind: 'not_accepted', reason: 'agent_not_qualified' as const,
            diagnosticCode: candidate?.diagnosticCodes[0] ?? 'TASK_CLAIM_CANDIDATE_UNAVAILABLE' };
        }
        const leaseToken = leaseTokens.nextToken();
        const leaseTokenHash = hash(leaseToken);
        const leaseFingerprint = leaseTokenHash.slice(0, 16);
        const acceptedResponse: TaskOfferResponseRecordDto = {
          offerId: offer.id, agentId: offer.agentId, kind: 'accepted', detail: null, respondedAt: now,
        };
        try {
          const result = await input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
            const task = await repositories.tasks.getById(offer.taskId);
            const coordination = await repositories.coordination.coordinations.getByTaskId(offer.taskId);
            if (!task || !coordination || task.revision !== offer.taskRevision ||
                coordination.attempt !== offer.taskAttempt || !['todo', 'in_progress'].includes(task.status)) {
              // AC#4：task 已变 → 回滚，不留 accepted 无 claim
              throw new TaskClaimConflict('TASK_CLAIM_OFFER_STALE');
            }
            const latest = await repositories.coordination.claimLeases.getLatest({
              taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
            });
            if (latest?.status === 'invalidated') throw new TaskClaimConflict('TASK_CLAIM_INVALIDATED');
            const decision = evaluateOfferAcceptance({
              eligibility: { state: 'qualified' },
              validity,
              acquire: {
                current: latest ? toDomainLease(latest) : undefined,
                taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
                agentId: offer.agentId, leaseTokenHash, leaseFingerprint,
                ancestorAgentIds: resolution.ancestorAgentIds, now, ttlMs: leaseTtlMs,
              },
            });
            if (decision.kind === 'not_accepted') {
              // 到达此处时 validity/eligibility 已预检通过，剩余 not_accepted 通常为 claim_rejected
              // （evaluateTaskClaimAcquire 因 invalid-claim-state/clock-regressed/fencing-overflow 拒绝）。
              // 经 TaskClaimConflict.offerReason 携带 reason，避免被 catch 一律映射成 offer_invalid。
              throw new TaskClaimConflict(
                decision.acquireRejection
                  ? `TASK_CLAIM_${code(decision.acquireRejection)}`
                  : 'TASK_CLAIM_OFFER_INVALID',
                decision.reason,
              );
            }
            if (decision.kind === 'overtaken') {
              // active-claim-held：他 Agent 已持 lease。标 overtaken（CAS 失败=已终态则忽略）。
              await repositories.coordination.offers.updateStatus({
                id: offer.id, expectedStatus: 'open', status: 'overtaken', response: acceptedResponse, now,
              });
              return { overtaken: true } as const;
            }
            // decision.kind === 'claim_granted'：CAS offer→accepted（AC#4：与 lease 同事务，任一失败整体回滚）
            const accepted = await repositories.coordination.offers.updateStatus({
              id: offer.id, expectedStatus: 'open', status: 'accepted', response: acceptedResponse, now,
            });
            if (!accepted) throw new TaskClaimConflict('TASK_CLAIM_OFFER_OVERTAKEN');
            // 以下 lease 落库 + events + task 更新镜像 acquire() 的 grant 块（AC#4 同事务）。
            // 抽取共享 helper 属后续重构——此处内联以保持既有 acquire 路径零改动、降低回归风险。
            if (latest?.status === 'active') {
              const expired = await repositories.coordination.claimLeases.update({
                id: latest.id, expectedStatus: 'active', status: 'expired',
                heartbeatAt: latest.heartbeatAt, expiresAt: latest.expiresAt,
              });
              if (!expired) throw new TaskClaimConflict('TASK_CLAIM_EXPIRE_CONFLICT');
            }
            const leaseId = input.ids.nextId();
            const lease: TaskClaimLeaseRecord = {
              id: leaseId, teamId: task.teamId, taskId: task.id,
              taskRevision: task.revision, taskAttempt: coordination.attempt, agentId: offer.agentId,
              leaseTokenHash, leaseFingerprint, fencingToken: decision.lease.fencingToken,
              status: 'active', acquiredAt: decision.lease.acquiredAt,
              heartbeatAt: decision.lease.renewedAt, expiresAt: decision.lease.expiresAt,
            };
            await repositories.coordination.claimLeases.create(lease);
            await appendTaskClaimEvent(repositories.management, {
              managementRunId: coordination.managementRunId, type: 'task-claimed',
              actorKind: 'agent', actorId: offer.agentId,
              idempotencyKey: `task-claimed:${lease.id}`,
              payload: { taskId: task.id, taskRevision: task.revision, agentId: offer.agentId,
                claimLeaseId: lease.id, attempt: coordination.attempt },
            }, now, input.ids);
            if (task.status === 'todo' || task.assigneeId !== offer.agentId) {
              const updated = await repositories.tasks.update({ taskId: task.id,
                changes: { ...(task.status === 'todo' ? { status: 'in_progress' as const } : {}),
                  assigneeId: offer.agentId, updatedAt: now } });
              if (!updated) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
            }
            if (task.status === 'todo') {
              await appendTaskClaimEvent(repositories.management, {
                managementRunId: coordination.managementRunId, type: 'task-state-changed',
                actorKind: 'agent', actorId: offer.agentId,
                idempotencyKey: `task-state-changed:${lease.id}`,
                payload: { taskId: task.id, taskRevision: task.revision, from: 'todo', to: 'in_progress' },
              }, now, input.ids);
            }
            const criteria = (await repositories.coordination.criteria.list(task.id))
              .filter((criterion) => criterion.introducedRevision <= task.revision &&
                (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision))
              .sort((left, right) => left.position - right.position)
              .map(({ taskId: _taskId, introducedRevision: _introducedRevision,
                retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion);
            const dependencyTaskIds = (await repositories.coordination.dependencies.list(task.id))
              .map((dependency) => dependency.dependencyTaskId);
            return { lease, task, coordination, criteria, dependencyTaskIds };
          });
          if ('overtaken' in result) return { kind: 'overtaken' };
          return {
            kind: 'claim_granted',
            lease: authority(result.lease, leaseToken),
            execution: {
              schemaVersion: 1, managementRunId: result.coordination.managementRunId,
              taskId: result.task.id, taskRevision: result.task.revision,
              taskAttempt: result.coordination.attempt, title: result.task.title,
              objective: result.task.description ?? result.task.title,
              acceptanceCriteria: result.criteria, dependencyTaskIds: result.dependencyTaskIds,
              ...(result.task.channelId ? { channelId: result.task.channelId } : {}),
            },
          };
        } catch (error) {
          if (error instanceof TaskClaimConflict) {
            if (error.message === 'TASK_CLAIM_OFFER_OVERTAKEN') return { kind: 'overtaken' };
            return {
              kind: 'not_accepted',
              reason: error.offerReason ?? 'offer_invalid',
              diagnosticCode: error.message,
            };
          }
          throw error;
        }
      });
    },
  };

  async function expireClaims(): Promise<readonly TaskClaimExpiredV1[]> {
    const now = input.clock.now();
    for (const [offerId, offer] of offers) if (now >= offer.offerExpiresAt) offers.delete(offerId);
    return input.repositories.taskCoordinationUnitOfWork.run(async (repositories) => {
      const expired: TaskClaimExpiredV1[] = [];
      for (const lease of await repositories.coordination.claimLeases.listActive()) {
        if (now < lease.expiresAt) continue;
        const updated = await repositories.coordination.claimLeases.update({
          id: lease.id, expectedStatus: 'active', status: 'expired',
          heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt,
        });
        if (!updated) continue;
        expired.push({ schemaVersion: 1, claimLeaseId: lease.id,
          taskId: lease.taskId, agentId: lease.agentId, expiredAt: now });
        const task = await repositories.tasks.getById(lease.taskId);
        const coordination = await repositories.coordination.coordinations.getByTaskId(lease.taskId);
        if (!task || !coordination || task.status !== 'in_progress'
          || task.revision !== lease.taskRevision
          || coordination.taskRevision !== lease.taskRevision
          || coordination.attempt !== lease.taskAttempt) continue;
        const reopened = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'todo', updatedAt: now } });
        if (!reopened) throw new TaskClaimConflict('TASK_CLAIM_TASK_UPDATE_CONFLICT');
        await appendTaskClaimEvent(repositories.management, {
          managementRunId: coordination.managementRunId,
          type: 'task-state-changed', actorKind: 'system', actorId: 'system',
          idempotencyKey: `task-claim-expired:${lease.id}:state`,
          payload: { taskId: task.id, taskRevision: task.revision,
            from: 'in_progress', to: 'todo' },
        }, now, input.ids);
        const invalidatedInvocationIds = (await repositories.management.invocations
          .listByRun(coordination.managementRunId))
          .filter((invocation) => invocation.intent.taskContext?.claimLeaseId === lease.id)
          .map((invocation) => invocation.id).sort();
        await appendTaskClaimEvent(repositories.management, {
          managementRunId: coordination.managementRunId,
          type: 'claim-invalidated', actorKind: 'system', actorId: 'system',
          idempotencyKey: `task-claim-expired:${lease.id}:invalidated`,
          payload: { taskId: task.id, previousTaskRevision: task.revision,
            claimLeaseId: lease.id, invalidatedInvocationIds,
            reasonCode: 'TASK_CLAIM_EXPIRED' },
        }, now, input.ids);
      }
      return expired;
    });
  }
}

async function collectAncestorAgentIds(
  taskId: string,
  repositories: ServerNextRepositories,
  now: number,
): Promise<string[]> {
  const result = new Set<string>();
  const visited = new Set<string>();
  let current = await repositories.taskCoordination.coordinations.getByTaskId(taskId);
  while (current?.parentTaskId && !visited.has(current.parentTaskId)) {
    visited.add(current.parentTaskId);
    const parent = await repositories.taskCoordination.coordinations.getByTaskId(current.parentTaskId);
    if (!parent) break;
    const claim = await repositories.taskCoordination.claimLeases.getLatest({
      taskId: parent.taskId, taskRevision: parent.taskRevision, taskAttempt: parent.attempt,
    });
    if (claim?.status === 'active' && claim.expiresAt > now) result.add(claim.agentId);
    const task = await repositories.tasks.getById(parent.taskId);
    if (task?.assigneeId) result.add(task.assigneeId);
    current = parent;
  }
  return [...result].sort();
}

function channelAllowsAgent(
  channel: Awaited<ReturnType<ServerNextRepositories['channels']['getById']>> | undefined | null,
  agentId: string,
): boolean {
  return !channel || channel.visibility === 'public' || channel.agentMemberIds.includes(agentId);
}

/**
 * #712 切片 C-1：计算 Offer 当前有效性（AC#1 fence + AC#5 失效前置判定）。
 * currentTaskRevision/manifestRevision 在事务外读取——轻微竞态可接受：UoW 内 lease grant
 * 会再次校验 task.revision===offer.taskRevision（STALE），manifest 变化由 CAS 状态机兜底。
 * task 或 active manifest 缺失 → 用 NaN 使 fence 比对失败（判 task_revision_changed / manifest_superseded）。
 */
async function computeOfferValidity(
  repositories: ServerNextRepositories,
  offer: TaskOfferRecord,
  now: number,
): Promise<OfferValidity> {
  const task = await repositories.tasks.getById(offer.taskId);
  const activeManifest = await repositories.agentExposure.manifests.getActiveByTeamAgent(offer.teamId, offer.agentId);
  const manifestRevision = activeManifest && (activeManifest.validUntil === null || activeManifest.validUntil > now)
    ? activeManifest.revision : Number.NaN;
  return evaluateOfferValidity({
    status: offer.status,
    offerExpiresAt: offer.offerExpiresAt,
    offerTaskRevision: offer.taskRevision,
    offerManifestRevision: offer.manifestRevision,
    now,
    currentTaskRevision: task?.revision ?? Number.NaN,
    currentManifestRevision: manifestRevision,
  });
}

function offerValidityCode(reason: OfferInvalidationReason): string {
  switch (reason) {
    case 'expired': return 'TASK_CLAIM_OFFER_EXPIRED';
    case 'task_revision_changed': return 'TASK_CLAIM_OFFER_TASK_REVISION_CHANGED';
    case 'manifest_superseded': return 'TASK_CLAIM_OFFER_MANIFEST_SUPERSEDED';
    case 'not_open': return 'TASK_CLAIM_OFFER_NOT_OPEN';
  }
}

function toDomainLease(lease: TaskClaimLeaseRecord): DomainTaskClaimLeaseRecord {
  return {
    taskId: lease.taskId, taskRevision: lease.taskRevision, taskAttempt: lease.taskAttempt,
    agentId: lease.agentId, leaseTokenHash: lease.leaseTokenHash,
    leaseFingerprint: lease.leaseFingerprint, fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt, renewedAt: lease.heartbeatAt, expiresAt: lease.expiresAt,
    ...(lease.releasedAt !== undefined ? { releasedAt: lease.releasedAt } : {}),
  };
}

function proof(authority: TaskClaimAuthorityV1) {
  return {
    taskId: authority.taskId, taskRevision: authority.taskRevision,
    taskAttempt: authority.taskAttempt, agentId: authority.agentId,
    presentedLeaseTokenHash: hash(authority.leaseToken), fencingToken: authority.fencingToken,
  };
}

function authority(lease: TaskClaimLeaseRecord, token: string): TaskClaimAuthorityV1 & {
  readonly acquiredAt: number; readonly expiresAt: number;
} {
  return {
    schemaVersion: 1, claimLeaseId: lease.id, taskId: lease.taskId,
    taskRevision: lease.taskRevision, taskAttempt: lease.taskAttempt,
    agentId: lease.agentId, leaseToken: token, fencingToken: lease.fencingToken,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
  };
}

function failure(
  errorCode: TaskClaimFailureAckV1['errorCode'],
  diagnosticCode: string,
  retryable: boolean,
): TaskClaimFailureAckV1 {
  return { schemaVersion: 1, ok: false, errorCode, diagnosticCode, retryable };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function code(value: string): string { return value.replaceAll('-', '_').toUpperCase(); }
function positiveDuration(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(errorCode);
  return value;
}
function consumeTaskOffers(offers: Map<string, StoredOffer>, taskId: string): void {
  for (const [offerId, offer] of offers) if (offer.taskId === taskId) offers.delete(offerId);
}

async function appendTaskClaimEvent(
  repositories: ServerNextRepositories['management'],
  event: Parameters<typeof appendValidatedManagementEventInTransaction>[1],
  now: number,
  ids: { nextId(): string },
): Promise<void> {
  await appendValidatedManagementEventInTransaction(repositories, event, now, ids, {
    payloadHash: hashManagementEventPayload({ type: event.type, payload: event.payload }),
    parseEvent: parseTaskCoordinationManagementEvent,
  });
}

async function withTaskLock<T>(
  taskId: string,
  tails: Map<string, Promise<void>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(taskId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(taskId) === tail) tails.delete(taskId);
  }
}

class TaskClaimConflict extends Error {
  constructor(
    message: string,
    /** #712：respondToOffer not_accepted 时携带 domain reason（claim_rejected 等），供 catch 保留区分。 */
    readonly offerReason?: 'offer_invalid' | 'agent_not_qualified' | 'claim_rejected',
  ) {
    super(message);
  }
}
