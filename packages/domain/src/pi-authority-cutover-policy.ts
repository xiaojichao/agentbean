/**
 * #930 Team PI authority cutover / legacy 兼容退役 纯策略（ADR-0068）。
 *
 * 无 IO、无 server 依赖。Server handler 在事务内组合这些决策。
 */
import type {
  CompatibilityRetirementMetricsV1,
  CutoverReadinessCheckV1,
  DaemonPiCapabilityNegotiationV1,
  DaemonPiCapabilityTier,
  LegacyDrainLineageState,
  PiAuthorityMigrationState,
  TeamPiAuthorityMigrationV1,
} from '@agentbean/contracts';
import { PI_AUTHORITY_MIGRATION_STATES } from '@agentbean/contracts';

// ---------------------------------------------------------------------------
// State machine —— 只允许前向
// ---------------------------------------------------------------------------

const STATE_ORDER: Readonly<Record<PiAuthorityMigrationState, number>> = {
  legacy: 0,
  shadow: 1,
  cutover_pending: 2,
  new_authority: 3,
  legacy_read_only: 4,
  retired: 5,
};

/** cutover 完成后 writer 必须 fenced 的状态。 */
export const LEGACY_WRITER_FENCED_STATES: ReadonlySet<PiAuthorityMigrationState> = new Set([
  'new_authority',
  'legacy_read_only',
  'retired',
]);

/** 仍允许创建 legacy coordination job 的状态。 */
export const LEGACY_WRITER_ACTIVE_STATES: ReadonlySet<PiAuthorityMigrationState> = new Set([
  'legacy',
  'shadow',
  'cutover_pending',
]);

export type MigrationTransitionDecision =
  | { readonly kind: 'allow'; readonly from: PiAuthorityMigrationState; readonly to: PiAuthorityMigrationState }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 单调前向：只能前进到更高序号状态，禁止回退到启用 legacy writer。
 * 允许同状态 no-op（由调用方处理幂等）。
 */
export function evaluateMigrationTransition(input: {
  readonly from: PiAuthorityMigrationState;
  readonly to: PiAuthorityMigrationState;
}): MigrationTransitionDecision {
  if (input.from === input.to) {
    return { kind: 'allow', from: input.from, to: input.to };
  }
  const fromOrder = STATE_ORDER[input.from];
  const toOrder = STATE_ORDER[input.to];
  if (toOrder <= fromOrder) {
    return { kind: 'reject', reason: 'migration_state_not_forward' };
  }
  // 禁止从 new_authority 之后回到任何 unfenced 状态（已由序号覆盖）。
  // cutover 只能落到 new_authority 起跳（execute-cutover）；advance 只能 legacy_read_only/retired。
  return { kind: 'allow', from: input.from, to: input.to };
}

export function isLegacyWriterFenced(state: PiAuthorityMigrationState, explicitFlag?: boolean): boolean {
  if (explicitFlag === true) return true;
  return LEGACY_WRITER_FENCED_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Role / readiness / cutover gates
// ---------------------------------------------------------------------------

export type TeamAdminRole = 'owner' | 'admin' | 'member' | 'viewer';

export type CutoverAuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** 只有合法 Team Owner/Admin 可发起 cutover / readiness 签发。 */
export function authorizeTeamCutoverOperator(role: TeamAdminRole): CutoverAuthorizationDecision {
  if (role === 'owner' || role === 'admin') return { allowed: true };
  return { allowed: false, reason: 'requires_team_owner_or_admin' };
}

export type ReadinessDecision =
  | { readonly kind: 'ready'; readonly checks: readonly CutoverReadinessCheckV1[] }
  | { readonly kind: 'not_ready'; readonly checks: readonly CutoverReadinessCheckV1[]; readonly failedIds: readonly string[] };

/**
 * Server readiness gate：全部检查通过才可签发 token。
 * 自动 rollout 只能提出 proposal，不能绕过本 gate。
 */
export function evaluateCutoverReadiness(
  checks: readonly CutoverReadinessCheckV1[],
): ReadinessDecision {
  if (checks.length === 0) {
    return { kind: 'not_ready', checks, failedIds: ['empty_checks'] };
  }
  const failedIds = checks.filter((c) => !c.passed).map((c) => c.checkId);
  if (failedIds.length > 0) return { kind: 'not_ready', checks, failedIds };
  return { kind: 'ready', checks };
}

export type CutoverTokenAcceptanceDecision =
  | {
      readonly kind: 'accept';
      readonly nextEpoch: number;
      readonly nextRevision: number;
      readonly nextState: 'new_authority';
    }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 接受 readiness token 与推进 epoch 的前置条件（纯判定）。
 * 实际 token hash / 消费在 handler 事务内完成。
 */
export function evaluateCutoverTokenAcceptance(input: {
  readonly migration: TeamPiAuthorityMigrationV1;
  readonly role: TeamAdminRole;
  readonly tokenExpired: boolean;
  readonly tokenConsumed: boolean;
  readonly tokenTeamId: string;
  readonly tokenTargetEpoch: number;
  readonly tokenMigrationRevision: number;
  readonly expectedMigrationRevision: number;
  readonly expectedTargetEpoch: number;
  readonly tokenHashMatches: boolean;
}): CutoverTokenAcceptanceDecision {
  const auth = authorizeTeamCutoverOperator(input.role);
  if (!auth.allowed) return { kind: 'reject', reason: auth.reason };

  if (input.migration.teamId !== input.tokenTeamId) {
    return { kind: 'reject', reason: 'token_team_mismatch' };
  }
  if (input.tokenExpired) return { kind: 'reject', reason: 'token_expired' };
  if (input.tokenConsumed) return { kind: 'reject', reason: 'token_already_consumed' };
  if (!input.tokenHashMatches) return { kind: 'reject', reason: 'token_hash_mismatch' };
  if (input.migration.migrationRevision !== input.expectedMigrationRevision) {
    return { kind: 'reject', reason: 'migration_revision_conflict' };
  }
  if (input.tokenMigrationRevision !== input.expectedMigrationRevision) {
    return { kind: 'reject', reason: 'token_revision_mismatch' };
  }
  if (input.tokenTargetEpoch !== input.expectedTargetEpoch) {
    return { kind: 'reject', reason: 'token_epoch_mismatch' };
  }
  if (input.migration.authorityEpoch + 1 !== input.expectedTargetEpoch) {
    return { kind: 'reject', reason: 'target_epoch_not_monotonic' };
  }
  if (LEGACY_WRITER_FENCED_STATES.has(input.migration.state)) {
    return { kind: 'reject', reason: 'already_cut_over' };
  }
  if (input.migration.state === 'retired') {
    return { kind: 'reject', reason: 'already_retired' };
  }

  return {
    kind: 'accept',
    nextEpoch: input.expectedTargetEpoch,
    nextRevision: input.migration.migrationRevision + 1,
    nextState: 'new_authority',
  };
}

// ---------------------------------------------------------------------------
// Legacy job disposition at cutover
// ---------------------------------------------------------------------------

export type LegacyJobDisposition =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'drain'; readonly deadlineAt: number }
  | { readonly kind: 'ignore_terminal' };

/**
 * 未开始 → 取消；已 running → 隔离 drain；终态 → 忽略。
 */
export function disposeLegacyJobAtCutover(input: {
  readonly status: 'pending' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
  readonly now: number;
  readonly drainDeadlineMs: number;
}): LegacyJobDisposition {
  if (input.status === 'pending' || input.status === 'retry_wait') {
    return { kind: 'cancel' };
  }
  if (input.status === 'running') {
    return { kind: 'drain', deadlineAt: input.now + input.drainDeadlineMs };
  }
  return { kind: 'ignore_terminal' };
}

// ---------------------------------------------------------------------------
// Drain bridge
// ---------------------------------------------------------------------------

export type DrainResultDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replay'; readonly existingMessageId: string }
  | { readonly kind: 'expire' }
  | { readonly kind: 'recovery_pending'; readonly reason: string }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 合法迟到结果经 Legacy drain bridge：
 * 校验 lineage / lease / fencing / deadline / 幂等；
 * 不得自动 promotion / 建 Task / 新 coordination job。
 */
export function evaluateLegacyDrainResult(input: {
  readonly drainState: LegacyDrainLineageState;
  readonly now: number;
  readonly deadlineAt: number;
  readonly expectedFencingToken: number;
  readonly providedFencingToken: number;
  readonly expectedLeaseId: string;
  readonly providedLeaseId: string;
  readonly expectedLineageKey: string;
  readonly providedLineageKey: string;
  readonly existingResultMessageId: string | null;
}): DrainResultDecision {
  if (input.expectedLineageKey !== input.providedLineageKey) {
    return { kind: 'reject', reason: 'lineage_mismatch' };
  }
  if (input.expectedFencingToken !== input.providedFencingToken) {
    return { kind: 'reject', reason: 'fencing_token_mismatch' };
  }
  if (input.expectedLeaseId !== input.providedLeaseId) {
    return { kind: 'reject', reason: 'drain_lease_mismatch' };
  }
  if (input.drainState === 'completed' && input.existingResultMessageId) {
    return { kind: 'replay', existingMessageId: input.existingResultMessageId };
  }
  if (input.drainState === 'completed') {
    return { kind: 'reject', reason: 'already_completed_without_message' };
  }
  if (input.drainState === 'recovery_pending') {
    return { kind: 'recovery_pending', reason: 'already_recovery_pending' };
  }
  if (input.drainState === 'expired' || input.now > input.deadlineAt) {
    return { kind: 'expire' };
  }
  if (input.drainState !== 'draining') {
    return { kind: 'reject', reason: 'invalid_drain_state' };
  }
  return { kind: 'accept' };
}

// ---------------------------------------------------------------------------
// Emergency stop
// ---------------------------------------------------------------------------

export interface EmergencyStopEffects {
  readonly promotionCommandsPaused: true;
  readonly piCommandsPaused: true;
  readonly messageDeliveryAvailable: true;
  readonly legacyWriterReenabled: false;
  readonly mayAdvancePromotion: false;
  readonly mayIssuePiCommand: false;
  readonly mayDeliverMessage: true;
}

/**
 * emergency-stop 只暂停新 promotion/PI command；消息投递仍可用；
 * 永不重新启用 legacy writer。
 */
export function emergencyStopEffects(): EmergencyStopEffects {
  return {
    promotionCommandsPaused: true,
    piCommandsPaused: true,
    messageDeliveryAvailable: true,
    legacyWriterReenabled: false,
    mayAdvancePromotion: false,
    mayIssuePiCommand: false,
    mayDeliverMessage: true,
  };
}

export type CommandPathDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * 运行时门控：cutover 后路径 + emergency-stop 组合。
 */
export function evaluateCommandPathAvailability(input: {
  readonly migration: Pick<TeamPiAuthorityMigrationV1, 'state' | 'legacyWriterFenced' | 'emergencyStop'>;
  readonly path: 'legacy_write' | 'legacy_read' | 'message_delivery' | 'promotion' | 'pi_orchestration' | 'drain_bridge';
}): CommandPathDecision {
  const fenced = isLegacyWriterFenced(input.migration.state, input.migration.legacyWriterFenced);

  if (input.path === 'legacy_write') {
    if (fenced) return { allowed: false, reason: 'LEGACY_COORDINATION_RETIRED' };
    return { allowed: true };
  }
  if (input.path === 'legacy_read') {
    // 只读 projection 在 cutover 后仍可用，直到 retired 删除入口。
    if (input.migration.state === 'retired') {
      return { allowed: false, reason: 'legacy_projection_retired' };
    }
    return { allowed: true };
  }
  if (input.path === 'message_delivery') {
    return { allowed: true };
  }
  if (input.path === 'drain_bridge') {
    if (!fenced) return { allowed: false, reason: 'drain_only_after_cutover' };
    return { allowed: true };
  }
  // promotion / pi_orchestration
  if (!fenced && input.migration.state !== 'shadow' && input.migration.state !== 'cutover_pending') {
    // pre-cutover 新路径可在 shadow 观察；真正权威在 new_authority。
    // 允许 shadow 下 promotion 存在（不 dual-write 旧 writer 由调用方保证）。
  }
  if (input.migration.emergencyStop) {
    return { allowed: false, reason: 'pi_emergency_stop' };
  }
  if (input.path === 'promotion' || input.path === 'pi_orchestration') {
    if (input.migration.state === 'legacy') {
      // legacy 下主路径仍是旧协调；新 promotion 可并存为独立入口，但不作为 dual-write。
      return { allowed: true };
    }
    return { allowed: true };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Message epoch binding linearization
// ---------------------------------------------------------------------------

export type MessageEpochBindDecision =
  | {
      readonly kind: 'bind';
      readonly authorityEpoch: number;
      readonly migrationRevision: number;
    }
  | {
      readonly kind: 'replay';
      readonly authorityEpoch: number;
      readonly migrationRevision: number;
    }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 同一 source lineage / clientMessageId 必须沿用首次绑定的 epoch；
 * 新消息绑定当前 migration revision 上的 epoch。
 */
export function evaluateMessageEpochBinding(input: {
  readonly current: Pick<TeamPiAuthorityMigrationV1, 'authorityEpoch' | 'migrationRevision'>;
  readonly existingBinding?: {
    readonly authorityEpoch: number;
    readonly migrationRevision: number;
    readonly sourceLineageKey: string;
  };
  readonly sourceLineageKey: string;
  readonly expectedMigrationRevision?: number;
}): MessageEpochBindDecision {
  if (
    input.expectedMigrationRevision !== undefined
    && input.expectedMigrationRevision !== input.current.migrationRevision
  ) {
    return { kind: 'reject', reason: 'migration_revision_conflict' };
  }
  if (input.existingBinding) {
    if (input.existingBinding.sourceLineageKey !== input.sourceLineageKey) {
      return { kind: 'reject', reason: 'lineage_key_mismatch' };
    }
    return {
      kind: 'replay',
      authorityEpoch: input.existingBinding.authorityEpoch,
      migrationRevision: input.existingBinding.migrationRevision,
    };
  }
  return {
    kind: 'bind',
    authorityEpoch: input.current.authorityEpoch,
    migrationRevision: input.current.migrationRevision,
  };
}

// ---------------------------------------------------------------------------
// Daemon capability negotiation
// ---------------------------------------------------------------------------

const PI_ORCHESTRATION_CAPS = new Set([
  'pi.orchestration.claim',
  'pi.orchestration.drive',
  'pi.create_root_task',
  'pi.create_dag',
  'coordination.job.create',
]);

/**
 * 旧 daemon 在 cutover 后只保留消息 + 合法 drain；不能取得 PI orchestration authority。
 * 升级失败只影响领取能力，不能让 Team 降级回 legacy。
 */
export function negotiateDaemonPiCapabilities(input: {
  readonly daemonProtocolVersion: number;
  readonly advertisedCapabilities: readonly string[];
  readonly teamMigrationState: PiAuthorityMigrationState;
  readonly legacyWriterFenced: boolean;
  /** 当前协议要求的最低 execution 版本。 */
  readonly minPiExecutionProtocolVersion?: number;
}): DaemonPiCapabilityNegotiationV1 {
  const minExec = input.minPiExecutionProtocolVersion ?? 2;
  const fenced = input.legacyWriterFenced || LEGACY_WRITER_FENCED_STATES.has(input.teamMigrationState);
  const hasOrchestrationCap = input.advertisedCapabilities.some((c) => PI_ORCHESTRATION_CAPS.has(c));
  const protocolOk = input.daemonProtocolVersion >= minExec;

  let grantedTier: DaemonPiCapabilityTier;
  let mayCreateCoordinationJob = false;
  let mayObtainPiOrchestrationAuthority = false;
  let mayDrainLegacyWork = false;
  let maySendMessages = true;
  let mayClaimPiExecution = false;

  if (!fenced) {
    grantedTier = 'legacy_full_coordination';
    mayCreateCoordinationJob = true;
    mayDrainLegacyWork = false;
    mayClaimPiExecution = protocolOk && hasOrchestrationCap;
    mayObtainPiOrchestrationAuthority = false; // orchestration authority 始终在 Server
  } else if (protocolOk && hasOrchestrationCap) {
    grantedTier = 'pi_execution_eligible';
    mayDrainLegacyWork = true;
    mayClaimPiExecution = true;
    mayObtainPiOrchestrationAuthority = false;
  } else {
    // 旧 daemon 或能力不足：只能 message + drain
    grantedTier = mayHaveDrainCap(input.advertisedCapabilities)
      ? 'message_and_drain_only'
      : 'message_only';
    mayDrainLegacyWork = grantedTier === 'message_and_drain_only';
    mayClaimPiExecution = false;
    mayObtainPiOrchestrationAuthority = false;
    mayCreateCoordinationJob = false;
  }

  return {
    schemaVersion: 1,
    daemonProtocolVersion: input.daemonProtocolVersion,
    advertisedCapabilities: input.advertisedCapabilities,
    teamMigrationState: input.teamMigrationState,
    legacyWriterFenced: fenced,
    grantedTier,
    mayCreateCoordinationJob,
    mayObtainPiOrchestrationAuthority,
    mayDrainLegacyWork,
    maySendMessages,
    mayClaimPiExecution,
  };
}

function mayHaveDrainCap(caps: readonly string[]): boolean {
  return caps.includes('legacy.drain') || caps.includes('message.send') || caps.length === 0;
}

// ---------------------------------------------------------------------------
// Retirement metrics gate
// ---------------------------------------------------------------------------

export type RetirementGateDecision =
  | { readonly kind: 'allow_runtime_retire' }
  | { readonly kind: 'allow_legacy_read_only' }
  | { readonly kind: 'block'; readonly reasons: readonly string[] };

/**
 * 删除 compatibility layer 的证据门槛（ADR-0068）。
 * storage 删除永远与 runtime 退役分版本，storageDeletionBlocked 必须为 true 才能 retired runtime。
 */
export function evaluateRetirementGate(
  metrics: CompatibilityRetirementMetricsV1,
  target: 'legacy_read_only' | 'retired',
): RetirementGateDecision {
  const reasons: string[] = [];

  if (metrics.openDrainLineageCount > 0) reasons.push('open_drain_lineages');
  if (metrics.recoveryPendingCount > 0) reasons.push('recovery_pending');
  if (!metrics.zeroCallWindowSatisfied) reasons.push('legacy_calls_not_zero');
  if (metrics.legacyWriterCallCount > 0) reasons.push('legacy_writer_calls_in_window');
  if (metrics.legacyClientCallCount > 0) reasons.push('legacy_client_calls_in_window');
  if (!metrics.replacementQueryPathReady) reasons.push('replacement_query_not_ready');
  if (!metrics.historicalProvenanceExportVerified) reasons.push('provenance_export_unverified');
  if (!metrics.emergencyStopDrillPassed) reasons.push('emergency_stop_drill_failed');
  if (!metrics.forwardRecoveryDrillPassed) reasons.push('forward_recovery_drill_failed');

  if (target === 'legacy_read_only') {
    // 进入只读兼容：drain/recovery 必须清零；调用窗口可放宽为「可观察」
    const strict = reasons.filter((r) =>
      r === 'open_drain_lineages' || r === 'recovery_pending');
    if (strict.length > 0) return { kind: 'block', reasons: strict };
    return { kind: 'allow_legacy_read_only' };
  }

  // retired runtime
  if (!metrics.storageDeletionBlocked) {
    reasons.push('storage_deletion_must_remain_blocked');
  }
  if (!metrics.readyToRetireRuntime) {
    reasons.push('ready_flag_false');
  }
  if (
    metrics.migrationState !== 'legacy_read_only'
    && metrics.migrationState !== 'new_authority'
    && metrics.migrationState !== 'retired'
  ) {
    reasons.push('invalid_state_for_retire');
  }
  if (reasons.length > 0) return { kind: 'block', reasons };
  return { kind: 'allow_runtime_retire' };
}

/**
 * 从原始计数合成 metrics（handler 可覆盖标志位）。
 */
export function buildRetirementMetrics(input: {
  readonly teamId: string;
  readonly migration: TeamPiAuthorityMigrationV1;
  readonly legacyWriterCallCount: number;
  readonly legacyClientCallCount: number;
  readonly openDrainLineageCount: number;
  readonly recoveryPendingCount: number;
  readonly observationWindowStartedAt: number | null;
  readonly observationWindowEndsAt: number | null;
  readonly now: number;
  readonly emergencyStopDrillPassed?: boolean;
  readonly forwardRecoveryDrillPassed?: boolean;
  readonly historicalProvenanceExportVerified?: boolean;
  readonly replacementQueryPathReady?: boolean;
}): CompatibilityRetirementMetricsV1 {
  const zeroCallWindowSatisfied =
    input.legacyWriterCallCount === 0
    && input.legacyClientCallCount === 0
    && input.observationWindowStartedAt !== null
    && input.observationWindowEndsAt !== null
    && input.now >= input.observationWindowEndsAt;

  const readyToRetireRuntime =
    zeroCallWindowSatisfied
    && input.openDrainLineageCount === 0
    && input.recoveryPendingCount === 0
    && (input.emergencyStopDrillPassed ?? false)
    && (input.forwardRecoveryDrillPassed ?? false)
    && (input.historicalProvenanceExportVerified ?? false)
    && (input.replacementQueryPathReady ?? false);

  return {
    schemaVersion: 1,
    teamId: input.teamId,
    cutoverVersion: input.migration.cutoverVersion,
    migrationState: input.migration.state,
    legacyWriterCallCount: input.legacyWriterCallCount,
    legacyClientCallCount: input.legacyClientCallCount,
    openDrainLineageCount: input.openDrainLineageCount,
    recoveryPendingCount: input.recoveryPendingCount,
    observationWindowStartedAt: input.observationWindowStartedAt,
    observationWindowEndsAt: input.observationWindowEndsAt,
    zeroCallWindowSatisfied,
    emergencyStopDrillPassed: input.emergencyStopDrillPassed ?? false,
    forwardRecoveryDrillPassed: input.forwardRecoveryDrillPassed ?? false,
    historicalProvenanceExportVerified: input.historicalProvenanceExportVerified ?? false,
    replacementQueryPathReady: input.replacementQueryPathReady ?? false,
    storageDeletionBlocked: true,
    readyToRetireRuntime,
    asOf: input.now,
  };
}

export function assertKnownMigrationState(state: string): asserts state is PiAuthorityMigrationState {
  if (!PI_AUTHORITY_MIGRATION_STATES.includes(state as PiAuthorityMigrationState)) {
    throw new Error(`unknown_migration_state:${state}`);
  }
}

/** 默认 Team 迁移初始事实。 */
export function initialTeamMigration(input: {
  readonly teamId: string;
  readonly now: number;
}): TeamPiAuthorityMigrationV1 {
  return {
    schemaVersion: 1,
    teamId: input.teamId,
    authorityEpoch: 0,
    migrationRevision: 0,
    state: 'legacy',
    legacyWriterFenced: false,
    emergencyStop: false,
    cutoverVersion: null,
    cutoverAt: null,
    cutoverBy: null,
    drainDeadlineAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
