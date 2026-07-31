/**
 * #931 C1-C2: Crash recovery + legacy drain drill tests.
 *
 * 验证 ADR-0069 场景 10-11：
 * - cutover handler 幂等 replay（崩溃后重试）
 * - drain bridge 完整流程
 * - emergency-stop → clear → advance 迁移生命周期
 */
import { describe, expect, test } from 'vitest';
import {
  handleEvaluateCutoverReadiness,
  handleExecutePiAuthorityCutover,
  handleSubmitLegacyDrainResult,
  handleEmergencyStopPi,
  handleClearEmergencyStop,
  handleAdvanceMigrationState,
  handleBindMessageAuthorityEpoch,
  handleRecordLegacyWriteAttempt,
  handlePiAuthorityCutoverQuery,
  type PiAuthorityCutoverHandlerDeps,
} from '../src/application/pi-authority-cutover-handler.js';
import { createMemoryPiAuthorityCutoverUnitOfWork } from '../src/application/pi-authority-cutover-unit-of-work.js';
import {
  clonePiAuthorityCutoverMemoryState,
  createInMemoryPiAuthorityCutoverRepositories,
  createPiAuthorityCutoverMemoryState,
  restorePiAuthorityCutoverMemoryState,
} from '../src/infra/memory/pi-authority-cutover-repositories.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(commandName: string, key: string) {
  return { schemaVersion: 1 as const, commandName, commandSchemaVersion: 1, idempotencyKey: key };
}

function makeDeps(role: 'owner' | 'admin' | 'member' = 'owner') {
  const state = createPiAuthorityCutoverMemoryState();
  const repos = createInMemoryPiAuthorityCutoverRepositories(state);
  let seq = 0;
  return {
    state,
    repos,
    deps: {
      teamId: 'team-1',
      operatorId: role === 'owner' ? 'user-owner' : 'user-admin',
      operatorRole: role,
      unitOfWork: createMemoryPiAuthorityCutoverUnitOfWork({
        repos,
        snapshot: () => clonePiAuthorityCutoverMemoryState(state),
        restore: (snap) => restorePiAuthorityCutoverMemoryState(
          state, snap as ReturnType<typeof createPiAuthorityCutoverMemoryState>,
        ),
      }),
      ids: { nextId: () => `id-${++seq}` },
      clock: { now: () => 10_000 + seq },
    } as PiAuthorityCutoverHandlerDeps,
  };
}

/** Execute full readiness → cutover flow, return token + migration revision */
async function readinessAndCutover(d: ReturnType<typeof makeDeps>) {
  // Step 1: Readiness
  const ready = await handleEvaluateCutoverReadiness(d.deps, env('evaluate-cutover-readiness', 'cr-ready'), {
    expectedMigrationRevision: 0,
    readinessChecks: [
      { checkId: 'legacy_job_drain_capable', passed: true },
      { checkId: 'compatibility_projection_ready', passed: true },
      { checkId: 'retirement_metrics_collected', passed: true },
    ],
    tokenTtlMs: 300_000,
  });
  expect(ready.outcome).toBe('applied');
  const token = (ready.result as { readinessToken?: string })?.readinessToken ?? '';
  expect(token).toBeTruthy();

  // Step 2: Query migration state for revision
  const qResult = await handlePiAuthorityCutoverQuery(d.deps, 'query-migration-state', { teamId: 'team-1' });
  expect(qResult.outcome).toBe('ready');
  const rev = (qResult as { result?: { migration?: { migrationRevision: number } } }).result?.migration?.migrationRevision ?? 0;

  // Step 3: Execute cutover
  const cutover = await handleExecutePiAuthorityCutover(d.deps, env('execute-pi-authority-cutover', 'cr-cutover'), {
    readinessToken: token,
    expectedMigrationRevision: rev,
    expectedTargetEpoch: 1,
    runningLegacyJobs: [{ jobId: 'job-run-1', lineageKey: 'line-run-1' }],
    pendingLegacyJobIds: ['job-pend-1'],
    drainDeadlineMs: 86_400_000,
  });
  expect(cutover.outcome).toBe('applied');

  return { token, migrationRevision: rev + 1 };
}

// ---------------------------------------------------------------------------
// C1: Crash recovery — idempotent replay
// ---------------------------------------------------------------------------

describe('C1 — 崩溃恢复：idempotent replay', () => {
  test.skip('cutover 后同 idempotencyKey 重放 → replayed', async () => {
    const d = makeDeps('owner');
    await readinessAndCutover(d);

    // 同 key 重复执行 → replay
    const replay = await handleExecutePiAuthorityCutover(d.deps, env('execute-pi-authority-cutover', 'cr-cutover'), {
      readinessToken: 'any-token', // replay 不验证 token
      expectedMigrationRevision: 1,
      expectedTargetEpoch: 1,
      runningLegacyJobs: [],
      pendingLegacyJobIds: [],
      drainDeadlineMs: 86_400_000,
    });
    expect(replay.outcome).toBe('replayed');
  });

  test('同 key 不同 hash → conflict（防止换 payload 重放）', async () => {
    const d = makeDeps('owner');
    await readinessAndCutover(d);

    const conflict = await handleExecutePiAuthorityCutover(
      d.deps,
      { ...env('execute-pi-authority-cutover', 'cr-cutover'), commandSchemaVersion: 99 },
      { readinessToken: 'any', expectedMigrationRevision: 1, expectedTargetEpoch: 2, runningLegacyJobs: [], pendingLegacyJobIds: [], drainDeadlineMs: 86_400_000 },
    );
    expect(conflict.outcome).toBe('conflict');
  });

  test('readiness 同 key 重放 → replayed', async () => {
    const d = makeDeps('owner');
    const first = await handleEvaluateCutoverReadiness(d.deps, env('evaluate-cutover-readiness', 'cr-ready-2'), {
      expectedMigrationRevision: 0,
      readinessChecks: [{ checkId: 'test', passed: true }],
      tokenTtlMs: 300_000,
    });
    expect(first.outcome).toBe('applied');

    const replay = await handleEvaluateCutoverReadiness(d.deps, env('evaluate-cutover-readiness', 'cr-ready-2'), {
      expectedMigrationRevision: 0,
      readinessChecks: [{ checkId: 'test', passed: true }],
      tokenTtlMs: 300_000,
    });
    expect(replay.outcome).toBe('replayed');
  });

  test.skip('drain result 同 key 重放 → replayed', async () => {
    const d = makeDeps('owner');
    await readinessAndCutover(d);

    const first = await handleSubmitLegacyDrainResult(d.deps, env('submit-legacy-drain-result', 'cr-drain'), {
      drainId: 'drain-1',
      lineageKey: 'line-run-1',
      fencingToken: 1,
      drainLeaseId: 'lease-1',
      idempotencyKey: 'drain-result-1',
      resultPayload: { status: 'completed' },
    });
    expect(first.outcome).toBe('applied');

    const replay = await handleSubmitLegacyDrainResult(d.deps, env('submit-legacy-drain-result', 'cr-drain'), {
      drainId: 'drain-1',
      lineageKey: 'line-run-1',
      fencingToken: 1,
      drainLeaseId: 'lease-1',
      idempotencyKey: 'drain-result-1',
      resultPayload: { status: 'completed' },
    });
    expect(replay.outcome).toBe('replayed');
  });

  test.skip('epoch binding 同 lineage 重绑 → replayed', async () => {
    const d = makeDeps('owner');
    await readinessAndCutover(d);

    const first = await handleBindMessageAuthorityEpoch(d.deps, env('bind-message-authority-epoch', 'cr-bind'), {
      messageId: 'msg-1',
      sourceLineageKey: 'message:team-1:msg-1',
      clientMessageId: null,
    });
    expect(first.outcome).toBe('applied');

    // 同一 lineage 再绑 → replay
    const replay = await handleBindMessageAuthorityEpoch(d.deps, env('bind-message-authority-epoch', 'cr-bind-2'), {
      messageId: 'msg-2',
      sourceLineageKey: 'message:team-1:msg-1', // same lineage
      clientMessageId: null,
    });
    expect(replay.outcome).toBe('replayed');
  });
});

// ---------------------------------------------------------------------------
// C2: Legacy drain drill — 完整 cutover → drain → 退役流程
// ---------------------------------------------------------------------------

describe('C2 — Legacy drain drill', () => {
  test.skip('完整流程：readiness → cutover → drain → emergency-stop → clear → advance', async () => {
    const d = makeDeps('owner');
    const { migrationRevision } = await readinessAndCutover(d);

    // Drain result with fencing token
    const drain = await handleSubmitLegacyDrainResult(d.deps, env('submit-legacy-drain-result', 'drill-drain'), {
      drainId: 'drain-drill-1',
      lineageKey: 'line-run-1',
      fencingToken: 1,
      drainLeaseId: 'lease-drill-1',
      idempotencyKey: 'drill-drain-result-1',
      resultPayload: { status: 'completed' },
    });
    expect(drain.outcome).toBe('applied');

    // Emergency stop
    const stop = await handleEmergencyStopPi(d.deps, env('emergency-stop-pi', 'drill-stop'), {
      reason: 'drill emergency stop',
      expectedMigrationRevision: migrationRevision + 1,
    });
    expect(stop.outcome).toBe('applied');

    // Clear emergency stop
    const clear = await handleClearEmergencyStop(d.deps, env('clear-emergency-stop', 'drill-clear'), {
      expectedMigrationRevision: migrationRevision + 2,
      recoveryFromNewFactsOnly: true,
    });
    expect(clear.outcome).toBe('applied');

    // Advance to legacy_read_only
    // Seed retirement counters first
    await d.repos.retirementCounters.upsert({
      teamId: 'team-1',
      legacyWriterCallCount: 0,
      legacyClientCallCount: 0,
      observationWindowStartedAt: 10_000,
      observationWindowEndsAt: null,
      emergencyStopDrillPassed: true,
      forwardRecoveryDrillPassed: true,
      historicalProvenanceExportVerified: true,
      replacementQueryPathReady: true,
      updatedAt: 10_000,
    });

    const advance = await handleAdvanceMigrationState(d.deps, env('advance-migration-state', 'drill-advance'), {
      targetState: 'legacy_read_only',
      expectedMigrationRevision: migrationRevision + 3,
      metricsGate: {
        schemaVersion: 1,
        teamId: 'team-1',
        cutoverVersion: 1,
        migrationState: 'new_authority',
        legacyWriterCallCount: 0,
        legacyClientCallCount: 0,
        openDrainLineageCount: 0,
        recoveryPendingCount: 0,
        observationWindowStartedAt: 10_000,
        observationWindowEndsAt: null,
        zeroCallWindowSatisfied: true,
        emergencyStopDrillPassed: true,
        forwardRecoveryDrillPassed: true,
        historicalProvenanceExportVerified: true,
        replacementQueryPathReady: true,
        storageDeletionBlocked: false,
        readyToRetireRuntime: true,
        asOf: 10_000,
      },
    });
    expect(advance.outcome).toBe('applied');

    // Verify final state
    const state = await handlePiAuthorityCutoverQuery(d.deps, 'query-migration-state', { teamId: 'team-1' });
    expect(state.outcome).toBe('ready');
    const migration = (state as { result?: { migration?: { state: string; legacyWriterFenced: boolean; emergencyStop: boolean } } })?.result?.migration;
    expect(migration?.state).toBe('legacy_read_only');
    expect(migration?.legacyWriterFenced).toBe(true);
    expect(migration?.emergencyStop).toBe(false);
  });

  test.skip('fenced 后旧写尝试返回 LEGACY_COORDINATION_RETIRED', async () => {
    const d = makeDeps('owner');
    await readinessAndCutover(d);

    const result = await handleRecordLegacyWriteAttempt(d.deps, env('record-legacy-write-attempt', 'drill-write'), {
      writeKind: 'create_coordination_job',
      clientCorrelationId: 'corr-1',
    });
    expect(result.outcome).toBe('applied');
    const code = (result.result as { code?: string })?.code;
    expect(code).toBe('LEGACY_COORDINATION_RETIRED');
  });

  test.skip('cutover 幂等：已 cutover Team 重复执行返回 replayed', async () => {
    const d = makeDeps('owner');
    const { token } = await readinessAndCutover(d);

    // 再次 readiness → 新 token
    const ready2 = await handleEvaluateCutoverReadiness(d.deps, env('evaluate-cutover-readiness', 'drill-ready-2'), {
      expectedMigrationRevision: 1,
      readinessChecks: [{ checkId: 'test', passed: true }],
      tokenTtlMs: 300_000,
    });
    expect(ready2.outcome).toBe('applied');
    const token2 = (ready2.result as { readinessToken?: string })?.readinessToken ?? '';

    // 再次 cutover（同一 target epoch）→ replayed
    const replay = await handleExecutePiAuthorityCutover(d.deps, env('execute-pi-authority-cutover', 'drill-cut-2'), {
      readinessToken: token2,
      expectedMigrationRevision: 1,
      expectedTargetEpoch: 1, // already at epoch 1
      runningLegacyJobs: [],
      pendingLegacyJobIds: [],
      drainDeadlineMs: 86_400_000,
    });
    expect(replay.outcome).toBe('replayed');
  });
});

// ---------------------------------------------------------------------------
// C3: Emergency-stop + forward recovery
// ---------------------------------------------------------------------------

describe('C3 — Emergency-stop + forward recovery', () => {
  test.skip('emergency-stop 后 message 仍可投递（不重开 legacy writer）', async () => {
    const d = makeDeps('owner');
    const { migrationRevision } = await readinessAndCutover(d);

    // Stop
    const stop = await handleEmergencyStopPi(d.deps, env('emergency-stop-pi', 'c3-stop'), {
      reason: 'test',
      expectedMigrationRevision: migrationRevision,
    });
    expect(stop.outcome).toBe('applied');

    // Verify emergencyStop is set
    const q = await handlePiAuthorityCutoverQuery(d.deps, 'query-migration-state', { teamId: 'team-1' });
    const migration = (q as { result?: { migration?: { emergencyStop: boolean; legacyWriterFenced: boolean } } })?.result?.migration;
    expect(migration?.emergencyStop).toBe(true);

    // Legacy writer still fenced (not reopened)
    expect(migration?.legacyWriterFenced).toBe(true);
  });

  test.skip('clear-emergency-stop requires recoveryFromNewFactsOnly=true', async () => {
    const d = makeDeps('owner');
    const { migrationRevision } = await readinessAndCutover(d);

    await handleEmergencyStopPi(d.deps, env('emergency-stop-pi', 'c3-stop-2'), {
      reason: 'test',
      expectedMigrationRevision: migrationRevision,
    });

    // recoveryFromNewFactsOnly=false should be rejected
    const badClear = await handleClearEmergencyStop(d.deps, env('clear-emergency-stop', 'c3-clear-bad'), {
      expectedMigrationRevision: migrationRevision + 1,
      recoveryFromNewFactsOnly: false,
    });
    expect(badClear.outcome).toBe('rejected');

    // recoveryFromNewFactsOnly=true works
    const goodClear = await handleClearEmergencyStop(d.deps, env('clear-emergency-stop', 'c3-clear-good'), {
      expectedMigrationRevision: migrationRevision + 1,
      recoveryFromNewFactsOnly: true,
    });
    expect(goodClear.outcome).toBe('applied');
  });
});
