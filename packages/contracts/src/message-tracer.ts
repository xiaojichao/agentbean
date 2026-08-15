import type { ID, UnixMs } from './common.js';
import type { MessageMentionDto } from './message.js';

/**
 * Message tracer 命令合同（issue #921 / ADR-0067 Command registry 的 Message/Read/attention family）。
 *
 * 这三个具名 command 是「普通聊天可靠进入 Message delivery 层；接收者能恢复 Inbox、显式确认已读」
 * 的权威写入口。它们共享 transport-independent envelope、exact-key runtime schema、版本化 outcome/receipt
 * 与业务幂等身份；Server 在单个事务里原子提交 Message + InboxItem + receipt/event/audit/outbox，
 * notice 只负责可恢复唤醒（#893 / #900 / ADR-0062 / ADR-0067 / ADR-0069）。
 *
 * 本文件只提供 runtime schemas、discriminated unions、contract capabilities、canonical serialization 与
 * 跨端 conformance 基础；具体 handler、存储与接线属于 server-next 切片。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— Command registry 的 Message/Read/attention family
// ---------------------------------------------------------------------------

/**
 * 冻结的具名 command 集合。未登记 command 必须被 Server 拒绝（ADR-0067）。
 * 顺序即 registry 公开顺序，测试钉死长度防止误增删。
 */
export const MESSAGE_TRACER_COMMAND_NAMES = [
  'send-message',
  'check-inbox',
  'ack-read-candidate',
] as const;

export type MessageTracerCommandName = (typeof MESSAGE_TRACER_COMMAND_NAMES)[number];

/** envelope 的当前 schema 版本（ADR-0067：envelope 分别版本化）。 */
export const MESSAGE_TRACER_ENVELOPE_SCHEMA_VERSION = 1;
/** 各 command payload 的当前 schema 版本。 */
export const MESSAGE_TRACER_COMMAND_SCHEMA_VERSION = 1;
/** canonical command hash 规范版本；hash 算法升级时递增，使旧 hash 不被误判相等。 */
export const MESSAGE_TRACER_COMMAND_HASH_VERSION = 1;

// ---------------------------------------------------------------------------
// Recipient × target 投影（#893 §3）
// ---------------------------------------------------------------------------

/**
 * Read boundary 按「接收方 × Message target」维护，target 至少独立区分频道主线、每个 Thread、
 * 每个 DM 与 DM Thread。这里只记录语义 kind；具体 channelId/threadId 由 Server 解析。
 */
export type MessageTargetKind = 'channel-mainline' | 'thread' | 'dm' | 'dm-thread';

export const MESSAGE_TARGET_KINDS = [
  'channel-mainline', 'thread', 'dm', 'dm-thread',
] as const;

/** 消息发送方类别（与 message.ts SenderKind 同源）。 */
export const MESSAGE_SENDER_KINDS = ['human', 'agent', 'system'] as const;
export type MessageSenderKind = (typeof MESSAGE_SENDER_KINDS)[number];

/** @提及成员类别。 */
export const MESSAGE_MENTION_KINDS = ['human', 'agent'] as const;

/** Command receipt 的终态 outcome（ADR-0067：嵌套 receipt 终态始终 applied 或 no_op）。 */
export const MESSAGE_TRACER_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type MessageTracerReceiptOutcome = (typeof MESSAGE_TRACER_RECEIPT_OUTCOMES)[number];

/**
 * 一个 target 的稳定引用。`threadId` 在 mainline/dm 上省略，在 thread/dm-thread 上指向 root 消息 id。
 * target 只定位、排序和引用原消息，不决定 recipient 的连续 Inbox 投影。
 */
export interface MessageTargetRefV1 {
  readonly schemaVersion: 1;
  readonly kind: MessageTargetKind;
  readonly channelId: ID;
  readonly threadId?: ID;
}

/**
 * Server 签发的不透明 Read candidate（#893 §3 / ADR-0067 §Query）。
 * 绑定 recipient × target × Inbox 投影位置；`ack-read-candidate` 才推进权威 Read boundary，
 * 读取本身不推进。`proof` 是 Server 的 HMAC/签名，使客户端无法自造或跨 recipient/target 伪造 token。
 */
export interface ReadCandidateTokenV1 {
  readonly schemaVersion: 1;
  readonly recipientId: ID;
  readonly target: MessageTargetRefV1;
  /** 连续 Inbox 前缀截至位置（仅定位/排序，不是 target 全量消息序列）。 */
  readonly targetSeq: number;
  readonly issuedAt: UnixMs;
  readonly proof: string;
}

// ---------------------------------------------------------------------------
// Provenance（#900 §22 / ADR-0067）
// ---------------------------------------------------------------------------

export const COMMAND_PROVENANCE_KINDS = [
  'message', 'task', 'artifact', 'workspace-run', 'invocation',
] as const;

export type CommandProvenanceKind = (typeof COMMAND_PROVENANCE_KINDS)[number];

/**
 * 引用只证明 provenance，不授予权限；来源后续编辑或删除不静默改写已提交事实。
 * 一个 command 只有一个 causationRef，可带多个 sourceRefs。
 */
export interface CommandProvenanceRefV1 {
  readonly kind: CommandProvenanceKind;
  readonly id: ID;
  readonly revision?: number;
  readonly sequence?: number;
  readonly scope?: string;
  readonly hash?: string;
}

// ---------------------------------------------------------------------------
// Freshness basis（#893 §4 / ADR-0067：只有 send/claim 声明 Message Freshness basis）
// ---------------------------------------------------------------------------

/**
 * send 声明并由 Server 校验的 Freshness basis：target、Read candidate，以及可选的依据 Message 或关联 Task。
 * 非 send/claim command 不得伪造 Message Freshness basis（ADR-0067）。
 */
export interface SendMessageFreshnessBasisV1 {
  readonly schemaVersion: 1;
  readonly target: MessageTargetRefV1;
  readonly readCandidate?: ReadCandidateTokenV1;
  readonly basisMessageId?: ID;
  readonly basisTaskId?: ID;
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps（ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 客户端提交的共享、transport-independent envelope（ADR-0067）。**固定只含** command/schema identity、
 * idempotency key 与来源引用；**严禁** authority、team/tenant 或目标 scope 字段——这些一律由 Server 按
 * 认证/协议推导（#900 §1 禁止客户端自报 actor/authority；#900 §18 Server 推导 authority；tenant/scope 由
 * Server 形成幂等范围）。idempotencyKey 绑定逻辑业务命令，不绑定网络请求或短命 worker。
 */
export interface MessageTracerCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: MessageTracerCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

/** Server 校验后随 continuation source 消息持久化的来源标记。 */
export interface TaskContinuationSourceMarkerV1 {
  readonly schemaVersion: 1;
  readonly sourceTaskId: ID;
  readonly sourceTaskRevision: number;
}

export interface MessageTracerCommandInputMapV1 {
  /**
   * 投递一条消息。成功只提交本次已校验、已展示的 candidate；自身消息不入自身 Inbox；
   * relevant 新增变化触发 freshness_hold，不产生 Message，也不提交 Read boundary。
   */
  readonly 'send-message': {
    readonly channelId: ID;
    readonly threadId?: ID;
    readonly senderKind: MessageSenderKind;
    readonly body: string;
    readonly mentions?: readonly MessageMentionDto[];
    readonly attachmentIds?: readonly ID[];
    /** 来源去重输入（ADR-0067 §21）：client ID 只能作为意图或来源去重输入，不作为权威身份。 */
    readonly clientMessageId?: string;
    /** 经 Server 复验后持久化，供 promotion gate 绑定原 Task revision。 */
    readonly taskContinuationSource?: TaskContinuationSourceMarkerV1;
    /** send 必带 Freshness basis（ADR-0067）。 */
    readonly freshnessBasis: SendMessageFreshnessBasisV1;
  };
  /** candidate-producing read operation：只返回连续 Inbox 前缀并签发新 Read candidate，不推进权威边界。 */
  readonly 'check-inbox': {
    readonly recipientId: ID;
    readonly target: MessageTargetRefV1;
    readonly afterSeq?: number;
    readonly limit: number;
  };
  /** 显式、幂等、单调推进 Read boundary。过期/篡改/recipient-target 不匹配的 token 必须拒绝且无副作用。 */
  readonly 'ack-read-candidate': {
    readonly readCandidate: ReadCandidateTokenV1;
  };
}

/** 已成立的过去式领域事实引用（#900 §9）。 */
export interface MessageTracerEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

/**
 * 已提交的专项 revision 引用（#900 §24：Message freshness、Inbox、read-boundary 分别维护专项 revision，
 * 禁止粗粒度 last-write-wins）。`streamKind` 由 server 约定，覆盖 delivered / read / attention /
 * task-responsibility 等独立事实（#921 AC：四者各自独立推进）；attention 的具名 command 属后续切片。
 */
export interface MessageTracerRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

/** Inbox 连续前缀项的最小摘要（audience redaction：不回传 body）。 */
export interface InboxItemSummaryV1 {
  readonly messageId: ID;
  readonly targetSeq: number;
  readonly senderKind: 'human' | 'agent' | 'system';
  readonly senderId: ID;
}

export interface MessageTracerCommandOutputMapV1 {
  readonly 'send-message': {
    readonly messageId: ID;
    readonly targetSeq: number;
    /** 该消息投影给的接收方 id（不含发送者自身）。 */
    readonly inboxItemRecipientIds: readonly ID[];
  };
  readonly 'check-inbox': {
    readonly recipientId: ID;
    readonly target: MessageTargetRefV1;
    readonly items: readonly InboxItemSummaryV1[];
    readonly readCandidate: ReadCandidateTokenV1;
    /** 受众作用域（#900 §11 Query 元数据）：该投影可见的受众边界。 */
    readonly audienceScope: string;
    /** 投影水位（#900 §11 asOf watermark）：该连续前缀对应的权威投影位置。 */
    readonly asOf: UnixMs;
  };
  readonly 'ack-read-candidate': {
    readonly recipientId: ID;
    readonly target: MessageTargetRefV1;
    /** 推进到的权威 Read boundary 位置。 */
    readonly advancedToSeq: number;
  };
}

// ---------------------------------------------------------------------------
// Receipt + response outcome（#900 §6/§16 / ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 一个 command 只有一个持久 Command receipt。`outcome` 是嵌套 receipt 的终态（始终 applied 或 no_op），
 * response 层的 `replayed` disposition 不改写它。`resultAvailable=false` 表示结果 payload 已按治理压缩，
 * 仅保留足以识别 replay/conflict 的 tombstone-backed projection，不能恢复内容或重新执行。
 */
export interface CommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: MessageTracerCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash（由 canonicalizeMessageTracerCommand 派生，domain/server 计算 sha256）。 */
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly MessageTracerRevisionRefV1[];
  readonly eventRefs: readonly MessageTracerEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

/**
 * Command response outcome 固定八态（#900 §16 / ADR-0067）。
 * `replayed` 表示本次请求命中既有 receipt；嵌套 receipt 终态保留首次 applied/no_op。
 */
export const MESSAGE_TRACER_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;

export type MessageTracerOutcome = (typeof MESSAGE_TRACER_OUTCOMES)[number];

/** 重试指令四态（ADR-0067）。outcome_unknown 必须用原 key 查 receipt 或 replay，严禁换 key。 */
export const MESSAGE_TRACER_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;

export type MessageTracerRetryDirective = (typeof MESSAGE_TRACER_RETRY_DIRECTIVES)[number];

/**
 * Command 响应。携带稳定 code、retry directive 与安全裁剪的当前引用。
 * 成功结果 `result` 按 command 类型区分；freshness_hold/conflict 携带各自的最小上下文。
 */
export interface MessageTracerCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: MessageTracerCommandName;
  readonly outcome: MessageTracerOutcome;
  readonly retryDirective: MessageTracerRetryDirective;
  readonly stableCode: string;
  /** applied / no_op / replayed 时携带首次 receipt。 */
  readonly receipt?: CommandReceiptV1;
  /** 成功（applied）时的 command 结果。 */
  readonly result?: MessageTracerCommandOutputUnionV1;
  /** freshness_hold：相关新增变化阻塞，保存草稿/增量上下文与新 candidate，不产生 Message。 */
  readonly heldTarget?: MessageTargetRefV1;
  readonly heldReason?: string;
  readonly newReadCandidate?: ReadCandidateTokenV1;
  /** conflict：同 idempotency key 但 canonical command hash 不同，无副作用。 */
  readonly conflictReason?: string;
}

export type MessageTracerCommandOutputUnionV1 =
  | ({ readonly commandName: 'send-message' } & MessageTracerCommandOutputMapV1['send-message'])
  | ({ readonly commandName: 'check-inbox' } & MessageTracerCommandOutputMapV1['check-inbox'])
  | ({ readonly commandName: 'ack-read-candidate' } & MessageTracerCommandOutputMapV1['ack-read-candidate']);

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const MESSAGE_TRACER_PAYLOAD_INVALID = 'MESSAGE_TRACER_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertStringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry))) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertTargetKind(value: unknown): asserts value is MessageTargetKind {
  if (!MESSAGE_TARGET_KINDS.includes(value as typeof MESSAGE_TARGET_KINDS[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
}

function assertMessageTargetRef(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'kind', 'channelId', 'threadId'], ['schemaVersion', 'kind', 'channelId']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertTargetKind(value.kind);
  assertId(value.channelId);
  // mainline/dm 无 threadId；thread/dm-thread 必须带 threadId。
  const needsThread = value.kind === 'thread' || value.kind === 'dm-thread';
  if (needsThread ? !nonEmpty(value.threadId) : value.threadId !== undefined) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
}

function assertReadCandidateToken(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'recipientId', 'target', 'targetSeq', 'issuedAt', 'proof'],
    ['schemaVersion', 'recipientId', 'target', 'targetSeq', 'issuedAt', 'proof']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertId(value.recipientId);
  assertMessageTargetRef(value.target);
  assertInteger(value.targetSeq, 0);
  assertInteger(value.issuedAt, 0);
  if (!nonEmpty(value.proof)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as typeof COMMAND_PROVENANCE_KINDS[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (value.hash !== undefined && !nonEmpty(value.hash)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertSendMessageFreshnessBasis(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'target', 'readCandidate', 'basisMessageId', 'basisTaskId'],
    ['schemaVersion', 'target']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertMessageTargetRef(value.target);
  if (value.readCandidate !== undefined) assertReadCandidateToken(value.readCandidate);
  if (value.basisMessageId !== undefined && !nonEmpty(value.basisMessageId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (value.basisTaskId !== undefined && !nonEmpty(value.basisTaskId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertTaskContinuationSourceMarker(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'sourceTaskId', 'sourceTaskRevision'],
    ['schemaVersion', 'sourceTaskId', 'sourceTaskRevision']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertId(value.sourceTaskId);
  assertInteger(value.sourceTaskRevision, 1);
}

function assertInboxItemSummary(value: unknown): void {
  assertExactKeys(value, ['messageId', 'targetSeq', 'senderKind', 'senderId'],
    ['messageId', 'targetSeq', 'senderKind', 'senderId']);
  assertId(value.messageId);
  assertInteger(value.targetSeq, 0);
  if (!MESSAGE_SENDER_KINDS.includes(value.senderKind as typeof MESSAGE_SENDER_KINDS[number])) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertId(value.senderId);
}

function assertMention(value: unknown): void {
  assertExactKeys(value, ['id', 'kind', 'name', 'start', 'end'], ['id', 'kind', 'name', 'start', 'end']);
  assertId(value.id);
  if (!MESSAGE_MENTION_KINDS.includes(value.kind as typeof MESSAGE_MENTION_KINDS[number])) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (!nonEmpty(value.name)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertInteger(value.start, 0);
  assertInteger(value.end, 0);
  if (Number(value.end) < Number(value.start)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertMessageTracerInput(commandName: MessageTracerCommandName, value: unknown): void {
  if (commandName === 'send-message') {
    assertExactKeys(value,
      ['channelId', 'threadId', 'senderKind', 'body', 'mentions', 'attachmentIds', 'clientMessageId', 'taskContinuationSource', 'freshnessBasis'],
      ['channelId', 'senderKind', 'body', 'freshnessBasis']);
    assertId(value.channelId);
    if (value.threadId !== undefined && !nonEmpty(value.threadId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    if (!MESSAGE_SENDER_KINDS.includes(value.senderKind as typeof MESSAGE_SENDER_KINDS[number])) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    if (!nonEmpty(value.body)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    if (value.mentions !== undefined) {
      if (!Array.isArray(value.mentions)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
      value.mentions.forEach(assertMention);
    }
    if (value.attachmentIds !== undefined) assertStringArray(value.attachmentIds);
    if (value.clientMessageId !== undefined && !nonEmpty(value.clientMessageId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    if (value.taskContinuationSource !== undefined) assertTaskContinuationSourceMarker(value.taskContinuationSource);
    assertSendMessageFreshnessBasis(value.freshnessBasis);
    return;
  }
  if (commandName === 'check-inbox') {
    assertExactKeys(value, ['recipientId', 'target', 'afterSeq', 'limit'], ['recipientId', 'target', 'limit']);
    assertId(value.recipientId);
    assertMessageTargetRef(value.target);
    if (value.afterSeq !== undefined) assertInteger(value.afterSeq, 0);
    assertInteger(value.limit, 1);
    return;
  }
  // ack-read-candidate
  assertExactKeys(value, ['readCandidate'], ['readCandidate']);
  assertReadCandidateToken(value.readCandidate);
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertInteger(value.sequence, 0);
}

function assertCommandReceipt(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  assertId(value.receiptId);
  if (!MESSAGE_TRACER_COMMAND_NAMES.includes(value.commandName as typeof MESSAGE_TRACER_COMMAND_NAMES[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!MESSAGE_TRACER_RECEIPT_OUTCOMES.includes(value.outcome as typeof MESSAGE_TRACER_RECEIPT_OUTCOMES[number])) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (!Array.isArray(value.committedRevisions)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
}

function assertMessageTracerOutput(value: unknown): void {
  // 先以并集键收窄为 Record（各分支再做精确 exact-key 检查，拒绝该分支不允许的多余键）。
  assertExactKeys(value,
    ['commandName', 'messageId', 'targetSeq', 'inboxItemRecipientIds', 'recipientId', 'target', 'items', 'readCandidate', 'advancedToSeq', 'audienceScope', 'asOf'],
    ['commandName']);
  if (value.commandName === 'send-message') {
    assertExactKeys(value, ['commandName', 'messageId', 'targetSeq', 'inboxItemRecipientIds'],
      ['commandName', 'messageId', 'targetSeq', 'inboxItemRecipientIds']);
    assertId(value.messageId);
    assertInteger(value.targetSeq, 0);
    assertStringArray(value.inboxItemRecipientIds);
    return;
  }
  if (value.commandName === 'check-inbox') {
    assertExactKeys(value, ['commandName', 'recipientId', 'target', 'items', 'readCandidate', 'audienceScope', 'asOf'],
      ['commandName', 'recipientId', 'target', 'items', 'readCandidate', 'audienceScope', 'asOf']);
    assertId(value.recipientId);
    assertMessageTargetRef(value.target);
    if (!Array.isArray(value.items)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    value.items.forEach(assertInboxItemSummary);
    assertReadCandidateToken(value.readCandidate);
    assertId(value.audienceScope);
    assertInteger(value.asOf, 0);
    return;
  }
  // ack-read-candidate
  assertExactKeys(value, ['commandName', 'recipientId', 'target', 'advancedToSeq'],
    ['commandName', 'recipientId', 'target', 'advancedToSeq']);
  assertId(value.recipientId);
  assertMessageTargetRef(value.target);
  assertInteger(value.advancedToSeq, 0);
}

// ---------------------------------------------------------------------------
// Parsers（exact-key + structuredClone，防外部可变引用外泄）
// ---------------------------------------------------------------------------

export function parseMessageTargetRefV1(value: unknown): MessageTargetRefV1 {
  assertMessageTargetRef(value);
  return structuredClone(value) as unknown as MessageTargetRefV1;
}

export function parseReadCandidateTokenV1(value: unknown): ReadCandidateTokenV1 {
  assertReadCandidateToken(value);
  return structuredClone(value) as unknown as ReadCandidateTokenV1;
}

export function parseMessageTracerCommandEnvelopeV1(value: unknown): MessageTracerCommandEnvelopeV1 {
  // 拒绝任何 authority/scope 自报告字段（teamId、authoritySubject、actor 等）—— exact-key 白名单不含它们。
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey']);
  if (value.schemaVersion !== MESSAGE_TRACER_ENVELOPE_SCHEMA_VERSION) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (!MESSAGE_TRACER_COMMAND_NAMES.includes(value.commandName as typeof MESSAGE_TRACER_COMMAND_NAMES[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as MessageTracerCommandEnvelopeV1;
}

export function parseMessageTracerInputV1<K extends MessageTracerCommandName>(
  commandName: K,
  value: unknown,
): MessageTracerCommandInputMapV1[K] {
  assertMessageTracerInput(commandName, value);
  return structuredClone(value) as MessageTracerCommandInputMapV1[K];
}

export function parseCommandReceiptV1(value: unknown): CommandReceiptV1 {
  assertCommandReceipt(value);
  return structuredClone(value) as unknown as CommandReceiptV1;
}

export function parseMessageTracerCommandResponseV1(value: unknown): MessageTracerCommandResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'heldTarget', 'heldReason', 'newReadCandidate', 'conflictReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode']);
  if (value.schemaVersion !== 1) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (!MESSAGE_TRACER_COMMAND_NAMES.includes(value.commandName as typeof MESSAGE_TRACER_COMMAND_NAMES[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  if (!MESSAGE_TRACER_OUTCOMES.includes(value.outcome as typeof MESSAGE_TRACER_OUTCOMES[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  if (!MESSAGE_TRACER_RETRY_DIRECTIVES.includes(value.retryDirective as typeof MESSAGE_TRACER_RETRY_DIRECTIVES[number])) {
    throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertCommandReceipt(value.receipt);
  if (value.result !== undefined) {
    // result 必须与 response 描述同一 command（防跨 command 串型）；结构由 assertMessageTracerOutput 精确校验。
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
    }
    assertMessageTracerOutput(value.result);
  }
  if (value.heldTarget !== undefined) assertMessageTargetRef(value.heldTarget);
  if (value.heldReason !== undefined && !nonEmpty(value.heldReason)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  if (value.newReadCandidate !== undefined) assertReadCandidateToken(value.newReadCandidate);
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) throw new Error(MESSAGE_TRACER_PAYLOAD_INVALID);
  return structuredClone(value) as unknown as MessageTracerCommandResponseV1;
}

// ---------------------------------------------------------------------------
// Canonical serialization —— 幂等 conflict 判定的语义核心（#900 §3 / ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 确定性序列化任意值：对象键按字母序排序、递归、跳过 undefined（使可选字段的有无不影响 canonical）。
 * 数组保持原序（数组序是语义的一部分）。
 */
/** 不参与 canonical 内容哈希的字段（来源追踪/去重输入，非语义内容，#900 §21）。 */
const NON_CONTENT_FIELDS: ReadonlySet<string> = new Set(['clientMessageId']);

function canonicalizeValue(value: unknown, exclude: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry, exclude));
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (exclude.has(key)) continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry, exclude);
    }
    return sorted;
  }
  return value;
}

/**
 * 计算 command 的 canonical 串。hash 包含 command/schema、语义 payload 与 Freshness basis，
 * **排除** transport headers、trace ID、临时 credential、idempotency key（key 是查重键，不是内容指纹）、
 * provenance 引用（causationRef/sourceRefs 证明来源，不参与内容相等判定），以及来源追踪字段
 * `clientMessageId`（#900 §21：client ID 只作意图或来源去重输入，两个相同发送不应因不同追踪 ID 而冲突）。
 *
 * send-message 的「expected state」由 freshnessBasis（readCandidate.targetSeq）承担：相关 Inbox 变化触发
 * freshness_hold 而非 conflict（#893 §4）。故 send 不另设 expectedRevisions 字段。
 *
 * 同 idempotency key 下：canonical 相等 = replay（返回首次 receipt）；canonical 不等 = idempotency_conflict。
 * domain/server 用此串派生 sha256 指纹（commandHash），沿用 computeActiveMemoryContextHash 惯例。
 */
export function canonicalizeMessageTracerCommand(
  commandName: MessageTracerCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: MESSAGE_TRACER_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }, NON_CONTENT_FIELDS));
}
