import type {
  EvidenceRefDto,
  ManagementEventPayloadMapV1,
  SubtaskAcceptanceV1,
} from '../../../../../packages/contracts/src/index.js';
import { evaluateSubtaskAcceptance } from '../../../../../packages/domain/src/index.js';
import type { TaskCoordinationTransactionRepositories, TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import {
  appendManagementEventInTransaction,
  appendValidatedManagementEventInTransaction,
  authorizeManagementWrite,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import { hashManagementCommandInput, parseTaskCoordinationManagementEvent } from './management-event-validator.js';
import { createEvidenceSnapshotService, type EvidenceAuthority } from './evidence-snapshot-service.js';

export function createSubtaskAcceptanceService(input: {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}) {
  const snapshots = createEvidenceSnapshotService({ ids: input.ids });
  return {
    async decide(command: {
      readonly authority: LeaseAuthorityInput;
      readonly idempotencyKey: string;
      readonly acceptance: SubtaskAcceptanceV1;
    }) {
      return input.unitOfWork.run(async (repositories) => {
        const now = input.clock.now();
        const run = await authorize(repositories, command.authority, now);
        const requested = command.acceptance;
        if (requested.decidedBy !== 'manager') throw new Error('TASK_ACCEPTANCE_ACTOR_MISMATCH');
        const task = await repositories.tasks.getById(requested.taskId);
        if (!task || task.teamId !== run.teamId || task.channelId !== run.channelId) {
          throw new Error('TASK_NOT_FOUND');
        }
        if (task.revision !== requested.expectedTaskRevision) throw new Error('TASK_ACCEPTANCE_REVISION_CONFLICT');
        const coordination = await repositories.coordination.coordinations.getByTaskId(task.id);
        if (!coordination || coordination.nodeKind !== 'subtask'
          || coordination.managementRunId !== run.id
          || coordination.taskRevision !== task.revision
          || coordination.attempt !== requested.taskAttempt) {
          throw new Error('TASK_ACCEPTANCE_AUTHORITY_MISMATCH');
        }
        const delivery = await repositories.coordination.deliveries.getById(requested.deliveryId);
        if (!delivery || delivery.taskId !== task.id || delivery.taskRevision !== task.revision
          || delivery.taskAttempt !== coordination.attempt
          || delivery.claimLeaseId !== requested.claimLeaseId) {
          throw new Error('TASK_DELIVERY_AUTHORITY_MISMATCH');
        }
        const canonicalAcceptance = canonicalizeAcceptance(requested, delivery.evidenceRefs);
        const commandHash = hashManagementCommandInput({ command: 'accept-subtask',
          acceptance: canonicalAcceptance });
        const existing = await repositories.coordination.acceptances.getCanonicalByDelivery(delivery.id);
        if (existing) {
          const event = (await repositories.management.events.list(run.id))
            .find((candidate) => candidate.event.idempotencyKey === command.idempotencyKey);
          if (!event || event.payloadHash !== commandHash) {
            throw new Error('TASK_ACCEPTANCE_ALREADY_DECIDED');
          }
          return { taskId: task.id, taskRevision: task.revision,
            status: task.status === 'done' ? 'done' as const : 'in_review' as const,
            disposition: 'existing' as const };
        }
        if (task.status !== 'in_review') throw new Error('TASK_ACCEPTANCE_STATE_CONFLICT');
        const claim = await repositories.coordination.claimLeases.getById(requested.claimLeaseId);
        const currentClaim = await repositories.coordination.claimLeases.getCurrent({ taskId: task.id,
          taskRevision: task.revision, taskAttempt: coordination.attempt });
        if (!claim || claim.id !== currentClaim?.id || claim.status !== 'active'
          || claim.expiresAt <= now) throw new Error('TASK_CLAIM_NOT_ACTIVE');

        if (canonicalAcceptance.decision !== 'rejected') {
          const criteria = (await repositories.coordination.criteria.list(task.id))
            .filter((criterion) => criterion.introducedRevision <= task.revision
              && (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision));
          const authority: EvidenceAuthority = { teamId: run.teamId, channelId: run.channelId,
            managementRunId: run.id, taskId: task.id, taskRevision: task.revision,
            taskAttempt: coordination.attempt, claimLeaseId: claim.id,
            invocationId: delivery.invocationId };
          const uniqueRefs = uniqueEvidenceRefs(canonicalAcceptance.criteriaResults
            .flatMap((result) => result.evidenceRefs));
          const facts = await Promise.all(uniqueRefs.map((ref) => snapshots.inspect(repositories,
            authority, ref)));
          const conflictingEvidence = hasConflictingEvidence(delivery.evidenceRefs)
            || (canonicalAcceptance.decision === 'needs_human'
              && canonicalAcceptance.reason.toUpperCase().includes('CONFLICT'));
          const highRisk = canonicalAcceptance.decision === 'needs_human' && !conflictingEvidence;
          const policy = evaluateSubtaskAcceptance({ criteria,
            criteriaResults: canonicalAcceptance.criteriaResults, evidenceSnapshots: facts,
            highRisk, conflictingEvidence });
          if (policy.kind === 'rejected') {
            throw new Error(`TASK_ACCEPTANCE_POLICY_${policy.reason.toUpperCase().replaceAll('-', '_')}`);
          }
          if (policy.kind !== canonicalAcceptance.decision) {
            throw new Error(policy.kind === 'needs_human'
              ? 'TASK_ACCEPTANCE_REQUIRES_HUMAN'
              : 'TASK_ACCEPTANCE_DECISION_MISMATCH');
          }
        }

        await repositories.coordination.acceptances.create({ ...canonicalAcceptance,
          id: input.ids.nextId(), teamId: run.teamId, decisionVersion: 1, canonical: true });
        const status = canonicalAcceptance.decision === 'accepted' ? 'done' as const : 'in_review' as const;
        if (status === 'done') {
          const updated = await repositories.tasks.update({ taskId: task.id,
            changes: { status, updatedAt: now } });
          if (!updated) throw new Error('TASK_NOT_FOUND');
        }
        await appendTaskEvent(repositories, { managementRunId: run.id,
          type: 'task-acceptance-decided', actorKind: 'manager',
          actorId: command.authority.workerId, idempotencyKey: command.idempotencyKey,
          payload: { taskId: task.id, acceptance: canonicalAcceptance } }, now, input.ids, commandHash);
        if (status === 'done') {
          await appendTaskEvent(repositories, { managementRunId: run.id,
            type: 'task-state-changed', actorKind: 'manager', actorId: command.authority.workerId,
            idempotencyKey: `${command.idempotencyKey}:state`, payload: { taskId: task.id,
              taskRevision: task.revision, from: 'in_review', to: 'done' } },
          now, input.ids, commandHash);
        }
        if (canonicalAcceptance.decision === 'needs_human') {
          await appendManagementEventInTransaction(repositories.management, {
            managementRunId: run.id, type: 'waiting-for-user', actorKind: 'manager',
            actorId: command.authority.workerId, idempotencyKey: `${command.idempotencyKey}:waiting`,
            payload: { reasonCode: canonicalAcceptance.reason },
          }, now, input.ids);
          await repositories.management.runs.update({ ...run, status: 'waiting_for_user', updatedAt: now });
        }
        return { taskId: task.id, taskRevision: task.revision, status,
          disposition: 'updated' as const };
      });
    },
  };
}

function canonicalizeAcceptance(requested: SubtaskAcceptanceV1,
  deliveryRefs: readonly EvidenceRefDto[]): SubtaskAcceptanceV1 {
  const bySource = new Map<string, EvidenceRefDto>();
  for (const ref of deliveryRefs) {
    const key = `${ref.kind}:${ref.id}`;
    if (bySource.has(key)) throw new Error('TASK_DELIVERY_EVIDENCE_CONFLICT');
    bySource.set(key, ref);
  }
  return { ...requested, criteriaResults: requested.criteriaResults.map((result) => ({
    ...result,
    evidenceRefs: result.evidenceRefs.map((clientRef) => {
      const canonical = bySource.get(`${clientRef.kind}:${clientRef.id}`);
      if (!canonical) throw new Error('TASK_ACCEPTANCE_EVIDENCE_NOT_DELIVERED');
      if (clientRef.snapshotHash !== canonical.snapshotHash
        || clientRef.snapshotRevision !== canonical.snapshotRevision
        || clientRef.capturedAt !== canonical.capturedAt) {
        throw new Error('TASK_ACCEPTANCE_CLIENT_DIGEST_MISMATCH');
      }
      return canonical;
    }),
  })) };
}

function uniqueEvidenceRefs(refs: readonly EvidenceRefDto[]): readonly EvidenceRefDto[] {
  const unique = new Map<string, EvidenceRefDto>();
  for (const ref of refs) unique.set(`${ref.kind}:${ref.id}:${ref.snapshotHash}`, ref);
  return [...unique.values()];
}

function hasConflictingEvidence(refs: readonly EvidenceRefDto[]): boolean {
  const hashes = new Map<string, string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    const previous = hashes.get(key);
    if (previous && previous !== ref.snapshotHash) return true;
    hashes.set(key, ref.snapshotHash);
  }
  return false;
}

async function authorize(repositories: TaskCoordinationTransactionRepositories,
  authority: LeaseAuthorityInput, now: number) {
  await authorizeManagementWrite(repositories.management, authority, now);
  const run = await repositories.management.runs.getById(authority.managementRunId);
  if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND');
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new Error('MANAGEMENT_RUN_TERMINAL');
  }
  return run;
}

async function appendTaskEvent<T extends 'task-acceptance-decided' | 'task-state-changed'>(
  repositories: TaskCoordinationTransactionRepositories,
  event: { managementRunId: string; type: T; actorKind: 'manager'; actorId: string;
    idempotencyKey: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
  commandHash: string,
) {
  return appendValidatedManagementEventInTransaction(repositories.management, event, now, ids, {
    payloadHash: commandHash,
    parseEvent: parseTaskCoordinationManagementEvent,
  });
}
