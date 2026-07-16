import { describe, expect, test } from 'vitest';

import {
  authorizeManagerLeaseWrite,
  evaluateManagerLeaseAcquire,
  evaluateManagerLeaseRelease,
  evaluateManagerLeaseRenew,
  inspectManagerLease,
  type ManagerLeaseAcquireInput,
  type ManagerLeaseAuthorizationProof,
  type ManagerLeaseRecord,
} from '../src/index.js';

const host = { kind: 'device' as const, deviceId: 'device-1', profileId: 'profile-1' };

function acquireInput(
  current: ManagerLeaseRecord | undefined = undefined,
  overrides: Partial<ManagerLeaseAcquireInput> = {},
): ManagerLeaseAcquireInput {
  return {
    current,
    managementRunId: 'run-1',
    workerId: 'worker-1',
    host,
    leaseTokenHash: 'hash-token-1',
    leaseFingerprint: 'fingerprint-1',
    now: 100,
    ttlMs: 60,
    ...overrides,
  };
}

function granted(input: ManagerLeaseAcquireInput = acquireInput()): ManagerLeaseRecord {
  const decision = evaluateManagerLeaseAcquire(input);
  expect(decision.kind).toBe('granted');
  if (decision.kind !== 'granted') throw new Error('expected granted lease');
  return decision.lease;
}

function proof(
  lease: ManagerLeaseRecord,
  overrides: Partial<ManagerLeaseAuthorizationProof> = {},
): ManagerLeaseAuthorizationProof {
  return {
    managementRunId: lease.managementRunId,
    workerId: lease.workerId,
    presentedLeaseTokenHash: lease.leaseTokenHash,
    fencingToken: lease.fencingToken,
    ...overrides,
  };
}

describe('Phase 1 Manager lease policy', () => {
  test('first acquire grants fencing token 1 and duplicate acquire is idempotent', () => {
    const first = evaluateManagerLeaseAcquire(acquireInput());
    expect(first).toEqual({
      kind: 'granted',
      reason: 'initial',
      lease: {
        managementRunId: 'run-1',
        workerId: 'worker-1',
        host,
        leaseTokenHash: 'hash-token-1',
        leaseFingerprint: 'fingerprint-1',
        fencingToken: 1,
        acquiredAt: 100,
        heartbeatAt: 100,
        expiresAt: 160,
      },
    });
    if (first.kind !== 'granted') throw new Error('expected granted lease');

    expect(evaluateManagerLeaseAcquire(acquireInput(first.lease, { now: 120 }))).toEqual({
      kind: 'existing',
      lease: first.lease,
    });
  });

  test('active leases reject takeover even from the same Device/profile', () => {
    const current = granted();
    expect(evaluateManagerLeaseAcquire(acquireInput(current, {
      workerId: 'worker-restarted',
      leaseTokenHash: 'hash-token-2',
      leaseFingerprint: 'fingerprint-2',
      now: 159,
    }))).toEqual({ kind: 'rejected', reason: 'active-lease-held' });
  });

  test('legacy Device host input is accepted and normalized', () => {
    expect(evaluateManagerLeaseAcquire(acquireInput(undefined, {
      host: { deviceId: 'legacy-device', profileId: 'profile-1' },
    }))).toMatchObject({
      kind: 'granted',
      lease: { host: { kind: 'device', deviceId: 'legacy-device', profileId: 'profile-1' } },
    });
  });

  test('same host/profile can reacquire at expiry and increments fencing', () => {
    const current = granted();
    expect(evaluateManagerLeaseAcquire(acquireInput(current, {
      workerId: 'worker-restarted',
      leaseTokenHash: 'hash-token-2',
      leaseFingerprint: 'fingerprint-2',
      now: 160,
    }))).toEqual({
      kind: 'granted',
      reason: 'expired-same-host',
      lease: {
        managementRunId: 'run-1',
        workerId: 'worker-restarted',
        host,
        leaseTokenHash: 'hash-token-2',
        leaseFingerprint: 'fingerprint-2',
        fencingToken: 2,
        acquiredAt: 160,
        heartbeatAt: 160,
        expiresAt: 220,
      },
    });
  });

  test('expired leases allow cross-host recovery with a new fencing token', () => {
    const current = granted();
    expect(evaluateManagerLeaseAcquire(acquireInput(current, {
      workerId: 'server-worker-1',
      host: { kind: 'server', workerPoolId: 'pool-1', profileId: 'profile-1' },
      leaseTokenHash: 'hash-other',
      leaseFingerprint: 'fingerprint-other',
      now: 160,
    }))).toEqual({
      kind: 'granted',
      reason: 'expired-cross-host',
      lease: {
        managementRunId: 'run-1',
        workerId: 'server-worker-1',
        host: { kind: 'server', workerPoolId: 'pool-1', profileId: 'profile-1' },
        leaseTokenHash: 'hash-other',
        leaseFingerprint: 'fingerprint-other',
        fencingToken: 2,
        acquiredAt: 160,
        heartbeatAt: 160,
        expiresAt: 220,
      },
    });
  });

  test('active leases still reject a different host', () => {
    const current = granted();
    expect(evaluateManagerLeaseAcquire(acquireInput(current, {
      workerId: 'server-worker-1',
      host: { kind: 'server', workerPoolId: 'pool-1', profileId: 'profile-1' },
      leaseTokenHash: 'hash-other',
      leaseFingerprint: 'fingerprint-other',
      now: 159,
    }))).toEqual({ kind: 'rejected', reason: 'active-lease-held' });
  });

  test('renew uses now plus TTL without changing fencing or acquiredAt', () => {
    const current = granted();
    expect(evaluateManagerLeaseRenew({
      lease: current,
      proof: proof(current),
      now: 130,
      ttlMs: 90,
    })).toEqual({
      kind: 'renewed',
      lease: {
        ...current,
        heartbeatAt: 130,
        expiresAt: 220,
      },
    });
  });

  test('the expiry boundary is closed to renew and writes', () => {
    const current = granted();
    expect(inspectManagerLease(current, 159)).toEqual({ kind: 'active', lease: current });
    expect(inspectManagerLease(current, 160)).toEqual({ kind: 'expired', lease: current });
    expect(evaluateManagerLeaseRenew({
      lease: current,
      proof: proof(current),
      now: 160,
      ttlMs: 60,
    })).toEqual({ kind: 'rejected', reason: 'lease-expired' });
    expect(authorizeManagerLeaseWrite({ lease: current, proof: proof(current), now: 160 }))
      .toEqual({ kind: 'rejected', reason: 'lease-expired' });
  });

  test('release is idempotent but permanently removes write authority', () => {
    const current = granted();
    const released = evaluateManagerLeaseRelease({ lease: current, proof: proof(current), now: 140 });
    expect(released).toEqual({
      kind: 'released',
      lease: { ...current, releasedAt: 140 },
    });
    if (released.kind !== 'released') throw new Error('expected release');
    expect(evaluateManagerLeaseRelease({ lease: released.lease, proof: proof(current), now: 141 }))
      .toEqual({ kind: 'already-released', lease: released.lease });
    expect(authorizeManagerLeaseWrite({ lease: released.lease, proof: proof(current), now: 141 }))
      .toEqual({ kind: 'rejected', reason: 'lease-released' });
  });

  test('stale and future fencing plus token or worker mismatches fail closed after reacquire', () => {
    const first = granted();
    const secondDecision = evaluateManagerLeaseAcquire(acquireInput(first, {
      workerId: 'worker-2',
      leaseTokenHash: 'hash-token-2',
      leaseFingerprint: 'fingerprint-2',
      now: 160,
    }));
    if (secondDecision.kind !== 'granted') throw new Error('expected reacquire');
    const second = secondDecision.lease;
    const cases = [
      [proof(second, { workerId: 'worker-1' }), 'worker-mismatch'],
      [proof(second, { presentedLeaseTokenHash: 'hash-token-1' }), 'lease-token-mismatch'],
      [proof(second, { fencingToken: 1 }), 'stale-fencing-token'],
      [proof(second, { fencingToken: 3 }), 'future-fencing-token'],
    ] as const;
    for (const [candidate, reason] of cases) {
      expect(authorizeManagerLeaseWrite({ lease: second, proof: candidate, now: 180 }))
        .toEqual({ kind: 'rejected', reason });
    }
    expect(authorizeManagerLeaseWrite({ lease: second, proof: proof(second), now: 180 }))
      .toEqual({ kind: 'authorized', lease: second });
  });

  test('released same-host leases can reacquire but never reuse a fencing token', () => {
    const current = granted();
    const released = evaluateManagerLeaseRelease({ lease: current, proof: proof(current), now: 130 });
    if (released.kind !== 'released') throw new Error('expected release');
    expect(evaluateManagerLeaseAcquire(acquireInput(released.lease, {
      workerId: 'worker-2',
      leaseTokenHash: 'hash-token-2',
      leaseFingerprint: 'fingerprint-2',
      now: 131,
    }))).toMatchObject({
      kind: 'granted',
      reason: 'released-same-host',
      lease: { fencingToken: 2 },
    });
  });

  test('invalid duration, clock regression, and fencing overflow are rejected', () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateManagerLeaseAcquire(acquireInput(undefined, { ttlMs })))
        .toEqual({ kind: 'rejected', reason: 'invalid-duration' });
    }
    const current = granted();
    expect(evaluateManagerLeaseRenew({
      lease: current,
      proof: proof(current),
      now: 99,
      ttlMs: 60,
    })).toEqual({ kind: 'rejected', reason: 'clock-regressed' });
    expect(evaluateManagerLeaseAcquire(acquireInput({
      ...current,
      fencingToken: Number.MAX_SAFE_INTEGER,
      acquiredAt: 40,
      heartbeatAt: 40,
      expiresAt: 100,
    }, {
      workerId: 'worker-2',
      leaseTokenHash: 'hash-token-2',
      leaseFingerprint: 'fingerprint-2',
      now: 100,
    }))).toEqual({ kind: 'rejected', reason: 'fencing-overflow' });
  });

  test('rejects persisted release timestamps at or after expiry', () => {
    const current = granted();
    for (const releasedAt of [current.expiresAt, current.expiresAt + 1]) {
      const corrupted = { ...current, releasedAt };
      expect(inspectManagerLease(corrupted, releasedAt)).toEqual({
        kind: 'invalid',
        lease: corrupted,
      });
      expect(authorizeManagerLeaseWrite({ lease: corrupted, proof: proof(current), now: releasedAt }))
        .toEqual({ kind: 'rejected', reason: 'invalid-lease-state' });
    }
  });
});
