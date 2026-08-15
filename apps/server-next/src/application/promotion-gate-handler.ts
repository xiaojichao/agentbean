import { createHash } from 'node:crypto';

import type {
  ID,
  UnixMs,
  PromotionGateCommandEnvelopeV1,
  PromotionGateCommandInputMapV1,
  PromotionGateCommandResponseV1,
  PromotionCommandReceiptV1,
  PromotionGateCommandOutputUnionV1,
  PromotionObjectiveSnapshotV1,
  PromotionTriggerKind,
  PromotionGateCommandName,
} from '../../../../packages/contracts/src/index.js';
import { canonicalizePromotionGateCommand } from '../../../../packages/contracts/src/index.js';
import type {
  PromotionCommandReceiptRecord,
  PromotionIdempotencyTombstoneRecord,
  PromotionSourceRelationRecord,
} from './promotion-gate-repositories.js';
import type {
  TaskCoordinationTransactionRepositories,
  TaskCoordinationUnitOfWork,
} from './task-coordination-unit-of-work.js';
import { appendManagementEventInTransaction } from './management/management-kernel.js';
import {
  canonicalizePromotionObjectiveSnapshot,
  classifyPromotionOutcome,
  evaluatePromotionAuthorization,
  evaluatePromotionConvergence,
  evaluatePromotionFreshness,
} from '../../../../packages/domain/src/index.js';

/**
 * #922 Promotion gate server handler —— `promote-to-task` command 的 transport-independent 处理器。
 *
 * 在 {@link TaskCoordinationUnitOfWork} 的单 teamDb 事务内按 #900 §18 门禁顺序执行：
 * authority → freshness → 幂等冲突 → convergence → 原子提交。成功 applied 原子创建
 * root Task + ManagementRun + coordination + source relation + scheduling intent + outbox +
 * access audit + receipt/tombstone（#894 §10）。replayed（converged）写 no_op receipt。
 * conflict / freshness_hold / rejected 无副作用、不写 receipt。
 *
 * authority（requesterId）由 deps 传入，不在 envelope（#900 §1/§18）。
 * 本 handler 不接 transport（同 #921 先例），由调用层做 envelope/input 解析后传入。
 */

// ---------------------------------------------------------------------------
// Stable code 常量（response.stableCode，ADR-0067）
// ---------------------------------------------------------------------------

const STABLE_CODE_APPLIED = 'PROMOTION_APPLIED';
const STABLE_CODE_CONTINUATION_CREATED = 'TASK_CONTINUATION_CREATED';
const STABLE_CODE_REPLAYED = 'PROMOTION_REPLAYED';
const STABLE_CODE_CONFLICT = 'PROMOTION_CONFLICT';
const STABLE_CODE_FRESHNESS_HOLD = 'PROMOTION_FRESHNESS_HOLD';
const STABLE_CODE_REJECTED = 'PROMOTION_REJECTED';
const STABLE_CODE_ROOT_MESSAGE_NOT_FOUND = 'PROMOTION_ROOT_MESSAGE_NOT_FOUND';
const STABLE_CODE_ROOT_MESSAGE_SCOPE_MISMATCH = 'PROMOTION_ROOT_MESSAGE_SCOPE_MISMATCH';
const STABLE_CODE_ROOT_MESSAGE_UNRESOLVED = 'PROMOTION_ROOT_MESSAGE_UNRESOLVED';
const STABLE_CODE_CHANNEL_NOT_FOUND = 'PROMOTION_CHANNEL_NOT_FOUND';
const STABLE_CODE_CHANNEL_FORBIDDEN = 'PROMOTION_CHANNEL_FORBIDDEN';
const STABLE_CODE_CHANNEL_ARCHIVED = 'PROMOTION_CHANNEL_ARCHIVED';
const STABLE_CODE_SCHEMA_UNSUPPORTED = 'PROMOTION_COMMAND_SCHEMA_UNSUPPORTED';
const STABLE_CODE_CONTINUATION_SOURCE_INVALID = 'TASK_CONTINUATION_SOURCE_INVALID';
const STABLE_CODE_CONTINUATION_SOURCE_STALE = 'TASK_CONTINUATION_SOURCE_STALE';
const STABLE_CODE_CONTINUATION_THREAD_MISMATCH = 'TASK_CONTINUATION_THREAD_MISMATCH';
const STABLE_CODE_CONTINUATION_VERSIONS_STALE = 'TASK_CONTINUATION_VERSIONS_STALE';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PromotionGateClock {
  now(): UnixMs;
}

export interface PromotionGateIdGenerator {
  nextId(): ID;
}

export interface PromotionGateHandlerDependencies {
  readonly teamId: ID;
  /** Server 推导的 authority（#900 §1/§18：不来自 envelope）。 */
  readonly requesterId: ID;
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: PromotionGateClock;
  readonly ids: PromotionGateIdGenerator;
  /** #923：只有完成 proposal/policy/escalation 专项授权的 Server handler 才能信任非 human trigger。 */
  readonly trustedTriggerKinds?: readonly Exclude<PromotionTriggerKind, 'human-structured'>[];
  /**
   * #923 direct escalation 原子 handoff hook。只在新 root Task 的 applied 分支、receipt 提交前执行；
   * 抛错会回滚整个 TaskCoordination UoW。
   */
  readonly onAppliedInTransaction?: (input: {
    readonly repositories: TaskCoordinationTransactionRepositories;
    readonly rootTaskId: ID;
    readonly managementRunId: ID;
    readonly sourceRelationId: ID;
    readonly rootMessageId: ID;
    readonly now: UnixMs;
  }) => Promise<void>;
  readonly onConvergedInTransaction?: (input: {
    readonly repositories: TaskCoordinationTransactionRepositories;
    readonly rootTaskId: ID;
    readonly managementRunId: ID;
    readonly sourceRelationId: ID;
    readonly rootMessageId: ID;
    readonly now: UnixMs;
  }) => Promise<void>;
  /**
   * create-task-continuation 提交时在同一 UoW 内重算当前稳定版本；缺失即 fail closed。
   * 返回 null 表示当前 delivery/version 投影不可用。
   */
  readonly resolveContinuationVersionIdsInTransaction?: (input: {
    readonly repositories: TaskCoordinationTransactionRepositories;
    readonly sourceTaskId: ID;
    readonly sourceTaskRevision: number;
    readonly channelId: ID;
  }) => Promise<readonly ID[] | null>;
}

export interface PromotionGateHandler {
  promoteToTask(
    envelope: PromotionGateCommandEnvelopeV1,
    input: PromotionGateCommandInputMapV1['promote-to-task'],
  ): Promise<PromotionGateCommandResponseV1>;
  createTaskContinuation(
    envelope: PromotionGateCommandEnvelopeV1,
    input: PromotionGateCommandInputMapV1['create-task-continuation'],
  ): Promise<PromotionGateCommandResponseV1>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function buildLineageKey(teamId: ID, sourceLineage: { readonly kind: string; readonly id: ID }): string {
  return `${teamId}:${sourceLineage.kind}:${sourceLineage.id}`;
}

function buildReceiptProjection(record: PromotionCommandReceiptRecord): PromotionCommandReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: record.receiptId,
    commandName: record.commandName,
    commandSchemaVersion: record.commandSchemaVersion,
    idempotencyKey: record.idempotencyKey,
    commandHash: record.commandHash,
    outcome: record.outcome,
    committedRevisions: record.committedRevisions,
    eventRefs: record.eventRefs,
    commitTime: record.commitTime,
    resultAvailable: record.resultAvailable,
  };
}

function buildResult(
  commandName: PromotionGateCommandName,
  rootTaskId: ID,
  managementRunId: ID,
  sourceRelationId: ID,
  disposition: 'created' | 'existing',
): PromotionGateCommandOutputUnionV1 {
  return {
    commandName,
    rootTaskId,
    managementRunId,
    sourceRelationId,
    disposition,
  };
}

// ---------------------------------------------------------------------------
// Root message 解析与校验
// ---------------------------------------------------------------------------

type RootMessageResolution =
  | { readonly ok: true; readonly rootMessageId: ID }
  | { readonly ok: false; readonly stableCode: string; readonly reason: string };

/**
 * 解析 ManagementRun 所需的真实 root Message：
 * - 显式 `rootMessageId` 优先；
 * - 否则仅当 source lineage 为 `message` 时用 lineage.id；
 * - 其它 lineage（task/artifact/workspace-run/invocation）必须显式带 rootMessageId。
 */
function resolveRootMessageId(
  input: PromotionGateCommandInputMapV1['promote-to-task'],
): RootMessageResolution {
  if (input.rootMessageId) {
    return { ok: true, rootMessageId: input.rootMessageId };
  }
  if (input.freshnessBasis.sourceLineage.kind === 'message') {
    return { ok: true, rootMessageId: input.freshnessBasis.sourceLineage.id };
  }
  return {
    ok: false,
    stableCode: STABLE_CODE_ROOT_MESSAGE_UNRESOLVED,
    reason: 'root-message-unresolved',
  };
}

function isDeletedMessage(message: { readonly meta?: Record<string, unknown> }): boolean {
  return Boolean(message.meta?.deletedAt);
}

function matchesTaskContinuationSourceMarker(
  message: { readonly meta?: Record<string, unknown> },
  input: TaskContinuationInput,
): boolean {
  const marker = message.meta?.taskContinuationSource;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const record = marker as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.sourceTaskId === input.sourceTaskId
    && record.sourceTaskRevision === input.sourceTaskRevision;
}

type ChannelAccessDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly stableCode: string };

/**
 * 校验 requester 对目标频道的访问权：频道须属于当前 team；private 须是 human 成员。
 * public 允许 team 内请求者（team 边界由 deps.teamId 已由 Server 推导）。
 */
async function evaluateChannelAccess(
  repos: { readonly channels: { getById(channelId: ID): Promise<{
    readonly teamId: ID;
    readonly visibility: string;
    readonly humanMemberIds: readonly ID[];
    readonly archivedAt?: UnixMs | null;
  } | null> } },
  input: { readonly teamId: ID; readonly requesterId: ID; readonly channelId: ID },
): Promise<ChannelAccessDecision> {
  const channel = await repos.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) {
    return { ok: false, stableCode: STABLE_CODE_CHANNEL_NOT_FOUND };
  }
  if (channel.archivedAt != null) {
    return { ok: false, stableCode: STABLE_CODE_CHANNEL_ARCHIVED };
  }
  if (channel.visibility === 'private' && !channel.humanMemberIds.includes(input.requesterId)) {
    return { ok: false, stableCode: STABLE_CODE_CHANNEL_FORBIDDEN };
  }
  return { ok: true };
}

/**
 * 在事务内读取 source lineage 的当前状态，喂入 freshness 策略。
 * 删除/不存在 → sourceChanged；有 revision 的来源（task / message.meta.revision）提供 currentSourceRevision。
 */
async function resolveSourceFreshness(
  repos: {
    readonly messages: { getById(id: ID): Promise<{
      readonly teamId: ID;
      readonly meta?: Record<string, unknown>;
    } | null> };
    readonly tasks: { getById(id: ID): Promise<{
      readonly teamId: ID;
      readonly revision: number;
    } | null> };
    readonly artifacts: { getForTeam(input: { teamId: ID; artifactId: ID }): Promise<unknown | null> };
  },
  input: {
    readonly teamId: ID;
    readonly freshnessBasis: PromotionGateCommandInputMapV1['promote-to-task']['freshnessBasis'];
  },
): Promise<{
  readonly requestedSourceRevision?: number;
  readonly currentSourceRevision?: number;
  readonly sourceChanged?: boolean;
}> {
  const lineage = input.freshnessBasis.sourceLineage;
  const requestedSourceRevision = input.freshnessBasis.sourceRevision;
  const base = requestedSourceRevision === undefined ? {} : { requestedSourceRevision };

  if (lineage.kind === 'message') {
    const message = await repos.messages.getById(lineage.id);
    if (!message || message.teamId !== input.teamId || isDeletedMessage(message)) {
      return { ...base, sourceChanged: true };
    }
    const metaRevision = message.meta?.revision;
    if (typeof metaRevision === 'number' && Number.isSafeInteger(metaRevision)) {
      return { ...base, currentSourceRevision: metaRevision, sourceChanged: false };
    }
    return { ...base, sourceChanged: false };
  }

  if (lineage.kind === 'task') {
    const task = await repos.tasks.getById(lineage.id);
    if (!task || task.teamId !== input.teamId) {
      return { ...base, sourceChanged: true };
    }
    return { ...base, currentSourceRevision: task.revision, sourceChanged: false };
  }

  if (lineage.kind === 'artifact') {
    const artifact = await repos.artifacts.getForTeam({
      teamId: input.teamId,
      artifactId: lineage.id,
    });
    if (!artifact) {
      return { ...base, sourceChanged: true };
    }
    return { ...base, sourceChanged: false };
  }

  // workspace-run / invocation：本切片无 revision 投影，仅当客户端声明了 revision 时仍可按策略比较（无 current 则不 hold）。
  return { ...base, sourceChanged: false };
}

type TaskContinuationInput = PromotionGateCommandInputMapV1['create-task-continuation'];

type ContinuationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly stableCode: string };

function sameIds(left: readonly ID[], right: readonly ID[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function validateTaskContinuation(
  repos: TaskCoordinationTransactionRepositories,
  dependencies: PromotionGateHandlerDependencies,
  input: TaskContinuationInput,
): Promise<ContinuationValidation> {
  const sourceTask = await repos.tasks.getById(input.sourceTaskId);
  if (!sourceTask || sourceTask.teamId !== dependencies.teamId
    || sourceTask.channelId !== input.channelId
    || !['done', 'cancelled', 'closed'].includes(sourceTask.status)) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_SOURCE_INVALID };
  }
  if (sourceTask.revision !== input.sourceTaskRevision) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_SOURCE_STALE };
  }
  const coordination = await repos.coordination.coordinations.getByTaskId(sourceTask.id);
  if (!coordination || coordination.nodeKind !== 'root' || coordination.rootTaskId !== sourceTask.id) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_SOURCE_INVALID };
  }
  const run = await repos.management.runs.getById(coordination.managementRunId);
  if (!run || run.rootTaskId !== sourceTask.id || run.rootMessageId !== input.rootMessageId) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_THREAD_MISMATCH };
  }
  const rootMessage = await repos.messages.getById(input.rootMessageId);
  if (!rootMessage || rootMessage.teamId !== dependencies.teamId
    || rootMessage.channelId !== input.channelId
    || isDeletedMessage(rootMessage)) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_THREAD_MISMATCH };
  }
  const sourceMessage = await repos.messages.getById(input.sourceMessageId);
  if (!sourceMessage || sourceMessage.teamId !== dependencies.teamId
    || sourceMessage.channelId !== input.channelId
    || sourceMessage.threadId !== input.rootMessageId
    || sourceMessage.senderKind !== 'human'
    || sourceMessage.senderId !== dependencies.requesterId
    || isDeletedMessage(sourceMessage)) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_THREAD_MISMATCH };
  }
  if (!matchesTaskContinuationSourceMarker(sourceMessage, input)) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_SOURCE_INVALID };
  }
  const currentVersionIds = await dependencies.resolveContinuationVersionIdsInTransaction?.({
    repositories: repos,
    sourceTaskId: input.sourceTaskId,
    sourceTaskRevision: input.sourceTaskRevision,
    channelId: input.channelId,
  });
  if (!currentVersionIds || !sameIds(currentVersionIds, input.sourceVersionIds)) {
    return { ok: false, stableCode: STABLE_CODE_CONTINUATION_VERSIONS_STALE };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createPromotionGateHandler(
  dependencies: PromotionGateHandlerDependencies,
): PromotionGateHandler {
  const { teamId, requesterId, unitOfWork, clock, ids } = dependencies;

  async function handlePromotion(
    envelope: PromotionGateCommandEnvelopeV1,
    input: PromotionGateCommandInputMapV1['promote-to-task'],
    continuationInput?: TaskContinuationInput,
  ): Promise<PromotionGateCommandResponseV1> {
      const commandName = envelope.commandName;
      const commandHash = sha256Hex(
        canonicalizePromotionGateCommand(commandName, envelope.commandSchemaVersion, continuationInput ?? input),
      );

      return unitOfWork.run(async (repos) => {
        // -------------------------------------------------------------------
        // 0. 仅接受本切片实现的 command schema 版本
        // -------------------------------------------------------------------
        if (envelope.commandSchemaVersion !== 1) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_SCHEMA_UNSUPPORTED,
          };
        }

        // -------------------------------------------------------------------
        // 1. 幂等 receipt 查重（#900 §1.5/§6）
        // -------------------------------------------------------------------
        const existingReceipt = await repos.promotion.receipts.getReceiptByIdempotencyKey(
          envelope.idempotencyKey,
        );
        if (existingReceipt) {
          if (existingReceipt.commandHash === commandHash) {
            // replay：返回首次 receipt + result，不写新 receipt。
            const result = existingReceipt.resultJson
              ? (JSON.parse(existingReceipt.resultJson) as PromotionGateCommandOutputUnionV1)
              : undefined;
            return {
              schemaVersion: 1,
              commandName,
              outcome: 'replayed',
              retryDirective: 'none',
              stableCode: STABLE_CODE_REPLAYED,
              receipt: buildReceiptProjection(existingReceipt),
              ...(result ? { result } : {}),
            };
          }
          // idempotency conflict：同 key 异 canonical hash，无副作用。
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'conflict',
            retryDirective: 'reread_then_new_command',
            stableCode: STABLE_CODE_CONFLICT,
            conflictReason: 'idempotency-key-hash-mismatch',
          };
        }

        // -------------------------------------------------------------------
        // 2. Authorization（#894 §1/§8 / #900 §18）：trigger + 频道访问权
        // -------------------------------------------------------------------
        const triggerAuthorization = evaluatePromotionAuthorization({
          triggerKind: input.triggerKind,
          ...(input.triggerKind !== 'human-structured'
            && dependencies.trustedTriggerKinds?.includes(input.triggerKind)
            ? { trustedStructuredTrigger: true }
            : {}),
        });
        if ('denied' in triggerAuthorization) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_REJECTED,
          };
        }
        const channelAccess = await evaluateChannelAccess(repos, {
          teamId,
          requesterId,
          channelId: input.channelId,
        });
        if (!channelAccess.ok) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: channelAccess.stableCode,
          };
        }
        const authorization = { allowed: true as const };

        // continuation 必须在授权后、同一事务里复验终态 root、原 thread human message 与稳定文件版本。
        if (continuationInput) {
          const continuation = await validateTaskContinuation(repos, dependencies, continuationInput);
          if (!continuation.ok) {
            return {
              schemaVersion: 1,
              commandName,
              outcome: continuation.stableCode === STABLE_CODE_CONTINUATION_SOURCE_STALE
                || continuation.stableCode === STABLE_CODE_CONTINUATION_VERSIONS_STALE
                ? 'freshness_hold'
                : 'rejected',
              retryDirective: 'user_action',
              stableCode: continuation.stableCode,
              ...(continuation.stableCode === STABLE_CODE_CONTINUATION_SOURCE_STALE
                || continuation.stableCode === STABLE_CODE_CONTINUATION_VERSIONS_STALE
                ? { freshnessReason: continuation.stableCode }
                : {}),
            };
          }
        }

        // -------------------------------------------------------------------
        // 3. Freshness（#894 §5）：事务内读取真实来源状态
        // -------------------------------------------------------------------
        const freshness = evaluatePromotionFreshness(
          await resolveSourceFreshness(repos, { teamId, freshnessBasis: input.freshnessBasis }),
        );

        // -------------------------------------------------------------------
        // 4. Convergence（#894 §6）
        // -------------------------------------------------------------------
        const lineageKey = buildLineageKey(teamId, input.freshnessBasis.sourceLineage);
        const existingRelation = await repos.promotion.sourceRelations.getByLineageKey(lineageKey);
        const convergence = evaluatePromotionConvergence({
          sourceLineageKey: lineageKey,
          requestedSnapshot: input.objectiveSnapshot,
          ...(existingRelation
            ? {
                existing: {
                  lineageKey,
                  taskId: existingRelation.taskId,
                  snapshot: JSON.parse(existingRelation.objectiveSnapshotJson) as PromotionObjectiveSnapshotV1,
                },
              }
            : {}),
        });

        // -------------------------------------------------------------------
        // 5. Outcome classification（#900 §18）
        // -------------------------------------------------------------------
        const classification = classifyPromotionOutcome({ authorization, freshness, convergence });

        // -------------------------------------------------------------------
        // 6. 按 outcome 分发
        // -------------------------------------------------------------------

        // --- rejected / freshness_hold / conflict：无副作用，不写 receipt ---
        if (classification.outcome === 'rejected') {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_REJECTED,
          };
        }
        if (classification.outcome === 'freshness_hold') {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'freshness_hold',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_FRESHNESS_HOLD,
            freshnessReason: classification.reason,
          };
        }
        if (classification.outcome === 'conflict') {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'conflict',
            retryDirective: 'reread_then_new_command',
            stableCode: STABLE_CODE_CONFLICT,
            conflictReason: classification.reason,
          };
        }

        // --- replayed（converged）：返回既有 Task，写 no_op receipt（#894 §6） ---
        if (classification.outcome === 'replayed') {
          if (!existingRelation) {
            // 防御：converged 必有 existingRelation，但 fail-closed。
            throw new Error('PROMOTION_CONVERGED_WITHOUT_EXISTING_RELATION');
          }
          const now = clock.now();
          const result = buildResult(
            commandName,
            existingRelation.taskId,
            existingRelation.managementRunId,
            existingRelation.id,
            'existing',
          );
          const receiptId = ids.nextId();
          const convergedRootMessageId = input.rootMessageId
            ?? (input.freshnessBasis.sourceLineage.kind === 'message'
              ? input.freshnessBasis.sourceLineage.id
              : existingRelation.taskId);
          await dependencies.onConvergedInTransaction?.({
            repositories: repos,
            rootTaskId: existingRelation.taskId,
            managementRunId: existingRelation.managementRunId,
            sourceRelationId: existingRelation.id,
            rootMessageId: convergedRootMessageId,
            now,
          });
          const receipt: PromotionCommandReceiptRecord = {
            receiptId,
            teamId,
            commandName,
            commandSchemaVersion: envelope.commandSchemaVersion,
            idempotencyKey: envelope.idempotencyKey,
            commandHash,
            outcome: 'no_op',
            committedRevisions: [],
            eventRefs: [],
            resultAvailable: true,
            resultJson: JSON.stringify(result),
            commitTime: now,
            createdAt: now,
          };
          const tombstone: PromotionIdempotencyTombstoneRecord = {
            id: ids.nextId(),
            teamId,
            commandName,
            idempotencyKey: envelope.idempotencyKey,
            commandHash,
            receiptId,
            outcome: 'no_op',
            resultAvailable: true,
            createdAt: now,
          };
          await repos.promotion.receipts.createReceipt(receipt);
          await repos.promotion.receipts.createTombstone(tombstone);
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'replayed',
            retryDirective: 'none',
            stableCode: STABLE_CODE_REPLAYED,
            receipt: buildReceiptProjection(receipt),
            result,
          };
        }

        // --- applied（create）：先校验可执行 root Message，再原子创建全链（#894 §10） ---
        const resolvedRoot = resolveRootMessageId(input);
        if (!resolvedRoot.ok) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: resolvedRoot.stableCode,
          };
        }

        const rootMessage = await repos.messages.getById(resolvedRoot.rootMessageId);
        if (!rootMessage) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_ROOT_MESSAGE_NOT_FOUND,
          };
        }
        if (rootMessage.teamId !== teamId || rootMessage.channelId !== input.channelId) {
          return {
            schemaVersion: 1,
            commandName,
            outcome: 'rejected',
            retryDirective: 'user_action',
            stableCode: STABLE_CODE_ROOT_MESSAGE_SCOPE_MISMATCH,
          };
        }
        const rootMessageId = rootMessage.id;

        const now = clock.now();
        const taskId = ids.nextId();
        const managementRunId = ids.nextId();
        const sourceRelationId = ids.nextId();

        // root Task：status 'todo'，绝不推进（#896 §4）
        const task = await repos.tasks.create({
          id: taskId,
          teamId,
          title: input.objectiveSnapshot.objective,
          status: 'todo',
          creatorId: requesterId,
          channelId: input.channelId,
          tags: [],
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        });

        // ManagementRun reservation（防重复 run 创建）
        const requestKey = `${commandName}:${envelope.idempotencyKey}`;
        await repos.management.reservations.create({
          id: ids.nextId(),
          teamId,
          requestKey,
          requestHash: commandHash,
          managementRunId,
          createdAt: now,
        });

        // Phase 2 ManagementRunV2
        await repos.management.runs.create({
          schemaVersion: 2,
          managementPhase: 2,
          id: managementRunId,
          teamId,
          channelId: input.channelId,
          rootTaskId: taskId,
          rootMessageId,
          initiatedByUserId: requesterId,
          mode: 'managed',
          status: 'queued',
          placementPolicy: {
            placement: 'managed',
            allowServerContext: true,
            requireLocalModelCredentials: false,
          },
          checkpointRevision: 0,
          orchestrationRevision: 1,
          recoveryState: 'healthy',
          budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
          collaborationMode: 'manager-orchestrated',
          createdAt: now,
          updatedAt: now,
        });

        // Root coordination（task-coordination-kernel.ts:152-157 字段）
        // #1061 AC4：root Human review authority 创建时预绑定 = requester。
        await repos.coordination.coordinations.create({
          schemaVersion: 1,
          taskId,
          teamId,
          managementRunId,
          rootTaskId: taskId,
          nodeKind: 'root',
          reviewPolicy: 'human',
          claimPolicy: 'open',
          requiredCapabilities: [],
          humanAcceptanceAuthorityIds: [requesterId],
          taskRevision: task.revision,
          attempt: 1,
          maxAttempts: 3,
          createdAt: now,
          updatedAt: now,
        });

        // Promotion source relation（收敛锚 + provenance）
        const objectiveSnapshotJson = canonicalizePromotionObjectiveSnapshot(input.objectiveSnapshot);
        const sourceRelation: PromotionSourceRelationRecord = {
          id: sourceRelationId,
          teamId,
          lineageKey,
          taskId,
          managementRunId,
          requesterId,
          triggerCommandRevision: 1,
          objectiveSnapshotJson,
          scopeSnapshotJson: input.objectiveSnapshot.scope,
          riskLevel: input.objectiveSnapshot.riskLevel,
          dataSnapshotJson: input.objectiveSnapshot.dataSnapshot ?? null,
          provenanceJson: JSON.stringify({
            ...(envelope.causationRef ? { causationRef: envelope.causationRef } : {}),
            ...(envelope.sourceRefs ? { sourceRefs: envelope.sourceRefs } : {}),
          }),
          relationKind: continuationInput ? 'task-continuation' : null,
          sourceTaskId: continuationInput?.sourceTaskId ?? null,
          sourceTaskRevision: continuationInput?.sourceTaskRevision ?? null,
          sourceVersionIdsJson: continuationInput
            ? JSON.stringify(continuationInput.sourceVersionIds)
            : null,
          claimState: 'awaiting-driver',
          createdAt: now,
        };
        await repos.promotion.sourceRelations.create(sourceRelation);

        // #924 canonical Server-owned orchestration claim 与可重建 scheduling facts。
        await repos.management.orchestrationClaims.create({
          managementRunId,
          rootTaskId: taskId,
          state: 'active',
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        await repos.management.scheduling.create({
          managementRunId,
          state: 'runnable',
          eligibleAt: now,
          enqueuedAt: now,
          priority: 0,
          revision: 1,
          updatedAt: now,
        });

        // 先持久化真实 management event，再引用其 stream/sequence（禁止悬空 eventRef）
        const eventRecord = await appendManagementEventInTransaction(
          repos.management,
          {
            managementRunId,
            type: 'run-started',
            actorKind: 'human',
            actorId: requesterId,
            idempotencyKey: `run-started:${requestKey}`,
            payload: {
              rootMessageId,
              rootTaskId: taskId,
              mode: 'managed',
            },
          },
          now,
          ids,
        );
        const eventRefs = [{
          streamKind: 'management-run',
          streamId: managementRunId,
          sequence: eventRecord.event.sequence,
        }];

        const result = buildResult(commandName, taskId, managementRunId, sourceRelationId, 'created');
        const receiptId = ids.nextId();
        await repos.promotion.outbox.create({
          id: ids.nextId(),
          teamId,
          receiptId,
          eventRefJson: JSON.stringify(eventRefs[0]),
          audience: 'team',
          deliveryState: 'pending',
          createdAt: now,
        });

        // Access audit（trigger audit）
        await repos.management.accessAudits.append({
          id: ids.nextId(),
          managementRunId,
          userId: requesterId,
          teamId,
          scopeType: 'task',
          scopeId: taskId,
          action: 'access',
          decision: 'allowed',
          diagnosticCode: `PROMOTION_${input.triggerKind.toUpperCase().replace(/-/g, '_')}`,
          createdAt: now,
        });

        await dependencies.onAppliedInTransaction?.({
          repositories: repos,
          rootTaskId: taskId,
          managementRunId,
          sourceRelationId,
          rootMessageId,
          now,
        });

        // Receipt + tombstone（幂等锚）
        const receipt: PromotionCommandReceiptRecord = {
          receiptId,
          teamId,
          commandName,
          commandSchemaVersion: envelope.commandSchemaVersion,
          idempotencyKey: envelope.idempotencyKey,
          commandHash,
          outcome: 'applied',
          committedRevisions: [{ streamKind: 'task', streamId: taskId, revision: task.revision }],
          eventRefs,
          resultAvailable: true,
          resultJson: JSON.stringify(result),
          commitTime: now,
          createdAt: now,
        };
        const tombstone: PromotionIdempotencyTombstoneRecord = {
          id: ids.nextId(),
          teamId,
          commandName,
          idempotencyKey: envelope.idempotencyKey,
          commandHash,
          receiptId,
          outcome: 'applied',
          resultAvailable: true,
          createdAt: now,
        };
        await repos.promotion.receipts.createReceipt(receipt);
        await repos.promotion.receipts.createTombstone(tombstone);

        return {
          schemaVersion: 1,
          commandName,
          outcome: 'applied',
          retryDirective: 'none',
          stableCode: continuationInput ? STABLE_CODE_CONTINUATION_CREATED : STABLE_CODE_APPLIED,
          receipt: buildReceiptProjection(receipt),
          result,
        };
      });
  }

  return {
    promoteToTask(envelope, input) {
      if (envelope.commandName !== 'promote-to-task') throw new Error('PROMOTION_COMMAND_MISMATCH');
      return handlePromotion(envelope, input);
    },
    createTaskContinuation(envelope, input) {
      if (envelope.commandName !== 'create-task-continuation') throw new Error('PROMOTION_COMMAND_MISMATCH');
      return handlePromotion(envelope, {
        triggerKind: 'human-structured',
        channelId: input.channelId,
        rootMessageId: input.rootMessageId,
        objectiveSnapshot: input.objectiveSnapshot,
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: input.sourceMessageId },
        },
      }, input);
    },
  };
}
