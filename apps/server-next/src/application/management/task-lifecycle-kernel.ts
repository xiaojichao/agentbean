import { canonicalizeTaskLifecycleCommand } from '../../../../../packages/contracts/src/index.js';
import type {
  TaskLifecycleCommandEnvelopeV1,
  TaskLifecycleCommandInputMapV1,
  TaskLifecycleCommandName,
  TaskLifecycleCommandOutputMapV1,
} from '../../../../../packages/contracts/src/index.js';
import {
  authorizeTaskLifecycleCommand,
  evaluateCancellationPreconditions,
  evaluateClosurePreconditions,
  evaluateRevisionFencing,
  validateTaskLifecycleTransition,
} from '../../../../../packages/domain/src/index.js';
import type { TaskRecord } from '../repositories.js';
import type {
  TaskCoordinationTransactionRepositories,
  TaskCoordinationUnitOfWork,
} from '../task-coordination-unit-of-work.js';
import {
  authorizeManagementWrite,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import { hashManagementCommandInput } from './management-event-validator.js';

type Tx = TaskCoordinationTransactionRepositories;
type AK = 'pi_driver' | 'human' | 'agent' | 'admin' | 'requester';

function conflict(code: string): never {
  throw Object.assign(new ManagementConflictError(`TASK_LIFECYCLE_${code}`), {
    code: `TASK_LIFECYCLE_${code}`,
  });
}

async function requireTask(repos: Tx, taskId: string): Promise<TaskRecord> {
  const t = await repos.tasks.getById(taskId);
  if (!t) conflict('TASK_NOT_FOUND');
  return t;
}

function assertRevision(actual: number, expected: number): void {
  const d = evaluateRevisionFencing(expected, actual);
  if (d.kind === 'rejected') conflict(d.reason ?? 'REVISION_FENCING_FAILED');
}

export interface TaskLifecycleKernelDependencies {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export function createTaskLifecycleKernel(deps: TaskLifecycleKernelDependencies) {
  const { unitOfWork, clock, ids } = deps;

  async function handle<K extends TaskLifecycleCommandName>(
    commandName: K,
    envelope: TaskLifecycleCommandEnvelopeV1,
    input: TaskLifecycleCommandInputMapV1[K],
    authority: LeaseAuthorityInput,
    authorityKind: AK,
    teamId: string,
    fn: (repos: Tx, now: number) => Promise<TaskLifecycleCommandOutputMapV1[K]>,
  ) {
    const a = authorizeTaskLifecycleCommand(commandName, authorityKind);
    if (a.kind === 'rejected') conflict(a.reason ?? 'UNAUTHORIZED');

    const ch = hashManagementCommandInput({
      command: `task-lifecycle:${commandName}`,
      input: canonicalizeTaskLifecycleCommand(commandName, envelope.commandSchemaVersion, input),
    });

    return unitOfWork.run(async (repos) => {
      const now = clock.now();
      if (authorityKind === 'pi_driver') {
        await authorizeManagementWrite(repos.management, authority, now);
      }

      const existing = await repos.lifecycle.receipts.getReceiptByIdempotencyKey(
        envelope.idempotencyKey,
      );
      if (existing) {
        if (existing.commandHash !== ch) conflict('COMMAND_IDEMPOTENCY_CONFLICT');
        return {
          result: JSON.parse(existing.resultJson ?? '{}') as TaskLifecycleCommandOutputMapV1[K],
          receipt: existing,
          disposition: 'applied' as const,
        };
      }

      const result = await fn(repos, now);
      const rid = ids.nextId();
      const rj = JSON.stringify(result);

      await repos.lifecycle.receipts.createReceipt({
        receiptId: rid,
        teamId,
        commandName: envelope.commandName,
        commandSchemaVersion: envelope.commandSchemaVersion,
        idempotencyKey: envelope.idempotencyKey,
        commandHash: ch,
        outcome: 'applied',
        committedRevisions: [],
        eventRefs: [],
        resultAvailable: true,
        resultJson: rj,
        commitTime: now,
        createdAt: now,
      });

      await repos.lifecycle.receipts.createTombstone({
        id: ids.nextId(),
        teamId,
        commandName: envelope.commandName,
        idempotencyKey: envelope.idempotencyKey,
        commandHash: ch,
        receiptId: rid,
        outcome: 'applied',
        resultAvailable: true,
        createdAt: now,
      });

      return { result, receipt: null as any, disposition: 'applied' as const };
    });
  }

  // Cascade helper
  async function cascadeTermination(
    repos: Tx,
    taskId: string,
    targetStatus: 'cancelled' | 'closed',
    now: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    const coord = await repos.coordination.coordinations.getByTaskId(taskId);
    if (coord?.nodeKind !== 'root') return ids;

    const allCoord = await repos.coordination.coordinations.listByManagementRun(
      coord.managementRunId,
    );
    for (const sc of allCoord) {
      if (sc.taskId === taskId || sc.nodeKind !== 'subtask') continue;
      const sub = await repos.tasks.getById(sc.taskId);
      if (
        !sub ||
        sub.status === 'done' ||
        sub.status === 'cancelled' ||
        sub.status === 'closed'
      )
        continue;

      await repos.tasks.update({
        taskId: sub.id,
        changes: { status: targetStatus, updatedAt: now },
      });
      ids.push(sub.id);

      // Release active claim
      const claim = await repos.coordination.claimLeases.getCurrent({
        taskId: sub.id,
        taskRevision: sub.revision,
        taskAttempt: sc.attempt,
      });
      if (claim?.status === 'active') {
        await repos.coordination.claimLeases.update({
          id: claim.id,
          expectedStatus: 'active',
          status: 'released',
          heartbeatAt: claim.heartbeatAt,
          expiresAt: claim.expiresAt,
          releasedAt: now,
        });
      }

      // Revoke active grants
      const grants = await repos.coordination.executionGrants.listActiveByTask(sub.id);
      for (const g of grants) {
        await repos.coordination.executionGrants.revoke({
          id: g.id,
          reason: 'authority-revoked',
          revokedAt: now,
          now,
        });
      }
    }
    return ids;
  }

  return {
    cancelTask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['cancel-task'],
      authority: LeaseAuthorityInput,
      authorityKind: AK,
      teamId: string,
    ) =>
      handle('cancel-task', envelope, input, authority, authorityKind, teamId, async (repos, now) => {
        const task = await requireTask(repos, input.taskId);
        assertRevision(task.revision, input.expectedTaskRevision);

        const cc = evaluateCancellationPreconditions(task.status);
        if (cc.kind === 'rejected') conflict(cc.reason ?? 'NOT_CANCELLABLE');

        const vt = validateTaskLifecycleTransition(task.status, 'cancelled');
        if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');

        const cancelledSubtaskIds = await cascadeTermination(repos, task.id, 'cancelled', now);

        const updated = await repos.tasks.update({
          taskId: task.id,
          changes: { status: 'cancelled', updatedAt: now },
        });
        if (!updated) conflict('TASK_NOT_FOUND');

        return {
          taskId: task.id,
          taskRevision: task.revision,
          status: 'cancelled' as const,
          cancelledSubtaskIds,
        };
      }),

    closeTask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['close-task'],
      authority: LeaseAuthorityInput,
      authorityKind: AK,
      teamId: string,
    ) =>
      handle('close-task', envelope, input, authority, authorityKind, teamId, async (repos, now) => {
        const task = await requireTask(repos, input.taskId);
        assertRevision(task.revision, input.expectedTaskRevision);

        const cc = evaluateClosurePreconditions(task.status);
        if (cc.kind === 'rejected') conflict(cc.reason ?? 'NOT_CLOSABLE');

        const vt = validateTaskLifecycleTransition(task.status, 'closed');
        if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');

        const closedSubtaskIds = await cascadeTermination(repos, task.id, 'closed', now);

        const updated = await repos.tasks.update({
          taskId: task.id,
          changes: { status: 'closed', updatedAt: now },
        });
        if (!updated) conflict('TASK_NOT_FOUND');

        return {
          taskId: task.id,
          taskRevision: task.revision,
          status: 'closed' as const,
          closedSubtaskIds,
        };
      }),
  } as const;
}
