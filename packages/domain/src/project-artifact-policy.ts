import type { ProjectArtifactLineageKind, ProjectArtifactLineageRefDto } from '@agentbean/contracts';

/**
 * #823 将既有 Artifact 提升为逻辑产物版本的纯策略。
 *
 * 设计要点：
 * - 集合身份与业务类型只来自显式请求；文件名、目录、mime、pathKind 不参与本判定（AC#5）。
 * - 同一 Artifact 在同一频道至多对应一个版本，重复提升返回既有版本（AC#3 幂等）。
 * - 版本序号与 current pointer 由集合已有版本数与 revision fence 共同决定，
 *   并发写入时由持久层用同一判定在事务内复核（AC#3 一致性）。
 */

export type ProjectArtifactPromotionRejectionCode =
  | 'collection_not_found'
  | 'collection_out_of_scope'
  | 'collection_revision_stale'
  | 'collection_name_conflict'
  | 'artifact_promoted_to_other_collection'
  | 'collection_target_ambiguous';

export interface ProjectArtifactCollectionSnapshot {
  id: string;
  teamId: string;
  channelId: string;
  name: string;
  revision: number;
  versionCount: number;
}

export interface ExistingProjectArtifactVersionSnapshot {
  id: string;
  collectionId: string;
}

export type ProjectArtifactPromotionDecision =
  | {
    kind: 'replay_existing_version';
    collectionId: string;
    versionId: string;
  }
  | {
    kind: 'create_collection';
    versionNumber: 1;
    collectionRevision: 1;
  }
  | {
    kind: 'append_version';
    collectionId: string;
    versionNumber: number;
    collectionRevision: number;
  }
  | {
    kind: 'rejected';
    reasonCode: ProjectArtifactPromotionRejectionCode;
  };

export function evaluateArtifactPromotion(input: {
  teamId: string;
  channelId: string;
  /** 请求追加到的既有集合 id；缺省表示创建新集合。 */
  requestedCollectionId?: string;
  /** 追加到既有集合时的 revision fence。 */
  expectedCollectionRevision?: number;
  /** 创建新集合时的显式名称。 */
  requestedCollectionName?: string;
  /** requestedCollectionId 对应的集合快照；不存在为 null。 */
  targetCollection?: ProjectArtifactCollectionSnapshot | null;
  /** 同频道内已有的集合名称，用于稳定身份去重。 */
  existingCollectionNames?: readonly string[];
  /** 该 Artifact 已存在的版本；存在即命中幂等路径。 */
  existingVersionForArtifact?: ExistingProjectArtifactVersionSnapshot | null;
}): ProjectArtifactPromotionDecision {
  const existingVersion = input.existingVersionForArtifact ?? null;
  if (existingVersion) {
    // 自然幂等键是 Artifact 自身：同一 Artifact 在同一频道至多一个版本。
    // 重试（无论是否带上目标集合）都回放既有版本；只有显式指向另一个集合才是冲突。
    if (input.requestedCollectionId && input.requestedCollectionId !== existingVersion.collectionId) {
      return { kind: 'rejected', reasonCode: 'artifact_promoted_to_other_collection' };
    }
    return {
      kind: 'replay_existing_version',
      collectionId: existingVersion.collectionId,
      versionId: existingVersion.id,
    };
  }

  if (input.requestedCollectionId) {
    const collection = input.targetCollection ?? null;
    if (!collection) {
      return { kind: 'rejected', reasonCode: 'collection_not_found' };
    }
    if (collection.id !== input.requestedCollectionId
      || collection.teamId !== input.teamId
      || collection.channelId !== input.channelId) {
      return { kind: 'rejected', reasonCode: 'collection_out_of_scope' };
    }
    if (collection.revision !== input.expectedCollectionRevision) {
      return { kind: 'rejected', reasonCode: 'collection_revision_stale' };
    }
    return {
      kind: 'append_version',
      collectionId: collection.id,
      versionNumber: collection.versionCount + 1,
      collectionRevision: collection.revision + 1,
    };
  }

  if (input.targetCollection) {
    return { kind: 'rejected', reasonCode: 'collection_target_ambiguous' };
  }
  const requestedName = (input.requestedCollectionName ?? '').trim();
  if (requestedName.length > 0
    && (input.existingCollectionNames ?? []).some((name) => name === requestedName)) {
    return { kind: 'rejected', reasonCode: 'collection_name_conflict' };
  }
  return { kind: 'create_collection', versionNumber: 1, collectionRevision: 1 };
}

export type ProjectArtifactLineageRejectionCode =
  | 'lineage_duplicate'
  | 'lineage_out_of_scope'
  | 'lineage_self_reference';

export interface ProjectArtifactLineageCandidate extends ProjectArtifactLineageRefDto {
  /** 该引用在持久层解析出的作用域；解析不到时传 null 表示不可见。 */
  scope: { teamId: string; channelId: string } | null;
}

export type ProjectArtifactLineageEvaluation =
  | { ok: true; lineage: ProjectArtifactLineageRefDto[] }
  | { ok: false; reasonCode: ProjectArtifactLineageRejectionCode };

export function evaluateProjectArtifactLineage(input: {
  teamId: string;
  channelId: string;
  /** 本次提升的 Artifact；lineage 不得自引用。 */
  promotedArtifactId: string;
  candidates: readonly ProjectArtifactLineageCandidate[];
}): ProjectArtifactLineageEvaluation {
  const seen = new Set<string>();
  const lineage: ProjectArtifactLineageRefDto[] = [];
  for (const candidate of input.candidates) {
    const key = `${candidate.kind}:${candidate.refId}`;
    if (seen.has(key)) {
      return { ok: false, reasonCode: 'lineage_duplicate' };
    }
    seen.add(key);
    if (candidate.kind === 'artifact' && candidate.refId === input.promotedArtifactId) {
      return { ok: false, reasonCode: 'lineage_self_reference' };
    }
    if (!candidate.scope
      || candidate.scope.teamId !== input.teamId
      || candidate.scope.channelId !== input.channelId) {
      return { ok: false, reasonCode: 'lineage_out_of_scope' };
    }
    lineage.push({ kind: candidate.kind, refId: candidate.refId });
  }
  return { ok: true, lineage };
}

export function isProjectArtifactLineageKind(value: unknown): value is ProjectArtifactLineageKind {
  return value === 'project_version' || value === 'artifact';
}
