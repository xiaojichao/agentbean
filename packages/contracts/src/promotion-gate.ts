import type { ID, UnixMs } from './common.js';
import { COMMAND_PROVENANCE_KINDS, type CommandProvenanceKind, type CommandProvenanceRefV1 } from './message-tracer.js';

/**
 * Promotion gate 命令合同（issue #922 / ADR-0067 Command registry 的 Promotion family）。
 *
 * 结构化 human trigger（“协调团队/作为任务”、明确 command、确认 Server 签发的 proposal）经本 gate
 * 创建唯一 root Task。本 gate 是唯一 Promotion 入口：按 source lineage、Freshness basis、
 * objective/scope/risk/data snapshot 做幂等收敛与去重，不一致时返回无副作用 Promotion conflict。
 *
 * 与 Message tracer 共享 transport-independent envelope、exact-key runtime schema、版本化
 * outcome/receipt 与业务幂等身份（#894 / #896 / #900 / ADR-0062 / ADR-0063 / ADR-0067 / ADR-0069）。
 * promotion authorization 只授权创建 root Task 与启动 PI orchestration，不授予删除、发布、付款、
 * 外发数据或生产变更等高风险 action（#894 §8）。
 *
 * #922 先实现结构化 human trigger；#923 扩展 proposal accept、Agent escalation 与确定性
 * Team policy。非 human trigger 只能由 Server 内部经过各自授权策略后调用，transport 不能自报 authority。
 *
 * 本文件只提供 runtime schemas、discriminated unions、contract capabilities、canonical serialization
 * 与跨端 conformance 基础；具体 handler、存储与接线属于 server-next 切片。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— Command registry 的 Promotion family
// ---------------------------------------------------------------------------

/**
 * 冻结的具名 command 集合。未登记 command 必须被 Server 拒绝（ADR-0067）。
 * 顺序即 registry 公开顺序，测试钉死长度防止误增删。
 */
export const PROMOTION_GATE_COMMAND_NAMES = ['promote-to-task'] as const;

export type PromotionGateCommandName = (typeof PROMOTION_GATE_COMMAND_NAMES)[number];

/** envelope 的当前 schema 版本（ADR-0067：envelope 分别版本化）。 */
export const PROMOTION_GATE_ENVELOPE_SCHEMA_VERSION = 1;
/** 各 command payload 的当前 schema 版本。 */
export const PROMOTION_GATE_COMMAND_SCHEMA_VERSION = 1;
/** canonical command hash 规范版本；hash 算法升级时递增，使旧 hash 不被误判相等。 */
export const PROMOTION_GATE_COMMAND_HASH_VERSION = 1;

/**
 * human 结构化 trigger 的来源类型（#894 §1）。
 * 普通自然语言、@Agent、DM、Thread owner 都不是 trigger，永远不能调用本 gate。
 * #922 只实现 human-structured；proposal accept / Agent escalation / policy 留后续切片。
 */
export const PROMOTION_TRIGGER_KINDS = [
  'human-structured', 'proposal-accept', 'team-policy', 'agent-escalation',
] as const;

export type PromotionTriggerKind = (typeof PROMOTION_TRIGGER_KINDS)[number];

/**
 * objective/scope/risk snapshot 的风险等级（#894 §8）。
 * 高风险边界扩大需先经 proposal 授权，promotion authorization 不授予高风险 action。
 */
export const PROMOTION_RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type PromotionRiskLevel = (typeof PROMOTION_RISK_LEVELS)[number];

/** Command receipt 的终态 outcome（ADR-0067：嵌套 receipt 终态始终 applied 或 no_op）。 */
export const PROMOTION_GATE_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type PromotionGateReceiptOutcome = (typeof PROMOTION_GATE_RECEIPT_OUTCOMES)[number];

/**
 * Promotion 成功后 root Task 的处置（#894 §6 幂等收敛）。
 * `created` = 本次新建唯一 root Task；`existing` = 同 lineage 一致请求命中既有 Task，返回同一结果。
 */
export const PROMOTION_DISPOSITIONS = ['created', 'existing'] as const;
export type PromotionDisposition = (typeof PROMOTION_DISPOSITIONS)[number];

// ---------------------------------------------------------------------------
// Objective / scope / risk / data snapshot（#894 §8 创建时不可变 snapshot）
// ---------------------------------------------------------------------------

/**
 * promotion 创建时冻结的 objective/scope/risk/data snapshot。同 source lineage 下 snapshot 一致即收敛到
 * 同一 root Task；snapshot 不一致返回无副作用 Promotion conflict（#894 §6/§8）。
 */
export interface PromotionObjectiveSnapshotV1 {
  readonly schemaVersion: 1;
  /** 规范化目标（#894 §1：唯一确定的 objective）。 */
  readonly objective: string;
  /** 作用域边界描述（频道 / 数据 / 权限 / 成本边界，#894 §4）。 */
  readonly scope: string;
  readonly riskLevel: PromotionRiskLevel;
  /** 创建时数据快照引用（hash 或指针，编辑/删除只产生 attention，不静默改写 Task，#894 §8）。 */
  readonly dataSnapshot?: string;
}

// ---------------------------------------------------------------------------
// Freshness basis（#894 §5：来源 revision 锚定幂等与失效）
// ---------------------------------------------------------------------------

/**
 * promotion 声明并由 Server 校验的 Freshness basis：source lineage 与可选来源 revision。
 * 来源编辑/删除、相关上下文、权限或风险边界变化时，旧请求进入 Freshness hold 或失效，不能跨 revision 复用（#894 §5）。
 */
export interface PromotionFreshnessBasisV1 {
  readonly schemaVersion: 1;
  readonly sourceLineage: CommandProvenanceRefV1;
  readonly sourceRevision?: number;
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps（ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 客户端提交的共享、transport-independent envelope（ADR-0067）。**固定只含** command/schema identity、
 * idempotency key 与来源引用；**严禁** authority、team/tenant 或 requester/scope 字段——requester 等
 * authority 一律由 Server 按认证/协议推导（#900 §1 禁止客户端自报 actor/authority；#900 §18 Server 推导
 * authority；tenant/scope 由 Server 形成幂等范围）。idempotencyKey 绑定逻辑业务命令，不绑定网络请求。
 */
export interface PromotionGateCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: 'promote-to-task';
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface PromotionGateCommandInputMapV1 {
  /**
   * 结构化 human trigger 创建唯一 root Task（status `todo`，#896 §3/§4）。
   * promotion 成功原子创建 root Task + source relation + run + orchestration claim + 调度事实 +
   * receipt/event/audit/outbox（#894 §10）；排队/lease/模型调用不把 root Task 推进为 in_progress。
   */
  readonly 'promote-to-task': {
    readonly triggerKind: PromotionTriggerKind;
    readonly channelId: ID;
    readonly rootMessageId?: ID;
    readonly objectiveSnapshot: PromotionObjectiveSnapshotV1;
    readonly freshnessBasis: PromotionFreshnessBasisV1;
    /** 来源去重输入（ADR-0067 §21）：client ID 只能作为意图或来源去重输入，不作为权威身份。 */
    readonly clientMessageId?: string;
  };
}

/** 已成立的过去式领域事实引用（#900 §9）。 */
export interface PromotionEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

/**
 * 已提交的专项 revision 引用（#900 §24：Message freshness、Task、run、claim 等分别维护专项 revision，
 * 禁止粗粒度 last-write-wins）。
 */
export interface PromotionRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface PromotionGateCommandOutputMapV1 {
  readonly 'promote-to-task': {
    readonly rootTaskId: ID;
    readonly managementRunId: ID;
    readonly sourceRelationId: ID;
    /** 幂等收敛结果（#894 §6）。 */
    readonly disposition: PromotionDisposition;
  };
}

export type PromotionGateCommandOutputUnionV1 =
  | ({ readonly commandName: 'promote-to-task' } & PromotionGateCommandOutputMapV1['promote-to-task']);

// ---------------------------------------------------------------------------
// Receipt + response outcome（#900 §6/§16 / ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 一个 command 只有一个持久 Command receipt。`outcome` 是嵌套 receipt 的终态（始终 applied 或 no_op），
 * response 层的 `replayed` disposition 不改写它。`resultAvailable=false` 表示结果 payload 已按治理压缩，
 * 仅保留足以识别 replay/conflict 的 tombstone-backed projection，不能恢复内容或重新执行。
 */
export interface PromotionCommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: 'promote-to-task';
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash（由 canonicalizePromotionGateCommand 派生，domain/server 计算 sha256）。 */
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly PromotionRevisionRefV1[];
  readonly eventRefs: readonly PromotionEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

/**
 * Command response outcome 固定八态（#900 §16 / ADR-0067）。
 * `replayed` 表示本次请求命中既有 receipt；嵌套 receipt 终态保留首次 applied/no_op。
 */
export const PROMOTION_GATE_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;

export type PromotionGateOutcome = (typeof PROMOTION_GATE_OUTCOMES)[number];

/** 重试指令四态（ADR-0067）。outcome_unknown 必须用原 key 查 receipt 或 replay，严禁换 key。 */
export const PROMOTION_GATE_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;

export type PromotionGateRetryDirective = (typeof PROMOTION_GATE_RETRY_DIRECTIVES)[number];

/**
 * Command 响应。携带稳定 code、retry directive 与安全裁剪的当前引用。
 * 成功结果 `result` 按 command 类型区分；conflict/freshness_hold 携带各自的最小上下文。
 */
export interface PromotionGateCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: 'promote-to-task';
  readonly outcome: PromotionGateOutcome;
  readonly retryDirective: PromotionGateRetryDirective;
  readonly stableCode: string;
  /** applied / no_op / replayed 时携带首次 receipt。 */
  readonly receipt?: PromotionCommandReceiptV1;
  /** 成功（applied）时的 command 结果。 */
  readonly result?: PromotionGateCommandOutputUnionV1;
  /** conflict：同 idempotency key 但 canonical command hash 不同，无副作用。 */
  readonly conflictReason?: string;
  /** freshness_hold：来源/上下文/权限/风险变化阻塞，不创建 Task。 */
  readonly freshnessReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const PROMOTION_GATE_PAYLOAD_INVALID = 'PROMOTION_GATE_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertTriggerKind(value: unknown): asserts value is PromotionTriggerKind {
  if (!PROMOTION_TRIGGER_KINDS.includes(value as typeof PROMOTION_TRIGGER_KINDS[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
}

function assertRiskLevel(value: unknown): asserts value is PromotionRiskLevel {
  if (!PROMOTION_RISK_LEVELS.includes(value as typeof PROMOTION_RISK_LEVELS[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  // 复用 #921 冻结的 COMMAND_PROVENANCE_KINDS，避免内联副本随源漂移。
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (value.hash !== undefined && !nonEmpty(value.hash)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertObjectiveSnapshot(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'objective', 'scope', 'riskLevel', 'dataSnapshot'],
    ['schemaVersion', 'objective', 'scope', 'riskLevel']);
  if (value.schemaVersion !== 1) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (!nonEmpty(value.objective)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (!nonEmpty(value.scope)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertRiskLevel(value.riskLevel);
  if (value.dataSnapshot !== undefined && !nonEmpty(value.dataSnapshot)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertFreshnessBasis(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'sourceLineage', 'sourceRevision'],
    ['schemaVersion', 'sourceLineage']);
  if (value.schemaVersion !== 1) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertCommandProvenanceRef(value.sourceLineage);
  if (value.sourceRevision !== undefined) assertInteger(value.sourceRevision, 0);
}

function assertPromotionGateInput(value: unknown): void {
  assertExactKeys(value,
    ['triggerKind', 'channelId', 'rootMessageId', 'objectiveSnapshot', 'freshnessBasis', 'clientMessageId'],
    ['triggerKind', 'channelId', 'objectiveSnapshot', 'freshnessBasis']);
  assertTriggerKind(value.triggerKind);
  assertId(value.channelId);
  if (value.rootMessageId !== undefined && !nonEmpty(value.rootMessageId)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertObjectiveSnapshot(value.objectiveSnapshot);
  assertFreshnessBasis(value.freshnessBasis);
  if (value.clientMessageId !== undefined && !nonEmpty(value.clientMessageId)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertInteger(value.sequence, 0);
}

function assertCommandReceipt(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable']);
  if (value.schemaVersion !== 1) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertId(value.receiptId);
  if (!PROMOTION_GATE_COMMAND_NAMES.includes(value.commandName as typeof PROMOTION_GATE_COMMAND_NAMES[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!PROMOTION_GATE_RECEIPT_OUTCOMES.includes(value.outcome as typeof PROMOTION_GATE_RECEIPT_OUTCOMES[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
}

function assertPromotionGateOutput(value: unknown): void {
  assertExactKeys(value, ['commandName', 'rootTaskId', 'managementRunId', 'sourceRelationId', 'disposition'],
    ['commandName', 'rootTaskId', 'managementRunId', 'sourceRelationId', 'disposition']);
  if (value.commandName !== 'promote-to-task') throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  assertId(value.rootTaskId);
  assertId(value.managementRunId);
  assertId(value.sourceRelationId);
  if (!PROMOTION_DISPOSITIONS.includes(value.disposition as typeof PROMOTION_DISPOSITIONS[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
}

// ---------------------------------------------------------------------------
// Parsers（exact-key + structuredClone，防外部可变引用外泄）
// ---------------------------------------------------------------------------

export function parsePromotionObjectiveSnapshotV1(value: unknown): PromotionObjectiveSnapshotV1 {
  assertObjectiveSnapshot(value);
  return structuredClone(value) as unknown as PromotionObjectiveSnapshotV1;
}

export function parsePromotionFreshnessBasisV1(value: unknown): PromotionFreshnessBasisV1 {
  assertFreshnessBasis(value);
  return structuredClone(value) as unknown as PromotionFreshnessBasisV1;
}

export function parsePromotionGateCommandEnvelopeV1(value: unknown): PromotionGateCommandEnvelopeV1 {
  // 拒绝任何 authority/scope 自报告字段（teamId、authoritySubject、requesterId、actor 等）。
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey']);
  if (value.schemaVersion !== PROMOTION_GATE_ENVELOPE_SCHEMA_VERSION) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (value.commandName !== 'promote-to-task') throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  // 本切片只实现 V1：未知/未来 commandSchemaVersion 必须拒绝，禁止按 V1 静默执行。
  if (value.commandSchemaVersion !== PROMOTION_GATE_COMMAND_SCHEMA_VERSION) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as PromotionGateCommandEnvelopeV1;
}

export function parsePromotionGateInputV1(value: unknown): PromotionGateCommandInputMapV1['promote-to-task'] {
  assertPromotionGateInput(value);
  return structuredClone(value) as unknown as PromotionGateCommandInputMapV1['promote-to-task'];
}

export function parsePromotionCommandReceiptV1(value: unknown): PromotionCommandReceiptV1 {
  assertCommandReceipt(value);
  return structuredClone(value) as unknown as PromotionCommandReceiptV1;
}

export function parsePromotionGateCommandResponseV1(value: unknown): PromotionGateCommandResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'freshnessReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode']);
  if (value.schemaVersion !== 1) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (value.commandName !== 'promote-to-task') throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (!PROMOTION_GATE_OUTCOMES.includes(value.outcome as typeof PROMOTION_GATE_OUTCOMES[number])) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  if (!PROMOTION_GATE_RETRY_DIRECTIVES.includes(
    value.retryDirective as typeof PROMOTION_GATE_RETRY_DIRECTIVES[number],
  )) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertCommandReceipt(value.receipt);
  if (value.result !== undefined) {
    // result 必须与 response 描述同一 command（防跨 command 串型）。
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
    }
    assertPromotionGateOutput(value.result);
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  if (value.freshnessReason !== undefined && !nonEmpty(value.freshnessReason)) {
    throw new Error(PROMOTION_GATE_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as PromotionGateCommandResponseV1;
}

// ---------------------------------------------------------------------------
// Canonical serialization —— 幂等 conflict 判定的语义核心（#900 §3 / ADR-0067）
// ---------------------------------------------------------------------------

/**
 * 不参与 canonical 内容哈希的字段（来源追踪/去重输入，非语义内容，#900 §21）。
 */
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
 * 计算 command 的 canonical 串。hash 包含 command/schema、语义 payload（triggerKind、objective/scope/risk
 * snapshot、freshness basis 的 source lineage）与 provenance 内容，**排除** transport headers、trace ID、
 * 临时 credential、idempotency key（key 是查重键，不是内容指纹）与来源追踪字段 `clientMessageId`
 * （#900 §21）。
 *
 * 同 idempotency key 下：canonical 相等 = replay（返回首次 receipt）；canonical 不等 = idempotency_conflict。
 * domain/server 用此串派生 sha256 指纹（commandHash），沿用 computeActiveMemoryContextHash 惯例。
 */
export function canonicalizePromotionGateCommand(
  commandName: PromotionGateCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: PROMOTION_GATE_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }, NON_CONTENT_FIELDS));
}
