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
} from '../../../../../packages/contracts/src/index.js';
import {
  evaluateTaskClaimAcquire,
  evaluateTaskClaimRelease,
  evaluateTaskClaimRenew,
  type TaskClaimLeaseRecord as DomainTaskClaimLeaseRecord,
} from '../../../../../packages/domain/src/index.js';
import type { ServerNextRepositories } from '../repositories.js';
import type { TaskClaimLeaseRecord } from '../task-coordination-repositories.js';
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

export interface TaskClaimBroker {
  resolveCandidates(taskId: string): Promise<TaskClaimCandidateResolution>;
  prepareOffers(taskId: string): Promise<readonly TaskClaimOfferV1[]>;
  acquire(input: TaskClaimAcquireV1): Promise<TaskClaimAcquireAckV1>;
  renew(input: TaskClaimRenewV1): Promise<TaskClaimRenewAckV1>;
  release(input: TaskClaimReleaseV1): Promise<TaskClaimReleaseAckV1>;
  expireClaims(): Promise<readonly TaskClaimExpiredV1[]>;
  disconnectDevice(deviceId: string): void;
  reconnectDevice(deviceId: string): void;
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
      const explicitCapabilities = new Set((agent.skills ?? []).map((skill) => skill.name));
      const missingCapabilities = coordination.requiredCapabilities
        .filter((capability) => !explicitCapabilities.has(capability));
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
        if (updated) expired.push({ schemaVersion: 1, claimLeaseId: lease.id,
          taskId: lease.taskId, agentId: lease.agentId, expiredAt: now });
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

class TaskClaimConflict extends Error {}
