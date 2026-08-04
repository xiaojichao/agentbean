import type { ID, UnixMs } from './common.js';
import { COMMAND_PROVENANCE_KINDS, type CommandProvenanceKind, type CommandProvenanceRefV1 } from './message-tracer.js';
import type { ProjectArtifactReviewDecision } from './project.js';

/**
 * PackageReview 命令合同(issue #1061,父规格 #1059 §5;ADR-0067 Command registry)。
 *
 * 把「文件版本审核」「Task delivery 验收」「最终版设置」保持为三个独立事实:
 * - `submit-package-artifact-review`:对 OutputPackage 成员的具体 version 提交审核,
 *   绑定 package/collection/version/delivery/Task revision/attempt 与 reviewer authority basis;
 *   结论 approved / changes_requested / rejected,历史 append-only(AC1)。
 * - `submit-package-review-and-finalize`:"通过并设为最终版"——同一操作者同时持有 review 与
 *   finalization authority,一个事务写入两个独立事实(review 记录 + finalization 记录 + 指针移动)(AC9)。
 * - `submit-package-review-and-reject-delivery`:审核(changes_requested/rejected)与退回 Task
 *   delivery 原子提交;退回按既有生命周期失效旧 delivery/claim/input rights(AC6)。
 *
 * authority 一律由 Server 从已持久化事实推导(频道项目画像/Stage reviewer/coordination 预绑定
 * authority ids/Team 角色),envelope 严禁 authority/teamId 字段(#900 §1 / ADR-0067)。
 * 频道成员资格只是可见性与候选门禁,不自动授予审核/验收/最终化权(AC2)。
 *
 * 本文件只提供 runtime schemas、discriminated unions、canonical serialization 与跨端 conformance
 * 基础;具体 handler、存储与接线属于 server-next 切片。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— PackageReview family
// ---------------------------------------------------------------------------

/** 冻结的具名 command 集合。未登记 command 必须被 Server 拒绝(ADR-0067)。 */
export const PACKAGE_REVIEW_COMMAND_NAMES = [
  'submit-package-artifact-review',
  'submit-package-review-and-finalize',
  'submit-package-review-and-reject-delivery',
] as const;
export type PackageReviewCommandName = (typeof PACKAGE_REVIEW_COMMAND_NAMES)[number];

/** envelope 的当前 schema 版本(ADR-0067:envelope 分别版本化)。 */
export const PACKAGE_REVIEW_ENVELOPE_SCHEMA_VERSION = 1;
/** command payload 的当前 schema 版本。 */
export const PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION = 1;
/** canonical command hash 规范版本;hash 算法升级时递增,使旧 hash 不被误判相等。 */
export const PACKAGE_REVIEW_COMMAND_HASH_VERSION = 1;

/** Command receipt 的终态 outcome(ADR-0067:嵌套 receipt 终态始终 applied 或 no_op)。 */
export const PACKAGE_REVIEW_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type PackageReviewReceiptOutcome = (typeof PACKAGE_REVIEW_RECEIPT_OUTCOMES)[number];

/** Command response outcome 固定八态(#900 §16 / ADR-0067)。 */
export const PACKAGE_REVIEW_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;
export type PackageReviewOutcome = (typeof PACKAGE_REVIEW_OUTCOMES)[number];

/** 重试指令四态(ADR-0067)。outcome_unknown 必须用原 key 查 receipt 或 replay,严禁换 key。 */
export const PACKAGE_REVIEW_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;
export type PackageReviewRetryDirective = (typeof PACKAGE_REVIEW_RETRY_DIRECTIVES)[number];

/**
 * 结构化拒绝码(#1059 §5/§11):任一拒绝都不得留下部分 review/transition/final 事实。
 * 组合命令中任一 authority、basis 或 revision 校验失败 → 无部分结果(AC6/AC9)。
 */
export const PACKAGE_REVIEW_REJECTION_REASONS = [
  /** 频道不存在 / 已归档。 */
  'channel-not-found',
  'channel-archived',
  /** 目标 package 不存在。 */
  'package-not-found',
  /** package 属于其他 Team/Channel(防跨作用域读取)。 */
  'package-out-of-scope',
  /** version 不是 package 冻结成员,或不属于声明的 collection。 */
  'version-not-in-package',
  'version-not-in-collection',
  /** 集合 revision fence:并发 finalization/append 已推进。 */
  'collection-revision-stale',
  /** Task revision fence:退回/验收时 Task 已漂移。 */
  'task-revision-stale',
  /** Task attempt fence:退回子 Task 时 attempt 已漂移。 */
  'task-attempt-stale',
  /** 操作者不是人类(Agent/PI Manager 一律拒绝人类审核/验收/最终化)。 */
  'actor-not-human',
  /** 操作者无该动作所需 authority(review/finalization/验收分离校验)。 */
  'actor-not-authorized',
  /** delivery 不存在 / 不属于该 package / 不是当前 Task revision/attempt 的 delivery。 */
  'delivery-not-found',
  'delivery-out-of-scope',
  /** Task 不处于可退回状态(delivery 未在 review 或已终态)。 */
  'delivery-not-reviewable',
  /** review 结论必须是 changes_requested/rejected 才能组合退回。 */
  'review-required-before-reject',
  /** 决策值非法。 */
  'invalid-decision',
  /** 退回理由必填。 */
  'reject-reason-required',
  /** 请求字段非法。 */
  'invalid-request',
] as const;
export type PackageReviewRejectionReason = (typeof PACKAGE_REVIEW_REJECTION_REASONS)[number];

/**
 * Server 计算并下发给客户端的可执行动作(AC11)。
 * 客户端只渲染 Server 给出的动作按钮,绝不依据按钮可见性或角色名称自行推断权限。
 */
export const PACKAGE_REVIEW_ACTIONS = [
  'review-approved',
  'review-changes-requested',
  'review-rejected',
  'review-and-finalize',
  'review-and-reject-delivery',
  'set-final',
] as const;
export type PackageReviewAction = (typeof PACKAGE_REVIEW_ACTIONS)[number];

/**
 * 审核依据的 authority basis(AC1:reviewer authority basis)。
 * 记录本次审核凭哪种合法 authority 成立,供审计区分三类事实来源。
 */
export const PACKAGE_REVIEW_AUTHORITY_BASIS_KINDS = [
  'team-owner',
  'team-admin',
  'project-lead',
  'stage-reviewer-delegation',
  'subtask-human-acceptance',
  'root-review-authority',
] as const;
export type PackageReviewAuthorityBasisKind = (typeof PACKAGE_REVIEW_AUTHORITY_BASIS_KINDS)[number];

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * 绑定 package 上下文的审核记录(AC1)。与 #824 的 ProjectArtifactReviewDto 同源但多出
 * package/delivery/Task revision/attempt 绑定与 authority basis;append-only,无 update/delete。
 */
export interface PackageReviewDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly collectionId: ID;
  readonly versionId: ID;
  /** 可空:人工 promote 路径的审核无 package 上下文;本 family 恒有。 */
  readonly packageId?: ID;
  /** 可空:同上。 */
  readonly deliveryId?: ID;
  readonly taskId?: ID;
  readonly taskRevision?: number;
  readonly taskAttempt?: number;
  readonly decision: ProjectArtifactReviewDecision;
  readonly comment: string;
  /** 本次审核依据的 authority basis(AC1)。 */
  readonly authorityBasis: PackageReviewAuthorityBasisKind;
  readonly reviewedBy: ID;
  readonly createdAt: UnixMs;
}

/** 组合命令的结果引用:两个独立事实分别返回,UI 与审计可区分(AC5/AC9)。 */
export interface PackageReviewFinalizeResultDto {
  readonly review: PackageReviewDto;
  readonly finalization: {
    readonly id: ID;
    readonly collectionId: ID;
    readonly versionId: ID;
    readonly previousVersionId?: ID;
    readonly basisReviewId: ID;
    readonly finalizedBy: ID;
    readonly createdAt: UnixMs;
  };
  readonly collection: {
    readonly collectionId: ID;
    readonly finalVersionId: ID;
    readonly previousVersionId?: ID;
    readonly revision: number;
  };
}

export interface PackageReviewRejectDeliveryResultDto {
  readonly review: PackageReviewDto;
  readonly task: {
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly status: 'todo' | 'in_progress' | 'in_review';
  };
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps(ADR-0067)
// ---------------------------------------------------------------------------

export interface PackageReviewCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: PackageReviewCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

/** 三个命令共享的 review 事实字段(AC1)。 */
export interface PackageReviewTargetV1 {
  readonly channelId: ID;
  readonly packageId: ID;
  readonly collectionId: ID;
  readonly versionId: ID;
  readonly decision: ProjectArtifactReviewDecision;
  readonly comment: string;
}

export interface PackageReviewCommandInputMapV1 {
  readonly 'submit-package-artifact-review': PackageReviewTargetV1 & {
    readonly idempotencyKey: string;
  };
  readonly 'submit-package-review-and-finalize': PackageReviewTargetV1 & {
    /** 集合 revision fence:并发 finalization/append 已推进 → conflict。 */
    readonly expectedCollectionRevision: number;
    readonly idempotencyKey: string;
  };
  readonly 'submit-package-review-and-reject-delivery': PackageReviewTargetV1 & {
    /** 退回目标 Task 的 revision fence。 */
    readonly expectedTaskRevision: number;
    /** 子 Task 退回时校验 attempt;根 Task 可省略。 */
    readonly expectedTaskAttempt?: number;
    /** 退回理由(必填,AC6 意见保留)。 */
    readonly rejectReason: string;
    readonly idempotencyKey: string;
  };
}

export interface PackageReviewCommandOutputMapV1 {
  readonly 'submit-package-artifact-review': {
    readonly review: PackageReviewDto;
  };
  readonly 'submit-package-review-and-finalize': PackageReviewFinalizeResultDto;
  readonly 'submit-package-review-and-reject-delivery': PackageReviewRejectDeliveryResultDto;
}

export type PackageReviewCommandOutputUnionV1 =
  | ({ readonly commandName: 'submit-package-artifact-review' } & PackageReviewCommandOutputMapV1['submit-package-artifact-review'])
  | ({ readonly commandName: 'submit-package-review-and-finalize' } & PackageReviewCommandOutputMapV1['submit-package-review-and-finalize'])
  | ({ readonly commandName: 'submit-package-review-and-reject-delivery' } & PackageReviewCommandOutputMapV1['submit-package-review-and-reject-delivery']);

/** 已成立的过去式领域事实引用(#900 §9)。 */
export interface PackageReviewEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

/** 已提交的专项 revision 引用(#900 §24)。 */
export interface PackageReviewRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface PackageReviewReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: PackageReviewCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash(由 canonicalizePackageReviewCommand 派生,server 计算 sha256)。 */
  readonly commandHash: string;
  readonly outcome: PackageReviewReceiptOutcome;
  readonly committedRevisions: readonly PackageReviewRevisionRefV1[];
  readonly eventRefs: readonly PackageReviewEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

/** Command 响应。携带稳定 code、retry directive 与安全裁剪的当前引用。 */
export interface PackageReviewCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: PackageReviewCommandName;
  readonly outcome: PackageReviewOutcome;
  readonly retryDirective: PackageReviewRetryDirective;
  readonly stableCode: string;
  /** applied / no_op / replayed 时携带首次 receipt。 */
  readonly receipt?: PackageReviewReceiptV1;
  /** 成功(applied)时的 command 结果。 */
  readonly result?: PackageReviewCommandOutputUnionV1;
  /** conflict:同 idempotency key 但 canonical command hash 不同,无副作用。 */
  readonly conflictReason?: string;
  /** rejected:结构化拒绝码(PACKAGE_REVIEW_REJECTION_REASONS)。 */
  readonly rejectedReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const PACKAGE_REVIEW_PAYLOAD_INVALID = 'PACKAGE_REVIEW_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
}

function assertDecision(value: unknown): void {
  if (value !== 'approved' && value !== 'changes_requested' && value !== 'rejected') {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  if (value.hash !== undefined && !nonEmpty(value.hash)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
}

/** 只校验 target 字段本身(不 exact-check,允许组合命令的扩展字段;完整性由外层 exact-key 负责)。 */
function assertTargetFields(value: Record<string, unknown>): void {
  assertId(value.channelId);
  assertId(value.packageId);
  assertId(value.collectionId);
  assertId(value.versionId);
  assertDecision(value.decision);
  if (value.comment !== undefined && !nonEmpty(value.comment)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
}

function assertReviewDto(value: unknown): void {
  assertExactKeys(value,
    ['id', 'teamId', 'channelId', 'collectionId', 'versionId', 'packageId', 'deliveryId',
      'taskId', 'taskRevision', 'taskAttempt', 'decision', 'comment', 'authorityBasis',
      'reviewedBy', 'createdAt'],
    ['id', 'teamId', 'channelId', 'collectionId', 'versionId', 'decision', 'comment',
      'authorityBasis', 'reviewedBy', 'createdAt']);
  assertId(value.id);
  assertId(value.teamId);
  assertId(value.channelId);
  assertId(value.collectionId);
  assertId(value.versionId);
  for (const opt of ['packageId', 'deliveryId', 'taskId'] as const) {
    if (value[opt] !== undefined) assertId(value[opt]);
  }
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 1);
  if (value.taskAttempt !== undefined) assertInteger(value.taskAttempt, 1);
  assertDecision(value.decision);
  if (value.comment !== undefined && !nonEmpty(value.comment)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  if (!PACKAGE_REVIEW_AUTHORITY_BASIS_KINDS.includes(value.authorityBasis as PackageReviewAuthorityBasisKind)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  assertId(value.reviewedBy);
  assertInteger(value.createdAt, 0);
}

function assertFinalizeResult(value: unknown): void {
  assertExactKeys(value, ['commandName', 'review', 'finalization', 'collection'],
    ['review', 'finalization', 'collection']);
  assertReviewDto(value.review);
  const finalization = value.finalization as Record<string, unknown>;
  assertExactKeys(finalization,
    ['id', 'collectionId', 'versionId', 'previousVersionId', 'basisReviewId', 'finalizedBy', 'createdAt'],
    ['id', 'collectionId', 'versionId', 'basisReviewId', 'finalizedBy', 'createdAt']);
  for (const key of ['id', 'collectionId', 'versionId', 'basisReviewId', 'finalizedBy'] as const) {
    assertId(finalization[key]);
  }
  if (finalization.previousVersionId !== undefined) assertId(finalization.previousVersionId);
  assertInteger(finalization.createdAt, 0);
  const collection = value.collection as Record<string, unknown>;
  assertExactKeys(collection,
    ['collectionId', 'finalVersionId', 'previousVersionId', 'revision'],
    ['collectionId', 'finalVersionId', 'revision']);
  assertId(collection.collectionId);
  assertId(collection.finalVersionId);
  if (collection.previousVersionId !== undefined) assertId(collection.previousVersionId);
  assertInteger(collection.revision, 1);
}

function assertRejectDeliveryResult(value: unknown): void {
  assertExactKeys(value, ['commandName', 'review', 'task'], ['review', 'task']);
  assertReviewDto(value.review);
  const task = value.task as Record<string, unknown>;
  assertExactKeys(task, ['taskId', 'taskRevision', 'taskAttempt', 'status'],
    ['taskId', 'taskRevision', 'taskAttempt', 'status']);
  assertId(task.taskId);
  assertInteger(task.taskRevision, 1);
  assertInteger(task.taskAttempt, 1);
  if (task.status !== 'todo' && task.status !== 'in_progress' && task.status !== 'in_review') {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  assertInteger(value.sequence, 0);
}

function assertReceipt(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable']);
  if (value.schemaVersion !== 1) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  assertId(value.receiptId);
  if (!PACKAGE_REVIEW_COMMAND_NAMES.includes(value.commandName as PackageReviewCommandName)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!PACKAGE_REVIEW_RECEIPT_OUTCOMES.includes(value.outcome as PackageReviewReceiptOutcome)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
}

function assertCommandOutput(value: unknown): void {
  assertExactKeys(value, ['commandName', 'review', 'finalization', 'collection', 'task'],
    ['commandName']);
  const commandName = value.commandName;
  if (commandName === 'submit-package-artifact-review') {
    assertExactKeys(value, ['commandName', 'review'], ['commandName', 'review']);
    assertReviewDto(value.review);
  } else if (commandName === 'submit-package-review-and-finalize') {
    assertExactKeys(value, ['commandName', 'review', 'finalization', 'collection'],
      ['commandName', 'review', 'finalization', 'collection']);
    assertReviewDto(value.review);
    assertFinalizeResult(value);
  } else if (commandName === 'submit-package-review-and-reject-delivery') {
    assertExactKeys(value, ['commandName', 'review', 'task'], ['commandName', 'review', 'task']);
    assertReviewDto(value.review);
    assertRejectDeliveryResult(value);
  } else {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
}

// ---------------------------------------------------------------------------
// Parsers(exact-key + structuredClone,防外部可变引用外泄)
// ---------------------------------------------------------------------------

export function parsePackageReviewCommandEnvelopeV1(value: unknown): PackageReviewCommandEnvelopeV1 {
  // 拒绝任何 authority/scope 自报告字段(teamId、authoritySubject、requesterId、actor 等)。
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey']);
  if (value.schemaVersion !== PACKAGE_REVIEW_ENVELOPE_SCHEMA_VERSION) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  if (!PACKAGE_REVIEW_COMMAND_NAMES.includes(value.commandName as PackageReviewCommandName)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  // 本切片只实现 V1:未知/未来 commandSchemaVersion 必须拒绝,禁止按 V1 静默执行。
  if (value.commandSchemaVersion !== PACKAGE_REVIEW_COMMAND_SCHEMA_VERSION) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as PackageReviewCommandEnvelopeV1;
}

export function parsePackageReviewCommandInputV1(
  commandName: PackageReviewCommandName,
  value: unknown,
): PackageReviewCommandInputMapV1[PackageReviewCommandName] {
  if (commandName === 'submit-package-artifact-review') {
    assertExactKeys(value,
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision', 'comment', 'idempotencyKey'],
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision', 'idempotencyKey']);
    assertTargetFields(value);
    assertId(value.idempotencyKey);
  } else if (commandName === 'submit-package-review-and-finalize') {
    assertExactKeys(value,
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision', 'comment',
        'expectedCollectionRevision', 'idempotencyKey'],
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision',
        'expectedCollectionRevision', 'idempotencyKey']);
    assertTargetFields(value);
    assertInteger(value.expectedCollectionRevision, 1);
    assertId(value.idempotencyKey);
  } else if (commandName === 'submit-package-review-and-reject-delivery') {
    assertExactKeys(value,
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision', 'comment',
        'expectedTaskRevision', 'expectedTaskAttempt', 'rejectReason', 'idempotencyKey'],
      ['channelId', 'packageId', 'collectionId', 'versionId', 'decision',
        'expectedTaskRevision', 'rejectReason', 'idempotencyKey']);
    assertTargetFields(value);
    assertInteger(value.expectedTaskRevision, 1);
    if (value.expectedTaskAttempt !== undefined) assertInteger(value.expectedTaskAttempt, 1);
    if (!nonEmpty(value.rejectReason)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
    assertId(value.idempotencyKey);
  } else {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as PackageReviewCommandInputMapV1[PackageReviewCommandName];
}

export function parsePackageReviewCommandResponseV1(value: unknown): PackageReviewCommandResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'rejectedReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode']);
  if (value.schemaVersion !== 1) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  if (!PACKAGE_REVIEW_COMMAND_NAMES.includes(value.commandName as PackageReviewCommandName)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  if (!PACKAGE_REVIEW_OUTCOMES.includes(value.outcome as PackageReviewOutcome)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  if (!PACKAGE_REVIEW_RETRY_DIRECTIVES.includes(value.retryDirective as PackageReviewRetryDirective)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertReceipt(value.receipt);
  if (value.result !== undefined) {
    // result 必须与 response 描述同一 command(防跨 command 串型)。
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
    }
    assertCommandOutput(value.result);
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  if (value.rejectedReason !== undefined
    && (!nonEmpty(value.rejectedReason)
      || !PACKAGE_REVIEW_REJECTION_REASONS.includes(value.rejectedReason as PackageReviewRejectionReason))) {
    // 结构化拒绝码必须来自冻结枚举:客户端不得自造 reason。
    throw new Error(PACKAGE_REVIEW_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as PackageReviewCommandResponseV1;
}

// ---------------------------------------------------------------------------
// Canonical serialization —— 幂等 conflict 判定的语义核心(#900 §3 / ADR-0067)
// ---------------------------------------------------------------------------

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry));
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * 计算 command 的 canonical 串。hash 包含 command/schema 与语义 payload,排除 transport
 * headers、trace ID 与 idempotency key(key 是查重键,不是内容指纹)。同 idempotency key 下:
 * canonical 相等 = replay(返回首次 receipt);canonical 不等 = idempotency_conflict。
 */
export function canonicalizePackageReviewCommand(
  commandName: PackageReviewCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: PACKAGE_REVIEW_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}
