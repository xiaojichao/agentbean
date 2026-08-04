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
  evaluateRejectRevision,
  evaluateRevisionFencing,
  evaluateRootCascadeCloseout,
  evaluateRootHumanReviewAuthority,
  evaluateSubtaskAcceptance,
  evaluateSubtaskHumanAcceptanceAuthority,
  resolveOutputSlots,
  validateTaskLifecycleTransition,
  type SubtaskCascadeState,
} from '../../../../../packages/domain/src/index.js';
import type { TaskRecord } from '../repositories.js';
import type {
  TaskCoordinationTransactionRepositories,
  TaskCoordinationUnitOfWork,
} from '../task-coordination-unit-of-work.js';
import {
  appendValidatedManagementEventInTransaction,
  authorizeManagementWrite,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import {
  hashManagementCommandInput,
  parseTaskCoordinationManagementEvent,
} from './management-event-validator.js';
import {
  activeCriteria,
  appendTaskEvent,
  inspectRootDeliveryReadiness,
  invalidateCapturedClaim,
  requireCoordination,
  requiresHumanIntervention,
} from './task-coordination-kernel.js';

type Tx = TaskCoordinationTransactionRepositories;
type AK = 'pi_driver' | 'human' | 'agent' | 'admin' | 'requester';

/** #996 receipt resultJson 包装：兼容旧版（直接存 result）。 */
const RECEIPT_RESULT_VERSION = 1 as const;

function packReceiptResultJson(result: unknown, reason?: string): string {
  return JSON.stringify({
    v: RECEIPT_RESULT_VERSION,
    result,
    ...(reason !== undefined ? { reason } : {}),
  });
}

/** 从 receipt.resultJson 解析业务结果与可选 reason（#996 审计查询）。 */
export function unpackLifecycleReceiptResultJson<T>(
  resultJson: string | null,
): { result: T; reason?: string } {
  if (!resultJson) return { result: {} as T };
  const parsed: unknown = JSON.parse(resultJson);
  if (
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as { v?: unknown }).v === RECEIPT_RESULT_VERSION
    && 'result' in (parsed as object)
  ) {
    const wrap = parsed as { result: T; reason?: unknown };
    return {
      result: wrap.result,
      ...(typeof wrap.reason === 'string' ? { reason: wrap.reason } : {}),
    };
  }
  return { result: parsed as T };
}

function inputReason(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const reason = (input as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

function conflict(code: string): never {
  // normalize 为大写 SNAKE_CASE，使 domain policy 的小写 kebab reason 与显式 code 一致
  const normalized = code.toUpperCase().replace(/-/g, '_');
  throw Object.assign(new ManagementConflictError(`TASK_LIFECYCLE_${normalized}`), {
    code: `TASK_LIFECYCLE_${normalized}`,
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

export interface TaskLifecycleAppliedEvent {
  readonly commandName: TaskLifecycleCommandName;
  readonly teamId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly status?: string;
  readonly deliveryMessageId?: string;
  readonly reason?: string;
  readonly channelId?: string | null;
  readonly creatorId?: string | null;
  readonly assigneeId?: string | null;
  readonly occurredAt: number;
  readonly eventId: string;
}

export interface TaskLifecycleKernelDependencies {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  /** #1014 post-commit：权威 lifecycle 成功后自动投影 System activity。 */
  readonly onApplied?: (event: TaskLifecycleAppliedEvent) => Promise<void> | void;
}

export function createTaskLifecycleKernel(deps: TaskLifecycleKernelDependencies) {
  const { unitOfWork, clock, ids, onApplied } = deps;

  /**
   * 通用 command 执行骨架：authority 检查 → canonical hash → UoW 事务 →
   * receipt/tombstone 幂等查重 → 业务逻辑 → receipt/tombstone 持久化。
   * #996：tombstone 可读；reason 写入 receipt 包装，便于审计查询。
   */
  async function handle<K extends TaskLifecycleCommandName>(
    commandName: K,
    envelope: TaskLifecycleCommandEnvelopeV1,
    input: TaskLifecycleCommandInputMapV1[K],
    authority: LeaseAuthorityInput,
    authorityKind: AK,
    teamId: string,
    fn: (repos: Tx, now: number, ctx: { ch: string; actorKind: 'manager' | 'human' | 'system'; actorId: string }) => Promise<TaskLifecycleCommandOutputMapV1[K]>,
  ) {
    const a = authorizeTaskLifecycleCommand(commandName, authorityKind);
    if (a.kind === 'rejected') conflict(a.reason ?? 'UNAUTHORIZED');

    const ch = hashManagementCommandInput({
      command: `task-lifecycle:${commandName}`,
      input: canonicalizeTaskLifecycleCommand(commandName, envelope.commandSchemaVersion, input),
    });
    const reason = inputReason(input);

    const outcome = await unitOfWork.run(async (repos) => {
      const now = clock.now();
      if (authorityKind === 'pi_driver') {
        await authorizeManagementWrite(repos.management, authority, now);
      }

      // receipt 幂等查重（优先完整结果）
      const existing = await repos.lifecycle.receipts.getReceiptByIdempotencyKey(
        envelope.idempotencyKey,
      );
      if (existing) {
        if (existing.commandHash !== ch) conflict('COMMAND_IDEMPOTENCY_CONFLICT');
        const unpacked = unpackLifecycleReceiptResultJson<TaskLifecycleCommandOutputMapV1[K]>(
          existing.resultJson,
        );
        return {
          result: unpacked.result,
          receipt: existing,
          disposition: 'replayed' as const,
          ...(unpacked.reason !== undefined ? { reason: unpacked.reason } : {}),
          freshlyApplied: false as const,
          now,
          taskSnapshot: null as TaskRecord | null,
        };
      }

      // #996：receipt 被治理压缩后仍可读 tombstone，禁止 silent re-apply
      const tombstone = await repos.lifecycle.receipts.getTombstoneByIdempotencyKey(
        envelope.idempotencyKey,
      );
      if (tombstone) {
        if (tombstone.commandHash !== ch) conflict('COMMAND_IDEMPOTENCY_CONFLICT');
        const viaReceipt = await repos.lifecycle.receipts.getReceiptById(tombstone.receiptId);
        if (viaReceipt?.resultAvailable && viaReceipt.resultJson) {
          const unpacked = unpackLifecycleReceiptResultJson<TaskLifecycleCommandOutputMapV1[K]>(
            viaReceipt.resultJson,
          );
          return {
            result: unpacked.result,
            receipt: viaReceipt,
            disposition: 'replayed' as const,
            ...(unpacked.reason !== undefined ? { reason: unpacked.reason } : {}),
            freshlyApplied: false as const,
            now,
            taskSnapshot: null as TaskRecord | null,
          };
        }
        // tombstone 仍在、结果已压缩：返回空结果壳，outcome 来自 tombstone，绝不重跑业务
        return {
          result: {} as TaskLifecycleCommandOutputMapV1[K],
          receipt: null as never,
          disposition: 'replayed' as const,
          tombstoneOutcome: tombstone.outcome,
          freshlyApplied: false as const,
          now,
          taskSnapshot: null as TaskRecord | null,
        };
      }

      const actorKind: 'manager' | 'human' | 'system' = authorityKind === 'human' ? 'human'
        : authorityKind === 'pi_driver' ? 'manager' : 'system';
      // #1061 AC3/AC4：human authority 的 actorId 必须是真实用户 id——usecase 层把 userId
      // 放进 workerId 注入(kernel 的 human 入口约定);显式 userId 字段优先,workerId 兜底,
      // 绝不让预绑定 authority 校验退化为匿名 'human'。
      const actorId = authorityKind === 'pi_driver' ? authority.workerId
        : authorityKind === 'human'
          ? (authority as { userId?: string }).userId ?? authority.workerId
          : 'system';

      const result = await fn(repos, now, { ch, actorKind, actorId });
      const rid = ids.nextId();
      const rj = packReceiptResultJson(result, reason);

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

      const taskId = (result as { taskId?: string }).taskId
        ?? (input as { taskId?: string }).taskId
        ?? '';
      const taskSnapshot = taskId ? await repos.tasks.getById(taskId) : null;

      return {
        result,
        receipt: null as never,
        disposition: 'applied' as const,
        ...(reason !== undefined ? { reason } : {}),
        freshlyApplied: true as const,
        now,
        taskSnapshot,
      };
    });

    // post-commit 自动投影（不回滚权威事实）
    if (outcome.freshlyApplied && onApplied) {
      const r = outcome.result as Record<string, unknown>;
      const taskId = String(r.taskId ?? (input as { taskId?: string }).taskId ?? '');
      const taskRevision = Number(r.taskRevision ?? (input as { expectedTaskRevision?: number }).expectedTaskRevision ?? 0);
      const status = typeof r.status === 'string' ? r.status : undefined;
      const deliveryMessageId = typeof r.deliveryMessageId === 'string' ? r.deliveryMessageId : undefined;
      const reason = typeof (input as { reason?: string }).reason === 'string'
        ? (input as { reason?: string }).reason
        : undefined;
      try {
        await onApplied({
          commandName,
          teamId,
          taskId,
          taskRevision,
          status,
          deliveryMessageId,
          reason,
          channelId: outcome.taskSnapshot?.channelId ?? null,
          creatorId: outcome.taskSnapshot?.creatorId ?? null,
          assigneeId: outcome.taskSnapshot?.assigneeId ?? null,
          occurredAt: outcome.now,
          eventId: `lifecycle:${commandName}:${taskId}:${taskRevision}:${envelope.idempotencyKey}`,
        });
      } catch {
        /* projection failure must not surface as lifecycle failure */
      }
    }

    return outcome;
  }

  /** 取 task 的 coordination 记录（不带 run 校验，lifecycle handler 自己管理 run 关联）。 */
  async function requireCoordForTask(repos: Tx, taskId: string) {
    const c = await requireCoordination(repos, taskId);
    if (!c) conflict('COORDINATION_NOT_FOUND');
    return c;
  }

  // -------------------------------------------------------------------
  // Root cascade helper（#996：统一走 evaluateRootCascadeCloseout）
  // -------------------------------------------------------------------
  async function cascadeTermination(
    repos: Tx,
    taskId: string,
    targetStatus: 'cancelled' | 'closed',
    now: number,
  ): Promise<string[]> {
    const coord = await repos.coordination.coordinations.getByTaskId(taskId);
    if (coord?.nodeKind !== 'root') return [];

    const root = await requireTask(repos, taskId);
    const allCoord = await repos.coordination.coordinations.listByManagementRun(coord.managementRunId);
    const subs: SubtaskCascadeState[] = [];

    for (const sc of allCoord) {
      if (sc.taskId === taskId || sc.nodeKind !== 'subtask') continue;
      const sub = await repos.tasks.getById(sc.taskId);
      if (!sub) continue;
      const claim = await repos.coordination.claimLeases.getCurrent({
        taskId: sub.id, taskRevision: sub.revision, taskAttempt: sc.attempt,
      });
      const grants = await repos.coordination.executionGrants.listActiveByTask(sub.id);
      const activeClaim = claim?.status === 'active' ? claim : null;
      const activeGrant = grants[0];
      subs.push({
        taskId: sub.id,
        status: sub.status,
        hasActiveClaim: Boolean(activeClaim),
        hasActiveGrant: grants.length > 0,
        ...(activeClaim ? { claimLeaseId: activeClaim.id } : {}),
        ...(activeGrant ? { grantId: activeGrant.id } : {}),
      });
    }

    // 权威决策：哪些子任务应 cascade、哪些 claim/grant 应吊销
    const decision = evaluateRootCascadeCloseout(root.status, targetStatus, subs);
    if (decision.kind === 'rejected') return [];

    for (const subTaskId of decision.affectedSubtaskIds) {
      await repos.tasks.update({
        taskId: subTaskId,
        changes: { status: targetStatus, updatedAt: now },
      });
      // domain 的 grantId 只建模单 grant；对受影响子任务吊销全部 active grants，避免遗漏
      for (const g of await repos.coordination.executionGrants.listActiveByTask(subTaskId)) {
        await repos.coordination.executionGrants.revoke({
          id: g.id, reason: 'authority-revoked', revokedAt: now, now,
        });
      }
    }
    for (const leaseId of decision.claimLeaseIdsToRevoke) {
      const claim = await repos.coordination.claimLeases.getById(leaseId);
      if (claim?.status === 'active') {
        await repos.coordination.claimLeases.update({
          id: claim.id, expectedStatus: 'active', status: 'released',
          heartbeatAt: claim.heartbeatAt, expiresAt: claim.expiresAt, releasedAt: now,
        });
      }
    }
    return [...decision.affectedSubtaskIds];
  }

  // ===================================================================
  // 10 个 command handler
  // ===================================================================

  return {
    // ---- 1. transition-task-in-progress: root todo → in_progress (pi_driver) ----
    transitionTaskInProgress: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['transition-task-in-progress'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('transition-task-in-progress', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
      const vt = validateTaskLifecycleTransition(task.status, 'in_progress');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');
      if (task.status !== 'todo') conflict('TASK_NOT_TODO');

      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'in_progress', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: { taskId: task.id, taskRevision: task.revision, from: 'todo', to: 'in_progress' },
      }, now, ids, ch);
      return { taskId: task.id, taskRevision: task.revision, status: updated.status };
    }),

    // ---- 2. submit-root-delivery: root in_progress → in_review (pi_driver) ----
    submitRootDelivery: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['submit-root-delivery'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('submit-root-delivery', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
      const run = await repos.management.runs.getById(coord.managementRunId);
      if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') conflict('MANAGEMENT_RUN_TERMINAL');

      // readiness：所有 leaf subtask accepted，收集 contributing invocation ids
      const readiness = await inspectRootDeliveryReadiness(repos, run);
      const inputIds = [...input.contributingInvocationIds].sort();
      if (inputIds.length !== readiness.contributingInvocationIds.length
        || inputIds.some((id, i) => id !== readiness.contributingInvocationIds[i])) {
        conflict('ROOT_DELIVERY_CONTRIBUTIONS_INCOMPLETE');
      }
      if (task.status !== 'in_progress') conflict('TASK_NOT_IN_PROGRESS');

      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'in_review', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      await appendValidatedManagementEventInTransaction(repos.management, {
        managementRunId: run.id, type: 'root-delivery-submitted', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: { messageId: input.messageId, contributingInvocationIds: readiness.contributingInvocationIds },
      }, now, ids, { payloadHash: ch, parseEvent: parseTaskCoordinationManagementEvent });
      await repos.management.runs.update({ ...run, status: 'in_review', updatedAt: now });
      return { taskId: task.id, taskRevision: task.revision, status: 'in_review' as const, deliveryMessageId: input.messageId };
    }),

    // ---- 3. accept-root-delivery: root in_review → done (human) ----
    acceptRootDelivery: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['accept-root-delivery'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('accept-root-delivery', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
      // #1061 AC4：root delivery 验收只接受当前 Human review authority。
      // 预绑定顺序：coordination 显式预绑定 > run.initiatedByUserId(requester,旧链路 device-hosted
      // PI 创建的 coordination 无预绑定字段,回退到任务发起者);两者皆空才 fail closed。
      const run = await repos.management.runs.getById(coord.managementRunId);
      const prebound = coord.humanAcceptanceAuthorityIds ?? [];
      const authorityIds = prebound.length > 0
        ? prebound
        : (run?.initiatedByUserId ? [run.initiatedByUserId] : []);
      if (evaluateRootHumanReviewAuthority({
        actorId,
        preboundAuthorityIds: authorityIds,
      }).kind === 'rejected') {
        conflict('TASK_ACCEPTANCE_AUTHORITY_MISMATCH');
      }
      const vt = validateTaskLifecycleTransition(task.status, 'done');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');
      if (task.status !== 'in_review') conflict('TASK_NOT_IN_REVIEW');

      if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
      if (run.status !== 'in_review') conflict('MANAGEMENT_RUN_NOT_IN_REVIEW');

      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'done', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: { taskId: task.id, taskRevision: task.revision, from: 'in_review', to: 'done' },
      }, now, ids, ch);
      await repos.management.runs.update({ ...run, status: 'completed', updatedAt: now, completedAt: now });
      return { taskId: task.id, taskRevision: task.revision, status: 'done' as const };
    }),

    // ---- 4. reject-root-delivery: root in_review → in_progress (new revision) (human) ----
    rejectRootDelivery: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['reject-root-delivery'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('reject-root-delivery', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
      const vt = validateTaskLifecycleTransition(task.status, 'in_progress');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');
      if (task.status !== 'in_review') conflict('TASK_NOT_IN_REVIEW');

      const run = await repos.management.runs.getById(coord.managementRunId);
      if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
      if (run.status !== 'in_review') conflict('MANAGEMENT_RUN_NOT_IN_REVIEW');

      const revDecision = evaluateRejectRevision(task.revision);
      if (revDecision.kind === 'rejected') conflict('REVISION_OVERFLOW');
      const nextRevision = revDecision.nextRevision!;

      const updatedTask = await repos.tasks.updateAtRevision({
        taskId: task.id, expectedRevision: task.revision, nextRevision,
        reasonCode: 'HUMAN_REJECTED_ROOT_DELIVERY',
        changes: { status: 'in_progress', updatedAt: now },
      });
      if (!updatedTask) conflict('TASK_REVISION_CONFLICT');
      const updatedCoord = await repos.coordination.coordinations.update({
        expectedTaskRevision: task.revision,
        record: { ...coord, taskRevision: nextRevision, attempt: 1, updatedAt: now },
      });
      if (!updatedCoord) conflict('TASK_COORDINATION_REVISION_CONFLICT');

      const criteria = activeCriteria(await repos.coordination.criteria.list(task.id), task.revision);
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-revised', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: {
          taskId: task.id, previousRevision: task.revision, taskRevision: nextRevision,
          criterionIds: criteria.map((c) => c.id), reasonCode: 'HUMAN_REJECTED_ROOT_DELIVERY',
          reason: input.reason,
        },
      }, now, ids, ch);
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
        actorId, idempotencyKey: `${envelope.idempotencyKey}:state`,
        payload: {
          taskId: task.id, taskRevision: nextRevision, from: 'in_review', to: 'in_progress',
          reason: input.reason,
        },
      }, now, ids, ch);
      await repos.management.runs.update({ ...run, status: 'running', updatedAt: now });
      return { taskId: task.id, taskRevision: nextRevision, status: 'in_progress' as const };
    }),

    // ---- 5. transition-subtask-in-review: subtask in_progress → in_review (agent) ----
    transitionSubtaskInReview: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['transition-subtask-in-review'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('transition-subtask-in-review', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'subtask') conflict('TASK_SUBTASK_REQUIRED');
      const vt = validateTaskLifecycleTransition(task.status, 'in_review');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');
      if (task.status !== 'in_progress') conflict('TASK_NOT_IN_PROGRESS');

      // 验证 claim active 且匹配
      const claim = await repos.coordination.claimLeases.getById(input.claimLeaseId);
      if (!claim || claim.taskId !== task.id || claim.taskRevision !== task.revision
        || claim.taskAttempt !== coord.attempt || claim.status !== 'active') {
        conflict('TASK_CLAIM_NOT_ACTIVE');
      }

      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'in_review', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
        actorId, idempotencyKey: input.idempotencyKey,
        payload: { taskId: task.id, taskRevision: task.revision, from: 'in_progress', to: 'in_review' },
      }, now, ids, ch);
      return { taskId: task.id, taskRevision: task.revision, status: 'in_review' as const };
    }),

    // ---- 6. accept-subtask: subtask in_review → done (pi_driver / human) ----
    acceptSubtask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['accept-subtask'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('accept-subtask', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const acceptance = input.acceptance;
      if (authorityKind === 'pi_driver' && acceptance.decidedBy !== 'manager') conflict('ACCEPTANCE_ACTOR_MISMATCH');
      if (authorityKind === 'human' && acceptance.decidedBy !== 'human') conflict('ACCEPTANCE_ACTOR_MISMATCH');
      const task = await requireTask(repos, acceptance.taskId);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'subtask') conflict('TASK_SUBTASK_REQUIRED');
      // #1061 AC3：主观/高风险验收必须由创建时预绑定的 Subtask human acceptance authority 执行。
      // 未绑定(空数组)= 人类不得验收(fail closed),客观验收由 pi_driver 路径负责。
      if (authorityKind === 'human'
        && evaluateSubtaskHumanAcceptanceAuthority({
          actorId,
          preboundAuthorityIds: coord.humanAcceptanceAuthorityIds ?? [],
        }).kind === 'rejected') {
        conflict('TASK_ACCEPTANCE_AUTHORITY_MISMATCH');
      }
      assertRevision(task.revision, acceptance.expectedTaskRevision);
      if (coord.attempt !== acceptance.taskAttempt) conflict('TASK_ATTEMPT_CONFLICT');
      if (task.status !== 'in_review') conflict('TASK_ACCEPTANCE_STATE_CONFLICT');

      const delivery = await repos.coordination.deliveries.getById(acceptance.deliveryId);
      if (!delivery || delivery.taskId !== task.id || delivery.taskRevision !== task.revision
        || delivery.taskAttempt !== coord.attempt || delivery.claimLeaseId !== acceptance.claimLeaseId) {
        conflict('TASK_DELIVERY_AUTHORITY_MISMATCH');
      }
      const claim = await repos.coordination.claimLeases.getById(acceptance.claimLeaseId);
      if (!claim || claim.taskId !== task.id || claim.taskRevision !== task.revision
        || claim.taskAttempt !== coord.attempt) conflict('TASK_CLAIM_AUTHORITY_MISMATCH');
      const currentClaim = await repos.coordination.claimLeases.getCurrent({
        taskId: task.id, taskRevision: task.revision, taskAttempt: coord.attempt,
      });
      if (claim.status !== 'active' || currentClaim?.id !== claim.id) conflict('TASK_CLAIM_NOT_ACTIVE');
      if (await repos.coordination.acceptances.getCanonicalByDelivery(delivery.id)) conflict('TASK_ACCEPTANCE_ALREADY_DECIDED');

      if (acceptance.decision === 'accepted' && authorityKind !== 'human') {
        // #1061 AC3：客观验收(criteria/evidence)只约束 PI authority(pi_driver);
        // 人类路径已由创建时预绑定的 Subtask human acceptance authority 授权,
        // 人类判定本身就是主观授权,不再强制客观 criteria 证明。
        const criteria = activeCriteria(await repos.coordination.criteria.list(task.id), task.revision);
        const snapshots = (await repos.coordination.evidenceSnapshots.listByTask(task.id))
          .filter((s) => s.taskRevision === task.revision && s.taskAttempt === coord.attempt && s.invocationId === delivery.invocationId);
        const evidenceRefs = acceptance.criteriaResults.flatMap((r) => r.evidenceRefs);
        const evidenceFacts = snapshots.flatMap((s) => {
          const ref = evidenceRefs.find((r) => s.kind === r.kind && s.sourceId === r.id && s.snapshotHash === r.snapshotHash
            && s.snapshotRevision === r.snapshotRevision && s.capturedAt === r.capturedAt);
          return ref ? [{ ref, available: true, visible: true, currentSnapshotHash: s.snapshotHash }] : [];
        });
        if (evaluateSubtaskAcceptance({ criteria, criteriaResults: acceptance.criteriaResults,
          evidenceSnapshots: evidenceFacts, highRisk: false, conflictingEvidence: false }).kind !== 'accepted') {
          conflict('TASK_ACCEPTANCE_POLICY_REJECTED');
        }
      }

      await repos.coordination.acceptances.create({ ...acceptance, id: ids.nextId(), teamId, decisionVersion: 1, canonical: true });
      const status: 'done' | 'in_review' = acceptance.decision === 'accepted' ? 'done' : 'in_review';
      if (status === 'done') {
        const updated = await repos.tasks.update({ taskId: task.id, changes: { status, updatedAt: now } });
        if (!updated) conflict('TASK_NOT_FOUND');
        // output slot 解析（验收后冻结不可变 snapshot）
        const declaredOutputSlots = coord.outputSlots ?? [];
        if (declaredOutputSlots.length > 0) {
          const slotDecision = resolveOutputSlots({ declaredSlots: declaredOutputSlots, deliveryEvidenceRefs: delivery.evidenceRefs });
          if (slotDecision.kind === 'rejected') conflict('TASK_OUTPUT_SLOT_RESOLUTION_CONFLICT');
          for (const slot of slotDecision.slots) {
            await repos.coordination.outputSnapshots.create({
              id: ids.nextId(), teamId, taskId: task.id, taskRevision: task.revision, taskAttempt: coord.attempt,
              slotName: slot.name, resolvedDeliveryId: delivery.id, resolvedEvidenceRefs: [...slot.evidenceRefs], resolvedAt: now,
            });
          }
        }
      }
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-acceptance-decided', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: { taskId: task.id, acceptance },
      }, now, ids, ch);
      if (status === 'done') {
        await appendTaskEvent(repos, {
          managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
          actorId, idempotencyKey: `${envelope.idempotencyKey}:state`,
          payload: { taskId: task.id, taskRevision: task.revision, from: 'in_review', to: 'done' },
        }, now, ids, ch);
      }
      return { taskId: task.id, taskRevision: task.revision, status };
    }),

    // ---- 7. reject-subtask: subtask in_review → todo (new attempt) (pi_driver / human) ----
    rejectSubtask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['reject-subtask'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('reject-subtask', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const coord = await requireCoordForTask(repos, task.id);
      if (coord.nodeKind !== 'subtask') conflict('TASK_SUBTASK_REQUIRED');
      const vt = validateTaskLifecycleTransition(task.status, 'todo');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');
      if (task.status !== 'in_review') conflict('TASK_RETRY_STATE_CONFLICT');

      const claim = await repos.coordination.claimLeases.getCurrent({
        taskId: task.id, taskRevision: task.revision, taskAttempt: coord.attempt,
      });
      const waitingForUser = coord.attempt >= coord.maxAttempts || requiresHumanIntervention(input.reason);
      const nextAttempt = waitingForUser ? coord.attempt : coord.attempt + 1;
      const updatedCoord = nextAttempt === coord.attempt ? coord
        : await repos.coordination.coordinations.update({
          expectedTaskRevision: task.revision,
          record: { ...coord, attempt: nextAttempt, updatedAt: now },
        });
      if (!updatedCoord) conflict('TASK_COORDINATION_REVISION_CONFLICT');

      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'todo', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      await appendTaskEvent(repos, {
        managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
        actorId, idempotencyKey: envelope.idempotencyKey,
        payload: {
          taskId: task.id, taskRevision: task.revision, from: 'in_review', to: 'todo',
          reason: input.reason,
        },
      }, now, ids, ch);
      await invalidateCapturedClaim(repos, coord.managementRunId, actorId,
        `${envelope.idempotencyKey}:claim-invalidated`, ch, claim, input.reason, now, ids,
        actorKind === 'human' ? 'system' : actorKind);
      return { taskId: task.id, taskRevision: task.revision, status: 'todo' as const, attempt: updatedCoord.attempt };
    }),

    // ---- 8. cancel-task: any non-terminal → cancelled ----
    cancelTask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['cancel-task'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('cancel-task', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const cc = evaluateCancellationPreconditions(task.status);
      if (cc.kind === 'rejected') conflict(cc.reason ?? 'NOT_CANCELLABLE');
      const vt = validateTaskLifecycleTransition(task.status, 'cancelled');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');

      const fromStatus = task.status;
      const cancelledSubtaskIds = await cascadeTermination(repos, task.id, 'cancelled', now);
      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'cancelled', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      const coord = await repos.coordination.coordinations.getByTaskId(task.id);
      if (coord) {
        await appendTaskEvent(repos, {
          managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
          actorId, idempotencyKey: envelope.idempotencyKey,
          payload: {
            taskId: task.id, taskRevision: task.revision, from: fromStatus, to: 'cancelled',
            reason: input.reason,
          },
        }, now, ids, ch);
      }
      return { taskId: task.id, taskRevision: task.revision, status: 'cancelled' as const, cancelledSubtaskIds };
    }),

    // ---- 9. close-task: any non-terminal → closed (admin) ----
    closeTask: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['close-task'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('close-task', envelope, input, authority, authorityKind, teamId, async (repos, now, { ch, actorKind, actorId }) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      const cc = evaluateClosurePreconditions(task.status);
      if (cc.kind === 'rejected') conflict(cc.reason ?? 'NOT_CLOSABLE');
      const vt = validateTaskLifecycleTransition(task.status, 'closed');
      if (vt.kind === 'rejected') conflict(vt.reason ?? 'INVALID_TRANSITION');

      const fromStatus = task.status;
      const closedSubtaskIds = await cascadeTermination(repos, task.id, 'closed', now);
      const updated = await repos.tasks.update({ taskId: task.id, changes: { status: 'closed', updatedAt: now } });
      if (!updated) conflict('TASK_NOT_FOUND');
      const coord = await repos.coordination.coordinations.getByTaskId(task.id);
      if (coord) {
        await appendTaskEvent(repos, {
          managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind,
          actorId, idempotencyKey: envelope.idempotencyKey,
          payload: {
            taskId: task.id, taskRevision: task.revision, from: fromStatus, to: 'closed',
            reason: input.reason,
          },
        }, now, ids, ch);
      }
      return { taskId: task.id, taskRevision: task.revision, status: 'closed' as const, closedSubtaskIds };
    }),

    // ---- 10. start-execution: 记录开工（不改 status）----
    startExecution: (
      envelope: TaskLifecycleCommandEnvelopeV1,
      input: TaskLifecycleCommandInputMapV1['start-execution'],
      authority: LeaseAuthorityInput, authorityKind: AK, teamId: string,
    ) => handle('start-execution', envelope, input, authority, authorityKind, teamId, async (repos, now) => {
      const task = await requireTask(repos, input.taskId);
      assertRevision(task.revision, input.expectedTaskRevision);
      if (task.status !== 'in_progress') conflict('TASK_NOT_IN_PROGRESS');
      const claim = await repos.coordination.claimLeases.getById(input.claimLeaseId);
      if (!claim || claim.taskId !== task.id || claim.status !== 'active') conflict('TASK_CLAIM_NOT_ACTIVE');
      // 不改 status，只记录 startedAt（claim acquire 与实际开工分离，ADR-0063）
      return { taskId: task.id, taskRevision: task.revision, startedAt: now };
    }),
  } as const;
}
