import { describe, expect, test } from 'vitest';

import {
  authorizeTaskClaimWrite,
  evaluateTaskClaimAcquire,
  evaluateTaskClaimRelease,
  evaluateTaskClaimRenew,
  inspectTaskClaim,
  type TaskClaimAcquireInput,
  type TaskClaimAuthorizationProof,
  type TaskClaimLeaseRecord,
} from '../src/index.js';

function acquireInput(
  current: TaskClaimLeaseRecord | undefined = undefined,
  overrides: Partial<TaskClaimAcquireInput> = {},
): TaskClaimAcquireInput {
  return {
    current,
    taskId: 'task-1',
    taskRevision: 2,
    taskAttempt: 1,
    agentId: 'agent-1',
    leaseTokenHash: 'token-hash-1',
    leaseFingerprint: 'fingerprint-1',
    ancestorAgentIds: [],
    now: 100,
    ttlMs: 60,
    ...overrides,
  };
}

function granted(input: TaskClaimAcquireInput = acquireInput()): TaskClaimLeaseRecord {
  const decision = evaluateTaskClaimAcquire(input);
  expect(decision.kind).toBe('granted');
  if (decision.kind !== 'granted') throw new Error('expected granted claim');
  return decision.lease;
}

function proof(
  lease: TaskClaimLeaseRecord,
  overrides: Partial<TaskClaimAuthorizationProof> = {},
): TaskClaimAuthorizationProof {
  return {
    taskId: lease.taskId,
    taskRevision: lease.taskRevision,
    taskAttempt: lease.taskAttempt,
    agentId: lease.agentId,
    presentedLeaseTokenHash: lease.leaseTokenHash,
    fencingToken: lease.fencingToken,
    ...overrides,
  };
}

describe('Phase 2 Task claim policy', () => {
  test('first eligible claimant wins and duplicate acquire is idempotent', () => {
    const first = evaluateTaskClaimAcquire(acquireInput());
    expect(first).toEqual({
      kind: 'granted',
      reason: 'initial',
      lease: {
        taskId: 'task-1',
        taskRevision: 2,
        taskAttempt: 1,
        agentId: 'agent-1',
        leaseTokenHash: 'token-hash-1',
        leaseFingerprint: 'fingerprint-1',
        fencingToken: 1,
        acquiredAt: 100,
        renewedAt: 100,
        expiresAt: 160,
      },
    });
    if (first.kind !== 'granted') throw new Error('expected granted claim');
    expect(evaluateTaskClaimAcquire(acquireInput(first.lease, { now: 120 })))
      .toEqual({ kind: 'existing', lease: first.lease });
  });

  test('a competing claimant loses without receiving authority', () => {
    const current = granted();
    expect(evaluateTaskClaimAcquire(acquireInput(current, {
      agentId: 'agent-2',
      leaseTokenHash: 'token-hash-2',
      leaseFingerprint: 'fingerprint-2',
      now: 120,
    }))).toEqual({ kind: 'rejected', reason: 'active-claim-held' });
  });

  test('ancestor Agent delegation loops are rejected before acquisition', () => {
    expect(evaluateTaskClaimAcquire(acquireInput(undefined, {
      ancestorAgentIds: ['agent-0', 'agent-1'],
    }))).toEqual({ kind: 'rejected', reason: 'ancestor-agent-loop' });
  });

  test('expired and released claims reopen with a strictly newer fencing token', () => {
    const current = granted();
    expect(evaluateTaskClaimAcquire(acquireInput(current, {
      agentId: 'agent-2',
      leaseTokenHash: 'token-hash-2',
      leaseFingerprint: 'fingerprint-2',
      now: 160,
    }))).toMatchObject({
      kind: 'granted',
      reason: 'reopened-expired',
      lease: { fencingToken: 2, agentId: 'agent-2' },
    });

    const released = evaluateTaskClaimRelease({
      lease: current,
      proof: proof(current),
      now: 130,
    });
    if (released.kind !== 'released') throw new Error('expected released claim');
    expect(evaluateTaskClaimAcquire(acquireInput(released.lease, {
      agentId: 'agent-2',
      leaseTokenHash: 'token-hash-2',
      leaseFingerprint: 'fingerprint-2',
      now: 131,
    }))).toMatchObject({
      kind: 'granted',
      reason: 'reopened-released',
      lease: { fencingToken: 2, agentId: 'agent-2' },
    });
  });

  test('renew extends the active lease without changing claim identity or fencing', () => {
    const current = granted();
    expect(evaluateTaskClaimRenew({
      lease: current,
      proof: proof(current),
      now: 130,
      ttlMs: 90,
    })).toEqual({
      kind: 'renewed',
      lease: { ...current, renewedAt: 130, expiresAt: 220 },
    });
  });

  test('expiry boundary closes renew and write authority', () => {
    const current = granted();
    expect(inspectTaskClaim(current, 159)).toEqual({ kind: 'active', lease: current });
    expect(inspectTaskClaim(current, 160)).toEqual({ kind: 'expired', lease: current });
    expect(evaluateTaskClaimRenew({
      lease: current,
      proof: proof(current),
      now: 160,
      ttlMs: 60,
    })).toEqual({ kind: 'rejected', reason: 'claim-expired' });
    expect(authorizeTaskClaimWrite({ lease: current, proof: proof(current), now: 160 }))
      .toEqual({ kind: 'rejected', reason: 'claim-expired' });
  });

  test('release is idempotent and permanently removes write authority', () => {
    const current = granted();
    const released = evaluateTaskClaimRelease({ lease: current, proof: proof(current), now: 130 });
    expect(released).toEqual({
      kind: 'released',
      lease: { ...current, releasedAt: 130 },
    });
    if (released.kind !== 'released') throw new Error('expected released claim');
    expect(evaluateTaskClaimRelease({ lease: released.lease, proof: proof(current), now: 131 }))
      .toEqual({ kind: 'already-released', lease: released.lease });
    expect(authorizeTaskClaimWrite({ lease: released.lease, proof: proof(current), now: 131 }))
      .toEqual({ kind: 'rejected', reason: 'claim-released' });
  });

  test.each([
    [{ agentId: 'agent-2' }, 'agent-mismatch'],
    [{ presentedLeaseTokenHash: 'wrong-token' }, 'lease-token-mismatch'],
    [{ fencingToken: 0 }, 'stale-fencing-token'],
    [{ fencingToken: 2 }, 'future-fencing-token'],
    [{ taskRevision: 1 }, 'stale-task-revision'],
    [{ taskRevision: 3 }, 'future-task-revision'],
    [{ taskAttempt: 0 }, 'stale-task-attempt'],
    [{ taskAttempt: 2 }, 'future-task-attempt'],
  ] as const)('rejects stale or mismatched authority: %s', (override, reason) => {
    const current = granted();
    expect(authorizeTaskClaimWrite({
      lease: current,
      proof: proof(current, override),
      now: 120,
    })).toEqual({ kind: 'rejected', reason });
  });

  test('invalid timing, identity, persisted release, and fencing overflow fail closed', () => {
    expect(evaluateTaskClaimAcquire(acquireInput(undefined, { ttlMs: 0 })))
      .toEqual({ kind: 'rejected', reason: 'invalid-duration' });
    expect(evaluateTaskClaimAcquire(acquireInput(undefined, { agentId: '' })))
      .toEqual({ kind: 'rejected', reason: 'invalid-claim-state' });
    const current = granted();
    expect(evaluateTaskClaimRenew({
      lease: current,
      proof: proof(current),
      now: 99,
      ttlMs: 60,
    })).toEqual({ kind: 'rejected', reason: 'clock-regressed' });
    expect(authorizeTaskClaimWrite({
      lease: current,
      proof: proof(current, { fencingToken: Number.NaN }),
      now: 120,
    })).toEqual({ kind: 'rejected', reason: 'invalid-claim-state' });
    const corrupt = { ...current, releasedAt: current.expiresAt };
    expect(inspectTaskClaim(corrupt, current.expiresAt))
      .toEqual({ kind: 'invalid', lease: corrupt });
    expect(evaluateTaskClaimAcquire(acquireInput({
      ...current,
      fencingToken: Number.MAX_SAFE_INTEGER,
    }, { now: 160 }))).toEqual({ kind: 'rejected', reason: 'fencing-overflow' });
  });
});
