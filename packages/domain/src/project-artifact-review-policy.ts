import type {
  ProjectArtifactReviewDecision,
  ProjectArtifactVersionReviewState,
} from '@agentbean/contracts';

/**
 * #824 人工审核产物版本与切换唯一最终版的纯策略。
 *
 * 设计要点：
 * - 审核与最终化都只接受人类决定；Agent 一律拒绝，PI Manager 只能在携带人类确认引用时代表用户最终化（AC#3/AC#6）。
 * - 版本审核状态取**最新一条**审核记录的 decision，因此「要求修改」对最终化真正有约束力（AC#2/AC#4）。
 * - 最终版是集合上的单一指针：唯一性由「只有一个 finalVersionId」结构性保证，
 *   并发切换由集合 revision fence 收敛，持久层在同一事务内用同样的判定复核（AC#4/AC#5）。
 * - 审核记录只追加：本策略从不产生「修改既有审核」的结论，旧记录永远原样保留（AC#2）。
 */

/** 提交决定的操作者种类。`agent` 覆盖一切黑盒 Agent/Daemon 来源。 */
export type ProjectArtifactActorKind = 'human' | 'pi_manager' | 'agent';

/**
 * 判定审核/最终化权限所需的事实。
 * 注意 `stageReviewerIds` 是**受审版本所属 Stage** 的审核者，不是频道全体成员：
 * 普通成员的 Markdown 编辑权不出现在这里，因此编辑权不可能隐含审核权（AC#3）。
 */
export interface ProjectArtifactAuthorityFacts {
  userId: string;
  teamRole: 'owner' | 'admin' | 'member' | null;
  projectLeadId: string;
  stageReviewerIds: readonly string[];
}

export function hasProjectArtifactDecisionAuthority(facts: ProjectArtifactAuthorityFacts): boolean {
  if (facts.teamRole !== 'owner' && facts.teamRole !== 'admin' && facts.teamRole !== 'member') {
    // 非团队成员没有任何项目决定权，即使 id 恰好等于项目负责人。
    return false;
  }
  return facts.teamRole === 'owner'
    || facts.teamRole === 'admin'
    || facts.userId === facts.projectLeadId
    || facts.stageReviewerIds.includes(facts.userId);
}

export type ProjectArtifactReviewRejectionCode =
  | 'actor_not_human'
  | 'actor_not_authorized'
  | 'invalid_decision';

export type ProjectArtifactReviewAuthorityDecision =
  | { kind: 'allowed' }
  | { kind: 'rejected'; reasonCode: ProjectArtifactReviewRejectionCode };

/**
 * AC#1/AC#3：项目负责人、该 Stage 的审核者与 Team owner/admin 可以审核；
 * 其他成员、Agent 与 PI Manager 都不能审核 —— Manager 的授权上限是「代表用户最终化」，不含审核。
 */
export function evaluateArtifactReviewAuthority(input: {
  actorKind: ProjectArtifactActorKind;
  facts: ProjectArtifactAuthorityFacts;
  decision: ProjectArtifactReviewDecision;
}): ProjectArtifactReviewAuthorityDecision {
  if (input.actorKind !== 'human') {
    return { kind: 'rejected', reasonCode: 'actor_not_human' };
  }
  if (!isProjectArtifactReviewDecision(input.decision)) {
    return { kind: 'rejected', reasonCode: 'invalid_decision' };
  }
  if (!hasProjectArtifactDecisionAuthority(input.facts)) {
    return { kind: 'rejected', reasonCode: 'actor_not_authorized' };
  }
  return { kind: 'allowed' };
}

export interface ProjectArtifactReviewFact {
  id: string;
  versionId: string;
  decision: ProjectArtifactReviewDecision;
  createdAt: number;
}

/**
 * 版本审核状态 = 该版本最新一条审核记录的 decision。
 * 排序键取 `createdAt` 再取 `id`，与持久层 `ORDER BY created_at, id` 完全一致，
 * 因此同一毫秒内的两条决定在 Server 投影与事务复核中得到同一个「最新」。
 */
export function deriveProjectArtifactVersionReviewState(
  reviews: readonly ProjectArtifactReviewFact[],
): ProjectArtifactVersionReviewState {
  const latest = latestProjectArtifactReview(reviews);
  return latest ? latest.decision : 'pending';
}

export function latestProjectArtifactReview(
  reviews: readonly ProjectArtifactReviewFact[],
): ProjectArtifactReviewFact | null {
  let latest: ProjectArtifactReviewFact | null = null;
  for (const review of reviews) {
    if (!latest
      || review.createdAt > latest.createdAt
      || (review.createdAt === latest.createdAt && review.id > latest.id)) {
      latest = review;
    }
  }
  return latest;
}

export type ProjectArtifactFinalizationRejectionCode =
  | 'actor_not_human'
  | 'actor_not_authorized'
  | 'manager_confirmation_missing'
  | 'manager_confirmation_unauthorized'
  | 'collection_not_found'
  | 'collection_out_of_scope'
  | 'collection_revision_stale'
  | 'version_not_in_collection'
  | 'version_not_approved';

export interface ProjectArtifactFinalizationCollectionSnapshot {
  id: string;
  teamId: string;
  channelId: string;
  revision: number;
  /** 尚未最终化时为 undefined。 */
  finalVersionId?: string;
}

export interface ProjectArtifactFinalizationVersionSnapshot {
  id: string;
  collectionId: string;
  /** 该版本已有的全部审核记录；状态由本策略自己派生，调用方不预先结论。 */
  reviews: readonly ProjectArtifactReviewFact[];
}

/**
 * Server 复验后的人类确认事实。`null` 表示 Manager 未携带引用或引用不可解析，
 * 两种情况都归入 `manager_confirmation_missing`：无法证明的确认等于没有确认。
 */
export interface ProjectArtifactHumanConfirmationFacts {
  confirmedBy: string;
  confirmerFacts: ProjectArtifactAuthorityFacts;
}

export type ProjectArtifactFinalizationDecision
  = | {
    /** 目标版本已经是最终版：重复请求回放既有事实，不写新审计。 */
    kind: 'replay_current_final';
    collectionId: string;
    versionId: string;
  }
  | {
    kind: 'finalize';
    collectionId: string;
    versionId: string;
    /** 切换来源；首次最终化为 undefined。 */
    previousVersionId?: string;
    /** 依据的通过审核记录：最终化必须落在一条明确的 approved 审核上。 */
    basisReviewId: string;
    collectionRevision: number;
  }
  | { kind: 'rejected'; reasonCode: ProjectArtifactFinalizationRejectionCode };

export function evaluateProjectArtifactFinalization(input: {
  teamId: string;
  channelId: string;
  actorKind: ProjectArtifactActorKind;
  actorFacts: ProjectArtifactAuthorityFacts;
  /** `pi_manager` 时必填；其他 actor 传入会被忽略。 */
  humanConfirmation?: ProjectArtifactHumanConfirmationFacts | null;
  collection: ProjectArtifactFinalizationCollectionSnapshot | null;
  expectedCollectionRevision: number;
  targetVersion: ProjectArtifactFinalizationVersionSnapshot | null;
}): ProjectArtifactFinalizationDecision {
  if (input.actorKind === 'agent') {
    return { kind: 'rejected', reasonCode: 'actor_not_human' };
  }
  const collection = input.collection ?? null;
  if (!collection) {
    return { kind: 'rejected', reasonCode: 'collection_not_found' };
  }
  if (collection.teamId !== input.teamId || collection.channelId !== input.channelId) {
    return { kind: 'rejected', reasonCode: 'collection_out_of_scope' };
  }
  const version = input.targetVersion ?? null;
  if (!version || version.collectionId !== collection.id) {
    return { kind: 'rejected', reasonCode: 'version_not_in_collection' };
  }
  // 权限先于幂等回放：无权者连「确认既有最终版」都不该得到成功语义。
  if (!hasProjectArtifactDecisionAuthority(input.actorFacts)) {
    return { kind: 'rejected', reasonCode: 'actor_not_authorized' };
  }
  if (input.actorKind === 'pi_manager') {
    const confirmation = input.humanConfirmation ?? null;
    if (!confirmation) {
      return { kind: 'rejected', reasonCode: 'manager_confirmation_missing' };
    }
    if (confirmation.confirmerFacts.userId !== confirmation.confirmedBy
      || !hasProjectArtifactDecisionAuthority(confirmation.confirmerFacts)) {
      return { kind: 'rejected', reasonCode: 'manager_confirmation_unauthorized' };
    }
  }
  if (collection.finalVersionId === version.id) {
    // 幂等：目标已是最终版就回放，不受 revision fence 影响 ——
    // 否则重试必然因为上一次成功已推进 revision 而永远失败。
    return { kind: 'replay_current_final', collectionId: collection.id, versionId: version.id };
  }
  if (collection.revision !== input.expectedCollectionRevision) {
    return { kind: 'rejected', reasonCode: 'collection_revision_stale' };
  }
  const latest = latestProjectArtifactReview(version.reviews);
  if (!latest || latest.decision !== 'approved') {
    // 首次最终化与后续切换用同一道门槛：目标版本当前必须处于通过状态。
    return { kind: 'rejected', reasonCode: 'version_not_approved' };
  }
  return {
    kind: 'finalize',
    collectionId: collection.id,
    versionId: version.id,
    ...(collection.finalVersionId === undefined ? {} : { previousVersionId: collection.finalVersionId }),
    basisReviewId: latest.id,
    collectionRevision: collection.revision + 1,
  };
}

export function isProjectArtifactReviewDecision(value: unknown): value is ProjectArtifactReviewDecision {
  return value === 'approved' || value === 'rejected' || value === 'changes_requested';
}

export function isProjectArtifactReviewBasisKind(
  value: unknown,
): value is 'project_version' | 'artifact' | 'message' {
  return value === 'project_version' || value === 'artifact' || value === 'message';
}
