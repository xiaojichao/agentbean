import type {
  ArtifactRevisionConflictCode,
  ArtifactRevisionRejectionReason,
  ProjectArtifactLineageRefDto,
} from '@agentbean/contracts';

/**
 * #1062 明确版本修订与 Markdown 并发冲突的纯策略(父规格 #1059 §7/§9/§11)。
 *
 * 保存一次 Markdown 修订 = 原子产生新 Artifact + 新 ProjectArtifactVersion +
 * collection.currentVersionId 移动。本文件只做判定:频道/成员/集合/版本/basis/双 fence
 * 事实全部由 Server 加载;applied 计划中的继承来源(stage/task/message/run/invocation)与
 * lineage 一律从 Server 持久化事实推导,客户端不得自报(AC3)。
 *
 * 独立性(AC4):新 revision 不继承旧 ArtifactReview(reviews 按 version_id 索引,新版本
 * 天然零记录)、不触碰 Task delivery/acceptance、不移动 finalVersionId——这三件事在本
 * 策略中体现为「计划里根本没有这些写入」。
 *
 * fail closed(AC8):归档、权限撤销、basis 对不上 → rejected;base/collection/basis review
 * 漂移 → 结构化 conflict;任何失败都不写部分版本。
 */

/** 操作者种类;`agent` 覆盖一切黑盒 Agent/Daemon 来源。 */
export type ArtifactRevisionActorKind = 'human' | 'pi_manager' | 'agent';

/** 版本来源快照(与 ProjectArtifactVersionSourceDto 同形,Server 从持久化事实读取)。 */
export interface ArtifactVersionSourceSnapshot {
  readonly stageId?: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly messageId?: string;
  readonly workspaceRunId?: string;
  readonly invocationId?: string;
}

export interface ArtifactVersionRevisionFacts {
  readonly teamId: string;
  readonly channelId: string;
  readonly channelArchived: boolean;
  /** markdownEditing rollout(与 Channel document 编辑同一开关)。 */
  readonly editingEnabled: boolean;
  readonly actorKind: ArtifactRevisionActorKind;
  /** 频道人类成员资格(Server 已鉴;私有频道成员或公开频道团队成员)。 */
  readonly actorCanViewChannel: boolean;
  readonly collection: {
    readonly id: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly revision: number;
    readonly currentVersionId: string;
    readonly latestVersionNumber: number;
  } | null;
  /** 内容 base 版本(fence 目标);null = 不存在。 */
  readonly baseVersion: {
    readonly id: string;
    readonly collectionId: string;
    readonly versionNumber: number;
    readonly isMarkdown: boolean;
    readonly source: ArtifactVersionSourceSnapshot;
  } | null;
  /** 「基于此修改」的明确来源版本;通常等于 baseVersion,人工合并后可不同。 */
  readonly sourceVersion: {
    readonly id: string;
    readonly collectionId: string;
    readonly source: ArtifactVersionSourceSnapshot;
  } | null;
  /** 客户端声称的 basis review(Server 按 id 加载);null = 不存在或未提供。 */
  readonly basisReview: {
    readonly id: string;
    readonly versionId: string;
    readonly decision: 'approved' | 'rejected' | 'changes_requested';
  } | null;
  /** sourceVersion 最新一条 review 的 id(无 review 时 null)。 */
  readonly sourceVersionLatestReviewId: string | null;
  /** 客户端声称的来源 package(Server 按 id 加载,含冻结成员);未提供 packageId 时 null。 */
  readonly basisPackage: {
    readonly id: string;
    readonly deliveryId: string;
    readonly members: readonly { readonly collectionId: string; readonly artifactVersionId: string }[];
  } | null;
}

export interface ArtifactVersionRevisionInput {
  readonly collectionId: string;
  readonly baseVersionId: string;
  readonly expectedCollectionRevision: number;
  readonly revisionBasis: {
    readonly sourceVersionId: string;
    readonly basisReviewId?: string;
    readonly packageId?: string;
    readonly deliveryId?: string;
  };
}

/** applied 写计划:只含本命令该写的事实;review/finalization/Task 写入不存在于此(AC4)。 */
export interface ArtifactVersionRevisionPlan {
  readonly collectionId: string;
  readonly baseVersionId: string;
  readonly sourceVersionId: string;
  readonly basisReviewId?: string;
  readonly packageId?: string;
  readonly deliveryId?: string;
  /** 继承来源:Server 从 sourceVersion 持久化事实推导(AC3 lineage 保留)。 */
  readonly inheritedSource: ArtifactVersionSourceSnapshot;
  /** lineage:来源版本在前;base ≠ source(人工合并)时追加 base 版本。 */
  readonly lineage: readonly ProjectArtifactLineageRefDto[];
  readonly nextVersionNumber: number;
  readonly nextCollectionRevision: number;
}

export type ArtifactVersionRevisionDecision =
  | { readonly kind: 'applied'; readonly plan: ArtifactVersionRevisionPlan }
  | { readonly kind: 'conflict'; readonly code: ArtifactRevisionConflictCode }
  | { readonly kind: 'rejected'; readonly reasonCode: ArtifactRevisionRejectionReason };

/**
 * 判定一次 Markdown 修订保存。
 * 顺序:可用性/权限 → 作用域 → basis 校验(identity 级错误先于 fence) → 双 fence → applied。
 */
export function evaluateArtifactVersionRevision(input: {
  readonly facts: ArtifactVersionRevisionFacts;
  readonly input: ArtifactVersionRevisionInput;
}): ArtifactVersionRevisionDecision {
  const { facts } = input;
  const command = input.input;
  if (!facts.editingEnabled) return { kind: 'rejected', reasonCode: 'revision-editing-disabled' };
  if (facts.channelArchived) return { kind: 'rejected', reasonCode: 'channel-archived' };
  if (input.facts.actorKind !== 'human' || !facts.actorCanViewChannel) {
    return { kind: 'rejected', reasonCode: 'actor-not-authorized' };
  }
  const collection = facts.collection;
  if (!collection || collection.teamId !== facts.teamId || collection.channelId !== facts.channelId) {
    return { kind: 'rejected', reasonCode: 'collection-not-found' };
  }
  if (!facts.baseVersion || facts.baseVersion.collectionId !== collection.id
    || facts.baseVersion.id !== command.baseVersionId) {
    return { kind: 'rejected', reasonCode: 'version-not-in-collection' };
  }
  const sourceVersion = facts.sourceVersion;
  if (!sourceVersion || sourceVersion.collectionId !== collection.id
    || sourceVersion.id !== command.revisionBasis.sourceVersionId) {
    return { kind: 'rejected', reasonCode: 'version-not-in-collection' };
  }
  if (!facts.baseVersion.isMarkdown) return { kind: 'rejected', reasonCode: 'not-markdown-version' };

  // --- basis 校验(AC1/AC8:identity 级错误是 rejected,不是 fence 漂移) ---
  const basis = command.revisionBasis;
  if (basis.basisReviewId !== undefined) {
    const review = facts.basisReview;
    if (!review || review.versionId !== sourceVersion.id
      || (review.decision !== 'rejected' && review.decision !== 'changes_requested')) {
      return { kind: 'rejected', reasonCode: 'revision-basis-mismatch' };
    }
  }
  if (basis.packageId !== undefined || basis.deliveryId !== undefined) {
    // package 与 delivery 必须成对冻结:只提供其一无法构成完整 delivery 依据,拒绝而非静默降级。
    const pkg = facts.basisPackage;
    if (basis.packageId === undefined || basis.deliveryId === undefined || !pkg
      || pkg.id !== basis.packageId || pkg.deliveryId !== basis.deliveryId
      || !pkg.members.some((member) => member.collectionId === collection.id
        && member.artifactVersionId === sourceVersion.id)) {
      return { kind: 'rejected', reasonCode: 'revision-basis-mismatch' };
    }
  }

  // --- 双 fence(AC6/AC8:stale → 结构化 conflict,零写入) ---
  if (command.baseVersionId !== collection.currentVersionId) {
    return { kind: 'conflict', code: 'base-version-stale' };
  }
  if (command.expectedCollectionRevision !== collection.revision) {
    return { kind: 'conflict', code: 'collection-revision-stale' };
  }
  if (basis.basisReviewId !== undefined && facts.sourceVersionLatestReviewId !== basis.basisReviewId) {
    return { kind: 'conflict', code: 'revision-basis-stale' };
  }

  const lineage: ProjectArtifactLineageRefDto[] = [{ kind: 'project_version', refId: sourceVersion.id }];
  if (command.baseVersionId !== sourceVersion.id) {
    lineage.push({ kind: 'project_version', refId: command.baseVersionId });
  }
  return {
    kind: 'applied',
    plan: {
      collectionId: collection.id,
      baseVersionId: command.baseVersionId,
      sourceVersionId: sourceVersion.id,
      ...(basis.basisReviewId !== undefined ? { basisReviewId: basis.basisReviewId } : {}),
      ...(basis.packageId !== undefined ? { packageId: basis.packageId } : {}),
      ...(basis.deliveryId !== undefined ? { deliveryId: basis.deliveryId } : {}),
      inheritedSource: { ...sourceVersion.source },
      lineage,
      nextVersionNumber: collection.latestVersionNumber + 1,
      nextCollectionRevision: collection.revision + 1,
    },
  };
}
