import type {
  ID,
  UnixMs,
  PromotionGateCommandName,
  PromotionGateReceiptOutcome,
  PromotionRiskLevel,
  PromotionRevisionRefV1,
  PromotionEventRefV1,
} from '../../../../packages/contracts/src/index.js';

/**
 * #922 Promotion gate 持久化记录与仓储接口。
 *
 * 这些记录是 server-next 专用的存储形状（合同 promotion-gate.ts 的 runtime schemas 只提供跨端语义；
 * 存储列、JSON 序列化与 row 映射属于 server-next 切片）。它们挂在 {@link TaskCoordinationTransactionRepositories}
 * 上（#922 扩展该超集），使 `promote-to-task` 能在 task coordination UoW 的单 teamDb 事务里原子提交
 * `root Task + source relation + run + event + audit + scheduling + outbox + receipt/tombstone`
 * （#894 §10 / #900 §6/§7 / ADR-0062 / ADR-0067 / ADR-0069）。
 */

// ---------------------------------------------------------------------------
// Promotion source relation（promotion_source_relations）
// ---------------------------------------------------------------------------

/**
 * 来源 → root Task 的不可变编排权归属 + provenance（#894 §8/§10）。同一 source lineage 最多一行；
 * 来源编辑/删除只产生 attention，不静默改写本行。requesterId 由 Server 推导（authority 不来自 envelope）。
 */
export interface PromotionSourceRelationRecord {
  readonly id: ID;
  readonly teamId: ID;
  /** 收敛键：同 lineage 一致请求返回同一 Task（#894 §6）。UNIQUE。 */
  readonly lineageKey: string;
  readonly taskId: ID;
  readonly managementRunId: ID;
  readonly requesterId: ID;
  readonly triggerCommandRevision: number;
  /** 创建时 objective snapshot 的 canonical JSON（收敛比对依据）。 */
  readonly objectiveSnapshotJson: string;
  readonly scopeSnapshotJson: string;
  readonly riskLevel: PromotionRiskLevel;
  readonly dataSnapshotJson: string | null;
  /** causationRef / sourceRefs 的 JSON。 */
  readonly provenanceJson: string;
  /** 编排权归属声明；PI driver（ManagerLease）由后续 worker acquire 填充。 */
  readonly claimState: 'awaiting-driver';
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Promotion scheduling intent（promotion_scheduling_intents，最小占位）
// ---------------------------------------------------------------------------

/**
 * 持久调度事实（#894 §10 / ADR-0062）。完整 scheduler 持久重放属后续切片；本记录保证 promotion 成功时
 * 调度意图原子落库、进程重启不丢。
 */
export interface PromotionSchedulingIntentRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly intent: 'queue';
  readonly profileHint: string | null;
  readonly deadline: UnixMs | null;
  readonly attempt: number;
  readonly state: 'pending';
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Promotion outbox record（promotion_outbox_records，最小占位）
// ---------------------------------------------------------------------------

/**
 * 原子落库的待投递事实（#894 §10 / #900 §15）。完整 outbox delivery 投递属后续切片；本记录保证
 * promotion-applied event 原子提交、notice 只负责可恢复唤醒。
 */
export interface PromotionOutboxRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly receiptId: ID;
  readonly eventRefJson: string;
  readonly audience: string;
  readonly deliveryState: 'pending';
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Promotion command receipt / idempotency tombstone（独立表，不触碰 #921 command_receipts）
// ---------------------------------------------------------------------------

/**
 * 一个 promote-to-task command 恰好一个持久 receipt（#900 §6）。结构同 #921 CommandReceiptRecord，
 * 但落在独立 promotion_command_receipts 表，避免重建 #921 历史表（migration-table-guard 纪律）。
 */
export interface PromotionCommandReceiptRecord {
  readonly receiptId: ID;
  readonly teamId: ID;
  readonly commandName: PromotionGateCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: PromotionGateReceiptOutcome;
  readonly committedRevisions: readonly PromotionRevisionRefV1[];
  readonly eventRefs: readonly PromotionEventRefV1[];
  readonly resultAvailable: boolean;
  readonly resultJson: string | null;
  readonly commitTime: UnixMs;
  readonly createdAt: UnixMs;
}

/**
 * 幂等去重锚（#900 §1.5）：即使 receipt 结果被治理压缩，tombstone 仍保留足以判定 replay/conflict 的
 * 最小投影。与 receipt 同事务写入。
 */
export interface PromotionIdempotencyTombstoneRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly commandName: PromotionGateCommandName;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly outcome: PromotionGateReceiptOutcome;
  readonly resultAvailable: boolean;
  readonly createdAt: UnixMs;
}

// ---------------------------------------------------------------------------
// 仓储接口
// ---------------------------------------------------------------------------

export interface PromotionSourceRelationRepository {
  /** 持久化 source relation。重复 lineage_key 抛约束错（handler 据此识别收敛）。 */
  create(input: PromotionSourceRelationRecord): Promise<PromotionSourceRelationRecord>;
  /** 按 lineage key 取既有 source relation（收敛查重入口）。 */
  getByLineageKey(lineageKey: string): Promise<PromotionSourceRelationRecord | null>;
}

export interface PromotionSchedulingIntentRepository {
  create(input: PromotionSchedulingIntentRecord): Promise<PromotionSchedulingIntentRecord>;
}

export interface PromotionOutboxRepository {
  create(input: PromotionOutboxRecord): Promise<PromotionOutboxRecord>;
}

export interface PromotionCommandReceiptRepository {
  /** 持久化 receipt。重复 idempotency_key 抛约束错（handler 据此识别 replay/conflict）。 */
  createReceipt(input: PromotionCommandReceiptRecord): Promise<PromotionCommandReceiptRecord>;
  getReceiptByIdempotencyKey(idempotencyKey: string): Promise<PromotionCommandReceiptRecord | null>;
  getReceiptById(receiptId: ID): Promise<PromotionCommandReceiptRecord | null>;
  /** 写入幂等 tombstone（与 receipt 同事务）。重复 idempotency_key 抛约束错。 */
  createTombstone(input: PromotionIdempotencyTombstoneRecord): Promise<PromotionIdempotencyTombstoneRecord>;
  getTombstoneByIdempotencyKey(idempotencyKey: string): Promise<PromotionIdempotencyTombstoneRecord | null>;
}

export interface PromotionGateRepositories {
  readonly sourceRelations: PromotionSourceRelationRepository;
  readonly schedulingIntents: PromotionSchedulingIntentRepository;
  readonly outbox: PromotionOutboxRepository;
  readonly receipts: PromotionCommandReceiptRepository;
}
