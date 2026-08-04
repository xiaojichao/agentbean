import { createHash } from 'node:crypto';
// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import {
  ARTIFACT_REVISION_COMMAND_SCHEMA_VERSION,
  canonicalizeArtifactRevisionCommand,
  type ArtifactRevisionConflictDto,
  type ArtifactRevisionRejectionReason,
  type ArtifactVersionRevisionSaveResultDto,
} from '../../../../packages/contracts/src/index.js';
import { evaluateArtifactVersionRevision } from '../../../../packages/domain/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type { ArtifactContentStore } from './usecases.js';
import type {
  ArtifactRevisionReceiptRecord,
  ArtifactRevisionTombstoneRecord,
} from './artifact-revision-repositories.js';
import type {
  ProjectArtifactCollectionRecord,
  ProjectArtifactVersionRecord,
} from './project-repositories.js';
import { isMarkdownArtifact, sanitizeMarkdownFilename } from './channel-document-policy.js';

/**
 * #1062 ArtifactRevision application handler(父规格 #1059 §7/§9/§11;ADR-0067)。
 *
 * `save-artifact-version-revision`:频道人类成员对 collection 内明确 base 版本保存 Markdown
 * 修订。单事务原子产生新 Artifact + 新 ProjectArtifactVersion + current 指针移动 +
 * receipt;不继承旧 review/acceptance/finalization(AC4——写计划里结构性不存在这些写入);
 * 原 Run artifact 与旧版本行永不改写(AC5);stale base/collection/basis → 结构化 conflict,
 * 零部分写入,客户端保留草稿(AC6/AC8)。
 *
 * authority 由 Server 从 session 与已持久化事实推导(team 成员 + 频道可见 + 未归档 +
 * markdownEditing rollout),input 无 authority 字段。lineage 与继承来源由 Server 从
 * sourceVersion 的持久化事实推导(AC3),客户端只提交目标身份与冻结 basis。
 */

export interface ArtifactRevisionHandlerDeps {
  readonly repositories: ServerNextRepositories;
  /** 必需:无 content store 时保存会产生无内容的版本事实,fail closed。 */
  readonly artifactContentStore: ArtifactContentStore;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  /** markdownEditing rollout(与 Channel document 编辑同一开关)。 */
  readonly editingEnabled: boolean;
}

export interface SaveArtifactVersionRevisionCommandInput {
  readonly teamId: string;
  /** 操作者(人类)。Server 从 session 推导,客户端不可自报。 */
  readonly userId: string;
  readonly channelId: string;
  readonly collectionId: string;
  readonly baseVersionId: string;
  readonly content: string;
  readonly filename?: string;
  readonly expectedCollectionRevision: number;
  readonly revisionBasis: {
    readonly sourceVersionId: string;
    readonly basisReviewId?: string;
    readonly packageId?: string;
    readonly deliveryId?: string;
  };
  readonly idempotencyKey: string;
}

export type SaveArtifactVersionRevisionResult =
  | {
    readonly kind: 'applied';
    readonly version: ProjectArtifactVersionRecord;
    readonly collection: ProjectArtifactCollectionRecord;
    readonly receipt: ArtifactRevisionReceiptRecord;
    /** AC10:完整保存结果(ack 直接返回,不重复解析)。 */
    readonly saveResult: ArtifactVersionRevisionSaveResultDto;
  }
  | {
    readonly kind: 'replayed';
    readonly version: ProjectArtifactVersionRecord;
    readonly receipt: ArtifactRevisionReceiptRecord;
  }
  | {
    readonly kind: 'conflict';
    readonly reasonCode: string;
    /** stale fence 三态的结构化 payload(AC6/AC7);幂等冲突无。 */
    readonly revisionConflict?: ArtifactRevisionConflictDto;
  }
  | { readonly kind: 'rejected'; readonly reasonCode: ArtifactRevisionRejectionReason };

/** 与 Channel document 保存同源的内容规则(2MB / 危险 HTML 与协议)。 */
function validateRevisionMarkdownContent(content: string): boolean {
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) return false;
  if (/<script\b/i.test(content) || /(?:javascript|vbscript|data):/i.test(content)) return false;
  return true;
}

export async function saveArtifactVersionRevisionCommand(
  deps: ArtifactRevisionHandlerDeps,
  input: SaveArtifactVersionRevisionCommandInput,
): Promise<SaveArtifactVersionRevisionResult> {
  const { repositories } = deps;
  const teamId = input.teamId;

  // canonical hash 覆盖语义 payload(teamId/userId 由 Server 注入,不参与内容指纹;
  // idempotencyKey 是查重键,同 key 同 payload 恒等)。
  const commandHash = sha256(canonicalizeArtifactRevisionCommand(
    'save-artifact-version-revision',
    ARTIFACT_REVISION_COMMAND_SCHEMA_VERSION,
    {
      channelId: input.channelId,
      collectionId: input.collectionId,
      baseVersionId: input.baseVersionId,
      content: input.content,
      ...(input.filename !== undefined ? { filename: input.filename } : {}),
      expectedCollectionRevision: input.expectedCollectionRevision,
      revisionBasis: input.revisionBasis,
    },
  ));

  const existingReceipt = await repositories.artifactRevisions.receipts.getByIdempotencyKey({
    teamId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingReceipt) {
    if (existingReceipt.commandHash !== commandHash) {
      return { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
    }
    const versionId = existingReceipt.committedRevisions
      .find((revision) => revision.streamKind === 'project-artifact-version')?.streamId;
    const versions = await repositories.channelProjects.listArtifactVersions({
      teamId,
      channelId: input.channelId,
    });
    const version = versions.find((candidate) => candidate.id === versionId) ?? null;
    if (!version) return { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
    return { kind: 'replayed', version, receipt: existingReceipt };
  }

  // ---- 加载事实(全部 Server 读取,客户端不可伪造) ----
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== teamId) return { kind: 'rejected', reasonCode: 'channel-not-found' };
  const teamMember = await repositories.teams.isMember(teamId, input.userId);
  const actorCanViewChannel = teamMember
    && (channel.visibility !== 'private' || channel.humanMemberIds.includes(input.userId));

  const collection = await repositories.channelProjects.getArtifactCollection({
    teamId,
    channelId: input.channelId,
    collectionId: input.collectionId,
  });
  const versions = await repositories.channelProjects.listArtifactVersions({
    teamId,
    channelId: input.channelId,
  });
  const collectionVersions = versions
    .filter((candidate) => candidate.collectionId === input.collectionId)
    .sort((left, right) => left.versionNumber - right.versionNumber);
  const baseVersion = collectionVersions.find((candidate) => candidate.id === input.baseVersionId) ?? null;
  const sourceVersion = collectionVersions
    .find((candidate) => candidate.id === input.revisionBasis.sourceVersionId) ?? null;
  const latestVersionNumber = collectionVersions
    .reduce((max, candidate) => Math.max(max, candidate.versionNumber), 0);
  const baseArtifact = baseVersion
    ? await repositories.artifacts.getForTeam({ teamId, artifactId: baseVersion.artifactId })
    : null;

  const reviews = await repositories.channelProjects.listArtifactReviews({
    teamId,
    channelId: input.channelId,
  });
  const sourceReviews = reviews
    .filter((review) => review.versionId === input.revisionBasis.sourceVersionId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const basisReview = input.revisionBasis.basisReviewId
    ? reviews.find((review) => review.id === input.revisionBasis.basisReviewId) ?? null
    : null;

  const basisPackage = input.revisionBasis.packageId
    ? await repositories.outputPackages.getPackageById({
      teamId,
      packageId: input.revisionBasis.packageId,
    })
    : null;

  const decision = evaluateArtifactVersionRevision({
    facts: {
      teamId,
      channelId: input.channelId,
      channelArchived: channel.archivedAt != null,
      editingEnabled: deps.editingEnabled,
      actorKind: 'human',
      actorCanViewChannel,
      collection: collection
        ? {
          id: collection.id,
          teamId: collection.teamId,
          channelId: collection.channelId,
          revision: collection.revision,
          currentVersionId: collection.currentVersionId,
          latestVersionNumber,
        }
        : null,
      baseVersion: baseVersion
        ? {
          id: baseVersion.id,
          collectionId: baseVersion.collectionId,
          versionNumber: baseVersion.versionNumber,
          isMarkdown: baseArtifact != null && isMarkdownArtifact(baseArtifact),
          source: versionSourceSnapshot(baseVersion),
        }
        : null,
      sourceVersion: sourceVersion
        ? {
          id: sourceVersion.id,
          collectionId: sourceVersion.collectionId,
          source: versionSourceSnapshot(sourceVersion),
        }
        : null,
      basisReview: basisReview
        ? { id: basisReview.id, versionId: basisReview.versionId, decision: basisReview.decision }
        : null,
      sourceVersionLatestReviewId: sourceReviews.at(-1)?.id ?? null,
      basisPackage: basisPackage
        ? {
          id: basisPackage.package.packageId,
          deliveryId: basisPackage.package.deliveryId,
          members: basisPackage.members.map((member) => ({
            collectionId: member.collectionId,
            artifactVersionId: member.artifactVersionId,
          })),
        }
        : null,
    },
    input: {
      collectionId: input.collectionId,
      baseVersionId: input.baseVersionId,
      expectedCollectionRevision: input.expectedCollectionRevision,
      revisionBasis: input.revisionBasis,
    },
  });

  if (decision.kind === 'rejected') return { kind: 'rejected', reasonCode: decision.reasonCode };
  if (decision.kind === 'conflict') {
    return {
      kind: 'conflict',
      reasonCode: decision.code,
      revisionConflict: buildRevisionConflict(decision.code, input, collection, collectionVersions),
    };
  }

  if (!validateRevisionMarkdownContent(input.content)) {
    return { kind: 'rejected', reasonCode: 'content-invalid' };
  }

  // ---- 内容物化(事务外先行;事务失败删孤儿,与文档保存同款) ----
  const plan = decision.plan;
  const now = deps.clock.now();
  const artifactId = deps.ids.nextId();
  const filename = sanitizeMarkdownFilename(
    input.filename ?? baseArtifact?.filename ?? 'document.md',
  );
  const stored = await deps.artifactContentStore.writeContent({
    teamId,
    artifactId,
    filename,
    content: Buffer.from(input.content, 'utf8'),
  });
  const artifact = {
    id: artifactId,
    teamId,
    channelId: input.channelId,
    uploaderId: input.userId,
    filename,
    mimeType: 'text/markdown',
    sizeBytes: stored.sizeBytes,
    pathKind: 'upload' as const,
    role: 'attachment' as const,
    storagePath: stored.storagePath,
    sha256: stored.sha256,
    createdAt: now,
  };
  const version: ProjectArtifactVersionRecord = {
    id: deps.ids.nextId(),
    teamId,
    channelId: input.channelId,
    collectionId: plan.collectionId,
    versionNumber: plan.nextVersionNumber,
    artifactId,
    ...(plan.inheritedSource.stageId ? { stageId: plan.inheritedSource.stageId } : {}),
    taskId: plan.inheritedSource.taskId,
    taskRevision: plan.inheritedSource.taskRevision,
    ...(plan.inheritedSource.messageId ? { sourceMessageId: plan.inheritedSource.messageId } : {}),
    ...(plan.inheritedSource.workspaceRunId
      ? { sourceWorkspaceRunId: plan.inheritedSource.workspaceRunId }
      : {}),
    ...(plan.inheritedSource.invocationId
      ? { sourceInvocationId: plan.inheritedSource.invocationId }
      : {}),
    lineage: [...plan.lineage],
    promotedBy: input.userId,
    revisedFromVersionId: plan.sourceVersionId,
    ...(plan.basisReviewId ? { revisionBasisReviewId: plan.basisReviewId } : {}),
    ...(plan.packageId ? { revisionPackageId: plan.packageId } : {}),
    ...(plan.deliveryId ? { revisionDeliveryId: plan.deliveryId } : {}),
    createdAt: now,
  };
  if (!collection) {
    // domain 已保证非空;防御性兜底(不写成业务事实)。
    await deps.artifactContentStore.deleteContent?.({ teamId, artifactId }).catch(() => undefined);
    return { kind: 'rejected', reasonCode: 'collection-not-found' };
  }
  const nextCollection: ProjectArtifactCollectionRecord = {
    ...collection,
    revision: plan.nextCollectionRevision,
    currentVersionId: version.id,
    versionCount: collection.versionCount + 1,
    updatedAt: now,
  };
  // commandName 是 output union 的附加键(ADR-0067:result 与 response 描述同一 command);
  // 存入 DTO 使 response.result 形状与 assertSaveResult 一致,replay 快照原样可恢复。
  const saveResult: ArtifactVersionRevisionSaveResultDto = {
    commandName: 'save-artifact-version-revision',
    versionId: version.id,
    collectionId: plan.collectionId,
    versionNumber: version.versionNumber,
    artifactId,
    baseVersionId: plan.baseVersionId,
    sourceVersionId: plan.sourceVersionId,
    ...(plan.basisReviewId ? { basisReviewId: plan.basisReviewId } : {}),
    ...(plan.packageId ? { packageId: plan.packageId } : {}),
    ...(plan.deliveryId ? { deliveryId: plan.deliveryId } : {}),
    collectionRevision: plan.nextCollectionRevision,
    currentVersionId: version.id,
    ...(collection.finalVersionId ? { finalVersionId: collection.finalVersionId } : {}),
    createdAt: now,
  };
  const receipt: ArtifactRevisionReceiptRecord = {
    receiptId: deps.ids.nextId(),
    teamId,
    commandName: 'save-artifact-version-revision',
    commandSchemaVersion: ARTIFACT_REVISION_COMMAND_SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    commandHash,
    outcome: 'applied',
    committedRevisions: [
      {
        streamKind: 'project-artifact-collection',
        streamId: plan.collectionId,
        revision: plan.nextCollectionRevision,
      },
      {
        streamKind: 'project-artifact-version',
        streamId: version.id,
        revision: version.versionNumber,
      },
    ],
    eventRefs: [],
    commitTime: now,
    resultAvailable: true,
    // 完整结果快照:同 key replay 时 usecase 原样恢复(AC10)。
    resultJson: JSON.stringify(saveResult),
    createdAt: now,
  };
  const tombstone: ArtifactRevisionTombstoneRecord = {
    id: deps.ids.nextId(),
    teamId,
    commandName: 'save-artifact-version-revision',
    idempotencyKey: input.idempotencyKey,
    commandHash,
    receiptId: receipt.receiptId,
    outcome: 'applied',
    resultAvailable: true,
    createdAt: now,
  };
  const committed = await repositories.artifactRevisions.recordArtifactVersionRevision({
    teamId,
    channelId: input.channelId,
    expectedCollectionRevision: input.expectedCollectionRevision,
    expectedCurrentVersionId: plan.baseVersionId,
    collection: nextCollection,
    artifact,
    version,
    receipt,
    tombstone,
  });
  if (committed.kind === 'idempotency_conflict') {
    await deps.artifactContentStore.deleteContent?.({ teamId, artifactId }).catch(() => undefined);
    return { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
  }
  if (committed.kind === 'conflict') {
    await deps.artifactContentStore.deleteContent?.({ teamId, artifactId }).catch(() => undefined);
    // 持久层 fence 复核失败(并发漂移):与 domain conflict 同语义,返回当前最新事实。
    return {
      kind: 'conflict',
      reasonCode: 'base-version-stale',
      revisionConflict: buildRevisionConflict('base-version-stale', input, collection, collectionVersions),
    };
  }
  if (committed.kind === 'replayed') {
    await deps.artifactContentStore.deleteContent?.({ teamId, artifactId }).catch(() => undefined);
    return { kind: 'replayed', version: committed.version, receipt };
  }

  // ---- 讨论串轻量活动投影(AC9):best-effort,失败不改写已提交事实 ----
  await appendArtifactRevisionSystemMessage(deps, {
    teamId,
    channelId: input.channelId,
    collection,
    version,
    saveResult,
    revisedBy: input.userId,
    createdAt: now,
  });

  return {
    kind: 'applied',
    version: committed.version,
    collection: nextCollection,
    receipt,
    saveResult,
  };
}

function versionSourceSnapshot(version: ProjectArtifactVersionRecord) {
  return {
    ...(version.stageId ? { stageId: version.stageId } : {}),
    taskId: version.taskId,
    taskRevision: version.taskRevision,
    ...(version.sourceMessageId ? { messageId: version.sourceMessageId } : {}),
    ...(version.sourceWorkspaceRunId ? { workspaceRunId: version.sourceWorkspaceRunId } : {}),
    ...(version.sourceInvocationId ? { invocationId: version.sourceInvocationId } : {}),
  };
}

function buildRevisionConflict(
  code: ArtifactRevisionConflictDto['code'],
  input: SaveArtifactVersionRevisionCommandInput,
  collection: ProjectArtifactCollectionRecord | null,
  collectionVersions: readonly ProjectArtifactVersionRecord[],
): ArtifactRevisionConflictDto | undefined {
  if (!collection) return undefined;
  const current = collectionVersions
    .find((candidate) => candidate.id === collection.currentVersionId)
    ?? collectionVersions.at(-1);
  return {
    code,
    baseVersionId: input.baseVersionId,
    serverCurrentVersionId: collection.currentVersionId,
    serverCurrentVersionNumber: current?.versionNumber ?? 0,
    collectionRevision: collection.revision,
    draftPreserved: true,
  };
}

/**
 * AC9 讨论串投影:保存成功后追加 system 消息(meta 快照,不复制 Markdown 全文);
 * clientMessageId 由版本 id 派生,重入/replay 不重复发卡;best-effort。
 */
async function appendArtifactRevisionSystemMessage(
  deps: ArtifactRevisionHandlerDeps,
  input: {
    teamId: string;
    channelId: string;
    collection: ProjectArtifactCollectionRecord;
    version: ProjectArtifactVersionRecord;
    saveResult: ArtifactVersionRevisionSaveResultDto;
    revisedBy: string;
    createdAt: number;
  },
): Promise<void> {
  try {
    const clientMessageId = `artifact-version-revision:${input.version.id}`;
    const existing = await deps.repositories.messages.getByClientMessageId({
      teamId: input.teamId,
      channelId: input.channelId,
      clientMessageId,
    });
    if (existing) return;
    const user = await deps.repositories.users.getById(input.revisedBy).catch(() => null);
    const displayName = user?.displayName ?? user?.username ?? input.revisedBy;
    const messageId = deps.ids.nextId();
    await deps.repositories.messages.append({
      id: messageId,
      teamId: input.teamId,
      channelId: input.channelId,
      // system 消息 threadId 存根为自身(与 output-package 系统卡同款:讨论串主线上可见)。
      threadId: messageId,
      senderKind: 'system',
      senderId: 'system',
      body: `${displayName} 保存了《${input.collection.name}》新版本 v${input.version.versionNumber}`,
      createdAt: input.createdAt,
      meta: {
        kind: 'artifact-version-revision',
        clientMessageId,
        collectionId: input.collection.id,
        collectionName: input.collection.name,
        versionId: input.version.id,
        versionNumber: input.version.versionNumber,
        baseVersionId: input.saveResult.baseVersionId,
        sourceVersionId: input.saveResult.sourceVersionId,
        ...(input.saveResult.basisReviewId ? { basisReviewId: input.saveResult.basisReviewId } : {}),
        ...(input.saveResult.packageId ? { packageId: input.saveResult.packageId } : {}),
        ...(input.saveResult.deliveryId ? { deliveryId: input.saveResult.deliveryId } : {}),
        revisedBy: input.revisedBy,
        revisedByName: displayName,
        createdAt: input.createdAt,
      },
    });
  } catch {
    // 消息追加失败不影响已提交的版本事实。
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
