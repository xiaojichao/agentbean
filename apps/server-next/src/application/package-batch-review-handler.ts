import { createHash } from 'node:crypto';
import {
  PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
  canonicalizePackageReviewCommand,
  type PackageReviewBatchFailureV1,
  type PackageReviewRejectionReason,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluatePackageBatchArtifactReview,
  mapPackageBatchReviewRejection,
} from '../../../../packages/domain/src/index.js';
import type { ServerNextRepositories } from './repositories.js';
import type {
  PackageReviewReceiptRecord,
  PackageReviewRecord,
  PackageReviewTombstoneRecord,
} from './package-review-repositories.js';
import { findCurrentManagedOutputPackage } from './output-package-current-delivery.js';

export interface SubmitPackageBatchReviewCommandInput {
  readonly teamId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly packageId: string;
  readonly deliveryId: string;
  readonly expectedPackageRevision: number;
  readonly targets: readonly { readonly collectionId: string; readonly artifactVersionId: string }[];
  readonly decision: 'approved' | 'changes_requested' | 'rejected';
  readonly comment: string;
  readonly idempotencyKey: string;
}

export type SubmitPackageBatchReviewResult =
  | { readonly kind: 'applied'; readonly reviews: readonly PackageReviewRecord[]; readonly receipt: PackageReviewReceiptRecord }
  | { readonly kind: 'replayed'; readonly receipt: PackageReviewReceiptRecord }
  | { readonly kind: 'conflict'; readonly reasonCode: string }
  | {
    readonly kind: 'rejected';
    readonly reasonCode: PackageReviewRejectionReason;
    readonly failures: readonly PackageReviewBatchFailureV1[];
  };

/** #1199 Server 原子批量审核：完整预检 N 个显式 current 版本后一次事务写入 N 条 review。 */
export async function submitPackageBatchReviewCommand(
  deps: { readonly repositories: ServerNextRepositories; readonly clock: { now(): number }; readonly ids: { nextId(): string } },
  input: SubmitPackageBatchReviewCommandInput,
): Promise<SubmitPackageBatchReviewResult> {
  const { repositories } = deps;
  const semanticInput = {
    channelId: input.channelId,
    packageId: input.packageId,
    deliveryId: input.deliveryId,
    expectedPackageRevision: input.expectedPackageRevision,
    targets: input.targets,
    decision: input.decision,
    comment: input.comment,
  };
  const commandHash = createHash('sha256').update(canonicalizePackageReviewCommand(
    'submit-package-artifact-reviews',
    PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
    semanticInput,
  )).digest('hex');
  const existingReceipt = await repositories.packageReviews.receipts.getByIdempotencyKey({
    teamId: input.teamId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existingReceipt) {
    return existingReceipt.commandHash === commandHash
      ? { kind: 'replayed', receipt: existingReceipt }
      : { kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' };
  }

  const reject = (reason: PackageReviewRejectionReason): SubmitPackageBatchReviewResult => ({
    kind: 'rejected',
    reasonCode: reason,
    failures: [{ reason }],
  });
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return reject('channel-not-found');
  if (channel.archivedAt != null) return reject('channel-archived');
  const packageProjection = await repositories.outputPackages.getPackageById({
    teamId: input.teamId,
    packageId: input.packageId,
  });
  if (!packageProjection) return reject('package-not-found');
  if (packageProjection.package.channelId !== input.channelId) return reject('package-out-of-scope');
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) return reject('actor-not-authorized');

  const task = await repositories.tasks.getById(packageProjection.package.taskId);
  const coordination = task
    ? await repositories.taskCoordination.coordinations.getByTaskId(task.id)
    : null;
  const packageTaskRevision = packageProjection.package.taskRevision ?? 1;
  if (!task || task.teamId !== input.teamId || task.channelId !== input.channelId
    || !coordination || coordination.teamId !== input.teamId
    || task.revision !== packageTaskRevision
    || coordination.taskRevision !== task.revision
    || coordination.attempt !== packageProjection.package.taskAttempt) {
    return reject('delivery-revision-stale');
  }
  const currentPackage = await findCurrentManagedOutputPackage(repositories.outputPackages, {
    teamId: input.teamId,
    channelId: input.channelId,
    taskId: task.id,
    taskRevision: task.revision,
    taskAttempt: coordination.attempt,
  });
  if (currentPackage.record?.packageId !== input.packageId
    || currentPackage.record.deliveryId !== input.deliveryId) {
    return reject('delivery-revision-stale');
  }

  const [collections, versions, stages, profile, teamRole] = await Promise.all([
    repositories.channelProjects.listArtifactCollections({ teamId: input.teamId, channelId: input.channelId }),
    repositories.channelProjects.listArtifactVersions({ teamId: input.teamId, channelId: input.channelId }),
    repositories.channelProjects.listStages({ teamId: input.teamId, channelId: input.channelId }),
    repositories.channelProjects.getProfile({ teamId: input.teamId, channelId: input.channelId }),
    repositories.teams.getMemberRole(input.teamId, input.userId),
  ]);
  const targetFacts = input.targets.map((target) => {
    const collection = collections.find((candidate) => candidate.id === target.collectionId);
    const version = versions.find((candidate) => candidate.id === target.artifactVersionId);
    const stage = version?.stageId ? stages.find((candidate) => candidate.id === version.stageId) : undefined;
    return {
      collectionId: target.collectionId,
      artifactVersionId: target.artifactVersionId,
      ...(version ? { versionCollectionId: version.collectionId } : {}),
      ...(collection?.currentVersionId ? { currentVersionId: collection.currentVersionId } : {}),
      actorFacts: {
        userId: input.userId,
        teamRole,
        projectLeadId: profile?.projectLeadId ?? '',
        stageReviewerIds: stage?.reviewerIds ?? [],
      },
    };
  });
  const decision = evaluatePackageBatchArtifactReview({
    actorKind: 'human',
    teamId: input.teamId,
    channelId: input.channelId,
    package: {
      id: packageProjection.package.packageId,
      teamId: packageProjection.package.teamId,
      channelId: packageProjection.package.channelId,
      deliveryId: packageProjection.package.deliveryId,
      // OutputPackage 聚合创建后不可变；仓储记录不重复存 revision，公开 DTO 恒投影为 1。
      revision: 1,
      members: packageProjection.members.map((member) => ({
        collectionId: member.collectionId,
        artifactVersionId: member.artifactVersionId,
      })),
    },
    deliveryId: input.deliveryId,
    expectedPackageRevision: input.expectedPackageRevision,
    decision: input.decision,
    targets: targetFacts,
  });
  if (decision.kind === 'rejected') {
    const failures = decision.failures.map((failure) => ({
      ...(failure.collectionId ? { collectionId: failure.collectionId } : {}),
      ...(failure.artifactVersionId ? { artifactVersionId: failure.artifactVersionId } : {}),
      reason: mapPackageBatchReviewRejection(failure.reasonCode),
    }));
    return { kind: 'rejected', reasonCode: failures[0]!.reason, failures };
  }

  const now = deps.clock.now();
  const reviews: PackageReviewRecord[] = decision.targets.map((target) => {
    const version = versions.find((candidate) => candidate.id === target.artifactVersionId)!;
    return {
      id: deps.ids.nextId(),
      teamId: input.teamId,
      channelId: input.channelId,
      collectionId: target.collectionId,
      versionId: target.artifactVersionId,
      ...(version.stageId ? { stageId: version.stageId } : {}),
      packageId: input.packageId,
      deliveryId: packageProjection.package.deliveryId,
      taskId: packageProjection.package.taskId,
      taskRevision: packageTaskRevision,
      taskAttempt: packageProjection.package.taskAttempt,
      authorityBasis: target.authorityBasis,
      decision: input.decision,
      comment: input.comment,
      basis: [],
      reviewedBy: input.userId,
      createdAt: now,
    };
  });
  const receipt: PackageReviewReceiptRecord = {
    receiptId: deps.ids.nextId(),
    teamId: input.teamId,
    commandName: 'submit-package-artifact-reviews',
    commandSchemaVersion: PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION,
    idempotencyKey: input.idempotencyKey,
    commandHash,
    outcome: 'applied',
    committedRevisions: reviews.map((review) => ({
      streamKind: 'project-artifact-review', streamId: review.id, revision: 1,
    })),
    eventRefs: [],
    commitTime: now,
    resultAvailable: true,
    resultJson: JSON.stringify({ reviews }),
    createdAt: now,
  };
  const tombstone: PackageReviewTombstoneRecord = {
    id: deps.ids.nextId(),
    teamId: input.teamId,
    commandName: 'submit-package-artifact-reviews',
    idempotencyKey: input.idempotencyKey,
    commandHash,
    receiptId: receipt.receiptId,
    outcome: 'applied',
    resultAvailable: true,
    createdAt: now,
  };
  const committed = await repositories.packageReviews.recordPackageReviews({
    reviews,
    lineageFence: {
      teamId: input.teamId,
      channelId: input.channelId,
      taskId: task.id,
      taskRevision: task.revision,
      taskAttempt: coordination.attempt,
      packageId: input.packageId,
      deliveryId: input.deliveryId,
    },
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
  if (committed.kind === 'idempotency_conflict') return { kind: 'conflict', reasonCode: 'idempotency-conflict' };
  if (committed.kind === 'delivery_revision_conflict') return reject('delivery-revision-stale');
  if (committed.kind === 'version_scope_conflict') {
    return reject('version-not-in-collection');
  }
  if (committed.kind === 'current_version_conflict') {
    return {
      kind: 'rejected',
      reasonCode: 'version-not-current',
      failures: [{
        collectionId: committed.collectionId,
        artifactVersionId: committed.versionId,
        reason: 'version-not-current',
      }],
    };
  }
  if (committed.kind === 'replayed') {
    const replayReceipt = await repositories.packageReviews.receipts.getByIdempotencyKey({
      teamId: input.teamId,
      idempotencyKey: input.idempotencyKey,
    });
    return replayReceipt
      ? { kind: 'replayed', receipt: replayReceipt }
      : { kind: 'conflict', reasonCode: 'idempotency-result-unavailable' };
  }
  return { kind: 'applied', reviews: committed.reviews, receipt };
}
