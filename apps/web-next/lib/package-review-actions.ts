/**
 * #1177：Tasks 阶段审核工作区的 package review / delivery mutation 辅助。
 *
 * 只把 Server availableActions 映射到既有具名 command；不在客户端推断 authority。
 * 成功后由调用方用 Server projection 刷新，禁止乐观改 TaskStatus/reviewState/finalVersionId。
 */
import type {
  OutputPackageDto,
  PackageReviewAction,
  ProjectArtifactReviewDecision,
  StageDeliveryReviewMemberV1,
} from '@agentbean/contracts';

import { projectEvents, taskEvents } from '@/lib/socket';

/** 可在 Tasks 阶段审核面提交的 package 动作（不含 Files 侧的 revise-version）。 */
export const STAGE_PACKAGE_MUTATION_ACTIONS = [
  'review-approved',
  'review-changes-requested',
  'review-rejected',
  'review-and-finalize',
  'review-and-reject-delivery',
  'set-final',
] as const satisfies readonly PackageReviewAction[];

export type StagePackageMutationAction = (typeof STAGE_PACKAGE_MUTATION_ACTIONS)[number];

export type StageDeliveryMutationKind =
  | { readonly kind: 'package'; readonly action: StagePackageMutationAction }
  | { readonly kind: 'accept-delivery' }
  | { readonly kind: 'reject-delivery' };

export interface PackageMutationTarget {
  readonly channelId: string;
  readonly package: OutputPackageDto;
  readonly member: StageDeliveryReviewMemberV1;
  readonly action: StagePackageMutationAction;
}

export interface DeliveryMutationTarget {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly kind: 'accept-delivery' | 'reject-delivery';
}

export interface MutationDialogDraft {
  readonly comment: string;
  readonly rejectReason: string;
}

export interface MutationSubmitResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly message?: string;
  readonly replayed?: boolean;
}

const ACTION_LABELS: Record<StagePackageMutationAction | 'accept-delivery' | 'reject-delivery', string> = {
  'review-approved': '通过审核',
  'review-changes-requested': '要求修改',
  'review-rejected': '拒绝此版本',
  'review-and-finalize': '通过并设为最终版',
  'review-and-reject-delivery': '审核并退回交付',
  'set-final': '设为最终版',
  'accept-delivery': '验收交付',
  'reject-delivery': '退回交付',
};

export function isStagePackageMutationAction(action: string): action is StagePackageMutationAction {
  return (STAGE_PACKAGE_MUTATION_ACTIONS as readonly string[]).includes(action);
}

export function packageMutationActionLabel(action: StagePackageMutationAction | 'accept-delivery' | 'reject-delivery'): string {
  return ACTION_LABELS[action];
}

export function decisionForPackageAction(action: StagePackageMutationAction): ProjectArtifactReviewDecision | null {
  switch (action) {
    case 'review-approved':
    case 'review-and-finalize':
      return 'approved';
    case 'review-changes-requested':
    case 'review-and-reject-delivery':
      return 'changes_requested';
    case 'review-rejected':
      return 'rejected';
    case 'set-final':
      return null;
  }
}

export function packageActionRequiresComment(action: StagePackageMutationAction): boolean {
  return action !== 'set-final';
}

export function packageActionRequiresRejectReason(action: StagePackageMutationAction): boolean {
  return action === 'review-and-reject-delivery';
}

export function mutationLockKey(
  target:
    | { readonly kind: 'package'; readonly collectionId: string; readonly versionId: string; readonly action: string }
    | { readonly kind: 'delivery'; readonly taskId: string; readonly action: string },
): string {
  if (target.kind === 'package') {
    return `package:${target.collectionId}:${target.versionId}:${target.action}`;
  }
  return `delivery:${target.taskId}:${target.action}`;
}

export function nextMutationIdempotencyKey(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}:${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function packageActionImpact(action: StagePackageMutationAction): string {
  switch (action) {
    case 'review-approved':
      return '写入一条 append-only 审核通过记录；不会自动完成 Task，也不会移动 final 指针。';
    case 'review-changes-requested':
      return '写入一条要求修改的审核记录；不会退回 Task delivery，也不会自动创建新 attempt。';
    case 'review-rejected':
      return '写入一条拒绝该版本的审核记录；不会自动退回 Task delivery。';
    case 'review-and-finalize':
      return '原子提交审核通过与设为最终版两个独立事实；任一失败则零部分写。';
    case 'review-and-reject-delivery':
      return '原子提交要求修改审核并退回 Task delivery；旧 delivery/claim 失效并产生新 revision/attempt。';
    case 'set-final':
      return '在已有 approved 审核基础上移动 final 指针；不新增审核记录，不改变 Task 状态。';
  }
}

export function validatePackageMutationDraft(
  action: StagePackageMutationAction,
  draft: MutationDialogDraft,
): string | null {
  if (packageActionRequiresComment(action) && !draft.comment.trim()) {
    return '请填写审核意见';
  }
  if (packageActionRequiresRejectReason(action) && !draft.rejectReason.trim()) {
    return '请填写退回理由';
  }
  return null;
}

export function validateDeliveryMutationDraft(
  kind: 'accept-delivery' | 'reject-delivery',
  draft: MutationDialogDraft,
): string | null {
  if (kind === 'reject-delivery' && !draft.rejectReason.trim()) {
    return '请填写退回理由';
  }
  return null;
}

/** 提交 package review / finalize / reject-delivery / set-final。idempotencyKey 由调用方在同一次意图内保持稳定。 */
export async function submitPackageMutation(
  target: PackageMutationTarget,
  draft: MutationDialogDraft,
  idempotencyKey: string,
): Promise<MutationSubmitResult> {
  const { channelId, package: pkg, member, action } = target;
  const versionId = member.artifactVersionId;
  const collectionId = member.collectionId;
  const collectionRevision = member.availableActions?.collectionRevision
    ?? member.delivered?.collectionRevision
    ?? member.current?.collectionRevision
    ?? 0;

  if (action === 'set-final') {
    const result = await projectEvents().setArtifactFinalVersion({
      channelId,
      collectionId,
      versionId,
      expectedCollectionRevision: collectionRevision,
      idempotencyKey,
      reason: draft.comment.trim() || '阶段审核工作区设为最终版',
    });
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    };
  }

  const decision = decisionForPackageAction(action);
  if (!decision) {
    return { ok: false, error: 'INVALID_ACTION', message: '未知审核动作' };
  }

  const base = {
    channelId,
    packageId: pkg.packageId,
    collectionId,
    versionId,
    decision,
    comment: draft.comment.trim(),
    idempotencyKey,
  };

  if (action === 'review-and-finalize') {
    const result = await projectEvents().submitPackageReviewAndFinalize({
      ...base,
      expectedCollectionRevision: collectionRevision,
    });
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    };
  }

  if (action === 'review-and-reject-delivery') {
    const result = await projectEvents().submitPackageReviewAndRejectDelivery({
      ...base,
      expectedTaskRevision: pkg.taskRevision ?? 0,
      ...(pkg.taskAttempt !== undefined ? { expectedTaskAttempt: pkg.taskAttempt } : {}),
      rejectReason: draft.rejectReason.trim(),
    });
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    };
  }

  const result = await projectEvents().submitPackageArtifactReview(base);
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
  };
}

/** 原型对齐（#1222 后续）：卡片级批量审核输入。targets 为焦点包内仍有对应动作的成员。 */
export interface PackageBatchReviewInput {
  readonly channelId: string;
  readonly packageId: string;
  readonly deliveryId: string;
  readonly expectedPackageRevision: number;
  readonly targets: readonly { readonly collectionId: string; readonly artifactVersionId: string }[];
  readonly decision: ProjectArtifactReviewDecision;
  readonly comment: string;
}

export interface PackageBatchReviewResult extends MutationSubmitResult {
  readonly reviews?: readonly unknown[];
  readonly rejectedTargets?: readonly { readonly collectionId?: string; readonly artifactVersionId?: string; readonly reason: string }[];
}

/**
 * 批量提交文件版本审核（#1199 全有或全无命令）。
 * idempotencyKey 由调用方在同一次意图内保持稳定；成功后由调用方刷新 Server projection。
 */
export async function submitPackageBatchReview(
  input: PackageBatchReviewInput,
  idempotencyKey: string,
): Promise<PackageBatchReviewResult> {
  const result = await projectEvents().submitPackageArtifactReviews({
    channelId: input.channelId,
    packageId: input.packageId,
    deliveryId: input.deliveryId,
    expectedPackageRevision: input.expectedPackageRevision,
    targets: input.targets,
    decision: input.decision,
    comment: input.comment,
    idempotencyKey,
  });
  return {
    ok: result.ok,
    ...(result.reviews ? { reviews: result.reviews } : {}),
    ...(result.details?.rejectedTargets ? { rejectedTargets: result.details.rejectedTargets } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
  };
}

/**
 * 单成员「通过并设为最终版」（#1061 AC9：一个事务两个独立事实）。
 * expectedCollectionRevision 取 Server availableActions 的集合 revision fence。
 */
export async function submitPackageReviewAndFinalizeMember(
  input: {
    readonly channelId: string;
    readonly packageId: string;
    readonly collectionId: string;
    readonly versionId: string;
    readonly expectedCollectionRevision: number;
    readonly comment: string;
    readonly idempotencyKey: string;
  },
): Promise<MutationSubmitResult> {
  const result = await projectEvents().submitPackageReviewAndFinalize({
    channelId: input.channelId,
    packageId: input.packageId,
    collectionId: input.collectionId,
    versionId: input.versionId,
    decision: 'approved',
    comment: input.comment,
    idempotencyKey: input.idempotencyKey,
    expectedCollectionRevision: input.expectedCollectionRevision,
  });
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
  };
}

/** 提交 Task delivery 验收/退回（既有 root lifecycle commands）。 */
export async function submitDeliveryMutation(
  target: DeliveryMutationTarget,
  draft: MutationDialogDraft,
): Promise<MutationSubmitResult> {
  if (target.kind === 'accept-delivery') {
    const result = await taskEvents().acceptRootDelivery({
      taskId: target.taskId,
      expectedTaskRevision: target.expectedTaskRevision,
    });
    return {
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(typeof result.error === 'string' ? { message: result.error } : {}),
    };
  }
  const result = await taskEvents().rejectRootDelivery({
    taskId: target.taskId,
    reason: draft.rejectReason.trim(),
    expectedTaskRevision: target.expectedTaskRevision,
  });
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(typeof result.error === 'string' ? { message: result.error } : {}),
  };
}

export function mutationErrorCopy(result: MutationSubmitResult): string {
  if (result.message?.trim()) return result.message.trim();
  if (result.error?.trim()) return `操作失败：${result.error}`;
  return '操作失败，请稍后重试';
}
