import type {
  ID,
  UnixMs,
  MessageTargetKind,
  MessageSenderKind,
  MessageTracerCommandName,
  MessageTracerReceiptOutcome,
  MessageTracerRevisionRefV1,
  MessageTracerEventRefV1,
} from '../../../../packages/contracts/src/index.js';

/**
 * #921 切片 B：Message tracer 持久化记录与仓储接口。
 *
 * 这些记录是 server-next 专用的存储形状（合同 message-tracer.ts 的 runtime schemas 只提供跨端语义；
 * 存储列、JSON 序列化与 row 映射属于 server-next 切片）。它们挂在 {@link ChannelCoordinationTransactionRepositories}
 * 上，使 `send-message` 能在 channel coordination UoW 的单 teamDb 事务里原子提交
 * `Message + InboxItem + receipt + tombstone`（#893 / #900 / ADR-0062 / ADR-0067）。
 */

// ---------------------------------------------------------------------------
// Inbox 投影记录（inbox_items）
// ---------------------------------------------------------------------------

/**
 * 一条消息投递给某 recipient 的连续 Inbox 前缀项。target 由 channelId + threadId(可空) + targetKind 定位，
 * targetSeq 是该 recipient × target 内的连续位置（仅定位/排序，非全量消息序列）。
 * 自身消息不入自身 inbox（由 handler 保证）。
 */
export interface InboxItemRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly messageId: ID;
  readonly recipientId: ID;
  readonly channelId: ID;
  /** mainline/dm 为 null；thread/dm-thread 为 root 消息 id。 */
  readonly threadId: ID | null;
  readonly targetKind: MessageTargetKind;
  readonly targetSeq: number;
  readonly senderKind: MessageSenderKind;
  readonly senderId: ID;
  /** 该消息在事务里提交的时间。 */
  readonly committedAt: UnixMs;
  readonly createdAt: UnixMs;
}

/**
 * 权威 Read boundary：ack-read-candidate 单调推进的位置。每 recipient × target 至多一行；
 * 无记录语义为 readSeq = 0（#893 §3 / #900 §13：check-inbox 不推进，ack 才推进）。
 */
export interface InboxReadBoundaryRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly recipientId: ID;
  readonly channelId: ID;
  readonly threadId: ID | null;
  readonly targetKind: MessageTargetKind;
  readonly readSeq: number;
  readonly advancedAt: UnixMs;
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Command receipt / 幂等 tombstone 记录
// ---------------------------------------------------------------------------

/**
 * 一个 command 恰好一个持久 receipt（#900 §6）。记录 command identity、applied/no_op 终态、
 * 提交 revisions、event references 与 commit time。resultJson 为成功结果的序列化形式，
 * 可被治理压缩为 null（此时 resultAvailable=false，仅留 tombstone 判定 replay/conflict，#900 §1.5）。
 */
export interface CommandReceiptRecord {
  readonly receiptId: ID;
  readonly teamId: ID;
  readonly commandName: MessageTracerCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash（canonicalizeMessageTracerCommand 派生）。 */
  readonly commandHash: string;
  readonly outcome: MessageTracerReceiptOutcome;
  readonly committedRevisions: readonly MessageTracerRevisionRefV1[];
  readonly eventRefs: readonly MessageTracerEventRefV1[];
  readonly resultAvailable: boolean;
  /** MessageTracerCommandOutputUnionV1 的 JSON 串；压缩后为 null。 */
  readonly resultJson: string | null;
  readonly commitTime: UnixMs;
  readonly createdAt: UnixMs;
}

/**
 * 幂等去重锚（#900 §1.5）：即使 receipt 结果被治理压缩，tombstone 仍保留足以判定 replay/conflict 的
 * 最小投影（idempotency key + command hash + receipt 引用 + 终态）。与 receipt 同事务写入。
 */
export interface IdempotencyTombstoneRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly commandName: MessageTracerCommandName;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly outcome: MessageTracerReceiptOutcome;
  readonly resultAvailable: boolean;
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// 仓储接口
// ---------------------------------------------------------------------------

/** recipient × target 的定位键（threadId=null 表示 mainline/dm）。 */
export interface InboxTargetKey {
  readonly recipientId: ID;
  readonly channelId: ID;
  readonly threadId: ID | null;
}

/**
 * Message Inbox 仓储：管理 inbox 投影（inbox_items）与权威 Read boundary（inbox_read_boundaries）。
 * 两者都按 recipient × target 维护，共享同一持久化域。
 */
export interface MessageInboxRepository {
  /** 投递一条消息到某 recipient 的 target 投影（caller 已分配 targetSeq）。重复 message+recipient 抛约束错。 */
  insertItem(input: InboxItemRecord): Promise<InboxItemRecord>;
  /** 取 recipient × target 的连续前缀：target_seq > afterSeq，按 seq 升序，至多 limit 条（audience redaction 由 handler 负责）。 */
  listItems(input: InboxTargetKey & { afterSeq: number; limit: number }): Promise<InboxItemRecord[]>;
  /** 当前 recipient × target 的最大 target_seq（无项则 -1）。handler 用其分配下一条 seq（事务内序列化，安全）。 */
  getMaxTargetSeq(input: InboxTargetKey): Promise<number>;
  /** 读取当前权威 Read boundary；无记录返回 null。 */
  getReadBoundary(input: InboxTargetKey): Promise<InboxReadBoundaryRecord | null>;
  /**
   * 单调推进 Read boundary 到 newSeq：仅当 newSeq > 当前 readSeq 时更新（否则幂等 no-op）。
   * 无记录时插入。返回推进后的记录（#900 §13：ack 才推进，单调不可回退）。
   */
  advanceReadBoundary(input: {
    readonly id: ID;
    readonly teamId: ID;
    readonly recipientId: ID;
    readonly channelId: ID;
    readonly threadId: ID | null;
    readonly targetKind: MessageTargetKind;
    readonly newSeq: number;
    readonly now: UnixMs;
  }): Promise<InboxReadBoundaryRecord>;
}

/**
 * Command receipt 仓储：管理 receipt（command_receipts）与幂等 tombstone（idempotency_tombstones）。
 * 同 idempotency key 下：相同 commandHash = replay（返回首次 receipt）；不同 commandHash = conflict（无副作用）。
 */
export interface CommandReceiptRepository {
  /** 持久化一个 receipt。重复 idempotency_key 抛约束错（handler 据此识别 replay/conflict）。 */
  createReceipt(input: CommandReceiptRecord): Promise<CommandReceiptRecord>;
  getReceiptByIdempotencyKey(idempotencyKey: string): Promise<CommandReceiptRecord | null>;
  getReceiptById(receiptId: ID): Promise<CommandReceiptRecord | null>;
  /** 写入幂等 tombstone（与 receipt 同事务）。重复 idempotency_key 抛约束错。 */
  createTombstone(input: IdempotencyTombstoneRecord): Promise<IdempotencyTombstoneRecord>;
  getTombstoneByIdempotencyKey(idempotencyKey: string): Promise<IdempotencyTombstoneRecord | null>;
}

/**
 * 持久 outbox 记录（message_tracer_outbox）：send-message 单事务原子入队的投递事件。
 * 与 receipt 同事务写；投递（socket emit / daemon wake）是 post-commit 关注，由 worker 拉 pending 行处理。
 */
export interface MessageTracerOutboxRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly receiptId: ID;
  readonly commandName: MessageTracerCommandName;
  readonly eventKind: 'message-delivered';
  readonly targetKind: MessageTargetKind;
  readonly channelId: ID;
  readonly threadId: ID | null;
  /** 受众 recipient id 快照（脱敏无 body）。 */
  readonly audienceRecipientIds: readonly ID[];
  /** 投递载荷 JSON（messageId/targetSeq/senderKind/senderId 等定位与摘要，不含全文）。 */
  readonly payloadJson: string;
  readonly deliveredAt: UnixMs | null;
  readonly attempts: number;
  readonly createdAt: UnixMs;
}

/**
 * Message tracer outbox 仓储：持久投递队列。幂等入队（同 receipt+eventKind 不重复）；
 * worker 拉 pending、标记已投递、自增尝试计数（完整投递 worker 属 C-wire，C-send 先入队）。
 */
export interface MessageTracerOutboxRepository {
  /** 入队一条投递事件。重复 (receiptId, eventKind) 抛约束错（command replay 不重复入队）。 */
  enqueue(input: MessageTracerOutboxRecord): Promise<MessageTracerOutboxRecord>;
  /** 拉取未投递行（deliveredAt 为 null），按 createdAt 升序，至多 limit 条。 */
  listPending(input: { limit: number }): Promise<MessageTracerOutboxRecord[]>;
  /** 标记已投递（置 deliveredAt）。 */
  markDelivered(input: { id: ID; now: UnixMs }): Promise<void>;
  /** 自增尝试计数（worker 重试跟踪）。 */
  incrementAttempts(input: { id: ID }): Promise<void>;
}

export interface MessageTracerRepositories {
  readonly inbox: MessageInboxRepository;
  readonly commandReceipts: CommandReceiptRepository;
  readonly outbox: MessageTracerOutboxRepository;
}
