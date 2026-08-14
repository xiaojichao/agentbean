import { createHash } from 'node:crypto';
// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import {
  PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
  canonicalizePackageReviewCommand,
  type PackageReviewCommandName,
  type PackageReviewRejectionReason,
} from '../../../../packages/contracts/src/index.js';
import {
  deriveAuthorityBasis,
  evaluatePackageArtifactReviewAuthority,
  evaluatePackageReviewAndFinalize,
  evaluatePackageReviewAndRejectDelivery,
  evaluateRejectRevision,
  mapPackageReviewRejection,
} from '../../../../packages/domain/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type {
  PackageReviewReceiptRecord,
  PackageReviewRecord,
  PackageReviewTombstoneRecord,
} from './package-review-repositories.js';
import type { ProjectArtifactFinalizationRecord } from './project-repositories.js';
import {
  activeCriteria,
  appendTaskEvent,
  invalidateCapturedClaim,
  requiresHumanIntervention,
} from './management/task-coordination-kernel.js';

/**
 * #1061 PackageReview application handler(父规格 #1059 §5;ADR-0067)。
 *
 * 三个人类命令:
 * - `submit-package-artifact-review`:对 package 成员版本提交审核(AC1),append-only;
 * - `submit-package-review-and-finalize`:"通过并设为最终版"(AC9),一个事务两个独立事实;
 * - `submit-package-review-and-reject-delivery`:审核+退回 Task delivery 原子提交(AC6)。
 *
 * authority 一律由 Server 从已持久化事实推导(Team 角色/项目画像/Stage reviewer/package
 * 冻结成员/Task coordination),envelope/input 无 authority 字段。
 * 组合命令的原子性:finalize 组合在 recordPackageReview 同一持久事务内完成(AC9);
 * reject-delivery 组合在 taskCoordinationUnitOfWork 内完成(review 写入为嵌套事务,
 * Task transition 用 UoW 原语,任一步失败整体回滚,不留部分事实)(AC6)。
 */

export interface PackageReviewHandlerDeps {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export interface SubmitPackageReviewCommandInput {
  readonly teamId: string;
  /** 操作者(人类)。Server 从 session 推导,客户端不可自报。 */
  readonly userId: string;
  readonly commandName: PackageReviewCommandName;
  readonly channelId: string;
  readonly packageId: string;
  readonly collectionId: string;
  readonly versionId: string;
  readonly decision: 'approved' | 'changes_requested' | 'rejected';
  readonly comment: string;
  readonly idempotencyKey: string;
  /** AC9 组合:集合 revision fence。 */
  readonly expectedCollectionRevision?: number;
  /** AC6 组合:Task revision fence。 */
  readonly expectedTaskRevision?: number;
  /** AC6 组合:子 Task attempt fence。 */
  readonly expectedTaskAttempt?: number;
  /** AC6 组合:退回理由(必填)。 */
  readonly rejectReason?: string;
}

export type SubmitPackageReviewResult =
  | {
    readonly kind: 'applied';
    readonly review: PackageReviewRecord;
    readonly receipt: PackageReviewReceiptRecord;
    /** AC9 组合成功时附加 finalization 事实。 */
    readonly finalization?: ProjectArtifactFinalizationRecord;
    /** AC6 组合成功时附加 Task transition 事实。 */
    readonly taskTransition?: { taskId: string; taskRevision: number; taskAttempt: number; status: string };
  }
  | { readonly kind: 'replayed'; readonly receipt: PackageReviewReceiptRecord }
  | { readonly kind: 'conflict'; readonly reasonCode: string }
  | { readonly kind: 'rejected'; readonly reasonCode: PackageReviewRejectionReason };

/**
 * 主入口:三个命令共用一条判定+写入骨架。try/catch 不抛——失败只返回
 * rejected/conflict,绝不留下部分 review/transition/final 事实。
 */
export async function submitPackageReviewCommand(
  deps: PackageReviewHandlerDeps,
  input: SubmitPackageReviewCommandInput,
): Promise<SubmitPackageReviewResult> {
  const { repositories } = deps;
  const teamId = input.teamId;

  // 幂等键由客户端声明(人类命令);canonical hash 覆盖语义 payload,不含 transport 字段。
  const semanticInput = {
    channelId: input.channelId,
    packageId: input.packageId,
    collectionId: input.collectionId,
    versionId: input.versionId,
    decision: input.decision,
    comment: input.comment,
    ...(input.expectedCollectionRevision !== undefined
      ? { expectedCollectionRevision: input.expectedCollectionRevision }
      : {}),
    ...(input.expectedTaskRevision !== undefined ? { expectedTaskRevision: input.expectedTaskRevision } : {}),
    ...(input.expectedTaskAttempt !== undefined ? { expectedTaskAttempt: input.expectedTaskAttempt } : {}),
    ...(input.rejectReason !== undefined ? { rejectReason: input.rejectReason } : {}),
  };
  const commandHash = sha256(canonicalizePackageReviewCommand(
    input.commandName,
    PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
    semanticInput,
  ));

  const existingReceipt = await repositories.packageReviews.receipts.getByIdempotencyKey({
    teamId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingReceipt) {
    if (existingReceipt.commandHash !== commandHash) {
      return { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
    }
    return { kind: 'replayed', receipt: existingReceipt };
  }

  // ---- 加载事实(全部 Server 读取,客户端不可伪造) ----
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== teamId) return { kind: 'rejected', reasonCode: 'channel-not-found' };
  if (channel.archivedAt != null) return { kind: 'rejected', reasonCode: 'channel-archived' };

  const packageProjection = await repositories.outputPackages.getPackageById({
    teamId,
    packageId: input.packageId,
  });
  if (!packageProjection) return { kind: 'rejected', reasonCode: 'package-not-found' };
  if (packageProjection.package.channelId !== input.channelId) {
    return { kind: 'rejected', reasonCode: 'package-out-of-scope' };
  }

  const collections = await repositories.channelProjects.listArtifactCollections({
    teamId,
    channelId: input.channelId,
  });
  const collection = collections.find((candidate) => candidate.id === input.collectionId) ?? null;
  const versions = await repositories.channelProjects.listArtifactVersions({
    teamId,
    channelId: input.channelId,
  });
  const version = versions.find((candidate) => candidate.id === input.versionId) ?? null;

  const profile = await repositories.channelProjects.getProfile({
    teamId,
    channelId: input.channelId,
  });
  const stage = version?.stageId
    ? (await repositories.channelProjects.listStages({ teamId, channelId: input.channelId }))
      .find((candidate) => candidate.id === version.stageId) ?? null
    : null;
  const teamMember = await repositories.teams.isMember(teamId, input.userId);
  if (!teamMember) return { kind: 'rejected', reasonCode: 'actor-not-authorized' };
  const actorFacts = {
    userId: input.userId,
    teamRole: await repositories.teams.getMemberRole(teamId, input.userId),
    projectLeadId: profile?.projectLeadId ?? '',
    stageReviewerIds: stage?.reviewerIds ?? [],
  };

  const packageFacts = {
    teamId,
    channelId: input.channelId,
    actorFacts,
    package: {
      id: packageProjection.package.packageId,
      teamId: packageProjection.package.teamId,
      channelId: packageProjection.package.channelId,
      members: packageProjection.members.map((member) => ({
        collectionId: member.collectionId,
        artifactVersionId: member.artifactVersionId,
      })),
    },
    versionScope: {
      collectionId: input.collectionId,
      versionId: input.versionId,
      versionCollectionId: version?.collectionId,
      currentVersionId: collection?.currentVersionId,
    },
  };

  // Task/coordination 事实(AC6 组合与 authority 预绑定校验用)。
  const task = await repositories.tasks.getById(packageProjection.package.taskId);
  const coordination = task
    ? await repositories.taskCoordination.coordinations.getByTaskId(task.id)
    : null;
  const rejectTargetNodeKind = coordination?.nodeKind;

  const now = deps.clock.now();
  const reviewId = deps.ids.nextId();

  const reviewBase: PackageReviewRecord = {
    id: reviewId,
    teamId,
    channelId: input.channelId,
    collectionId: input.collectionId,
    versionId: input.versionId,
    ...(version?.stageId ? { stageId: version.stageId } : {}),
    packageId: input.packageId,
    deliveryId: packageProjection.package.deliveryId,
    taskId: packageProjection.package.taskId,
    taskRevision: packageProjection.package.taskRevision ?? 1,
    taskAttempt: packageProjection.package.taskAttempt,
    authorityBasis: deriveAuthorityBasis(actorFacts),
    decision: input.decision,
    comment: input.comment,
    basis: [],
    reviewedBy: input.userId,
    createdAt: now,
  };

  // ---- 判定(按命令分派,复用 domain 纯函数) ----
  if (input.commandName === 'submit-package-artifact-review') {
    const decision = evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: packageFacts,
      decision: input.decision,
    });
    if (decision.kind === 'rejected') {
      return { kind: 'rejected', reasonCode: mapPackageReviewRejection(decision.reasonCode) };
    }
    return commitReview(deps, input, commandHash, { ...reviewBase, authorityBasis: decision.authorityBasis }, now);
  }

  if (input.commandName === 'submit-package-review-and-finalize') {
    if (input.decision !== 'approved') {
      // "通过并设为最终版"只接受 approved(最终化必须落在 approved review 上,AC7)。
      return { kind: 'rejected', reasonCode: 'invalid-decision' };
    }
    const decision = evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: packageFacts,
      decision: input.decision,
      collection: collection ? {
        id: collection.id,
        teamId: collection.teamId,
        channelId: collection.channelId,
        revision: collection.revision,
      } : null,
      expectedCollectionRevision: input.expectedCollectionRevision ?? -1,
    });
    if (decision.kind === 'rejected') {
      return { kind: 'rejected', reasonCode: mapPackageReviewRejection(decision.reasonCode) };
    }
    if (!collection || input.expectedCollectionRevision === undefined) {
      return { kind: 'rejected', reasonCode: 'collection-revision-stale' };
    }
    const finalization: ProjectArtifactFinalizationRecord = {
      id: deps.ids.nextId(),
      teamId,
      channelId: input.channelId,
      collectionId: input.collectionId,
      versionId: input.versionId,
      ...(collection.finalVersionId ? { previousVersionId: collection.finalVersionId } : {}),
      basisReviewId: reviewId,
      actorKind: 'human',
      finalizedBy: input.userId,
      createdAt: now,
    };
    return commitReview(deps, input, commandHash, reviewBase, now, {
      finalization,
      collectionId: input.collectionId,
      expectedCollectionRevision: collection.revision,
      nextRevision: collection.revision + 1,
      updatedAt: now,
    });
  }

  // submit-package-review-and-reject-delivery(AC6)
  const combined = evaluatePackageReviewAndRejectDelivery({
    actorKind: 'human',
    facts: packageFacts,
    decision: input.decision,
    task: task && coordination ? {
      id: task.id,
      teamId: task.teamId,
      channelId: task.channelId ?? undefined,
      revision: task.revision,
      nodeKind: coordination.nodeKind,
      attempt: coordination.attempt,
      status: task.status,
    } : null,
    expectedTaskRevision: input.expectedTaskRevision ?? -1,
    expectedTaskAttempt: input.expectedTaskAttempt,
  });
  if (combined.kind === 'rejected') {
    return { kind: 'rejected', reasonCode: mapPackageReviewRejection(combined.reasonCode) };
  }
  if (!task || !coordination || input.expectedTaskRevision === undefined) {
    return { kind: 'rejected', reasonCode: 'delivery-not-found' };
  }
  if (!input.rejectReason) {
    return { kind: 'rejected', reasonCode: 'reject-reason-required' };
  }
  return commitReviewWithTaskReject(deps, input, commandHash, reviewBase, now, task.id, input.rejectReason,
    rejectTargetNodeKind);
}

/** AC1/AC9 提交:review 落库(AC9 时同事务写 finalization)。 */
async function commitReview(
  deps: PackageReviewHandlerDeps,
  input: SubmitPackageReviewCommandInput,
  commandHash: string,
  review: PackageReviewRecord,
  now: number,
  finalizationPlan?: {
    finalization: ProjectArtifactFinalizationRecord;
    collectionId: string;
    expectedCollectionRevision: number;
    nextRevision: number;
    updatedAt: number;
  },
): Promise<SubmitPackageReviewResult> {
  const { repositories, ids } = deps;
  const receipt = buildReceipt(ids, input, commandHash, review, now);
  const tombstone: PackageReviewTombstoneRecord = {
    id: ids.nextId(),
    teamId: input.teamId,
    commandName: input.commandName,
    idempotencyKey: input.idempotencyKey,
    commandHash,
    receiptId: receipt.receiptId,
    outcome: 'applied',
    resultAvailable: true,
    createdAt: now,
  };
  const result = await repositories.packageReviews.recordPackageReview({
    review,
    mutation: {
      teamId: input.teamId,
      channelId: input.channelId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: commandHash,
      createdAt: now,
    },
    receipt,
    tombstone,
    ...(finalizationPlan ? { finalization: finalizationPlan } : {}),
  });
  if (result.kind === 'idempotency_conflict') {
    return { kind: 'conflict', reasonCode: 'idempotency-conflict' };
  }
  if (result.kind === 'version_scope_conflict') {
    return { kind: 'rejected', reasonCode: 'version-not-in-collection' };
  }
  if (result.kind === 'replayed') {
    return { kind: 'replayed', receipt };
  }
  if (result.kind === 'finalization_conflict') {
    return { kind: 'conflict', reasonCode: 'collection-revision-stale' };
  }
  return {
    kind: 'applied',
    review: result.review,
    receipt,
    ...(finalizationPlan ? { finalization: finalizationPlan.finalization } : {}),
  };
}

/** AC6 提交:review 与 Task transition 在同一 UoW 事务内原子完成。 */
async function commitReviewWithTaskReject(
  deps: PackageReviewHandlerDeps,
  input: SubmitPackageReviewCommandInput,
  commandHash: string,
  review: PackageReviewRecord,
  now: number,
  taskId: string,
  rejectReason: string,
  rejectTargetNodeKind?: 'root' | 'subtask',
): Promise<SubmitPackageReviewResult> {
  const { repositories, ids } = deps;
  const receipt = buildReceipt(ids, input, commandHash, review, now, {
    taskId,
    // AC10：replay 恢复首次事实所需——subtask 首次退回 → todo;root 首次退回 → in_progress。
    taskStatusAfterReject: rejectTargetNodeKind === 'root' ? 'in_progress' : 'todo',
  });
  const tombstone: PackageReviewTombstoneRecord = {
    id: ids.nextId(),
    teamId: input.teamId,
    commandName: input.commandName,
    idempotencyKey: input.idempotencyKey,
    commandHash,
    receiptId: receipt.receiptId,
    outcome: 'applied',
    resultAvailable: true,
    createdAt: now,
  };

  try {
    const outcome = await repositories.taskCoordinationUnitOfWork.run(async (repos) => {
      // 1. review 落库(sqlite:外层 BEGIN 内的嵌套 SAVEPOINT;memory:外层快照回滚兜底)。
      const result = await repos.packageReviews.recordPackageReview({
        review,
        mutation: {
          teamId: input.teamId,
          channelId: input.channelId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: commandHash,
          createdAt: now,
        },
        receipt,
        tombstone,
      });
      if (result.kind === 'idempotency_conflict') throw new PackageReviewAbort('idempotency-conflict');
      if (result.kind === 'version_scope_conflict') throw new PackageReviewAbort('version-not-in-collection');
      if (result.kind === 'replayed') throw new PackageReviewAbort('idempotency-replay');
      // 2. Task transition(UoW 原语,逻辑与 task-lifecycle-kernel 的 reject 命令对齐)。
      return applyTaskRejectInUnitOfWork(repos, {
        taskId,
        expectedTaskRevision: input.expectedTaskRevision ?? 0,
        expectedTaskAttempt: input.expectedTaskAttempt,
        reason: rejectReason,
        actorId: input.userId,
        now,
        idempotencyKey: input.idempotencyKey,
        ids,
      });
    });
    return {
      kind: 'applied',
      review,
      receipt,
      taskTransition: {
        taskId,
        taskRevision: outcome.taskRevision,
        taskAttempt: outcome.taskAttempt,
        status: outcome.status,
      },
    };
  } catch (error) {
    if (error instanceof PackageReviewAbort) {
      return error.reasonCode === 'idempotency-replay'
        ? { kind: 'replayed', receipt }
        : { kind: 'conflict', reasonCode: error.reasonCode };
    }
    // 事务失败(校验/并发冲突)统一映射为 conflict,无部分事实。
    return { kind: 'conflict', reasonCode: 'transaction-failed' };
  }
}

function buildReceipt(
  ids: { nextId(): string },
  input: SubmitPackageReviewCommandInput,
  commandHash: string,
  review: PackageReviewRecord,
  now: number,
  taskTransition?: { taskId: string; taskStatusAfterReject: string },
): PackageReviewReceiptRecord {
  return {
    receiptId: ids.nextId(),
    teamId: input.teamId,
    commandName: input.commandName,
    commandSchemaVersion: PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    commandHash,
    outcome: 'applied',
    committedRevisions: [{ streamKind: 'project-artifact-review', streamId: review.id, revision: 1 }],
    eventRefs: [],
    commitTime: now,
    resultAvailable: true,
    // 完整 review 快照:同 key replay 时 usecase 可从 receipt 恢复既有事实(AC10)。
    resultJson: JSON.stringify({
      review: {
        id: review.id, teamId: review.teamId, channelId: review.channelId,
        collectionId: review.collectionId, versionId: review.versionId,
        ...(review.stageId ? { stageId: review.stageId } : {}),
        packageId: review.packageId, deliveryId: review.deliveryId, taskId: review.taskId,
        taskRevision: review.taskRevision, taskAttempt: review.taskAttempt,
        authorityBasis: review.authorityBasis, decision: review.decision,
        comment: review.comment, reviewedBy: review.reviewedBy, createdAt: review.createdAt,
      },
      ...(taskTransition ? { task: taskTransition } : {}),
    }),
    createdAt: now,
  };
}

/** UoW 事务内的 Task reject 原语(reject-subtask / reject-root-delivery 语义,与 kernel 对齐)。 */
async function applyTaskRejectInUnitOfWork(
  repos: import('./task-coordination-unit-of-work.js').TaskCoordinationTransactionRepositories,
  input: {
    taskId: string;
    expectedTaskRevision: number;
    expectedTaskAttempt?: number;
    reason: string;
    actorId: string;
    now: number;
    idempotencyKey: string;
    ids: { nextId(): string };
  },
): Promise<{ taskRevision: number; taskAttempt: number; status: string }> {
  const { taskId, reason, actorId, now, idempotencyKey, ids } = input;
  const task = await repos.tasks.getById(taskId);
  if (!task || task.revision !== input.expectedTaskRevision) {
    throw new PackageReviewAbort('task-revision-stale');
  }
  if (task.status !== 'in_review') {
    throw new PackageReviewAbort('delivery-not-reviewable');
  }
  const coord = await repos.coordination.coordinations.getByTaskId(taskId);
  if (!coord) throw new PackageReviewAbort('delivery-not-found');

  if (coord.nodeKind === 'subtask') {
    if (input.expectedTaskAttempt !== undefined && coord.attempt !== input.expectedTaskAttempt) {
      throw new PackageReviewAbort('task-attempt-stale');
    }
    const claim = await repos.coordination.claimLeases.getCurrent({
      taskId, taskRevision: task.revision, taskAttempt: coord.attempt,
    });
    const waitingForUser = coord.attempt >= coord.maxAttempts || requiresHumanIntervention(reason);
    const nextAttempt = waitingForUser ? coord.attempt : coord.attempt + 1;
    const updatedCoord = nextAttempt === coord.attempt ? coord
      : await repos.coordination.coordinations.update({
        expectedTaskRevision: task.revision,
        record: { ...coord, attempt: nextAttempt, updatedAt: now },
      });
    if (!updatedCoord) throw new PackageReviewAbort('task-attempt-stale');
    const updated = await repos.tasks.update({ taskId, changes: { status: 'todo', updatedAt: now } });
    if (!updated) throw new PackageReviewAbort('task-revision-stale');
    await appendTaskEvent(repos, {
      managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind: 'human',
      actorId, idempotencyKey,
      payload: {
        taskId, taskRevision: task.revision, from: 'in_review', to: 'todo', reason,
      },
    }, now, ids, '');
    await invalidateCapturedClaim(repos, coord.managementRunId, actorId,
      `${idempotencyKey}:claim-invalidated`, '', claim, reason, now, ids);
    return { taskRevision: task.revision, taskAttempt: updatedCoord.attempt, status: 'todo' };
  }

  // root:revision bump + coordination 更新 + run 回 running(与 reject-root-delivery 对齐,AC4)。
  if (coord.nodeKind !== 'root') {
    throw new PackageReviewAbort('delivery-not-found');
  }
  const run = await repos.management.runs.getById(coord.managementRunId);
  if (!run || run.status !== 'in_review') {
    throw new PackageReviewAbort('delivery-not-reviewable');
  }
  const revDecision = evaluateRejectRevision(task.revision);
  if (revDecision.kind === 'rejected') throw new PackageReviewAbort('task-revision-stale');
  const nextRevision = revDecision.nextRevision!;
  const updatedTask = await repos.tasks.updateAtRevision({
    taskId, expectedRevision: task.revision, nextRevision,
    reasonCode: 'HUMAN_REJECTED_ROOT_DELIVERY',
    changes: { status: 'in_progress', updatedAt: now },
  });
  if (!updatedTask) throw new PackageReviewAbort('task-revision-stale');
  const updatedCoord = await repos.coordination.coordinations.update({
    expectedTaskRevision: task.revision,
    record: { ...coord, taskRevision: nextRevision, attempt: 1, updatedAt: now },
  });
  if (!updatedCoord) throw new PackageReviewAbort('task-revision-stale');
  // 与 kernel 对齐:task-revised 事件携带当前 revision 的 active criteria id。
  const criteria = activeCriteria(await repos.coordination.criteria.list(task.id), task.revision);
  await appendTaskEvent(repos, {
    managementRunId: coord.managementRunId, type: 'task-revised', actorKind: 'human',
    actorId, idempotencyKey,
    payload: {
      taskId, previousRevision: task.revision, taskRevision: nextRevision,
      criterionIds: criteria.map((c) => c.id), reasonCode: 'HUMAN_REJECTED_ROOT_DELIVERY', reason,
    },
  }, now, ids, '');
  await appendTaskEvent(repos, {
    managementRunId: coord.managementRunId, type: 'task-state-changed', actorKind: 'human',
    actorId, idempotencyKey: `${idempotencyKey}:state`,
    payload: { taskId, taskRevision: nextRevision, from: 'in_review', to: 'in_progress', reason },
  }, now, ids, '');
  await repos.management.runs.update({ ...run, status: 'running', updatedAt: now });
  return { taskRevision: nextRevision, taskAttempt: 1, status: 'in_progress' };
}

class PackageReviewAbort extends Error {
  constructor(public readonly reasonCode: string) {
    super(reasonCode);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
