import type { PackageReviewAuthorityBasisKind, PackageReviewRejectionReason, ProjectArtifactReviewDecision } from '@agentbean/contracts';
import {
  hasProjectArtifactDecisionAuthority,
  type ProjectArtifactAuthorityFacts,
} from './project-artifact-review-policy.js';

/**
 * #1061 分离文件审核、Task 交付验收与最终版设置的纯策略(父规格 #1059 §5)。
 *
 * 三类事实彼此独立:
 * - ArtifactReview:绑定 package/collection/version/delivery/Task revision/attempt 与 reviewer
 *   authority basis(AC1),append-only;
 * - Task delivery 验收:子 Task 客观验收仅 PI authority,主观/高风险用创建时预绑定的人类
 *   authority token(AC3);根 Task 由当前 Human review authority 验收(AC4);
 * - finalization:只指向符合策略且仍有有效 approved review 的版本(AC7),人工编辑/Agent 修订/
 *   Task 状态变化均不自动移动 final(AC8)。
 *
 * 权限分离(AC2):频道成员资格只是可见性与候选门禁;Team Owner/Admin、建议审核人、Task
 * assignee、Agent 或 PI Manager 不因角色名称自动取得审核/验收/最终化权。本文件只做判定,
 * 事实(Team 角色/Stage reviewer/coordination 预绑定 ids/package 成员)全部由 Server 加载。
 */

/** 审核/验收/最终化的操作者种类。`agent` 覆盖一切黑盒 Agent/Daemon 来源。 */
export type PackageReviewActorKind = 'human' | 'pi_manager' | 'agent';

// ---------------------------------------------------------------------------
// AC1/AC2:package 文件审核 authority
// ---------------------------------------------------------------------------

export type PackageReviewRejection =
  | 'actor_not_human'
  | 'actor_not_authorized'
  | 'invalid_decision'
  | 'package_not_found'
  | 'package_out_of_scope'
  | 'version_not_in_package'
  | 'version_not_in_collection';

export type PackageArtifactReviewAuthorityDecision =
  | { kind: 'allowed'; authorityBasis: PackageReviewAuthorityBasisKind }
  | { kind: 'rejected'; reasonCode: PackageReviewRejection };

export interface PackageArtifactReviewFacts {
  /** package 与受审 version 的频道作用域。 */
  readonly teamId: string;
  readonly channelId: string;
  /** #824 同款 authority 事实(owner/admin/projectLead/stageReviewer)。 */
  readonly actorFacts: ProjectArtifactAuthorityFacts;
  /** package 快照;null = 不存在。 */
  readonly package: {
    readonly id: string;
    readonly teamId: string;
    readonly channelId: string;
    /** 冻结成员(collectionId+artifactVersionId)。 */
    readonly members: readonly { readonly collectionId: string; readonly artifactVersionId: string }[];
  } | null;
  /** 目标 collection/version 作用域校验事实。 */
  readonly versionScope: {
    readonly collectionId: string;
    readonly versionId: string;
    /** 目标版本实际所属 collection;null = 版本不存在。 */
    readonly versionCollectionId?: string;
    /** package 成员 collection 的当前 Server 版本；允许包入口审核人工/Agent 修订后的 current。 */
    readonly currentVersionId?: string;
  };
}

export interface PackageBatchReviewTargetFacts {
  readonly collectionId: string;
  readonly artifactVersionId: string;
  readonly versionCollectionId?: string;
  readonly currentVersionId?: string;
  readonly actorFacts: ProjectArtifactAuthorityFacts;
}

export type PackageBatchReviewFailureReason = PackageReviewRejection
  | 'delivery_revision_stale'
  | 'package_revision_stale'
  | 'batch_targets_required'
  | 'duplicate_target'
  | 'version_not_current';

export interface PackageBatchReviewFailure {
  readonly collectionId?: string;
  readonly artifactVersionId?: string;
  readonly reasonCode: PackageBatchReviewFailureReason;
}

export type PackageBatchArtifactReviewDecision =
  | { readonly kind: 'allowed'; readonly targets: readonly (PackageBatchReviewTargetFacts & {
    readonly authorityBasis: PackageReviewAuthorityBasisKind;
  })[] }
  | { readonly kind: 'rejected'; readonly failures: readonly PackageBatchReviewFailure[] };

/**
 * #1199 批量审核策略：只接受当前 delivery/package revision 下显式列出的 current 版本。
 * 对全部目标完成作用域、stale 与逐 Stage authority 校验后才允许持久层一次性写入。
 */
export function evaluatePackageBatchArtifactReview(input: {
  readonly actorKind: PackageReviewActorKind;
  readonly teamId: string;
  readonly channelId: string;
  readonly package: {
    readonly id: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly deliveryId: string;
    readonly revision: number;
    readonly members: readonly { readonly collectionId: string; readonly artifactVersionId: string }[];
  } | null;
  readonly deliveryId: string;
  readonly expectedPackageRevision: number;
  readonly decision: unknown;
  readonly targets: readonly PackageBatchReviewTargetFacts[];
}): PackageBatchArtifactReviewDecision {
  if (input.actorKind !== 'human') {
    return { kind: 'rejected', failures: [{ reasonCode: 'actor_not_human' }] };
  }
  if (!isPackageArtifactReviewDecision(input.decision)) {
    return { kind: 'rejected', failures: [{ reasonCode: 'invalid_decision' }] };
  }
  if (!input.package) return { kind: 'rejected', failures: [{ reasonCode: 'package_not_found' }] };
  if (input.package.teamId !== input.teamId || input.package.channelId !== input.channelId) {
    return { kind: 'rejected', failures: [{ reasonCode: 'package_out_of_scope' }] };
  }
  if (input.package.deliveryId !== input.deliveryId) {
    return { kind: 'rejected', failures: [{ reasonCode: 'delivery_revision_stale' }] };
  }
  if (input.package.revision !== input.expectedPackageRevision) {
    return { kind: 'rejected', failures: [{ reasonCode: 'package_revision_stale' }] };
  }
  if (input.targets.length === 0) {
    return { kind: 'rejected', failures: [{ reasonCode: 'batch_targets_required' }] };
  }

  const seenVersions = new Set<string>();
  const failures: PackageBatchReviewFailure[] = [];
  const allowed: (PackageBatchReviewTargetFacts & { authorityBasis: PackageReviewAuthorityBasisKind })[] = [];
  for (const target of input.targets) {
    const identity = { collectionId: target.collectionId, artifactVersionId: target.artifactVersionId };
    if (seenVersions.has(target.artifactVersionId)) {
      failures.push({ ...identity, reasonCode: 'duplicate_target' });
      continue;
    }
    seenVersions.add(target.artifactVersionId);
    const member = input.package.members.find((candidate) => candidate.collectionId === target.collectionId);
    if (!member) {
      failures.push({ ...identity, reasonCode: 'version_not_in_package' });
      continue;
    }
    if (target.versionCollectionId !== target.collectionId) {
      failures.push({ ...identity, reasonCode: 'version_not_in_collection' });
      continue;
    }
    if (target.currentVersionId !== target.artifactVersionId) {
      failures.push({ ...identity, reasonCode: 'version_not_current' });
      continue;
    }
    if (!hasProjectArtifactDecisionAuthority(target.actorFacts)) {
      failures.push({ ...identity, reasonCode: 'actor_not_authorized' });
      continue;
    }
    allowed.push({ ...target, authorityBasis: deriveAuthorityBasis(target.actorFacts) });
  }
  return failures.length > 0 ? { kind: 'rejected', failures } : { kind: 'allowed', targets: allowed };
}

export function isPackageArtifactReviewDecision(value: unknown): value is ProjectArtifactReviewDecision {
  return value === 'approved' || value === 'rejected' || value === 'changes_requested';
}

/**
 * 判定人类能否对 package 成员版本提交审核(AC1/AC2)。
 * 复用 #824 的 authority 判定(owner/admin/projectLead/stageReviewer);Agent/PI Manager 一律
 * 拒绝;建议审核人、Task assignee 不因角色名称取得审核权(不在判定事实内,自然不通过)。
 */
export function evaluatePackageArtifactReviewAuthority(input: {
  readonly actorKind: PackageReviewActorKind;
  readonly facts: PackageArtifactReviewFacts;
  readonly decision: unknown;
}): PackageArtifactReviewAuthorityDecision {
  if (input.actorKind !== 'human') {
    return { kind: 'rejected', reasonCode: 'actor_not_human' };
  }
  if (!isPackageArtifactReviewDecision(input.decision)) {
    return { kind: 'rejected', reasonCode: 'invalid_decision' };
  }
  const pkg = input.facts.package;
  if (!pkg) return { kind: 'rejected', reasonCode: 'package_not_found' };
  if (pkg.teamId !== input.facts.teamId || pkg.channelId !== input.facts.channelId) {
    return { kind: 'rejected', reasonCode: 'package_out_of_scope' };
  }
  const member = pkg.members.find((candidate) => candidate.collectionId === input.facts.versionScope.collectionId);
  const isDeliveredVersion = member?.artifactVersionId === input.facts.versionScope.versionId;
  const isCurrentVersion = input.facts.versionScope.currentVersionId === input.facts.versionScope.versionId;
  if (!member || (!isDeliveredVersion && !isCurrentVersion)) {
    return { kind: 'rejected', reasonCode: 'version_not_in_package' };
  }
  if (input.facts.versionScope.versionCollectionId !== undefined
    && input.facts.versionScope.versionCollectionId !== input.facts.versionScope.collectionId) {
    return { kind: 'rejected', reasonCode: 'version_not_in_collection' };
  }
  if (!hasProjectArtifactDecisionAuthority(input.facts.actorFacts)) {
    return { kind: 'rejected', reasonCode: 'actor_not_authorized' };
  }
  return { kind: 'allowed', authorityBasis: deriveAuthorityBasis(input.facts.actorFacts) };
}

/** 从 #824 authority 事实推导本次审核的 authority basis(审计用,AC1)。 */
export function deriveAuthorityBasis(facts: ProjectArtifactAuthorityFacts): PackageReviewAuthorityBasisKind {
  if (facts.teamRole === 'owner') return 'team-owner';
  if (facts.teamRole === 'admin') return 'team-admin';
  if (facts.userId === facts.projectLeadId) return 'project-lead';
  return 'stage-reviewer-delegation';
}

// ---------------------------------------------------------------------------
// AC3:子 Task 人类验收 authority token(创建时预绑定,绑定当前 revision/attempt/delivery)
// ---------------------------------------------------------------------------

/**
 * 子 Task delivery 的验收 authority:
 * - 客观验收(criteria/evidence 全部满足且无高风险/冲突证据)由 PI authority 执行,不需要人类;
 * - 主观或高风险验收必须由创建时预绑定在 coordination 上的人类 authority 执行(AC3)。
 * token 绑定当前 revision/attempt/delivery:验收输入必须携带与当前 coordination 一致的
 * deliveryId/claimLeaseId,revision/attempt 漂移即 token 失效(由 kernel 既有 fence 校验)。
 */
export function evaluateSubtaskHumanAcceptanceAuthority(input: {
  readonly actorId: string;
  /** coordination 创建时预绑定的人类验收者;空 = 未绑定(人类不得验收)。 */
  readonly preboundAuthorityIds: readonly string[];
}): { kind: 'allowed' } | { kind: 'rejected'; reasonCode: 'actor_not_authorized' } {
  if (!input.preboundAuthorityIds.includes(input.actorId)) {
    return { kind: 'rejected', reasonCode: 'actor_not_authorized' };
  }
  return { kind: 'allowed' };
}

// ---------------------------------------------------------------------------
// AC4:根 Task Human review authority(创建时预绑定)
// ---------------------------------------------------------------------------

/** 根 Task delivery 的验收 authority:当前 Human review authority 接受才进入 done(AC4)。 */
export function evaluateRootHumanReviewAuthority(input: {
  readonly actorId: string;
  /** root coordination 创建时预绑定(默认 requester);空 = 未绑定(无人可验收,需治理介入)。 */
  readonly preboundAuthorityIds: readonly string[];
}): { kind: 'allowed' } | { kind: 'rejected'; reasonCode: 'actor_not_authorized' } {
  if (!input.preboundAuthorityIds.includes(input.actorId)) {
    return { kind: 'rejected', reasonCode: 'actor_not_authorized' };
  }
  return { kind: 'allowed' };
}

// ---------------------------------------------------------------------------
// AC9:"通过并设为最终版"组合决策(一个事务两个独立事实)
// ---------------------------------------------------------------------------

export type PackageReviewFinalizeRejection =
  | PackageReviewRejection
  | 'collection_not_found'
  | 'collection_out_of_scope'
  | 'collection_revision_stale';

export type PackageReviewAndFinalizeDecision =
  | { kind: 'finalize' }
  | { kind: 'rejected'; reasonCode: PackageReviewFinalizeRejection };

/**
 * 组合命令决策(AC9):review authority 与 finalization authority 在 #824 合同下同源
 * (owner/admin/projectLead/stageReviewer 同时持有两权),因此一次 `hasProjectArtifactDecisionAuthority`
 * 判定即同时满足双 authority;集合 revision fence 校验;通过后由持久层在一个事务内写入
 * review 记录与 finalization 记录两个独立事实,并以本次 review 为 basisReviewId(组合语义:
 * review 写入后即最新,不要求预置 approved;AC7 的"仍有效 approved review"门槛由最终化
 * 落库时复核保证)。
 */
export function evaluatePackageReviewAndFinalize(input: {
  readonly actorKind: PackageReviewActorKind;
  readonly facts: PackageArtifactReviewFacts;
  readonly decision: unknown;
  readonly collection: {
    readonly id: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly revision: number;
  } | null;
  readonly expectedCollectionRevision: number;
}): PackageReviewAndFinalizeDecision {
  const review = evaluatePackageArtifactReviewAuthority({
    actorKind: input.actorKind,
    facts: input.facts,
    decision: input.decision,
  });
  if (review.kind === 'rejected') return { kind: 'rejected', reasonCode: review.reasonCode };
  const collection = input.collection;
  if (!collection) return { kind: 'rejected', reasonCode: 'collection_not_found' };
  if (collection.teamId !== input.facts.teamId || collection.channelId !== input.facts.channelId) {
    return { kind: 'rejected', reasonCode: 'collection_out_of_scope' };
  }
  if (collection.revision !== input.expectedCollectionRevision) {
    return { kind: 'rejected', reasonCode: 'collection_revision_stale' };
  }
  return { kind: 'finalize' };
}

// ---------------------------------------------------------------------------
// AC6:审核(changes_requested/rejected)与退回 Task delivery 组合决策
// ---------------------------------------------------------------------------

export type PackageReviewRejectDeliveryRejection =
  | PackageReviewRejection
  | 'delivery_not_found'
  | 'delivery_out_of_scope'
  | 'delivery_not_reviewable'
  | 'task_revision_stale'
  | 'task_attempt_stale'
  | 'review_required_before_reject';

export type PackageReviewAndRejectDeliveryDecision =
  | { kind: 'reject-delivery' }
  | { kind: 'rejected'; reasonCode: PackageReviewRejectDeliveryRejection };

/**
 * 组合命令决策(AC6):审核结论必须为 changes_requested/rejected,退回目标必须是当前
 * Task revision/attempt 上处于 review 中的 delivery;由持久层在一个事务内写入 review 记录
 * 与 Task transition(子 Task 产生新 attempt;根 Task 产生新 revision 并恢复 in_progress)。
 */
export function evaluatePackageReviewAndRejectDelivery(input: {
  readonly actorKind: PackageReviewActorKind;
  readonly facts: PackageArtifactReviewFacts;
  readonly decision: unknown;
  /** package 绑定的 Task(delivery 退回目标);null = package 无 managed Task 绑定。 */
  readonly task: {
    readonly id: string;
    readonly teamId: string;
    readonly channelId?: string;
    readonly revision: number;
    readonly nodeKind: 'root' | 'subtask';
    readonly attempt: number;
    readonly status: string;
  } | null;
  readonly expectedTaskRevision: number;
  readonly expectedTaskAttempt?: number;
}): PackageReviewAndRejectDeliveryDecision {
  const review = evaluatePackageArtifactReviewAuthority({
    actorKind: input.actorKind,
    facts: input.facts,
    decision: input.decision,
  });
  if (review.kind === 'rejected') return { kind: 'rejected', reasonCode: review.reasonCode };
  if (input.decision === 'approved') {
    return { kind: 'rejected', reasonCode: 'review_required_before_reject' };
  }
  const task = input.task;
  if (!task) return { kind: 'rejected', reasonCode: 'delivery_not_found' };
  if (task.teamId !== input.facts.teamId || (task.channelId !== undefined && task.channelId !== input.facts.channelId)) {
    return { kind: 'rejected', reasonCode: 'delivery_out_of_scope' };
  }
  if (task.revision !== input.expectedTaskRevision) {
    return { kind: 'rejected', reasonCode: 'task_revision_stale' };
  }
  if (task.nodeKind === 'subtask') {
    if (input.expectedTaskAttempt === undefined || task.attempt !== input.expectedTaskAttempt) {
      return { kind: 'rejected', reasonCode: 'task_attempt_stale' };
    }
  }
  if (task.status !== 'in_review') {
    return { kind: 'rejected', reasonCode: 'delivery_not_reviewable' };
  }
  return { kind: 'reject-delivery' };
}

/** 结构化拒绝码映射:domain 内部码 → contracts 公开拒绝码(供 handler/response 使用)。 */
export function mapPackageReviewRejection(
  reasonCode: PackageReviewRejection
    | PackageReviewFinalizeRejection
    | PackageReviewRejectDeliveryRejection
    | 'actor_not_authorized',
): PackageReviewRejectionReason {
  const map: Record<string, PackageReviewRejectionReason> = {
    actor_not_human: 'actor-not-human',
    actor_not_authorized: 'actor-not-authorized',
    invalid_decision: 'invalid-decision',
    package_not_found: 'package-not-found',
    package_out_of_scope: 'package-out-of-scope',
    version_not_in_package: 'version-not-in-package',
    version_not_in_collection: 'version-not-in-collection',
    collection_not_found: 'package-not-found',
    collection_out_of_scope: 'package-out-of-scope',
    collection_revision_stale: 'collection-revision-stale',
    delivery_not_found: 'delivery-not-found',
    delivery_out_of_scope: 'delivery-out-of-scope',
    delivery_not_reviewable: 'delivery-not-reviewable',
    task_revision_stale: 'task-revision-stale',
    task_attempt_stale: 'task-attempt-stale',
    review_required_before_reject: 'review-required-before-reject',
  };
  return map[reasonCode] ?? 'invalid-request';
}

export function mapPackageBatchReviewRejection(reasonCode: PackageBatchReviewFailureReason): PackageReviewRejectionReason {
  const batchMap: Partial<Record<PackageBatchReviewFailureReason, PackageReviewRejectionReason>> = {
    delivery_revision_stale: 'delivery-revision-stale',
    package_revision_stale: 'package-revision-stale',
    batch_targets_required: 'batch-targets-required',
    duplicate_target: 'duplicate-target',
    version_not_current: 'version-not-current',
  };
  return batchMap[reasonCode] ?? mapPackageReviewRejection(reasonCode as PackageReviewRejection);
}
