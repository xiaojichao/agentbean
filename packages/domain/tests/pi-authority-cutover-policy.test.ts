import { describe, expect, test } from 'vitest';
import type { CompatibilityRetirementMetricsV1, TeamPiAuthorityMigrationV1 } from '@agentbean/contracts';
import {
  authorizeTeamCutoverOperator,
  buildRetirementMetrics,
  disposeLegacyJobAtCutover,
  emergencyStopEffects,
  evaluateCommandPathAvailability,
  evaluateCutoverReadiness,
  evaluateCutoverTokenAcceptance,
  evaluateLegacyDrainResult,
  evaluateMessageEpochBinding,
  evaluateMigrationTransition,
  evaluateRetirementGate,
  initialTeamMigration,
  negotiateDaemonPiCapabilities,
} from '../src/pi-authority-cutover-policy.js';

function migration(overrides: Partial<TeamPiAuthorityMigrationV1> = {}): TeamPiAuthorityMigrationV1 {
  return {
    ...initialTeamMigration({ teamId: 'team-1', now: 1000 }),
    ...overrides,
  };
}

describe('migration state machine', () => {
  test('allows forward only', () => {
    expect(evaluateMigrationTransition({ from: 'legacy', to: 'new_authority' }).kind).toBe('allow');
    expect(evaluateMigrationTransition({ from: 'new_authority', to: 'legacy' }).kind).toBe('reject');
    expect(evaluateMigrationTransition({ from: 'legacy_read_only', to: 'new_authority' }).kind).toBe('reject');
  });
});

describe('authorization + readiness', () => {
  test('only owner/admin', () => {
    expect(authorizeTeamCutoverOperator('owner').allowed).toBe(true);
    expect(authorizeTeamCutoverOperator('admin').allowed).toBe(true);
    expect(authorizeTeamCutoverOperator('member').allowed).toBe(false);
  });

  test('readiness requires all checks', () => {
    const ready = evaluateCutoverReadiness([
      { checkId: 'a', passed: true },
      { checkId: 'b', passed: true },
    ]);
    expect(ready.kind).toBe('ready');
    const notReady = evaluateCutoverReadiness([
      { checkId: 'a', passed: true },
      { checkId: 'b', passed: false },
    ]);
    expect(notReady.kind).toBe('not_ready');
  });
});

describe('cutover token acceptance', () => {
  test('accepts valid monotonic advance', () => {
    const d = evaluateCutoverTokenAcceptance({
      migration: migration({ migrationRevision: 2, authorityEpoch: 0, state: 'cutover_pending' }),
      role: 'owner',
      tokenExpired: false,
      tokenConsumed: false,
      tokenTeamId: 'team-1',
      tokenTargetEpoch: 1,
      tokenMigrationRevision: 2,
      expectedMigrationRevision: 2,
      expectedTargetEpoch: 1,
      tokenHashMatches: true,
    });
    expect(d).toEqual({
      kind: 'accept',
      nextEpoch: 1,
      nextRevision: 3,
      nextState: 'new_authority',
    });
  });

  test('rejects revision conflict and already cut over', () => {
    expect(evaluateCutoverTokenAcceptance({
      migration: migration({ migrationRevision: 3 }),
      role: 'admin',
      tokenExpired: false,
      tokenConsumed: false,
      tokenTeamId: 'team-1',
      tokenTargetEpoch: 1,
      tokenMigrationRevision: 2,
      expectedMigrationRevision: 2,
      expectedTargetEpoch: 1,
      tokenHashMatches: true,
    }).kind).toBe('reject');

    expect(evaluateCutoverTokenAcceptance({
      migration: migration({
        migrationRevision: 2, authorityEpoch: 1, state: 'new_authority', legacyWriterFenced: true,
      }),
      role: 'owner',
      tokenExpired: false,
      tokenConsumed: false,
      tokenTeamId: 'team-1',
      tokenTargetEpoch: 2,
      tokenMigrationRevision: 2,
      expectedMigrationRevision: 2,
      expectedTargetEpoch: 2,
      tokenHashMatches: true,
    }).kind).toBe('reject');
  });
});

describe('legacy job disposition', () => {
  test('cancel pending, drain running', () => {
    expect(disposeLegacyJobAtCutover({
      status: 'pending', now: 10, drainDeadlineMs: 100,
    }).kind).toBe('cancel');
    expect(disposeLegacyJobAtCutover({
      status: 'retry_wait', now: 10, drainDeadlineMs: 100,
    }).kind).toBe('cancel');
    const drain = disposeLegacyJobAtCutover({
      status: 'running', now: 10, drainDeadlineMs: 100,
    });
    expect(drain).toEqual({ kind: 'drain', deadlineAt: 110 });
  });
});

describe('legacy drain bridge', () => {
  test('accept / replay / expire / fencing', () => {
    expect(evaluateLegacyDrainResult({
      drainState: 'draining',
      now: 50,
      deadlineAt: 100,
      expectedFencingToken: 3,
      providedFencingToken: 3,
      expectedLeaseId: 'L',
      providedLeaseId: 'L',
      expectedLineageKey: 'line',
      providedLineageKey: 'line',
      existingResultMessageId: null,
    }).kind).toBe('accept');

    expect(evaluateLegacyDrainResult({
      drainState: 'completed',
      now: 50,
      deadlineAt: 100,
      expectedFencingToken: 3,
      providedFencingToken: 3,
      expectedLeaseId: 'L',
      providedLeaseId: 'L',
      expectedLineageKey: 'line',
      providedLineageKey: 'line',
      existingResultMessageId: 'msg-1',
    })).toEqual({ kind: 'replay', existingMessageId: 'msg-1' });

    expect(evaluateLegacyDrainResult({
      drainState: 'draining',
      now: 200,
      deadlineAt: 100,
      expectedFencingToken: 3,
      providedFencingToken: 3,
      expectedLeaseId: 'L',
      providedLeaseId: 'L',
      expectedLineageKey: 'line',
      providedLineageKey: 'line',
      existingResultMessageId: null,
    }).kind).toBe('expire');

    expect(evaluateLegacyDrainResult({
      drainState: 'draining',
      now: 50,
      deadlineAt: 100,
      expectedFencingToken: 3,
      providedFencingToken: 9,
      expectedLeaseId: 'L',
      providedLeaseId: 'L',
      expectedLineageKey: 'line',
      providedLineageKey: 'line',
      existingResultMessageId: null,
    }).kind).toBe('reject');
  });
});

describe('emergency-stop + command paths', () => {
  test('never re-enables legacy writer; message still available', () => {
    const effects = emergencyStopEffects();
    expect(effects.legacyWriterReenabled).toBe(false);
    expect(effects.messageDeliveryAvailable).toBe(true);
    expect(effects.promotionCommandsPaused).toBe(true);

    const m = migration({
      state: 'new_authority', legacyWriterFenced: true, emergencyStop: true,
    });
    expect(evaluateCommandPathAvailability({ migration: m, path: 'legacy_write' }).allowed).toBe(false);
    expect(evaluateCommandPathAvailability({ migration: m, path: 'message_delivery' }).allowed).toBe(true);
    expect(evaluateCommandPathAvailability({ migration: m, path: 'promotion' }).allowed).toBe(false);
    expect(evaluateCommandPathAvailability({ migration: m, path: 'pi_orchestration' }).allowed).toBe(false);
  });

  test('legacy write retired after cutover', () => {
    const m = migration({ state: 'new_authority', legacyWriterFenced: true });
    const d = evaluateCommandPathAvailability({ migration: m, path: 'legacy_write' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('LEGACY_COORDINATION_RETIRED');
  });
});

describe('message epoch binding linearization', () => {
  test('binds current epoch; replays same lineage', () => {
    const current = migration({ authorityEpoch: 1, migrationRevision: 5 });
    const first = evaluateMessageEpochBinding({
      current,
      sourceLineageKey: 'line-a',
    });
    expect(first).toEqual({ kind: 'bind', authorityEpoch: 1, migrationRevision: 5 });

    const replay = evaluateMessageEpochBinding({
      current: migration({ authorityEpoch: 2, migrationRevision: 9 }),
      existingBinding: { authorityEpoch: 1, migrationRevision: 5, sourceLineageKey: 'line-a' },
      sourceLineageKey: 'line-a',
    });
    expect(replay).toEqual({ kind: 'replay', authorityEpoch: 1, migrationRevision: 5 });
  });

  test('rejects concurrent revision mismatch', () => {
    const d = evaluateMessageEpochBinding({
      current: migration({ migrationRevision: 3 }),
      sourceLineageKey: 'x',
      expectedMigrationRevision: 2,
    });
    expect(d.kind).toBe('reject');
  });
});

describe('daemon capability negotiation', () => {
  test('old daemon after cutover cannot create jobs or obtain PI authority', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 1,
      advertisedCapabilities: ['message.send', 'legacy.drain'],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
      minPiExecutionProtocolVersion: 2,
    });
    expect(n.mayCreateCoordinationJob).toBe(false);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.mayDrainLegacyWork).toBe(true);
    expect(n.maySendMessages).toBe(true);
    expect(n.mayClaimPiExecution).toBe(false);
    expect(n.grantedTier).toBe('message_and_drain_only');
  });

  test('new daemon can claim execution but never owns orchestration authority', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 2,
      advertisedCapabilities: ['message.send', 'pi.orchestration.claim', 'legacy.drain'],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
    });
    expect(n.mayClaimPiExecution).toBe(true);
    expect(n.mayObtainPiOrchestrationAuthority).toBe(false);
    expect(n.grantedTier).toBe('pi_execution_eligible');
  });

  test('upgrade failure does not unfence legacy', () => {
    const n = negotiateDaemonPiCapabilities({
      daemonProtocolVersion: 0,
      advertisedCapabilities: [],
      teamMigrationState: 'new_authority',
      legacyWriterFenced: true,
    });
    expect(n.legacyWriterFenced).toBe(true);
    expect(n.mayCreateCoordinationJob).toBe(false);
  });
});

describe('retirement gate', () => {
  test('blocks retire when drains open or storage would delete', () => {
    const base: CompatibilityRetirementMetricsV1 = {
      schemaVersion: 1,
      teamId: 'team-1',
      cutoverVersion: 1,
      migrationState: 'legacy_read_only',
      legacyWriterCallCount: 0,
      legacyClientCallCount: 0,
      openDrainLineageCount: 1,
      recoveryPendingCount: 0,
      observationWindowStartedAt: 1,
      observationWindowEndsAt: 2,
      zeroCallWindowSatisfied: true,
      emergencyStopDrillPassed: true,
      forwardRecoveryDrillPassed: true,
      historicalProvenanceExportVerified: true,
      replacementQueryPathReady: true,
      storageDeletionBlocked: true,
      readyToRetireRuntime: false,
      asOf: 3,
    };
    expect(evaluateRetirementGate(base, 'legacy_read_only').kind).toBe('block');
    expect(evaluateRetirementGate({
      ...base,
      openDrainLineageCount: 0,
      readyToRetireRuntime: true,
      storageDeletionBlocked: false,
    }, 'retired').kind).toBe('block');
    expect(evaluateRetirementGate({
      ...base,
      openDrainLineageCount: 0,
      readyToRetireRuntime: true,
      storageDeletionBlocked: true,
    }, 'retired').kind).toBe('allow_runtime_retire');
  });

  test('buildRetirementMetrics synthesizes zero window', () => {
    const m = buildRetirementMetrics({
      teamId: 'team-1',
      migration: migration({
        state: 'legacy_read_only', cutoverVersion: 1, authorityEpoch: 1, legacyWriterFenced: true,
      }),
      legacyWriterCallCount: 0,
      legacyClientCallCount: 0,
      openDrainLineageCount: 0,
      recoveryPendingCount: 0,
      observationWindowStartedAt: 100,
      observationWindowEndsAt: 200,
      now: 250,
      emergencyStopDrillPassed: true,
      forwardRecoveryDrillPassed: true,
      historicalProvenanceExportVerified: true,
      replacementQueryPathReady: true,
    });
    expect(m.zeroCallWindowSatisfied).toBe(true);
    expect(m.readyToRetireRuntime).toBe(true);
    expect(m.storageDeletionBlocked).toBe(true);
  });
});
