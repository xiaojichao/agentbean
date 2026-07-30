import type { ID, UnixMs } from './common.js';

/**
 * Audience-scoped System activity / attention / change feed
 * （issue #929 / ADR-0066 / ADR-0067）。
 *
 * System activity projection 不是 Message、发送者或新的业务事实。
 * PI Manager 不以成员/头像/聊天气泡/typing 出现。
 * attention/read/Task responsibility 独立推进；change-feed cursor ack 不推进 Message Read。
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** 用户可见活动语义等级（ADR-0066）。 */
export const SYSTEM_ACTIVITY_LEVELS = [
  'info',
  'milestone',
  'attention',
  'action_required',
] as const;
export type SystemActivityLevel = (typeof SYSTEM_ACTIVITY_LEVELS)[number];

/** 投影界面用途：三处不得等量复制。 */
export const SYSTEM_ACTIVITY_SURFACES = [
  'task_timeline',
  'thread_card',
  'attention_inbox',
] as const;
export type SystemActivitySurface = (typeof SYSTEM_ACTIVITY_SURFACES)[number];

/**
 * 权威编排事实 kind（从已提交 Task/PI orchestration event 派生）。
 * 内部过程（lease/fencing/checkpoint/model call/CoT）不进入用户活动流。
 */
export const SYSTEM_ACTIVITY_FACT_KINDS = [
  'task_created',
  'task_revised',
  'task_state_changed',
  'offer_issued',
  'claim_acquired',
  'execution_started',
  'waiting',
  'delivery_submitted',
  'in_review',
  'delivery_accepted',
  'delivery_rejected',
  'reassigned',
  'sla_breach',
  'recovery_pending',
  'action_required_opened',
  'action_required_resolved',
  'task_cancelled',
  'task_closed',
] as const;
export type SystemActivityFactKind = (typeof SYSTEM_ACTIVITY_FACT_KINDS)[number];

/** Attention 责任状态：只能由业务动作结束，read/seen 不能解决。 */
export const SYSTEM_ATTENTION_STATES = [
  'open',
  'resolved',
  'dismissed_by_policy',
  'superseded',
] as const;
export type SystemAttentionState = (typeof SYSTEM_ATTENTION_STATES)[number];

export const SYSTEM_ACTIVITY_SCHEMA_VERSION = 1;
export const SYSTEM_ACTIVITY_QUERY_SCHEMA_VERSION = 1;
export const SYSTEM_ACTIVITY_COMMAND_SCHEMA_VERSION = 1;
export const SYSTEM_ACTIVITY_COMMAND_HASH_VERSION = 1;

// ---------------------------------------------------------------------------
// Query / command names
// ---------------------------------------------------------------------------

export const SYSTEM_ACTIVITY_QUERY_NAMES = [
  'query-task-activity',
  'query-thread-task-card',
  'query-attention-inbox',
  'pull-change-feed',
] as const;
export type SystemActivityQueryName = (typeof SYSTEM_ACTIVITY_QUERY_NAMES)[number];

export const SYSTEM_ACTIVITY_COMMAND_NAMES = [
  'project-source-fact',
  'mark-attention-seen',
  'ack-change-feed-cursor',
  'retrim-audience',
] as const;
export type SystemActivityCommandName = (typeof SYSTEM_ACTIVITY_COMMAND_NAMES)[number];

export const SYSTEM_ACTIVITY_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type SystemActivityReceiptOutcome = (typeof SYSTEM_ACTIVITY_RECEIPT_OUTCOMES)[number];

export const SYSTEM_ACTIVITY_OUTCOMES = [
  'applied',
  'no_op',
  'replayed',
  'freshness_hold',
  'conflict',
  'rejected',
  'temporarily_unavailable',
  'outcome_unknown',
  'projection_not_ready',
] as const;
export type SystemActivityOutcome = (typeof SYSTEM_ACTIVITY_OUTCOMES)[number];

export const SYSTEM_ACTIVITY_RETRY_DIRECTIVES = [
  'none',
  'same_key',
  'reread_then_new_command',
  'user_action',
] as const;
export type SystemActivityRetryDirective = (typeof SYSTEM_ACTIVITY_RETRY_DIRECTIVES)[number];

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

/**
 * 权威 stream 上的 Consistency token 片段（ADR-0067）。
 * Query 可要求 minimum positions；投影未追上时必须返回 projection_not_ready。
 */
export interface ConsistencyTokenEntryV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface ConsistencyTokenV1 {
  readonly schemaVersion: 1;
  readonly entries: readonly ConsistencyTokenEntryV1[];
}

/**
 * 已提交编排事实的最小输入（投影原料）。
 * 不含 PI 头像/typing/prompt/CoT；Server 在投影前做 audience 裁剪。
 */
export interface SystemActivitySourceFactV1 {
  readonly schemaVersion: 1;
  readonly eventId: ID;
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly rootTaskId?: ID;
  readonly channelId?: ID;
  readonly threadId?: ID;
  readonly factKind: SystemActivityFactKind;
  readonly occurredAt: UnixMs;
  /** 任务/频道可见成员（用于 timeline / thread card）。 */
  readonly visibleRecipientIds: readonly ID[];
  /** 当前责任人（attention / action_required）。 */
  readonly responsibleRecipientIds: readonly ID[];
  /** 人类可读摘要（已裁剪，无 secret/prompt）。 */
  readonly summary: string;
  /** 绑定的 action_required / review 等稳定业务键。 */
  readonly attentionKey?: string;
  readonly taskRevision?: number;
  readonly deliveryRevision?: number;
  readonly allowedCommands?: readonly string[];
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
}

/**
 * 面向特定受众与界面的投影行（不是 Message）。
 * actorKind 固定为 system；禁止 pi/agent 伪装发送者。
 */
export interface SystemActivityProjectionItemV1 {
  readonly schemaVersion: 1;
  readonly projectionId: ID;
  readonly eventId: ID;
  readonly surface: SystemActivitySurface;
  readonly level: SystemActivityLevel;
  readonly factKind: SystemActivityFactKind;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly rootTaskId?: ID;
  readonly channelId?: ID;
  readonly threadId?: ID;
  readonly recipientId: ID;
  readonly sequence: number;
  readonly revision: number;
  readonly summary: string;
  readonly occurredAt: UnixMs;
  readonly actorKind: 'system';
  readonly attentionIdentity?: ID;
  readonly attentionRevision?: number;
  readonly taskRevision?: number;
  readonly deliveryRevision?: number;
  readonly allowedCommands?: readonly string[];
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
}

export interface SystemAttentionItemV1 {
  readonly schemaVersion: 1;
  readonly attentionIdentity: ID;
  readonly teamId: ID;
  readonly recipientId: ID;
  readonly taskId: ID;
  readonly rootTaskId?: ID;
  readonly channelId?: ID;
  readonly threadId?: ID;
  readonly level: 'attention' | 'action_required';
  readonly state: SystemAttentionState;
  readonly revision: number;
  readonly sourceEventId: ID;
  readonly summary: string;
  readonly unread: boolean;
  readonly seenAt?: UnixMs;
  readonly lastReminderAt?: UnixMs;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly resolvedAt?: UnixMs;
  readonly taskRevision?: number;
  readonly deliveryRevision?: number;
  readonly allowedCommands?: readonly string[];
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
}

/** Thread 稀疏 Task 活动卡（挂在来源 Message/Thread 上，不是聊天气泡）。 */
export interface ThreadTaskActivityCardV1 {
  readonly schemaVersion: 1;
  readonly taskId: ID;
  readonly rootTaskId?: ID;
  readonly channelId: ID;
  readonly threadId?: ID;
  readonly currentLevel: SystemActivityLevel;
  readonly currentSummary: string;
  readonly milestones: readonly SystemActivityProjectionItemV1[];
  readonly asOf: UnixMs;
  readonly audienceScope: string;
}

// ---------------------------------------------------------------------------
// Opaque cursor + change feed
// ---------------------------------------------------------------------------

/**
 * Change feed / query opaque cursor 的解码形态。
 * 客户端只持有 opaque 字符串；ack 只确认 feed delivery。
 */
export interface SystemActivityCursorPayloadV1 {
  readonly schemaVersion: 1;
  readonly audienceUserId: ID;
  readonly teamId: ID;
  readonly surface: SystemActivitySurface | 'change_feed';
  readonly position: number;
  readonly feedEpoch: number;
}

export interface ChangeFeedNoticeV1 {
  readonly schemaVersion: 1;
  readonly noticeId: ID;
  readonly teamId: ID;
  readonly recipientId: ID;
  readonly kind: 'system_activity_wake';
  readonly projectionIds: readonly ID[];
  readonly attentionIdentities: readonly ID[];
  readonly cursor: string;
  readonly issuedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Query I/O
// ---------------------------------------------------------------------------

export interface SystemActivityQueryInputMapV1 {
  readonly 'query-task-activity': {
    readonly taskId: ID;
    readonly recipientId: ID;
    readonly cursor?: string;
    readonly limit: number;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
  readonly 'query-thread-task-card': {
    readonly channelId: ID;
    readonly threadId?: ID;
    readonly taskId: ID;
    readonly recipientId: ID;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
  readonly 'query-attention-inbox': {
    readonly recipientId: ID;
    readonly cursor?: string;
    readonly limit: number;
    readonly onlyUnread?: boolean;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
  readonly 'pull-change-feed': {
    readonly recipientId: ID;
    readonly cursor?: string;
    readonly limit: number;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
}

export interface SystemActivityQueryOutputMapV1 {
  readonly 'query-task-activity': {
    readonly taskId: ID;
    readonly recipientId: ID;
    readonly items: readonly SystemActivityProjectionItemV1[];
    readonly audienceScope: string;
    readonly asOf: UnixMs;
    readonly nextCursor?: string;
    readonly schemaVersion: 1;
  };
  readonly 'query-thread-task-card': {
    readonly card: ThreadTaskActivityCardV1;
    readonly schemaVersion: 1;
  };
  readonly 'query-attention-inbox': {
    readonly recipientId: ID;
    readonly items: readonly SystemAttentionItemV1[];
    readonly audienceScope: string;
    readonly asOf: UnixMs;
    readonly nextCursor?: string;
    readonly schemaVersion: 1;
  };
  readonly 'pull-change-feed': {
    readonly recipientId: ID;
    readonly items: readonly SystemActivityProjectionItemV1[];
    readonly attentionItems: readonly SystemAttentionItemV1[];
    readonly audienceScope: string;
    readonly asOf: UnixMs;
    readonly nextCursor?: string;
    readonly schemaVersion: 1;
  };
}

// ---------------------------------------------------------------------------
// Command envelope + I/O
// ---------------------------------------------------------------------------

export interface SystemActivityCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: SystemActivityCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
}

export interface SystemActivityCommandInputMapV1 {
  readonly 'project-source-fact': {
    readonly fact: SystemActivitySourceFactV1;
    readonly projectionWatermark: number;
  };
  readonly 'mark-attention-seen': {
    readonly attentionIdentity: ID;
    readonly recipientId: ID;
    readonly expectedRevision: number;
  };
  readonly 'ack-change-feed-cursor': {
    readonly recipientId: ID;
    readonly cursor: string;
  };
  readonly 'retrim-audience': {
    readonly taskId: ID;
    readonly visibleRecipientIds: readonly ID[];
    readonly responsibleRecipientIds: readonly ID[];
  };
}

export interface SystemActivityCommandOutputMapV1 {
  readonly 'project-source-fact': {
    readonly eventId: ID;
    readonly projectedItemCount: number;
    readonly attentionUpserted: boolean;
    readonly projectionWatermark: number;
  };
  readonly 'mark-attention-seen': {
    readonly attentionIdentity: ID;
    readonly recipientId: ID;
    readonly revision: number;
    readonly unread: boolean;
    readonly stillOpen: boolean;
  };
  readonly 'ack-change-feed-cursor': {
    readonly recipientId: ID;
    readonly ackedPosition: number;
    /** 明确：不推进 Message Read / attention / Task responsibility。 */
    readonly advancedMessageRead: false;
    readonly advancedAttention: false;
    readonly advancedTaskResponsibility: false;
  };
  readonly 'retrim-audience': {
    readonly taskId: ID;
    readonly removedProjectionCount: number;
    readonly retainedProjectionCount: number;
  };
}

export interface SystemActivityEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

export interface SystemActivityRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface SystemActivityCommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: SystemActivityCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: SystemActivityReceiptOutcome;
  readonly committedRevisions: readonly SystemActivityRevisionRefV1[];
  readonly eventRefs: readonly SystemActivityEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

export interface SystemActivityCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: SystemActivityCommandName;
  readonly outcome: SystemActivityOutcome;
  readonly retryDirective: SystemActivityRetryDirective;
  readonly stableCode: string;
  readonly receipt?: SystemActivityCommandReceiptV1;
  readonly result?: SystemActivityCommandOutputUnionV1;
  readonly conflictReason?: string;
  readonly rejectReason?: string;
  /** 投影未满足 minimum consistency token 时返回。 */
  readonly notReadyStreams?: readonly ConsistencyTokenEntryV1[];
}

export type SystemActivityCommandOutputUnionV1 =
  | ({ readonly commandName: 'project-source-fact' } & SystemActivityCommandOutputMapV1['project-source-fact'])
  | ({ readonly commandName: 'mark-attention-seen' } & SystemActivityCommandOutputMapV1['mark-attention-seen'])
  | ({ readonly commandName: 'ack-change-feed-cursor' } & SystemActivityCommandOutputMapV1['ack-change-feed-cursor'])
  | ({ readonly commandName: 'retrim-audience' } & SystemActivityCommandOutputMapV1['retrim-audience']);

export type SystemActivityQueryOutputUnionV1 =
  | ({ readonly queryName: 'query-task-activity' } & SystemActivityQueryOutputMapV1['query-task-activity'])
  | ({ readonly queryName: 'query-thread-task-card' } & SystemActivityQueryOutputMapV1['query-thread-task-card'])
  | ({ readonly queryName: 'query-attention-inbox' } & SystemActivityQueryOutputMapV1['query-attention-inbox'])
  | ({ readonly queryName: 'pull-change-feed' } & SystemActivityQueryOutputMapV1['pull-change-feed']);

export interface SystemActivityQueryResponseV1 {
  readonly schemaVersion: 1;
  readonly queryName: SystemActivityQueryName;
  readonly outcome: 'ready' | 'projection_not_ready' | 'rejected';
  readonly stableCode: string;
  readonly result?: SystemActivityQueryOutputUnionV1;
  readonly rejectReason?: string;
  readonly notReadyStreams?: readonly ConsistencyTokenEntryV1[];
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
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

export function canonicalizeSystemActivityCommand(
  commandName: SystemActivityCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: SYSTEM_ACTIVITY_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}

// ---------------------------------------------------------------------------
// Opaque cursor helpers
// ---------------------------------------------------------------------------

/** Portable base64url（contracts 可被 web 与 server 共用；避免依赖 Node Buffer）。 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : (globalThis as { Buffer?: { from(data: string, enc: string): { toString(enc: string): string } } })
      .Buffer?.from(binary, 'binary').toString('base64');
  if (!b64) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(cursor: string): string {
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(padLen);
  const binary = typeof atob === 'function'
    ? atob(b64)
    : (globalThis as { Buffer?: { from(data: string, enc: string): { toString(enc: string): string } } })
      .Buffer?.from(b64, 'base64').toString('binary');
  if (binary === undefined) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeSystemActivityCursor(payload: SystemActivityCursorPayloadV1): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeSystemActivityCursor(cursor: string): SystemActivityCursorPayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  return parseSystemActivityCursorPayloadV1(parsed);
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

export const SYSTEM_ACTIVITY_PAYLOAD_INVALID = 'SYSTEM_ACTIVITY_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry))) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function assertLevel(value: unknown): asserts value is SystemActivityLevel {
  if (!SYSTEM_ACTIVITY_LEVELS.includes(value as SystemActivityLevel)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function assertSurface(value: unknown): asserts value is SystemActivitySurface {
  if (!SYSTEM_ACTIVITY_SURFACES.includes(value as SystemActivitySurface)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function assertFactKind(value: unknown): asserts value is SystemActivityFactKind {
  if (!SYSTEM_ACTIVITY_FACT_KINDS.includes(value as SystemActivityFactKind)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

function assertAttentionState(value: unknown): asserts value is SystemAttentionState {
  if (!SYSTEM_ATTENTION_STATES.includes(value as SystemAttentionState)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
}

export function parseConsistencyTokenV1(value: unknown): ConsistencyTokenV1 {
  assertExactKeys(value, ['schemaVersion', 'entries'], ['schemaVersion', 'entries']);
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (!Array.isArray(value.entries)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  const entries = value.entries.map((entry) => {
    assertExactKeys(entry, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
    if (!nonEmpty(entry.streamKind) || !nonEmpty(entry.streamId)) {
      throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
    }
    assertInteger(entry.revision, 0);
    return entry as unknown as ConsistencyTokenEntryV1;
  });
  return { schemaVersion: 1, entries };
}

export function parseSystemActivityCursorPayloadV1(value: unknown): SystemActivityCursorPayloadV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'audienceUserId', 'teamId', 'surface', 'position', 'feedEpoch'],
    ['schemaVersion', 'audienceUserId', 'teamId', 'surface', 'position', 'feedEpoch'],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  assertId(value.audienceUserId);
  assertId(value.teamId);
  if (
    value.surface !== 'change_feed'
    && !SYSTEM_ACTIVITY_SURFACES.includes(value.surface as SystemActivitySurface)
  ) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  assertInteger(value.position, 0);
  assertInteger(value.feedEpoch, 0);
  return value as unknown as SystemActivityCursorPayloadV1;
}

export function parseSystemActivitySourceFactV1(value: unknown): SystemActivitySourceFactV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'eventId', 'streamKind', 'streamId', 'sequence', 'teamId', 'taskId',
      'rootTaskId', 'channelId', 'threadId', 'factKind', 'occurredAt', 'visibleRecipientIds',
      'responsibleRecipientIds', 'summary', 'attentionKey', 'taskRevision', 'deliveryRevision',
      'allowedCommands', 'confirmationToken', 'escalationRevision',
    ],
    [
      'schemaVersion', 'eventId', 'streamKind', 'streamId', 'sequence', 'teamId', 'taskId',
      'factKind', 'occurredAt', 'visibleRecipientIds', 'responsibleRecipientIds', 'summary',
    ],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  assertId(value.eventId);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  assertInteger(value.sequence, 0);
  assertId(value.teamId);
  assertId(value.taskId);
  if (value.rootTaskId !== undefined) assertId(value.rootTaskId);
  if (value.channelId !== undefined) assertId(value.channelId);
  if (value.threadId !== undefined) assertId(value.threadId);
  assertFactKind(value.factKind);
  assertInteger(value.occurredAt, 0);
  assertStringArray(value.visibleRecipientIds);
  assertStringArray(value.responsibleRecipientIds);
  if (!nonEmpty(value.summary)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (value.attentionKey !== undefined && !nonEmpty(value.attentionKey)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 0);
  if (value.deliveryRevision !== undefined) assertInteger(value.deliveryRevision, 0);
  if (value.allowedCommands !== undefined) assertStringArray(value.allowedCommands);
  if (value.confirmationToken !== undefined && !nonEmpty(value.confirmationToken)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (value.escalationRevision !== undefined) assertInteger(value.escalationRevision, 1);
  return value as unknown as SystemActivitySourceFactV1;
}

export function parseSystemActivityProjectionItemV1(value: unknown): SystemActivityProjectionItemV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'projectionId', 'eventId', 'surface', 'level', 'factKind', 'teamId', 'taskId',
      'rootTaskId', 'channelId', 'threadId', 'recipientId', 'sequence', 'revision', 'summary',
      'occurredAt', 'actorKind', 'attentionIdentity', 'attentionRevision', 'taskRevision',
      'deliveryRevision', 'allowedCommands', 'confirmationToken', 'escalationRevision',
    ],
    [
      'schemaVersion', 'projectionId', 'eventId', 'surface', 'level', 'factKind', 'teamId', 'taskId',
      'recipientId', 'sequence', 'revision', 'summary', 'occurredAt', 'actorKind',
    ],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  assertId(value.projectionId);
  assertId(value.eventId);
  assertSurface(value.surface);
  assertLevel(value.level);
  assertFactKind(value.factKind);
  assertId(value.teamId);
  assertId(value.taskId);
  if (value.rootTaskId !== undefined) assertId(value.rootTaskId);
  if (value.channelId !== undefined) assertId(value.channelId);
  if (value.threadId !== undefined) assertId(value.threadId);
  assertId(value.recipientId);
  assertInteger(value.sequence, 0);
  assertInteger(value.revision, 1);
  if (!nonEmpty(value.summary)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  assertInteger(value.occurredAt, 0);
  if (value.actorKind !== 'system') throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (value.attentionIdentity !== undefined) assertId(value.attentionIdentity);
  if (value.attentionRevision !== undefined) assertInteger(value.attentionRevision, 1);
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 0);
  if (value.deliveryRevision !== undefined) assertInteger(value.deliveryRevision, 0);
  if (value.allowedCommands !== undefined) assertStringArray(value.allowedCommands);
  if (value.confirmationToken !== undefined && !nonEmpty(value.confirmationToken)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (value.escalationRevision !== undefined) assertInteger(value.escalationRevision, 1);
  return value as unknown as SystemActivityProjectionItemV1;
}

export function parseSystemAttentionItemV1(value: unknown): SystemAttentionItemV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'attentionIdentity', 'teamId', 'recipientId', 'taskId', 'rootTaskId',
      'channelId', 'threadId', 'level', 'state', 'revision', 'sourceEventId', 'summary', 'unread',
      'seenAt', 'lastReminderAt', 'createdAt', 'updatedAt', 'resolvedAt', 'taskRevision',
      'deliveryRevision', 'allowedCommands', 'confirmationToken', 'escalationRevision',
    ],
    [
      'schemaVersion', 'attentionIdentity', 'teamId', 'recipientId', 'taskId', 'level', 'state',
      'revision', 'sourceEventId', 'summary', 'unread', 'createdAt', 'updatedAt',
    ],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  assertId(value.attentionIdentity);
  assertId(value.teamId);
  assertId(value.recipientId);
  assertId(value.taskId);
  if (value.rootTaskId !== undefined) assertId(value.rootTaskId);
  if (value.channelId !== undefined) assertId(value.channelId);
  if (value.threadId !== undefined) assertId(value.threadId);
  if (value.level !== 'attention' && value.level !== 'action_required') {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  assertAttentionState(value.state);
  assertInteger(value.revision, 1);
  assertId(value.sourceEventId);
  if (!nonEmpty(value.summary)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (typeof value.unread !== 'boolean') throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (value.seenAt !== undefined) assertInteger(value.seenAt, 0);
  if (value.lastReminderAt !== undefined) assertInteger(value.lastReminderAt, 0);
  assertInteger(value.createdAt, 0);
  assertInteger(value.updatedAt, 0);
  if (value.resolvedAt !== undefined) assertInteger(value.resolvedAt, 0);
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 0);
  if (value.deliveryRevision !== undefined) assertInteger(value.deliveryRevision, 0);
  if (value.allowedCommands !== undefined) assertStringArray(value.allowedCommands);
  if (value.confirmationToken !== undefined && !nonEmpty(value.confirmationToken)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (value.escalationRevision !== undefined) assertInteger(value.escalationRevision, 1);
  return value as unknown as SystemAttentionItemV1;
}

export function parseSystemActivityCommandEnvelopeV1(value: unknown): SystemActivityCommandEnvelopeV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (!SYSTEM_ACTIVITY_COMMAND_NAMES.includes(value.commandName as SystemActivityCommandName)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  return value as unknown as SystemActivityCommandEnvelopeV1;
}

export function parseSystemActivityCommandInputV1<K extends SystemActivityCommandName>(
  commandName: K,
  value: unknown,
): SystemActivityCommandInputMapV1[K] {
  switch (commandName) {
    case 'project-source-fact': {
      assertExactKeys(value, ['fact', 'projectionWatermark'], ['fact', 'projectionWatermark']);
      const fact = parseSystemActivitySourceFactV1(value.fact);
      assertInteger(value.projectionWatermark, 0);
      return { fact, projectionWatermark: value.projectionWatermark as number } as SystemActivityCommandInputMapV1[K];
    }
    case 'mark-attention-seen': {
      assertExactKeys(
        value,
        ['attentionIdentity', 'recipientId', 'expectedRevision'],
        ['attentionIdentity', 'recipientId', 'expectedRevision'],
      );
      assertId(value.attentionIdentity);
      assertId(value.recipientId);
      assertInteger(value.expectedRevision, 1);
      return value as unknown as SystemActivityCommandInputMapV1[K];
    }
    case 'ack-change-feed-cursor': {
      assertExactKeys(value, ['recipientId', 'cursor'], ['recipientId', 'cursor']);
      assertId(value.recipientId);
      if (!nonEmpty(value.cursor)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
      // 校验 opaque cursor 可解码
      decodeSystemActivityCursor(value.cursor as string);
      return value as unknown as SystemActivityCommandInputMapV1[K];
    }
    case 'retrim-audience': {
      assertExactKeys(
        value,
        ['taskId', 'visibleRecipientIds', 'responsibleRecipientIds'],
        ['taskId', 'visibleRecipientIds', 'responsibleRecipientIds'],
      );
      assertId(value.taskId);
      assertStringArray(value.visibleRecipientIds);
      assertStringArray(value.responsibleRecipientIds);
      return value as unknown as SystemActivityCommandInputMapV1[K];
    }
    default: {
      const _exhaustive: never = commandName;
      void _exhaustive;
      throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
    }
  }
}

export function parseSystemActivityQueryInputV1<K extends SystemActivityQueryName>(
  queryName: K,
  value: unknown,
): SystemActivityQueryInputMapV1[K] {
  switch (queryName) {
    case 'query-task-activity': {
      assertExactKeys(
        value,
        ['taskId', 'recipientId', 'cursor', 'limit', 'minimumConsistency'],
        ['taskId', 'recipientId', 'limit'],
      );
      assertId(value.taskId);
      assertId(value.recipientId);
      if (value.cursor !== undefined) {
        if (!nonEmpty(value.cursor)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
        decodeSystemActivityCursor(value.cursor as string);
      }
      assertInteger(value.limit, 1);
      if (value.minimumConsistency !== undefined) {
        parseConsistencyTokenV1(value.minimumConsistency);
      }
      return value as unknown as SystemActivityQueryInputMapV1[K];
    }
    case 'query-thread-task-card': {
      assertExactKeys(
        value,
        ['channelId', 'threadId', 'taskId', 'recipientId', 'minimumConsistency'],
        ['channelId', 'taskId', 'recipientId'],
      );
      assertId(value.channelId);
      if (value.threadId !== undefined) assertId(value.threadId);
      assertId(value.taskId);
      assertId(value.recipientId);
      if (value.minimumConsistency !== undefined) {
        parseConsistencyTokenV1(value.minimumConsistency);
      }
      return value as unknown as SystemActivityQueryInputMapV1[K];
    }
    case 'query-attention-inbox': {
      assertExactKeys(
        value,
        ['recipientId', 'cursor', 'limit', 'onlyUnread', 'minimumConsistency'],
        ['recipientId', 'limit'],
      );
      assertId(value.recipientId);
      if (value.cursor !== undefined) {
        if (!nonEmpty(value.cursor)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
        decodeSystemActivityCursor(value.cursor as string);
      }
      assertInteger(value.limit, 1);
      if (value.onlyUnread !== undefined && typeof value.onlyUnread !== 'boolean') {
        throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
      }
      if (value.minimumConsistency !== undefined) {
        parseConsistencyTokenV1(value.minimumConsistency);
      }
      return value as unknown as SystemActivityQueryInputMapV1[K];
    }
    case 'pull-change-feed': {
      assertExactKeys(
        value,
        ['recipientId', 'cursor', 'limit', 'minimumConsistency'],
        ['recipientId', 'limit'],
      );
      assertId(value.recipientId);
      if (value.cursor !== undefined) {
        if (!nonEmpty(value.cursor)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
        decodeSystemActivityCursor(value.cursor as string);
      }
      assertInteger(value.limit, 1);
      if (value.minimumConsistency !== undefined) {
        parseConsistencyTokenV1(value.minimumConsistency);
      }
      return value as unknown as SystemActivityQueryInputMapV1[K];
    }
    default: {
      const _exhaustive: never = queryName;
      void _exhaustive;
      throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
    }
  }
}

export function parseSystemActivityCommandResponseV1(value: unknown): SystemActivityCommandResponseV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt',
      'result', 'conflictReason', 'rejectReason', 'notReadyStreams',
    ],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode'],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (!SYSTEM_ACTIVITY_COMMAND_NAMES.includes(value.commandName as SystemActivityCommandName)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (!SYSTEM_ACTIVITY_OUTCOMES.includes(value.outcome as SystemActivityOutcome)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (!SYSTEM_ACTIVITY_RETRY_DIRECTIVES.includes(value.retryDirective as SystemActivityRetryDirective)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  return value as unknown as SystemActivityCommandResponseV1;
}

export function parseSystemActivityQueryResponseV1(value: unknown): SystemActivityQueryResponseV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'queryName', 'outcome', 'stableCode', 'result', 'rejectReason', 'notReadyStreams'],
    ['schemaVersion', 'queryName', 'outcome', 'stableCode'],
  );
  if (value.schemaVersion !== 1) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  if (!SYSTEM_ACTIVITY_QUERY_NAMES.includes(value.queryName as SystemActivityQueryName)) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (
    value.outcome !== 'ready'
    && value.outcome !== 'projection_not_ready'
    && value.outcome !== 'rejected'
  ) {
    throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(SYSTEM_ACTIVITY_PAYLOAD_INVALID);
  return value as unknown as SystemActivityQueryResponseV1;
}
