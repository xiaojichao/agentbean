import { describe, expect, test } from 'vitest';
import {
  TASK_FAILURE_CLASSES,
  TASK_REMEDIATION_COMMAND_NAMES,
  canonicalizeTaskRemediationCommand,
  parseTaskFailureReportV1,
  parseTaskRemediationCommandEnvelopeV1,
  parseTaskRemediationInputV1,
  parseTaskRemediationCommandResponseV1,
  type TaskFailureReportV1,
  type TaskRemediationCommandEnvelopeV1,
} from '../src/task-failure-remediation.js';

const INVALID = /TASK_REMEDIATION_PAYLOAD_INVALID/;

const report: TaskFailureReportV1 = {
  schemaVersion: 1,
  taskId: 'task-1',
  taskRevision: 2,
  taskAttempt: 1,
  claimLeaseId: 'lease-1',
  errorCode: 'ENV_TRANSIENT',
  observableFacts: ['a'],
  reportedBy: 'daemon',
  reportedAt: 1000,
};

const envelope: TaskRemediationCommandEnvelopeV1 = {
  schemaVersion: 1,
  commandName: 'classify-failure',
  commandSchemaVersion: 1,
  idempotencyKey: 'idem-1',
};

describe('TASK_REMEDIATION_COMMAND_NAMES', () => {
  test('frozen command set includes remediation family', () => {
    expect(TASK_REMEDIATION_COMMAND_NAMES).toContain('classify-failure');
    expect(TASK_REMEDIATION_COMMAND_NAMES).toContain('request-conditional-reassignment');
    expect(TASK_REMEDIATION_COMMAND_NAMES).toContain('retry-attempt');
    expect(TASK_REMEDIATION_COMMAND_NAMES).toContain('acknowledge-action-required');
    expect(TASK_FAILURE_CLASSES).toContain('unknown');
    expect(TASK_FAILURE_CLASSES).toContain('no_progress_timeout');
  });
});

describe('parseTaskFailureReportV1', () => {
  test('accepts valid', () => {
    expect(parseTaskFailureReportV1(report).errorCode).toBe('ENV_TRANSIENT');
  });
  test('rejects empty errorCode', () => {
    expect(() => parseTaskFailureReportV1({ ...report, errorCode: '' })).toThrow(INVALID);
  });
  test('rejects bad reportedBy', () => {
    expect(() => parseTaskFailureReportV1({ ...report, reportedBy: 'pi' })).toThrow(INVALID);
  });
});

describe('parseTaskRemediationCommandEnvelopeV1', () => {
  test('accepts valid', () => {
    expect(parseTaskRemediationCommandEnvelopeV1(envelope).commandName).toBe('classify-failure');
  });
  test('rejects unknown command', () => {
    expect(() => parseTaskRemediationCommandEnvelopeV1({
      ...envelope, commandName: 'bogus',
    })).toThrow(INVALID);
  });
});

describe('parseTaskRemediationInputV1', () => {
  test('classify-failure', () => {
    const input = parseTaskRemediationInputV1('classify-failure', {
      taskId: 'task-1',
      taskRevision: 2,
      taskAttempt: 1,
      claimLeaseId: 'lease-1',
      report,
    });
    expect(input.report.errorCode).toBe('ENV_TRANSIENT');
  });

  test('acknowledge-action-required only allows non-resolving signals', () => {
    const input = parseTaskRemediationInputV1('acknowledge-action-required', {
      actionRequiredId: 'ar-1',
      signal: 'dismiss',
    });
    expect(input.signal).toBe('dismiss');
    expect(() => parseTaskRemediationInputV1('acknowledge-action-required', {
      actionRequiredId: 'ar-1',
      signal: 'retry-attempt',
    })).toThrow(INVALID);
  });

  test('retry-attempt requires escalation binding', () => {
    expect(() => parseTaskRemediationInputV1('retry-attempt', {
      taskId: 'task-1',
    })).toThrow(INVALID);
    const input = parseTaskRemediationInputV1('retry-attempt', {
      taskId: 'task-1',
      expectedTaskRevision: 2,
      actionRequiredId: 'ar-1',
      confirmationToken: 'tok',
      expectedEscalationRevision: 1,
    });
    expect(input.confirmationToken).toBe('tok');
  });
});

describe('canonicalizeTaskRemediationCommand', () => {
  test('stable hash input', () => {
    const a = canonicalizeTaskRemediationCommand('classify-failure', 1, {
      taskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'l', report,
    });
    const b = canonicalizeTaskRemediationCommand('classify-failure', 1, {
      taskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'l', report,
    });
    expect(a).toBe(b);
  });
});

describe('parseTaskRemediationCommandResponseV1', () => {
  test('accepts applied response', () => {
    const r = parseTaskRemediationCommandResponseV1({
      schemaVersion: 1,
      commandName: 'acknowledge-action-required',
      outcome: 'applied',
      retryDirective: 'none',
      stableCode: 'STILL_OPEN',
    });
    expect(r.outcome).toBe('applied');
  });
});
