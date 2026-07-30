import { describe, expect, test } from 'vitest';
import {
  LEGACY_COORDINATION_RETIRED_CODE,
  PI_AUTHORITY_CUTOVER_COMMAND_NAMES,
  PI_AUTHORITY_MIGRATION_STATES,
  buildLegacyCoordinationRetiredError,
  canonicalizePiAuthorityCutoverCommand,
  parsePiAuthorityCutoverCommandEnvelopeV1,
  parsePiAuthorityCutoverCommandInputV1,
  parsePiAuthorityCutoverCommandResponseV1,
  parsePiAuthorityCutoverQueryInputV1,
} from '../src/pi-authority-cutover.js';

const INVALID = /PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID/;

describe('PI authority cutover command registry', () => {
  test('frozen command set covers cutover / drain / emergency-stop', () => {
    expect(PI_AUTHORITY_CUTOVER_COMMAND_NAMES).toContain('evaluate-cutover-readiness');
    expect(PI_AUTHORITY_CUTOVER_COMMAND_NAMES).toContain('execute-pi-authority-cutover');
    expect(PI_AUTHORITY_CUTOVER_COMMAND_NAMES).toContain('submit-legacy-drain-result');
    expect(PI_AUTHORITY_CUTOVER_COMMAND_NAMES).toContain('emergency-stop-pi');
    expect(PI_AUTHORITY_CUTOVER_COMMAND_NAMES).toContain('record-legacy-write-attempt');
    expect(PI_AUTHORITY_MIGRATION_STATES).toEqual([
      'legacy', 'shadow', 'cutover_pending', 'new_authority', 'legacy_read_only', 'retired',
    ]);
  });
});

describe('parsePiAuthorityCutoverCommandEnvelopeV1', () => {
  test('accepts valid', () => {
    const env = parsePiAuthorityCutoverCommandEnvelopeV1({
      schemaVersion: 1,
      commandName: 'emergency-stop-pi',
      commandSchemaVersion: 1,
      idempotencyKey: 'k1',
    });
    expect(env.commandName).toBe('emergency-stop-pi');
  });
  test('rejects unknown command', () => {
    expect(() => parsePiAuthorityCutoverCommandEnvelopeV1({
      schemaVersion: 1,
      commandName: 'rollback-to-legacy',
      commandSchemaVersion: 1,
      idempotencyKey: 'k1',
    })).toThrow(INVALID);
  });
});

describe('parsePiAuthorityCutoverCommandInputV1', () => {
  test('evaluate-cutover-readiness', () => {
    const input = parsePiAuthorityCutoverCommandInputV1('evaluate-cutover-readiness', {
      expectedMigrationRevision: 0,
      readinessChecks: [{ checkId: 'pi-ready', passed: true }],
      tokenTtlMs: 60_000,
    });
    expect(input.readinessChecks).toHaveLength(1);
  });

  test('execute-pi-authority-cutover', () => {
    const input = parsePiAuthorityCutoverCommandInputV1('execute-pi-authority-cutover', {
      readinessToken: 'tok-plain',
      expectedMigrationRevision: 1,
      expectedTargetEpoch: 1,
      runningLegacyJobs: [{ jobId: 'job-1', lineageKey: 'line-1' }],
      pendingLegacyJobIds: ['job-2'],
      drainDeadlineMs: 3_600_000,
    });
    expect(input.runningLegacyJobs[0]?.jobId).toBe('job-1');
  });

  test('clear-emergency-stop requires recoveryFromNewFactsOnly=true', () => {
    expect(() => parsePiAuthorityCutoverCommandInputV1('clear-emergency-stop', {
      expectedMigrationRevision: 2,
      recoveryFromNewFactsOnly: false,
    })).toThrow(INVALID);
  });

  test('submit-legacy-drain-result', () => {
    const input = parsePiAuthorityCutoverCommandInputV1('submit-legacy-drain-result', {
      drainId: 'd1',
      lineageKey: 'line-1',
      fencingToken: 1,
      drainLeaseId: 'lease-1',
      idempotencyKey: 'drain-idem-1',
      resultPayload: { text: 'done' },
    });
    expect(input.fencingToken).toBe(1);
  });
});

describe('canonicalizePiAuthorityCutoverCommand', () => {
  test('stable', () => {
    const a = canonicalizePiAuthorityCutoverCommand('emergency-stop-pi', 1, {
      reason: 'ops', expectedMigrationRevision: 1,
    });
    const b = canonicalizePiAuthorityCutoverCommand('emergency-stop-pi', 1, {
      expectedMigrationRevision: 1, reason: 'ops',
    });
    expect(a).toBe(b);
  });
});

describe('LEGACY_COORDINATION_RETIRED', () => {
  test('buildLegacyCoordinationRetiredError', () => {
    const err = buildLegacyCoordinationRetiredError({
      cutoverVersion: 1,
      authorityEpoch: 1,
      migrationRevision: 2,
      correlationId: 'corr-1',
    });
    expect(err.code).toBe(LEGACY_COORDINATION_RETIRED_CODE);
    expect(err.replacementEntry).toContain('promotion-gate');
  });
});

describe('parsePiAuthorityCutoverQueryInputV1', () => {
  test('query-migration-state', () => {
    const q = parsePiAuthorityCutoverQueryInputV1('query-migration-state', { teamId: 't1' });
    expect(q.teamId).toBe('t1');
  });
});

describe('parsePiAuthorityCutoverCommandResponseV1', () => {
  test('accepts applied', () => {
    const r = parsePiAuthorityCutoverCommandResponseV1({
      schemaVersion: 1,
      commandName: 'record-legacy-write-attempt',
      outcome: 'applied',
      retryDirective: 'user_action',
      stableCode: LEGACY_COORDINATION_RETIRED_CODE,
    });
    expect(r.stableCode).toBe(LEGACY_COORDINATION_RETIRED_CODE);
  });
});
