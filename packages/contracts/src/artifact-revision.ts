import type { ID, UnixMs } from './common.js';
import { COMMAND_PROVENANCE_KINDS, type CommandProvenanceKind, type CommandProvenanceRefV1 } from './message-tracer.js';

/**
 * ArtifactRevision 命令合同(issue #1062,父规格 #1059 §7/§9/§11;ADR-0067 Command registry)。
 *
 * 闭环「基于此修改」与 Markdown 并发冲突:用户对 collection 内一个明确版本(典型为被拒绝或
 * 要求修改的交付版本)发起修订,保存时携带冻结 provenance(revisionBasis:sourceVersionId +
 * review basis + 来源 package/delivery),Server 复验后原子产生新 Artifact +
 * 新 ProjectArtifactVersion + collection.currentVersionId 移动。新 revision 不自动继承旧
 * ArtifactReview、Task acceptance 或 finalization;finalVersionId 不因手工编辑或 Agent 修订移动;
 * 历史 Run artifact 保持不可变(永远新建 Artifact,不改写原文件事实)。
 *
 * 并发合同:baseVersionId 必须等于 collection.currentVersionId(内容 base fence),
 * expectedCollectionRevision 必须等于 collection.revision(覆盖 final 移动/其他 append);
 * stale → outcome='conflict' + 结构化 revisionConflict(base/Server 最新/草稿保留),
 * 不写任何部分版本;首版不做自动文本合并,客户端保留草稿并提供「查看最新版/人工合并」。
 *
 * authority 一律由 Server 从 session 与已持久化事实推导(频道人类成员 + 未归档 +
 * markdownEditing rollout),envelope 严禁 authority/teamId 字段(#900 §1 / ADR-0067)。
 *
 * 本文件只提供 runtime schemas、discriminated unions、canonical serialization 与跨端 conformance
 * 基础;具体 handler、存储与接线属于 server-next 切片。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— ArtifactRevision family
// ---------------------------------------------------------------------------

/** 冻结的具名 command 集合。未登记 command 必须被 Server 拒绝(ADR-0067)。 */
export const ARTIFACT_REVISION_COMMAND_NAMES = ['save-artifact-version-revision'] as const;
export type ArtifactRevisionCommandName = (typeof ARTIFACT_REVISION_COMMAND_NAMES)[number];

/** envelope 的当前 schema 版本(ADR-0067:envelope 分别版本化)。 */
export const ARTIFACT_REVISION_ENVELOPE_SCHEMA_VERSION = 1;
/** command payload 的当前 schema 版本。 */
export const ARTIFACT_REVISION_COMMAND_SCHEMA_VERSION = 1;
/** canonical command hash 规范版本;hash 算法升级时递增,使旧 hash 不被误判相等。 */
export const ARTIFACT_REVISION_COMMAND_HASH_VERSION = 1;

/** Command receipt 的终态 outcome(ADR-0067:嵌套 receipt 终态始终 applied 或 no_op)。 */
export const ARTIFACT_REVISION_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type ArtifactRevisionReceiptOutcome = (typeof ARTIFACT_REVISION_RECEIPT_OUTCOMES)[number];

/** Command response outcome 固定八态(#900 §16 / ADR-0067)。 */
export const ARTIFACT_REVISION_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;
export type ArtifactRevisionOutcome = (typeof ARTIFACT_REVISION_OUTCOMES)[number];

/** 重试指令四态(ADR-0067)。stale conflict 用 reread_then_new_command(查看最新版后人工合并)。 */
export const ARTIFACT_REVISION_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;
export type ArtifactRevisionRetryDirective = (typeof ARTIFACT_REVISION_RETRY_DIRECTIVES)[number];

/**
 * 结构化拒绝码(#1059 §7/§11):任一拒绝都不得留下部分 version/artifact 事实;
 * 用户草稿与明确选择不被静默丢弃。
 */
export const ARTIFACT_REVISION_REJECTION_REASONS = [
  /** 频道不存在。 */
  'channel-not-found',
  /** 频道已归档,归档后所有写 command fail closed(#1059 §11)。 */
  'channel-archived',
  /** collection 不存在或不属于该频道(防跨作用域读取,不暴露存在性)。 */
  'collection-not-found',
  /** base/source version 不属于声明的 collection。 */
  'version-not-in-collection',
  /** base 版本不是 Markdown(在线编辑只支持 Markdown;其他类型走下游 Agent 修订)。 */
  'not-markdown-version',
  /** 操作者不是当前频道人类成员(权限撤销 fail closed;Agent/PI 无此命令)。 */
  'actor-not-authorized',
  /** 冻结 basis 与 Server 事实对不上:review 不属于 sourceVersion 或 decision 非
   *  rejected/changes_requested;package/delivery 与 sourceVersion 的冻结成员身份不符。 */
  'revision-basis-mismatch',
  /** Markdown 编辑 rollout 未启用(与 Channel document 编辑同一开关)。 */
  'revision-editing-disabled',
  /** 内容超 2MB 或含危险 HTML/协议(与文档保存同规则)。 */
  'content-invalid',
  /** 请求字段非法。 */
  'invalid-request',
] as const;
export type ArtifactRevisionRejectionReason = (typeof ARTIFACT_REVISION_REJECTION_REASONS)[number];

/**
 * 结构化 conflict 码(AC6/AC8)。同 idempotency key 异 payload 的 conflict 不属于此类
 * (走 conflictReason='idempotency-key-hash-mismatch',registry 通用语义,无结构化 payload)。
 */
export const ARTIFACT_REVISION_CONFLICT_CODES = [
  /** 内容 base fence:baseVersionId 已不等于 collection.currentVersionId。 */
  'base-version-stale',
  /** 集合 revision fence:并发 append/finalization 已推进 collection.revision。 */
  'collection-revision-stale',
  /** 冻结 review basis 已被更新的审核取代(sourceVersion 出现更新 review)。 */
  'revision-basis-stale',
] as const;
export type ArtifactRevisionConflictCode = (typeof ARTIFACT_REVISION_CONFLICT_CODES)[number];

/**
 * 「基于此修改」动作(AC1)。Server 在 package 成员 availableActions 中下发;
 * 客户端只渲染 Server 给出的动作,不推断权限(#1061 AC11 同源)。
 */
export const ARTIFACT_REVISION_ACTIONS = ['revise-version'] as const;
export type ArtifactRevisionAction = (typeof ARTIFACT_REVISION_ACTIONS)[number];

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * 修订冻结 provenance(AC1):修改动作始终携带具体 version/review/package/delivery 依据;
 * 短标识或「刚才那个」不充当长期身份(AC3)。Server 逐项复验,不信客户端自报。
 */
export interface ArtifactRevisionBasisV1 {
  /** 基于此修改的明确版本(通常即 baseVersionId;人工合并后可不同)。 */
  readonly sourceVersionId: ID;
  /** 回应的 rejected/changes_requested 审核记录(可选;提供时必须是 sourceVersion 的最新 review)。 */
  readonly basisReviewId?: ID;
  /** 来源 package(可选;提供时 sourceVersion 必须是其冻结成员)。 */
  readonly packageId?: ID;
  /** 来源 delivery(可选;必须与 package 的 delivery 一致)。 */
  readonly deliveryId?: ID;
}

/**
 * 结构化 conflict payload(AC6/AC7):客户端据此展示当前 base、Server 最新 revision、
 * 草稿保留状态与「查看最新版/人工合并」下一步。Server 未写任何部分版本。
 */
export interface ArtifactRevisionConflictDto {
  readonly code: ArtifactRevisionConflictCode;
  /** 用户编辑时的内容 base。 */
  readonly baseVersionId: ID;
  /** Server 当前最新版本(current 指针)。 */
  readonly serverCurrentVersionId: ID;
  readonly serverCurrentVersionNumber: number;
  /** Server 当前 collection revision(人工合并后重存的新 fence)。 */
  readonly collectionRevision: number;
  /** 恒 true:conflict 时 Server 零写入,用户草稿由客户端保留。 */
  readonly draftPreserved: true;
}

/** 保存成功结果:一致 identity 供 Chat/Task/Files 三处投影对齐(AC10)。 */
export interface ArtifactVersionRevisionSaveResultDto {
  /** ADR-0067 output union 附加键:result 与 response 描述同一 command。 */
  readonly commandName: 'save-artifact-version-revision';
  readonly versionId: ID;
  readonly collectionId: ID;
  readonly versionNumber: number;
  readonly artifactId: ID;
  readonly baseVersionId: ID;
  readonly sourceVersionId: ID;
  readonly basisReviewId?: ID;
  readonly packageId?: ID;
  readonly deliveryId?: ID;
  /** 保存后的 collection revision(新 fence)。 */
  readonly collectionRevision: number;
  /** 保存后的 current 指针(= versionId)。 */
  readonly currentVersionId: ID;
  /** 保存后的 final 指针(不因此命令移动,返回以钉死 AC4;可能为空)。 */
  readonly finalVersionId?: ID;
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps(ADR-0067)
// ---------------------------------------------------------------------------

export interface ArtifactRevisionCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: ArtifactRevisionCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface ArtifactRevisionCommandInputMapV1 {
  readonly 'save-artifact-version-revision': {
    readonly channelId: ID;
    readonly collectionId: ID;
    /** 内容 base + fence:必须等于保存时的 collection.currentVersionId。 */
    readonly baseVersionId: ID;
    /** Markdown 全文;空字符串合法(用户清空),大小/安全校验在 Server。 */
    readonly content: string;
    /** 可选展示文件名(sanitize 在 Server);缺省沿用 base 版本文件名。 */
    readonly filename?: string;
    /** 集合 revision fence:并发 append/finalization 已推进 → conflict。 */
    readonly expectedCollectionRevision: number;
    /** 冻结修订 provenance(AC1)。 */
    readonly revisionBasis: ArtifactRevisionBasisV1;
    readonly idempotencyKey: string;
  };
}

export interface ArtifactRevisionCommandOutputMapV1 {
  readonly 'save-artifact-version-revision': ArtifactVersionRevisionSaveResultDto;
}

export type ArtifactRevisionCommandOutputUnionV1 =
  | ({ readonly commandName: 'save-artifact-version-revision' } & ArtifactRevisionCommandOutputMapV1['save-artifact-version-revision']);

/** 已成立的过去式领域事实引用(#900 §9)。 */
export interface ArtifactRevisionEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

/** 已提交的专项 revision 引用(#900 §24)。 */
export interface ArtifactRevisionRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

/** 一个 command 只有一个持久 Command receipt。 */
export interface ArtifactRevisionReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: ArtifactRevisionCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash(由 canonicalizeArtifactRevisionCommand 派生,server 计算 sha256)。 */
  readonly commandHash: string;
  readonly outcome: ArtifactRevisionReceiptOutcome;
  readonly committedRevisions: readonly ArtifactRevisionRevisionRefV1[];
  readonly eventRefs: readonly ArtifactRevisionEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

/** Command 响应。携带稳定 code、retry directive 与结构化 conflict。 */
export interface ArtifactRevisionCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: ArtifactRevisionCommandName;
  readonly outcome: ArtifactRevisionOutcome;
  readonly retryDirective: ArtifactRevisionRetryDirective;
  readonly stableCode: string;
  /** applied / no_op / replayed 时携带首次 receipt。 */
  readonly receipt?: ArtifactRevisionReceiptV1;
  /** 成功(applied)时的 command 结果。 */
  readonly result?: ArtifactRevisionCommandOutputUnionV1;
  /** conflict:稳定码(stale fence 三态或 idempotency-key-hash-mismatch)。 */
  readonly conflictReason?: string;
  /** conflict(stale fence):结构化 payload(AC6/AC7)。 */
  readonly revisionConflict?: ArtifactRevisionConflictDto;
  /** rejected:结构化拒绝码(ARTIFACT_REVISION_REJECTION_REASONS)。 */
  readonly rejectedReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const ARTIFACT_REVISION_PAYLOAD_INVALID = 'ARTIFACT_REVISION_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  if (value.hash !== undefined && !nonEmpty(value.hash)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
}

function assertRevisionBasis(value: unknown): void {
  assertExactKeys(value, ['sourceVersionId', 'basisReviewId', 'packageId', 'deliveryId'], ['sourceVersionId']);
  assertId(value.sourceVersionId);
  for (const opt of ['basisReviewId', 'packageId', 'deliveryId'] as const) {
    if (value[opt] !== undefined) assertId(value[opt]);
  }
}

function assertSaveInput(value: unknown): void {
  assertExactKeys(value,
    ['channelId', 'collectionId', 'baseVersionId', 'content', 'filename',
      'expectedCollectionRevision', 'revisionBasis', 'idempotencyKey'],
    ['channelId', 'collectionId', 'baseVersionId', 'content',
      'expectedCollectionRevision', 'revisionBasis', 'idempotencyKey']);
  assertId(value.channelId);
  assertId(value.collectionId);
  assertId(value.baseVersionId);
  if (typeof value.content !== 'string') throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  if (value.filename !== undefined && !nonEmpty(value.filename)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  assertInteger(value.expectedCollectionRevision, 1);
  assertRevisionBasis(value.revisionBasis);
  assertId(value.idempotencyKey);
}

function assertConflictDto(value: unknown): void {
  assertExactKeys(value,
    ['code', 'baseVersionId', 'serverCurrentVersionId', 'serverCurrentVersionNumber',
      'collectionRevision', 'draftPreserved'],
    ['code', 'baseVersionId', 'serverCurrentVersionId', 'serverCurrentVersionNumber',
      'collectionRevision', 'draftPreserved']);
  if (!ARTIFACT_REVISION_CONFLICT_CODES.includes(value.code as ArtifactRevisionConflictCode)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  assertId(value.baseVersionId);
  assertId(value.serverCurrentVersionId);
  assertInteger(value.serverCurrentVersionNumber, 1);
  assertInteger(value.collectionRevision, 1);
  if (value.draftPreserved !== true) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
}

function assertSaveResult(value: unknown): void {
  assertExactKeys(value,
    ['commandName', 'versionId', 'collectionId', 'versionNumber', 'artifactId', 'baseVersionId',
      'sourceVersionId', 'basisReviewId', 'packageId', 'deliveryId', 'collectionRevision',
      'currentVersionId', 'finalVersionId', 'createdAt'],
    ['commandName', 'versionId', 'collectionId', 'versionNumber', 'artifactId', 'baseVersionId',
      'sourceVersionId', 'collectionRevision', 'currentVersionId', 'createdAt']);
  if (value.commandName !== 'save-artifact-version-revision') throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  for (const key of ['versionId', 'collectionId', 'artifactId', 'baseVersionId', 'sourceVersionId',
    'currentVersionId'] as const) {
    assertId(value[key]);
  }
  for (const opt of ['basisReviewId', 'packageId', 'deliveryId', 'finalVersionId'] as const) {
    if (value[opt] !== undefined) assertId(value[opt]);
  }
  assertInteger(value.versionNumber, 1);
  assertInteger(value.collectionRevision, 1);
  assertInteger(value.createdAt, 0);
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  assertInteger(value.sequence, 0);
}

function assertReceipt(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable']);
  if (value.schemaVersion !== 1) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  assertId(value.receiptId);
  if (!ARTIFACT_REVISION_COMMAND_NAMES.includes(value.commandName as ArtifactRevisionCommandName)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!ARTIFACT_REVISION_RECEIPT_OUTCOMES.includes(value.outcome as ArtifactRevisionReceiptOutcome)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
}

// ---------------------------------------------------------------------------
// Parsers(exact-key + structuredClone,防外部可变引用外泄)
// ---------------------------------------------------------------------------

export function parseArtifactRevisionCommandEnvelopeV1(value: unknown): ArtifactRevisionCommandEnvelopeV1 {
  // 拒绝任何 authority/scope 自报告字段(teamId、authoritySubject、requesterId、actor 等)。
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey']);
  if (value.schemaVersion !== ARTIFACT_REVISION_ENVELOPE_SCHEMA_VERSION) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  if (!ARTIFACT_REVISION_COMMAND_NAMES.includes(value.commandName as ArtifactRevisionCommandName)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  // 本切片只实现 V1:未知/未来 commandSchemaVersion 必须拒绝,禁止按 V1 静默执行。
  if (value.commandSchemaVersion !== ARTIFACT_REVISION_COMMAND_SCHEMA_VERSION) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as ArtifactRevisionCommandEnvelopeV1;
}

export function parseArtifactRevisionCommandInputV1(
  commandName: ArtifactRevisionCommandName,
  value: unknown,
): ArtifactRevisionCommandInputMapV1[ArtifactRevisionCommandName] {
  if (commandName !== 'save-artifact-version-revision') throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  assertSaveInput(value);
  return structuredClone(value) as unknown as ArtifactRevisionCommandInputMapV1['save-artifact-version-revision'];
}

export function parseArtifactRevisionReceiptV1(value: unknown): ArtifactRevisionReceiptV1 {
  assertReceipt(value);
  return structuredClone(value) as unknown as ArtifactRevisionReceiptV1;
}

export function parseArtifactRevisionCommandResponseV1(value: unknown): ArtifactRevisionCommandResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'revisionConflict', 'rejectedReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode']);
  if (value.schemaVersion !== 1) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  if (!ARTIFACT_REVISION_COMMAND_NAMES.includes(value.commandName as ArtifactRevisionCommandName)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  if (!ARTIFACT_REVISION_OUTCOMES.includes(value.outcome as ArtifactRevisionOutcome)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  if (!ARTIFACT_REVISION_RETRY_DIRECTIVES.includes(value.retryDirective as ArtifactRevisionRetryDirective)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertReceipt(value.receipt);
  if (value.result !== undefined) {
    // result 必须与 response 描述同一 command(防跨 command 串型)。
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)) {
      throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
    }
    assertSaveResult(value.result);
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  if (value.revisionConflict !== undefined) assertConflictDto(value.revisionConflict);
  if (value.rejectedReason !== undefined && !nonEmpty(value.rejectedReason)) {
    throw new Error(ARTIFACT_REVISION_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as ArtifactRevisionCommandResponseV1;
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
 * 计算 command 的 canonical 串。hash 包含 command/schema 与完整语义 payload(含 revisionBasis、
 * content 与 payload 内的 idempotencyKey——与 package-review 同源:key 是查重键同时也是 payload
 * 字段,同 key 同 payload 恒等),**排除** transport headers 与 trace ID。
 * 同 idempotency key 下:canonical 相等 = replay(返回首次 receipt);不等 = conflict。
 */
export function canonicalizeArtifactRevisionCommand(
  commandName: ArtifactRevisionCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: ARTIFACT_REVISION_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}
