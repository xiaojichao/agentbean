import { describe, expect, test } from 'vitest';
import type { EffectIdentityV1 } from '@agentbean/contracts';
import {
  canonicalizeEffectIdentity,
  evaluateInvocationAuthorization,
  evaluateActionApproval,
  resolveEffectIdempotency,
  classifyEffectOutcome,
} from '../src/invocation-authorization-policy.js';

// #927 领域策略纯函数测试。覆盖四条验收标准。

const effect: EffectIdentityV1 = {
  schemaVersion: 1,
  effectKind: 'api-call',
  scope: { managementRunId: 'run-1', invocationId: 'inv-1' },
  dedupKey: 'create-report',
  contentHash: 'sha256:abc123',
};

describe('canonicalizeEffectIdentity', () => {
  test('stable for same identity', () => {
    expect(canonicalizeEffectIdentity(effect)).toBe(canonicalizeEffectIdentity(effect));
  });
  test('different effectKind → different', () => {
    expect(canonicalizeEffectIdentity(effect))
      .not.toBe(canonicalizeEffectIdentity({ ...effect, effectKind: 'email' }));
  });
});

// AC: 旧 claim/attempt/revision 的 Invocation 或 approval 均被拒绝
describe('evaluateInvocationAuthorization', () => {
  const base = {
    managementRunId: 'run-1',
    invocationId: 'inv-1',
    requestedOperationHash: 'op-hash-1',
    currentTaskRevision: 3,
    currentTaskAttempt: 1,
    currentClaimLeaseId: 'lease-1',
    claimActive: true,
    now: 1000,
  };

  test('no existing → authorized with frozen revision/attempt', () => {
    const d = evaluateInvocationAuthorization(base);
    expect(d.kind).toBe('authorized');
    if (d.kind === 'authorized') {
      expect(d.frozenRevision).toBe(3);
      expect(d.frozenAttempt).toBe(1);
    }
  });

  test('same existing + matching everything → replayed', () => {
    const d = evaluateInvocationAuthorization({
      ...base,
      existing: {
        authorizationId: 'auth-1', operationHash: 'op-hash-1',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'active',
      },
    });
    expect(d.kind).toBe('replayed');
  });

  test('existing different operation hash → conflict', () => {
    const d = evaluateInvocationAuthorization({
      ...base,
      existing: {
        authorizationId: 'auth-1', operationHash: 'different',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'active',
      },
    });
    expect(d.kind).toBe('conflict');
  });

  test('revision changed → rejected', () => {
    const d = evaluateInvocationAuthorization({
      ...base, currentTaskRevision: 4,
      existing: {
        authorizationId: 'auth-1', operationHash: 'op-hash-1',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'active',
      },
    });
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('revision_changed');
  });

  test('attempt changed → rejected', () => {
    const d = evaluateInvocationAuthorization({
      ...base, currentTaskAttempt: 2,
      existing: {
        authorizationId: 'auth-1', operationHash: 'op-hash-1',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'active',
      },
    });
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('attempt_changed');
  });

  test('claim lease changed → rejected', () => {
    const d = evaluateInvocationAuthorization({
      ...base, currentClaimLeaseId: 'lease-2',
      existing: {
        authorizationId: 'auth-1', operationHash: 'op-hash-1',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'active',
      },
    });
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('claim_lease_changed');
  });

  test('claim inactive → rejected', () => {
    expect(evaluateInvocationAuthorization({ ...base, claimActive: false }).kind).toBe('rejected');
  });

  test('deadline expired → rejected', () => {
    const d = evaluateInvocationAuthorization({ ...base, deadlineAt: 500, now: 1000 });
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('deadline_expired');
  });

  test('deadline future → authorized', () => {
    expect(evaluateInvocationAuthorization({ ...base, deadlineAt: 2000, now: 1000 }).kind).toBe('authorized');
  });

  test('existing superseded → rejected', () => {
    const d = evaluateInvocationAuthorization({
      ...base,
      existing: {
        authorizationId: 'auth-1', operationHash: 'op-hash-1',
        frozenRevision: 3, frozenAttempt: 1, frozenClaimLeaseId: 'lease-1', state: 'superseded',
      },
    });
    expect(d.kind).toBe('rejected');
  });
});

// AC: 旧 revision 的 approval 被拒绝
describe('evaluateActionApproval', () => {
  const base = {
    actionRef: 'deploy',
    effectIdentity: effect,
    authorizationState: 'active' as const,
    authorizationFrozenRevision: 3,
    currentRevision: 3,
  };

  test('active + matching revision → approved', () => {
    expect(evaluateActionApproval(base).kind).toBe('approved');
  });

  test('authorization superseded → rejected', () => {
    expect(evaluateActionApproval({ ...base, authorizationState: 'superseded' }).kind).toBe('rejected');
  });

  test('authorization revoked → rejected', () => {
    expect(evaluateActionApproval({ ...base, authorizationState: 'revoked' }).kind).toBe('rejected');
  });

  test('revision stale → rejected', () => {
    const d = evaluateActionApproval({ ...base, authorizationFrozenRevision: 3, currentRevision: 4 });
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('revision_stale');
  });

  test('existing applied approval → replayed', () => {
    const d = evaluateActionApproval({
      ...base,
      existingApproval: {
        approvalId: 'ap-1', actionRef: 'deploy', effectKind: 'api-call',
        dedupKey: 'create-report', contentHash: 'sha256:abc123', state: 'applied',
      },
    });
    expect(d.kind).toBe('replayed');
    if (d.kind === 'replayed') expect(d.approvalId).toBe('ap-1');
  });
});

// AC: 同一 Effect identity 不重复产生外部效果；cancellation 不能伪造外部效果已撤销
describe('resolveEffectIdempotency', () => {
  test('no existing → create', () => {
    expect(resolveEffectIdempotency({ effectIdentity: effect, requestedOutcome: 'succeeded' }).kind).toBe('create');
  });

  test('same contentHash + same outcome → replay', () => {
    const d = resolveEffectIdempotency({
      effectIdentity: effect,
      existing: {
        effectOutcomeId: 'eo-1', effectKind: 'api-call', dedupKey: 'create-report',
        contentHash: 'sha256:abc123', outcome: 'succeeded', externalEffectUnknown: false,
      },
      requestedOutcome: 'succeeded',
    });
    expect(d.kind).toBe('replay');
  });

  test('different contentHash → conflict', () => {
    const d = resolveEffectIdempotency({
      effectIdentity: { ...effect, contentHash: 'sha256:new' },
      existing: {
        effectOutcomeId: 'eo-1', effectKind: 'api-call', dedupKey: 'create-report',
        contentHash: 'sha256:abc123', outcome: 'succeeded', externalEffectUnknown: false,
      },
      requestedOutcome: 'succeeded',
    });
    expect(d.kind).toBe('conflict');
  });

  test('different outcome → conflict (cancellation cannot fake reversal)', () => {
    const d = resolveEffectIdempotency({
      effectIdentity: effect,
      existing: {
        effectOutcomeId: 'eo-1', effectKind: 'api-call', dedupKey: 'create-report',
        contentHash: 'sha256:abc123', outcome: 'succeeded', externalEffectUnknown: false,
      },
      requestedOutcome: 'failed',
    });
    expect(d.kind).toBe('conflict');
    if (d.kind === 'conflict') expect(d.reason).toBe('outcome_mismatch');
  });
});

// AC: network timeout ≠ External effect unknown
describe('classifyEffectOutcome', () => {
  test('succeeded → terminal', () => {
    const c = classifyEffectOutcome({ outcome: 'succeeded', isExternalEffectUnknown: false });
    expect(c.externalEffectUnknown).toBe(false);
    expect(c.actionRequired).toBe(false);
  });

  test('failed → terminal', () => {
    const c = classifyEffectOutcome({ outcome: 'failed', isExternalEffectUnknown: false });
    expect(c.externalEffectUnknown).toBe(false);
    expect(c.actionRequired).toBe(false);
  });

  test('unknown + externalEffectUnknown → action_required (ADR-0067)', () => {
    const c = classifyEffectOutcome({ outcome: 'unknown', isExternalEffectUnknown: true });
    expect(c.externalEffectUnknown).toBe(true);
    expect(c.actionRequired).toBe(true);
  });

  test('unknown + !externalEffectUnknown → safe retry (network timeout)', () => {
    const c = classifyEffectOutcome({ outcome: 'unknown', isExternalEffectUnknown: false });
    expect(c.externalEffectUnknown).toBe(false);
    expect(c.actionRequired).toBe(false);
  });
});
