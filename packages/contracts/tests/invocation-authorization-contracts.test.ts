import { describe, expect, test } from 'vitest';
import {
  INVOCATION_AUTHORIZATION_COMMAND_NAMES,
  canonicalizeInvocationAuthorizationCommand,
  parseEffectIdentityV1,
  parseInvocationAuthorizationCommandEnvelopeV1,
  parseInvocationAuthorizationCommandReceiptV1,
  parseInvocationAuthorizationCommandResponseV1,
  parseInvocationAuthorizationInputV1,
  parseInvocationOperationScopeV1,
  type EffectIdentityV1,
  type InvocationAuthorizationCommandEnvelopeV1,
} from '../src/invocation-authorization.js';

// #927 合约测试：exact-key validators、canonical hash、schema version gate。

const INVALID = /INVOCATION_AUTHORIZATION_PAYLOAD_INVALID/;

const effect: EffectIdentityV1 = {
  schemaVersion: 1,
  effectKind: 'api-call',
  scope: { managementRunId: 'run-1', invocationId: 'inv-1' },
  dedupKey: 'create-report',
  contentHash: 'sha256:abc123',
};

const operationScope = {
  operationKind: 'agents.invoke',
  inputHash: 'sha256:input',
  plannedEffectIdentities: [effect],
  riskLevel: 'medium' as const,
};

const taskContext = { taskId: 'task-1', taskRevision: 3, taskAttempt: 1, claimLeaseId: 'lease-1' };

const envelope: InvocationAuthorizationCommandEnvelopeV1 = {
  schemaVersion: 1, commandName: 'authorize-invocation', commandSchemaVersion: 1, idempotencyKey: 'idem-1',
};

describe('INVOCATION_AUTHORIZATION_COMMAND_NAMES', () => {
  test('frozen length 3', () => {
    expect(INVOCATION_AUTHORIZATION_COMMAND_NAMES).toHaveLength(3);
    expect(INVOCATION_AUTHORIZATION_COMMAND_NAMES).toContain('authorize-invocation');
    expect(INVOCATION_AUTHORIZATION_COMMAND_NAMES).toContain('approve-action');
    expect(INVOCATION_AUTHORIZATION_COMMAND_NAMES).toContain('report-effect-outcome');
  });
});

describe('parseEffectIdentityV1', () => {
  test('accepts valid', () => {
    expect(parseEffectIdentityV1(effect).effectKind).toBe('api-call');
  });
  test('returns defensive copy', () => {
    expect(parseEffectIdentityV1(effect)).not.toBe(effect);
  });
  test('rejects empty effectKind', () => {
    expect(() => parseEffectIdentityV1({ ...effect, effectKind: '' })).toThrow(INVALID);
  });
  test('rejects empty dedupKey', () => {
    expect(() => parseEffectIdentityV1({ ...effect, dedupKey: '' })).toThrow(INVALID);
  });
  test('rejects empty contentHash', () => {
    expect(() => parseEffectIdentityV1({ ...effect, contentHash: '' })).toThrow(INVALID);
  });
  test('rejects missing scope field', () => {
    expect(() => parseEffectIdentityV1({ ...effect, scope: { invocationId: 'inv-1' } })).toThrow(INVALID);
  });
  test('rejects wrong schemaVersion', () => {
    expect(() => parseEffectIdentityV1({ ...effect, schemaVersion: 2 })).toThrow(INVALID);
  });
  test('rejects non-object', () => {
    expect(() => parseEffectIdentityV1('nope')).toThrow(INVALID);
    expect(() => parseEffectIdentityV1(null)).toThrow(INVALID);
  });
});

describe('parseInvocationOperationScopeV1', () => {
  test('accepts valid', () => {
    expect(parseInvocationOperationScopeV1(operationScope).operationKind).toBe('agents.invoke');
  });
  test('rejects empty operationKind', () => {
    expect(() => parseInvocationOperationScopeV1({ ...operationScope, operationKind: '' })).toThrow(INVALID);
  });
  test('rejects invalid riskLevel', () => {
    expect(() => parseInvocationOperationScopeV1({ ...operationScope, riskLevel: 'critical' })).toThrow(INVALID);
  });
  test('rejects non-array plannedEffectIdentities', () => {
    expect(() => parseInvocationOperationScopeV1({ ...operationScope, plannedEffectIdentities: 'nope' })).toThrow(INVALID);
  });
  test('accepts optional deadlineAt', () => {
    expect(parseInvocationOperationScopeV1({ ...operationScope, deadlineAt: 2000 }).deadlineAt).toBe(2000);
  });
});

describe('parseInvocationAuthorizationCommandEnvelopeV1', () => {
  test('accepts valid', () => {
    expect(parseInvocationAuthorizationCommandEnvelopeV1(envelope).commandName).toBe('authorize-invocation');
  });
  test('rejects unknown commandName', () => {
    expect(() => parseInvocationAuthorizationCommandEnvelopeV1({ ...envelope, commandName: 'bogus' })).toThrow(INVALID);
  });
  test('rejects unknown schemaVersion', () => {
    expect(() => parseInvocationAuthorizationCommandEnvelopeV1({ ...envelope, schemaVersion: 2 })).toThrow(INVALID);
  });
  test('rejects unknown commandSchemaVersion', () => {
    expect(() => parseInvocationAuthorizationCommandEnvelopeV1({ ...envelope, commandSchemaVersion: 2 })).toThrow(INVALID);
  });
  test('rejects authority self-report field (teamId)', () => {
    expect(() => parseInvocationAuthorizationCommandEnvelopeV1({ ...envelope, teamId: 'evil' })).toThrow(INVALID);
  });
});

describe('parseInvocationAuthorizationInputV1', () => {
  test('authorize-invocation accepts valid', () => {
    const parsed = parseInvocationAuthorizationInputV1('authorize-invocation', {
      managementRunId: 'run-1', invocationId: 'inv-1', taskContext, operationScope,
    });
    expect(parsed.managementRunId).toBe('run-1');
  });
  test('authorize-invocation rejects missing managementRunId', () => {
    expect(() => parseInvocationAuthorizationInputV1('authorize-invocation', {
      invocationId: 'inv-1', taskContext, operationScope,
    })).toThrow(INVALID);
  });
  test('approve-action accepts valid', () => {
    const parsed = parseInvocationAuthorizationInputV1('approve-action', {
      managementRunId: 'run-1', invocationId: 'inv-1', authorizationReceiptId: 'r-1',
      taskRevision: 3, taskAttempt: 1, claimLeaseId: 'lease-1', actionRef: 'deploy', effectIdentity: effect,
    });
    expect(parsed.actionRef).toBe('deploy');
  });
  test('approve-action rejects empty actionRef', () => {
    expect(() => parseInvocationAuthorizationInputV1('approve-action', {
      managementRunId: 'run-1', invocationId: 'inv-1', authorizationReceiptId: 'r-1',
      taskRevision: 3, taskAttempt: 1, claimLeaseId: 'lease-1', actionRef: '', effectIdentity: effect,
    })).toThrow(INVALID);
  });
  test('report-effect-outcome accepts valid', () => {
    const parsed = parseInvocationAuthorizationInputV1('report-effect-outcome', {
      managementRunId: 'run-1', invocationId: 'inv-1', effectIdentity: effect, outcome: 'succeeded',
    });
    expect(parsed.outcome).toBe('succeeded');
  });
  test('report-effect-outcome rejects invalid outcome', () => {
    expect(() => parseInvocationAuthorizationInputV1('report-effect-outcome', {
      managementRunId: 'run-1', invocationId: 'inv-1', effectIdentity: effect, outcome: 'pending',
    })).toThrow(INVALID);
  });
});

describe('parseInvocationAuthorizationCommandReceiptV1', () => {
  const receipt = {
    schemaVersion: 1, receiptId: 'r-1', commandName: 'authorize-invocation' as const,
    commandSchemaVersion: 1, idempotencyKey: 'idem-1', commandHash: 'sha256:h',
    outcome: 'applied' as const, committedRevisions: [], eventRefs: [],
    commitTime: 1000, resultAvailable: true,
  };
  test('accepts valid', () => {
    expect(() => parseInvocationAuthorizationCommandReceiptV1(receipt)).not.toThrow();
  });
  test('rejects receipt outcome replayed', () => {
    expect(() => parseInvocationAuthorizationCommandReceiptV1({ ...receipt, outcome: 'replayed' as any })).toThrow(INVALID);
  });
});

describe('parseInvocationAuthorizationCommandResponseV1', () => {
  test('accepts valid applied response with result', () => {
    const resp = {
      schemaVersion: 1, commandName: 'authorize-invocation' as const,
      outcome: 'applied' as const, retryDirective: 'none' as const, stableCode: 'AUTHORIZATION_APPLIED',
      receipt: {
        schemaVersion: 1, receiptId: 'r-1', commandName: 'authorize-invocation' as const,
        commandSchemaVersion: 1, idempotencyKey: 'idem-1', commandHash: 'sha256:h',
        outcome: 'applied' as const, committedRevisions: [], eventRefs: [],
        commitTime: 1000, resultAvailable: true,
      },
      result: {
        commandName: 'authorize-invocation' as const, authorizationId: 'a-1',
        managementRunId: 'run-1', invocationId: 'inv-1', frozenRevision: 3, frozenAttempt: 1,
        authorizedEffectIdentities: [effect], requiresActionApproval: false,
      },
    };
    expect(() => parseInvocationAuthorizationCommandResponseV1(resp)).not.toThrow();
  });
  test('rejects result with mismatched commandName', () => {
    expect(() => parseInvocationAuthorizationCommandResponseV1({
      schemaVersion: 1, commandName: 'authorize-invocation', outcome: 'applied',
      retryDirective: 'none', stableCode: 'X',
      result: { commandName: 'approve-action' } as any,
    })).toThrow(INVALID);
  });
  test('rejects unknown outcome', () => {
    expect(() => parseInvocationAuthorizationCommandResponseV1({
      schemaVersion: 1, commandName: 'authorize-invocation', outcome: 'bogus' as any,
      retryDirective: 'none', stableCode: 'X',
    })).toThrow(INVALID);
  });
  test('rejects empty stableCode', () => {
    expect(() => parseInvocationAuthorizationCommandResponseV1({
      schemaVersion: 1, commandName: 'authorize-invocation', outcome: 'rejected',
      retryDirective: 'user_action', stableCode: '',
    })).toThrow(INVALID);
  });
});

describe('canonicalizeInvocationAuthorizationCommand', () => {
  test('stable for same input', () => {
    const input = { managementRunId: 'run-1', invocationId: 'inv-1', taskContext, operationScope };
    expect(canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, input))
      .toBe(canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, input));
  });
  test('different operationKind → different hash', () => {
    const a = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, {
      managementRunId: 'run-1', invocationId: 'inv-1', taskContext,
      operationScope: { ...operationScope, operationKind: 'a' },
    });
    const b = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, {
      managementRunId: 'run-1', invocationId: 'inv-1', taskContext,
      operationScope: { ...operationScope, operationKind: 'b' },
    });
    expect(a).not.toBe(b);
  });
  test('excludes clientRequestId from hash', () => {
    const base = { managementRunId: 'run-1', invocationId: 'inv-1', taskContext, operationScope };
    const a = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, base);
    const b = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, { ...base, clientRequestId: 'diff' });
    expect(a).toBe(b);
  });
  test('different taskRevision → different hash', () => {
    const a = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, {
      managementRunId: 'run-1', invocationId: 'inv-1', taskContext, operationScope,
    });
    const b = canonicalizeInvocationAuthorizationCommand('authorize-invocation', 1, {
      managementRunId: 'run-1', invocationId: 'inv-1',
      taskContext: { ...taskContext, taskRevision: 4 }, operationScope,
    });
    expect(a).not.toBe(b);
  });
});
