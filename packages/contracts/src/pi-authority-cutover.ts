import type { ID, UnixMs } from './common.js';

/**
 * Team PI authority cutover 与 legacy 兼容退役
 * （issue #930 / ADR-0068 / ADR-0069 legacy cutover 场景）。
 *
 * Server 为每个 Team 持久维护单调 PI authority epoch 与迁移状态。
 * Message/source lineage 在提交时绑定 epoch；cutover 与消息在同一 migration revision 上线性化。
 * 无 dual-write、无失败 fallback、无旧 API 静默转译。
 *
 * 本文件提供 runtime schemas、Command registry、capabilities 与精确校验；
 * handler / 存储 / 接线属于 server-next。
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * 单调迁移状态（ADR-0068）：只能前向推进，不能语义回滚到启用 legacy writer。
 * - legacy: 旧 Channel Coordinator writer 仍是协调权威
 * - shadow: 新路径可观察/审计，legacy 仍写（本切片不启用 dual-write；shadow 仅表示迁移准备）
 * - cutover_pending: readiness 已通过，等待合法 cutover 提交
 * - new_authority: 新 Promotion/PI 路径为权威；legacy writer fenced
 * - legacy_read_only: 旧查询只读 projection；写接口退役
 * - retired: 兼容层运行时入口可删除（存储删除另版本）
 */
export const PI_AUTHORITY_MIGRATION_STATES = [
  'legacy',
  'shadow',
  'cutover_pending',
  'new_authority',
  'legacy_read_only',
  'retired',
] as const;
export type PiAuthorityMigrationState = (typeof PI_AUTHORITY_MIGRATION_STATES)[number];

/** 旧协调写接口退役后的稳定错误码（ADR-0068：不得静默转译）。 */
export const LEGACY_COORDINATION_RETIRED_CODE = 'LEGACY_COORDINATION_RETIRED' as const;

export const PI_AUTHORITY_CUTOVER_SCHEMA_VERSION = 1;
export const PI_AUTHORITY_CUTOVER_COMMAND_SCHEMA_VERSION = 1;
export const PI_AUTHORITY_CUTOVER_COMMAND_HASH_VERSION = 1;
export const PI_AUTHORITY_CUTOVER_QUERY_SCHEMA_VERSION = 1;

export const PI_AUTHORITY_CUTOVER_COMMAND_NAMES = [
  'evaluate-cutover-readiness',
  'execute-pi-authority-cutover',
  'submit-legacy-drain-result',
  'emergency-stop-pi',
  'clear-emergency-stop',
  'advance-migration-state',
  'bind-message-authority-epoch',
  'record-legacy-write-attempt',
] as const;
export type PiAuthorityCutoverCommandName = (typeof PI_AUTHORITY_CUTOVER_COMMAND_NAMES)[number];

export const PI_AUTHORITY_CUTOVER_QUERY_NAMES = [
  'query-migration-state',
  'query-retirement-metrics',
  'query-legacy-compatibility-projection',
] as const;
export type PiAuthorityCutoverQueryName = (typeof PI_AUTHORITY_CUTOVER_QUERY_NAMES)[number];

export const PI_AUTHORITY_CUTOVER_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type PiAuthorityCutoverReceiptOutcome = (typeof PI_AUTHORITY_CUTOVER_RECEIPT_OUTCOMES)[number];

export const PI_AUTHORITY_CUTOVER_OUTCOMES = [
  'applied',
  'no_op',
  'replayed',
  'freshness_hold',
  'conflict',
  'rejected',
  'temporarily_unavailable',
  'outcome_unknown',
] as const;
export type PiAuthorityCutoverOutcome = (typeof PI_AUTHORITY_CUTOVER_OUTCOMES)[number];

export const PI_AUTHORITY_CUTOVER_RETRY_DIRECTIVES = [
  'none',
  'same_key',
  'reread_then_new_command',
  'user_action',
] as const;
export type PiAuthorityCutoverRetryDirective = (typeof PI_AUTHORITY_CUTOVER_RETRY_DIRECTIVES)[number];

/** drain lineage 生命周期。 */
export const LEGACY_DRAIN_LINEAGE_STATES = [
  'draining',
  'completed',
  'expired',
  'recovery_pending',
] as const;
export type LegacyDrainLineageState = (typeof LEGACY_DRAIN_LINEAGE_STATES)[number];

/** 旧 daemon 协商后的执行权限（不能取得 PI orchestration authority）。 */
export const DAEMON_PI_CAPABILITY_TIERS = [
  'legacy_full_coordination',
  'message_and_drain_only',
  'message_only',
  'pi_execution_eligible',
] as const;
export type DaemonPiCapabilityTier = (typeof DAEMON_PI_CAPABILITY_TIERS)[number];

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------

/**
 * Team 级 PI authority 迁移权威快照。
 * migrationRevision 在消息提交与 cutover 上线性化递增。
 */
export interface TeamPiAuthorityMigrationV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  /** 单调 authority epoch；cutover 时 +1。 */
  readonly authorityEpoch: number;
  /** 消息/cutover 线性化 revision。 */
  readonly migrationRevision: number;
  readonly state: PiAuthorityMigrationState;
  /** legacy writer 是否已被 fencing。 */
  readonly legacyWriterFenced: boolean;
  /** emergency-stop：只暂停新 promotion/PI command，不重开 legacy writer。 */
  readonly emergencyStop: boolean;
  readonly cutoverVersion: number | null;
  readonly cutoverAt: UnixMs | null;
  readonly cutoverBy: ID | null;
  readonly drainDeadlineAt: UnixMs | null;
  readonly updatedAt: UnixMs;
  readonly createdAt: UnixMs;
}

/** Server readiness snapshot：绑定 Team、目标 epoch、revision 与检查项。 */
export interface CutoverReadinessSnapshotV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly migrationRevision: number;
  readonly currentEpoch: number;
  readonly targetEpoch: number;
  readonly currentState: PiAuthorityMigrationState;
  readonly targetState: 'new_authority';
  readonly checks: readonly CutoverReadinessCheckV1[];
  readonly allPassed: boolean;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export interface CutoverReadinessCheckV1 {
  readonly checkId: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/**
 * 一次性 readiness token（接受时与 epoch 推进原子提交）。
 * token 明文只签发一次；存储侧只保留 hash。
 */
export interface CutoverReadinessTokenV1 {
  readonly schemaVersion: 1;
  readonly tokenId: ID;
  readonly teamId: ID;
  readonly tokenHash: string;
  readonly targetEpoch: number;
  readonly migrationRevision: number;
  readonly readinessSnapshotId: ID;
  readonly issuedTo: ID;
  readonly issuedAt: UnixMs;
  readonly expiresAt: UnixMs;
  readonly consumedAt: UnixMs | null;
}

/** Message / source lineage 绑定的 authority epoch（提交时冻结）。 */
export interface MessageAuthorityEpochBindingV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly messageId: ID;
  readonly sourceLineageKey: string;
  readonly authorityEpoch: number;
  readonly migrationRevision: number;
  readonly boundAt: UnixMs;
  readonly clientMessageId?: string;
}

/** cutover 时登记的 drain lineage。 */
export interface LegacyDrainLineageV1 {
  readonly schemaVersion: 1;
  readonly drainId: ID;
  readonly teamId: ID;
  readonly lineageKey: string;
  readonly jobId: ID;
  readonly cutoverVersion: number;
  readonly fencingToken: number;
  readonly drainLeaseId: ID;
  readonly state: LegacyDrainLineageState;
  readonly deadlineAt: UnixMs;
  readonly resultMessageId: ID | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/** Legacy drain bridge 提交的迟到结果 provenance。 */
export interface LegacyDrainResultProvenanceV1 {
  readonly schemaVersion: 1;
  readonly drainId: ID;
  readonly lineageKey: string;
  readonly cutoverVersion: number;
  readonly fencingToken: number;
  readonly drainLeaseId: ID;
  readonly sourceJobId: ID;
  readonly submittedAt: UnixMs;
}

/**
 * 兼容层退役指标（可查询门槛）。
 * 全部满足后才能进入 retired / 删除运行时入口。
 */
export interface CompatibilityRetirementMetricsV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly cutoverVersion: number | null;
  readonly migrationState: PiAuthorityMigrationState;
  readonly legacyWriterCallCount: number;
  readonly legacyClientCallCount: number;
  readonly openDrainLineageCount: number;
  readonly recoveryPendingCount: number;
  readonly observationWindowStartedAt: UnixMs | null;
  readonly observationWindowEndsAt: UnixMs | null;
  readonly zeroCallWindowSatisfied: boolean;
  readonly emergencyStopDrillPassed: boolean;
  readonly forwardRecoveryDrillPassed: boolean;
  readonly historicalProvenanceExportVerified: boolean;
  readonly replacementQueryPathReady: boolean;
  readonly storageDeletionBlocked: boolean;
  readonly readyToRetireRuntime: boolean;
  readonly asOf: UnixMs;
}

/** 旧写接口退役响应（结构化，含替代入口）。 */
export interface LegacyCoordinationRetiredErrorV1 {
  readonly schemaVersion: 1;
  readonly code: typeof LEGACY_COORDINATION_RETIRED_CODE;
  readonly cutoverVersion: number | null;
  readonly authorityEpoch: number;
  readonly migrationRevision: number;
  readonly correlationId: ID;
  readonly replacementEntry: string;
  readonly message: string;
}

/** 旧只读兼容投影（不得回写）。 */
export interface LegacyCompatibilityProjectionV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly projectionKind: 'coordination_job' | 'coordination_decision' | 'management_run_legacy';
  readonly sourceId: ID;
  readonly cutoverVersion: number | null;
  readonly authorityEpoch: number;
  readonly immutable: true;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projectedAt: UnixMs;
}

/** daemon capability negotiation 输入/结果。 */
export interface DaemonPiCapabilityNegotiationV1 {
  readonly schemaVersion: 1;
  readonly daemonProtocolVersion: number;
  readonly advertisedCapabilities: readonly string[];
  readonly teamMigrationState: PiAuthorityMigrationState;
  readonly legacyWriterFenced: boolean;
  readonly grantedTier: DaemonPiCapabilityTier;
  readonly mayCreateCoordinationJob: boolean;
  readonly mayObtainPiOrchestrationAuthority: boolean;
  readonly mayDrainLegacyWork: boolean;
  readonly maySendMessages: boolean;
  readonly mayClaimPiExecution: boolean;
}

// ---------------------------------------------------------------------------
// Command / query envelopes
// ---------------------------------------------------------------------------

export interface PiAuthorityCutoverCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: PiAuthorityCutoverCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
}

export interface PiAuthorityCutoverCommandInputMapV1 {
  readonly 'evaluate-cutover-readiness': {
    readonly expectedMigrationRevision: number;
    readonly readinessChecks: readonly CutoverReadinessCheckV1[];
    readonly tokenTtlMs: number;
  };
  readonly 'execute-pi-authority-cutover': {
    readonly readinessToken: string;
    readonly expectedMigrationRevision: number;
    readonly expectedTargetEpoch: number;
    /**
     * 可选客户端提示。#931：Server 必须自动扫描 Team 内全部 pending/retry_wait/running
     * legacy job 并处置，不依赖调用方传全量 job id。
     */
    readonly runningLegacyJobs?: readonly {
      readonly jobId: ID;
      readonly lineageKey: string;
    }[];
    readonly pendingLegacyJobIds?: readonly ID[];
    readonly drainDeadlineMs: number;
  };
  readonly 'submit-legacy-drain-result': {
    readonly drainId: ID;
    readonly lineageKey: string;
    readonly fencingToken: number;
    readonly drainLeaseId: ID;
    readonly idempotencyKey: string;
    readonly resultPayload: Readonly<Record<string, unknown>>;
  };
  readonly 'emergency-stop-pi': {
    readonly reason: string;
    readonly expectedMigrationRevision: number;
  };
  readonly 'clear-emergency-stop': {
    readonly expectedMigrationRevision: number;
    readonly recoveryFromNewFactsOnly: true;
  };
  readonly 'advance-migration-state': {
    readonly expectedMigrationRevision: number;
    readonly targetState: Extract<PiAuthorityMigrationState, 'legacy_read_only' | 'retired'>;
    readonly metricsGate: CompatibilityRetirementMetricsV1;
  };
  readonly 'bind-message-authority-epoch': {
    readonly messageId: ID;
    readonly sourceLineageKey: string;
    readonly clientMessageId?: string;
    readonly expectedMigrationRevision?: number;
  };
  readonly 'record-legacy-write-attempt': {
    readonly writeKind: string;
    readonly clientCorrelationId?: string;
  };
}

export interface PiAuthorityCutoverCommandOutputMapV1 {
  readonly 'evaluate-cutover-readiness': {
    readonly snapshot: CutoverReadinessSnapshotV1;
    readonly readinessSnapshotId: ID;
    /** 仅当 allPassed 时签发；明文 token 只返回一次。 */
    readonly readinessToken?: string;
    readonly tokenId?: ID;
    readonly expiresAt?: UnixMs;
  };
  readonly 'execute-pi-authority-cutover': {
    readonly migration: TeamPiAuthorityMigrationV1;
    readonly cancelledJobIds: readonly ID[];
    readonly drainLineages: readonly LegacyDrainLineageV1[];
    readonly cutoverVersion: number;
  };
  readonly 'submit-legacy-drain-result': {
    readonly drainId: ID;
    readonly state: LegacyDrainLineageState;
    readonly resultMessageId?: ID;
    readonly provenance?: LegacyDrainResultProvenanceV1;
    readonly disposition: 'accepted' | 'replayed' | 'expired' | 'recovery_pending';
  };
  readonly 'emergency-stop-pi': {
    readonly migration: TeamPiAuthorityMigrationV1;
    readonly promotionCommandsPaused: true;
    readonly piCommandsPaused: true;
    readonly messageDeliveryAvailable: true;
    readonly legacyWriterReenabled: false;
  };
  readonly 'clear-emergency-stop': {
    readonly migration: TeamPiAuthorityMigrationV1;
    readonly recoveredFromNewFactsOnly: true;
    readonly legacyWriterReenabled: false;
  };
  readonly 'advance-migration-state': {
    readonly migration: TeamPiAuthorityMigrationV1;
  };
  readonly 'bind-message-authority-epoch': {
    readonly binding: MessageAuthorityEpochBindingV1;
  };
  readonly 'record-legacy-write-attempt': {
    readonly retired: LegacyCoordinationRetiredErrorV1;
  };
}

export interface PiAuthorityCutoverQueryInputMapV1 {
  readonly 'query-migration-state': {
    readonly teamId: ID;
  };
  readonly 'query-retirement-metrics': {
    readonly teamId: ID;
  };
  readonly 'query-legacy-compatibility-projection': {
    readonly teamId: ID;
    readonly projectionKind: LegacyCompatibilityProjectionV1['projectionKind'];
    readonly sourceId: ID;
  };
}

export interface PiAuthorityCutoverQueryOutputMapV1 {
  readonly 'query-migration-state': {
    readonly migration: TeamPiAuthorityMigrationV1;
  };
  readonly 'query-retirement-metrics': {
    readonly metrics: CompatibilityRetirementMetricsV1;
  };
  readonly 'query-legacy-compatibility-projection': {
    readonly projection: LegacyCompatibilityProjectionV1 | null;
    readonly writable: false;
  };
}

export interface PiAuthorityCutoverEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

export interface PiAuthorityCutoverRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

export interface PiAuthorityCutoverCommandReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: PiAuthorityCutoverCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: PiAuthorityCutoverReceiptOutcome;
  readonly committedRevisions: readonly PiAuthorityCutoverRevisionRefV1[];
  readonly eventRefs: readonly PiAuthorityCutoverEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

export type PiAuthorityCutoverCommandOutputUnionV1 =
  | ({ readonly commandName: 'evaluate-cutover-readiness' } & PiAuthorityCutoverCommandOutputMapV1['evaluate-cutover-readiness'])
  | ({ readonly commandName: 'execute-pi-authority-cutover' } & PiAuthorityCutoverCommandOutputMapV1['execute-pi-authority-cutover'])
  | ({ readonly commandName: 'submit-legacy-drain-result' } & PiAuthorityCutoverCommandOutputMapV1['submit-legacy-drain-result'])
  | ({ readonly commandName: 'emergency-stop-pi' } & PiAuthorityCutoverCommandOutputMapV1['emergency-stop-pi'])
  | ({ readonly commandName: 'clear-emergency-stop' } & PiAuthorityCutoverCommandOutputMapV1['clear-emergency-stop'])
  | ({ readonly commandName: 'advance-migration-state' } & PiAuthorityCutoverCommandOutputMapV1['advance-migration-state'])
  | ({ readonly commandName: 'bind-message-authority-epoch' } & PiAuthorityCutoverCommandOutputMapV1['bind-message-authority-epoch'])
  | ({ readonly commandName: 'record-legacy-write-attempt' } & PiAuthorityCutoverCommandOutputMapV1['record-legacy-write-attempt']);

export interface PiAuthorityCutoverCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: PiAuthorityCutoverCommandName;
  readonly outcome: PiAuthorityCutoverOutcome;
  readonly retryDirective: PiAuthorityCutoverRetryDirective;
  readonly stableCode: string;
  readonly receipt?: PiAuthorityCutoverCommandReceiptV1;
  readonly result?: PiAuthorityCutoverCommandOutputUnionV1;
  readonly conflictReason?: string;
  readonly rejectReason?: string;
}

export type PiAuthorityCutoverQueryOutputUnionV1 =
  | ({ readonly queryName: 'query-migration-state' } & PiAuthorityCutoverQueryOutputMapV1['query-migration-state'])
  | ({ readonly queryName: 'query-retirement-metrics' } & PiAuthorityCutoverQueryOutputMapV1['query-retirement-metrics'])
  | ({ readonly queryName: 'query-legacy-compatibility-projection' } & PiAuthorityCutoverQueryOutputMapV1['query-legacy-compatibility-projection']);

export interface PiAuthorityCutoverQueryResponseV1 {
  readonly schemaVersion: 1;
  readonly queryName: PiAuthorityCutoverQueryName;
  readonly outcome: 'ready' | 'rejected';
  readonly stableCode: string;
  readonly result?: PiAuthorityCutoverQueryOutputUnionV1;
  readonly rejectReason?: string;
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

export function canonicalizePiAuthorityCutoverCommand(
  commandName: PiAuthorityCutoverCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: PI_AUTHORITY_CUTOVER_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

export const PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID = 'PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
}

function assertMigrationState(value: unknown): asserts value is PiAuthorityMigrationState {
  if (!PI_AUTHORITY_MIGRATION_STATES.includes(value as PiAuthorityMigrationState)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
}

export function parsePiAuthorityCutoverCommandEnvelopeV1(
  value: unknown,
): PiAuthorityCutoverCommandEnvelopeV1 {
  assertExactKeys(
    value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey'],
  );
  if (value.schemaVersion !== 1) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  if (!PI_AUTHORITY_CUTOVER_COMMAND_NAMES.includes(value.commandName as PiAuthorityCutoverCommandName)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  if (!nonEmpty(value.idempotencyKey)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  return value as unknown as PiAuthorityCutoverCommandEnvelopeV1;
}

function parseReadinessCheck(value: unknown): CutoverReadinessCheckV1 {
  assertExactKeys(value, ['checkId', 'passed', 'detail'], ['checkId', 'passed']);
  if (!nonEmpty(value.checkId)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  assertBoolean(value.passed);
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  return value as unknown as CutoverReadinessCheckV1;
}

export function parsePiAuthorityCutoverCommandInputV1<
  N extends PiAuthorityCutoverCommandName,
>(commandName: N, value: unknown): PiAuthorityCutoverCommandInputMapV1[N] {
  switch (commandName) {
    case 'evaluate-cutover-readiness': {
      assertExactKeys(
        value,
        ['expectedMigrationRevision', 'readinessChecks', 'tokenTtlMs'],
        ['expectedMigrationRevision', 'readinessChecks', 'tokenTtlMs'],
      );
      assertInteger(value.expectedMigrationRevision, 0);
      if (!Array.isArray(value.readinessChecks) || value.readinessChecks.length < 1) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      const readinessChecks = value.readinessChecks.map(parseReadinessCheck);
      assertInteger(value.tokenTtlMs, 1);
      return {
        expectedMigrationRevision: value.expectedMigrationRevision as number,
        readinessChecks,
        tokenTtlMs: value.tokenTtlMs as number,
      } as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'execute-pi-authority-cutover': {
      assertExactKeys(
        value,
        [
          'readinessToken', 'expectedMigrationRevision', 'expectedTargetEpoch',
          'drainDeadlineMs',
        ],
        [
          'readinessToken', 'expectedMigrationRevision', 'expectedTargetEpoch',
          'runningLegacyJobs', 'pendingLegacyJobIds', 'drainDeadlineMs',
        ],
      );
      if (!nonEmpty(value.readinessToken)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      assertInteger(value.expectedMigrationRevision, 0);
      assertInteger(value.expectedTargetEpoch, 1);
      const runningRaw = value.runningLegacyJobs;
      if (runningRaw !== undefined && !Array.isArray(runningRaw)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      const pendingRaw = value.pendingLegacyJobIds;
      if (pendingRaw !== undefined && !Array.isArray(pendingRaw)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      const runningLegacyJobs = (runningRaw ?? []).map((job) => {
        assertExactKeys(job, ['jobId', 'lineageKey'], ['jobId', 'lineageKey']);
        assertId(job.jobId);
        if (!nonEmpty(job.lineageKey)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
        return { jobId: job.jobId as ID, lineageKey: job.lineageKey as string };
      });
      const pendingLegacyJobIds = (pendingRaw ?? []).map((id) => {
        assertId(id);
        return id as ID;
      });
      assertInteger(value.drainDeadlineMs, 1);
      return {
        readinessToken: value.readinessToken as string,
        expectedMigrationRevision: value.expectedMigrationRevision as number,
        expectedTargetEpoch: value.expectedTargetEpoch as number,
        runningLegacyJobs,
        pendingLegacyJobIds,
        drainDeadlineMs: value.drainDeadlineMs as number,
      } as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'submit-legacy-drain-result': {
      assertExactKeys(
        value,
        ['drainId', 'lineageKey', 'fencingToken', 'drainLeaseId', 'idempotencyKey', 'resultPayload'],
        ['drainId', 'lineageKey', 'fencingToken', 'drainLeaseId', 'idempotencyKey', 'resultPayload'],
      );
      assertId(value.drainId);
      if (!nonEmpty(value.lineageKey) || !nonEmpty(value.drainLeaseId) || !nonEmpty(value.idempotencyKey)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      assertInteger(value.fencingToken, 1);
      if (!value.resultPayload || typeof value.resultPayload !== 'object' || Array.isArray(value.resultPayload)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'emergency-stop-pi': {
      assertExactKeys(
        value,
        ['reason', 'expectedMigrationRevision'],
        ['reason', 'expectedMigrationRevision'],
      );
      if (!nonEmpty(value.reason)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      assertInteger(value.expectedMigrationRevision, 0);
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'clear-emergency-stop': {
      assertExactKeys(
        value,
        ['expectedMigrationRevision', 'recoveryFromNewFactsOnly'],
        ['expectedMigrationRevision', 'recoveryFromNewFactsOnly'],
      );
      assertInteger(value.expectedMigrationRevision, 0);
      if (value.recoveryFromNewFactsOnly !== true) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'advance-migration-state': {
      assertExactKeys(
        value,
        ['expectedMigrationRevision', 'targetState', 'metricsGate'],
        ['expectedMigrationRevision', 'targetState', 'metricsGate'],
      );
      assertInteger(value.expectedMigrationRevision, 0);
      if (value.targetState !== 'legacy_read_only' && value.targetState !== 'retired') {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      parseCompatibilityRetirementMetricsV1(value.metricsGate);
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'bind-message-authority-epoch': {
      assertExactKeys(
        value,
        ['messageId', 'sourceLineageKey', 'clientMessageId', 'expectedMigrationRevision'],
        ['messageId', 'sourceLineageKey'],
      );
      assertId(value.messageId);
      if (!nonEmpty(value.sourceLineageKey)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      if (value.clientMessageId !== undefined && !nonEmpty(value.clientMessageId)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      if (value.expectedMigrationRevision !== undefined) {
        assertInteger(value.expectedMigrationRevision, 0);
      }
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    case 'record-legacy-write-attempt': {
      assertExactKeys(
        value,
        ['writeKind', 'clientCorrelationId'],
        ['writeKind'],
      );
      if (!nonEmpty(value.writeKind)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      if (value.clientCorrelationId !== undefined && !nonEmpty(value.clientCorrelationId)) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      return value as unknown as PiAuthorityCutoverCommandInputMapV1[N];
    }
    default:
      throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
}

export function parseCompatibilityRetirementMetricsV1(value: unknown): CompatibilityRetirementMetricsV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'teamId', 'cutoverVersion', 'migrationState', 'legacyWriterCallCount',
      'legacyClientCallCount', 'openDrainLineageCount', 'recoveryPendingCount',
      'observationWindowStartedAt', 'observationWindowEndsAt', 'zeroCallWindowSatisfied',
      'emergencyStopDrillPassed', 'forwardRecoveryDrillPassed', 'historicalProvenanceExportVerified',
      'replacementQueryPathReady', 'storageDeletionBlocked', 'readyToRetireRuntime', 'asOf',
    ],
    [
      'schemaVersion', 'teamId', 'cutoverVersion', 'migrationState', 'legacyWriterCallCount',
      'legacyClientCallCount', 'openDrainLineageCount', 'recoveryPendingCount',
      'observationWindowStartedAt', 'observationWindowEndsAt', 'zeroCallWindowSatisfied',
      'emergencyStopDrillPassed', 'forwardRecoveryDrillPassed', 'historicalProvenanceExportVerified',
      'replacementQueryPathReady', 'storageDeletionBlocked', 'readyToRetireRuntime', 'asOf',
    ],
  );
  if (value.schemaVersion !== 1) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  assertId(value.teamId);
  assertMigrationState(value.migrationState);
  assertInteger(value.legacyWriterCallCount, 0);
  assertInteger(value.legacyClientCallCount, 0);
  assertInteger(value.openDrainLineageCount, 0);
  assertInteger(value.recoveryPendingCount, 0);
  assertBoolean(value.zeroCallWindowSatisfied);
  assertBoolean(value.emergencyStopDrillPassed);
  assertBoolean(value.forwardRecoveryDrillPassed);
  assertBoolean(value.historicalProvenanceExportVerified);
  assertBoolean(value.replacementQueryPathReady);
  assertBoolean(value.storageDeletionBlocked);
  assertBoolean(value.readyToRetireRuntime);
  assertInteger(value.asOf, 0);
  return value as unknown as CompatibilityRetirementMetricsV1;
}

export function parsePiAuthorityCutoverQueryInputV1<
  N extends PiAuthorityCutoverQueryName,
>(queryName: N, value: unknown): PiAuthorityCutoverQueryInputMapV1[N] {
  switch (queryName) {
    case 'query-migration-state':
    case 'query-retirement-metrics': {
      assertExactKeys(value, ['teamId'], ['teamId']);
      assertId(value.teamId);
      return value as unknown as PiAuthorityCutoverQueryInputMapV1[N];
    }
    case 'query-legacy-compatibility-projection': {
      assertExactKeys(
        value,
        ['teamId', 'projectionKind', 'sourceId'],
        ['teamId', 'projectionKind', 'sourceId'],
      );
      assertId(value.teamId);
      assertId(value.sourceId);
      if (
        value.projectionKind !== 'coordination_job'
        && value.projectionKind !== 'coordination_decision'
        && value.projectionKind !== 'management_run_legacy'
      ) {
        throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
      }
      return value as unknown as PiAuthorityCutoverQueryInputMapV1[N];
    }
    default:
      throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
}

export function parsePiAuthorityCutoverCommandResponseV1(
  value: unknown,
): PiAuthorityCutoverCommandResponseV1 {
  assertExactKeys(
    value,
    [
      'schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode',
      'receipt', 'result', 'conflictReason', 'rejectReason',
    ],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode'],
  );
  if (value.schemaVersion !== 1) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  if (!PI_AUTHORITY_CUTOVER_COMMAND_NAMES.includes(value.commandName as PiAuthorityCutoverCommandName)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  if (!PI_AUTHORITY_CUTOVER_OUTCOMES.includes(value.outcome as PiAuthorityCutoverOutcome)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  if (!PI_AUTHORITY_CUTOVER_RETRY_DIRECTIVES.includes(value.retryDirective as PiAuthorityCutoverRetryDirective)) {
    throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID);
  return value as unknown as PiAuthorityCutoverCommandResponseV1;
}

/**
 * 构造旧写接口退役错误（transport / handler 共用）。
 */
export function buildLegacyCoordinationRetiredError(input: {
  readonly cutoverVersion: number | null;
  readonly authorityEpoch: number;
  readonly migrationRevision: number;
  readonly correlationId: ID;
  readonly replacementEntry?: string;
}): LegacyCoordinationRetiredErrorV1 {
  return {
    schemaVersion: 1,
    code: LEGACY_COORDINATION_RETIRED_CODE,
    cutoverVersion: input.cutoverVersion,
    authorityEpoch: input.authorityEpoch,
    migrationRevision: input.migrationRevision,
    correlationId: input.correlationId,
    replacementEntry: input.replacementEntry ?? 'promotion-gate:promote-to-task',
    message: 'Legacy coordination write APIs are retired for this Team; use the new Promotion gate / PI orchestration path.',
  };
}
