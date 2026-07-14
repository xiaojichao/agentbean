import type { EvidenceKind, EvidenceRefDto } from '../../../../../packages/contracts/src/index.js';
import type { EvidenceSnapshotFact } from '../../../../../packages/domain/src/index.js';
import type { EvidenceSnapshotRecord } from '../task-coordination-repositories.js';
import type { TaskCoordinationTransactionRepositories } from '../task-coordination-unit-of-work.js';
import { hashManagementCommandInput } from './management-event-validator.js';

export interface EvidenceLocator {
  readonly kind: EvidenceKind;
  readonly id: string;
}

export interface EvidenceAuthority {
  readonly teamId: string;
  readonly channelId: string;
  readonly managementRunId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly invocationId: string;
}

interface ResolvedEvidence {
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly snapshotHash: string;
  readonly snapshotRevision?: number;
}

export function createEvidenceSnapshotService(input: {
  readonly ids: { nextId(): string };
}) {
  return {
    async capture(
      repositories: TaskCoordinationTransactionRepositories,
      authority: EvidenceAuthority,
      locators: readonly EvidenceLocator[],
      capturedAt: number,
    ): Promise<{ snapshots: readonly EvidenceSnapshotRecord[]; refs: readonly EvidenceRefDto[] }> {
      assertUniqueLocators(locators);
      const snapshots: EvidenceSnapshotRecord[] = [];
      for (const locator of locators) {
        const resolved = await resolveEvidence(repositories, authority, locator);
        const record: EvidenceSnapshotRecord = {
          id: input.ids.nextId(),
          teamId: authority.teamId,
          taskId: authority.taskId,
          taskRevision: authority.taskRevision,
          taskAttempt: authority.taskAttempt,
          invocationId: authority.invocationId,
          kind: locator.kind,
          sourceId: locator.id,
          snapshotHash: resolved.snapshotHash,
          ...(resolved.snapshotRevision !== undefined
            ? { snapshotRevision: resolved.snapshotRevision }
            : {}),
          snapshot: resolved.snapshot,
          capturedAt,
        };
        snapshots.push(await repositories.coordination.evidenceSnapshots.create(record));
      }
      return { snapshots, refs: snapshots.map(toEvidenceRef) };
    },

    async inspect(
      repositories: TaskCoordinationTransactionRepositories,
      authority: EvidenceAuthority,
      ref: EvidenceRefDto,
    ): Promise<EvidenceSnapshotFact> {
      try {
        const current = await resolveEvidence(repositories, authority, ref);
        return { ref, available: true, visible: true, currentSnapshotHash: current.snapshotHash };
      } catch (error) {
        const code = error instanceof Error ? error.message : 'EVIDENCE_SOURCE_UNAVAILABLE';
        return {
          ref,
          available: code !== 'EVIDENCE_SOURCE_NOT_FOUND',
          visible: code !== 'EVIDENCE_SOURCE_NOT_VISIBLE',
          currentSnapshotHash: '',
        };
      }
    },
  };
}

async function resolveEvidence(
  repositories: TaskCoordinationTransactionRepositories,
  authority: EvidenceAuthority,
  locator: EvidenceLocator,
): Promise<ResolvedEvidence> {
  const invocation = await requireCurrentSucceededInvocation(repositories, authority);
  const attempt = (await repositories.management.dispatchAttempts.list(invocation.id))
    .sort((left, right) => left.attemptNumber - right.attemptNumber).at(-1)!;
  const dispatch = await repositories.dispatches.getById(attempt.dispatchId);
  if (!dispatch) throw new Error('EVIDENCE_SOURCE_NOT_FOUND');
  if (dispatch.teamId !== authority.teamId || dispatch.channelId !== authority.channelId) {
    throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
  }

  let snapshot: Readonly<Record<string, unknown>>;
  let snapshotRevision: number | undefined;
  switch (locator.kind) {
    case 'message': {
      const message = await repositories.messages.getById(locator.id);
      if (!message) throw new Error('EVIDENCE_SOURCE_NOT_FOUND');
      if (message.teamId !== authority.teamId || message.channelId !== authority.channelId
        || message.senderKind !== 'agent' || message.senderId !== invocation.intent.targetAgentId
        || message.meta?.dispatchId !== dispatch.id) {
        throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
      }
      snapshotRevision = message.updatedAt ?? message.createdAt;
      snapshot = compact({ kind: 'message', id: message.id, teamId: message.teamId,
        channelId: message.channelId, threadId: message.threadId, senderKind: message.senderKind,
        senderId: message.senderId, body: message.body, dispatchId: dispatch.id,
        createdAt: message.createdAt, updatedAt: message.updatedAt });
      break;
    }
    case 'artifact': {
      const artifact = await repositories.artifacts.getForTeam({ teamId: authority.teamId,
        artifactId: locator.id });
      if (!artifact) throw new Error('EVIDENCE_SOURCE_NOT_FOUND');
      if (artifact.channelId !== authority.channelId || artifact.dispatchId !== dispatch.id) {
        throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
      }
      snapshot = compact({ kind: 'artifact', id: artifact.id, teamId: artifact.teamId,
        channelId: artifact.channelId, messageId: artifact.messageId, dispatchId: artifact.dispatchId,
        workspaceRunId: artifact.workspaceRunId, filename: artifact.filename,
        mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, relativePath: artifact.relativePath,
        pathKind: artifact.pathKind, sha256: artifact.sha256, createdAt: artifact.createdAt });
      break;
    }
    case 'workspace-run': {
      const workspaceRun = await repositories.workspaceRuns.getForTeam({ teamId: authority.teamId,
        runId: locator.id });
      if (!workspaceRun) throw new Error('EVIDENCE_SOURCE_NOT_FOUND');
      if (workspaceRun.channelId !== authority.channelId || workspaceRun.dispatchId !== dispatch.id
        || workspaceRun.agentId !== invocation.intent.targetAgentId) {
        throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
      }
      snapshotRevision = workspaceRun.updatedAt;
      snapshot = compact({ kind: 'workspace-run', id: workspaceRun.id, teamId: workspaceRun.teamId,
        channelId: workspaceRun.channelId, messageId: workspaceRun.messageId,
        sourceMessageId: workspaceRun.sourceMessageId, dispatchId: workspaceRun.dispatchId,
        agentId: workspaceRun.agentId, deviceId: workspaceRun.deviceId, status: workspaceRun.status,
        cwd: workspaceRun.cwd, command: workspaceRun.command, logExcerpt: workspaceRun.logExcerpt,
        exitCode: workspaceRun.exitCode, startedAt: workspaceRun.startedAt,
        completedAt: workspaceRun.completedAt, createdAt: workspaceRun.createdAt,
        updatedAt: workspaceRun.updatedAt, artifactIds: [...workspaceRun.artifactIds].sort() });
      break;
    }
    case 'invocation': {
      if (locator.id !== invocation.id) throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
      snapshotRevision = attempt.attemptNumber;
      snapshot = compact({ kind: 'invocation', id: invocation.id,
        managementRunId: invocation.managementRunId, intentHash: invocation.intentHash,
        teamId: invocation.intent.teamId, channelId: invocation.intent.channelId,
        targetAgentId: invocation.intent.targetAgentId, taskContext: invocation.intent.taskContext,
        status: 'succeeded', dispatchId: dispatch.id, attemptNumber: attempt.attemptNumber,
        createdAt: invocation.createdAt, completedAt: dispatch.completedAt });
      break;
    }
    case 'task': {
      const task = await repositories.tasks.getById(locator.id);
      if (!task) throw new Error('EVIDENCE_SOURCE_NOT_FOUND');
      if (task.id !== authority.taskId || task.teamId !== authority.teamId
        || task.channelId !== authority.channelId || task.revision !== authority.taskRevision) {
        throw new Error('EVIDENCE_SOURCE_NOT_VISIBLE');
      }
      snapshotRevision = task.revision;
      snapshot = compact({ kind: 'task', id: task.id, teamId: task.teamId,
        channelId: task.channelId, title: task.title, description: task.description,
        assigneeId: task.assigneeId, revision: task.revision });
      break;
    }
  }
  return { snapshot, snapshotHash: hashManagementCommandInput(snapshot),
    ...(snapshotRevision !== undefined ? { snapshotRevision } : {}) };
}

async function requireCurrentSucceededInvocation(
  repositories: TaskCoordinationTransactionRepositories,
  authority: EvidenceAuthority,
) {
  const invocation = await repositories.management.invocations.getById(authority.invocationId);
  const context = invocation?.intent.taskContext;
  if (!invocation || invocation.managementRunId !== authority.managementRunId
    || invocation.intent.teamId !== authority.teamId || invocation.intent.channelId !== authority.channelId
    || context?.taskId !== authority.taskId || context.taskRevision !== authority.taskRevision
    || context.taskAttempt !== authority.taskAttempt || context.claimLeaseId !== authority.claimLeaseId) {
    throw new Error('EVIDENCE_INVOCATION_AUTHORITY_MISMATCH');
  }
  const attempts = (await repositories.management.dispatchAttempts.list(invocation.id))
    .sort((left, right) => left.attemptNumber - right.attemptNumber);
  const current = attempts.at(-1);
  if (!current || current.status !== 'succeeded') throw new Error('EVIDENCE_INVOCATION_NOT_CURRENT_SUCCEEDED');
  const dispatch = await repositories.dispatches.getById(current.dispatchId);
  if (!dispatch || dispatch.status !== 'succeeded') throw new Error('EVIDENCE_INVOCATION_NOT_CURRENT_SUCCEEDED');
  return invocation;
}

function compact(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function assertUniqueLocators(locators: readonly EvidenceLocator[]): void {
  if (locators.length === 0) throw new Error('EVIDENCE_LOCATORS_REQUIRED');
  const keys = locators.map((locator) => `${locator.kind}:${locator.id}`);
  if (keys.some((key) => key.endsWith(':')) || new Set(keys).size !== keys.length) {
    throw new Error('EVIDENCE_LOCATORS_INVALID');
  }
}

function toEvidenceRef(snapshot: EvidenceSnapshotRecord): EvidenceRefDto {
  return { kind: snapshot.kind, id: snapshot.sourceId, snapshotHash: snapshot.snapshotHash,
    ...(snapshot.snapshotRevision !== undefined ? { snapshotRevision: snapshot.snapshotRevision } : {}),
    capturedAt: snapshot.capturedAt };
}
