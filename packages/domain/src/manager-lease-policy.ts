export interface ManagerLeaseHost {
  readonly deviceId: string;
  readonly profileId: string;
}

export interface ManagerLeaseRecord {
  readonly managementRunId: string;
  readonly workerId: string;
  readonly host: ManagerLeaseHost;
  readonly leaseTokenHash: string;
  readonly leaseFingerprint: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly releasedAt?: number;
}

export type ManagerLeaseStatus =
  | { readonly kind: 'unleased' }
  | { readonly kind: 'active'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'expired'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'released'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'invalid'; readonly lease: ManagerLeaseRecord };

export interface ManagerLeaseAcquireInput {
  readonly current?: ManagerLeaseRecord;
  readonly managementRunId: string;
  readonly workerId: string;
  readonly host: ManagerLeaseHost;
  readonly leaseTokenHash: string;
  readonly leaseFingerprint: string;
  readonly now: number;
  readonly ttlMs: number;
}

export type ManagerLeaseAcquireRejection =
  | 'active-lease-held'
  | 'cross-host-recovery-not-supported'
  | 'invalid-lease-state'
  | 'invalid-duration'
  | 'fencing-overflow'
  | 'clock-regressed';

export type ManagerLeaseAcquireDecision =
  | {
      readonly kind: 'granted';
      readonly reason: 'initial' | 'expired-same-host' | 'released-same-host';
      readonly lease: ManagerLeaseRecord;
    }
  | { readonly kind: 'existing'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: ManagerLeaseAcquireRejection };

export interface ManagerLeaseAuthorizationProof {
  readonly managementRunId: string;
  readonly workerId: string;
  readonly presentedLeaseTokenHash: string;
  readonly fencingToken: number;
}

export type ManagerLeaseAuthorizationFailure =
  | 'lease-missing'
  | 'lease-expired'
  | 'lease-released'
  | 'management-run-mismatch'
  | 'worker-mismatch'
  | 'lease-token-mismatch'
  | 'stale-fencing-token'
  | 'future-fencing-token'
  | 'invalid-lease-state'
  | 'invalid-duration'
  | 'clock-regressed';

export interface ManagerLeaseRenewInput {
  readonly lease?: ManagerLeaseRecord;
  readonly proof: ManagerLeaseAuthorizationProof;
  readonly now: number;
  readonly ttlMs: number;
}

export type ManagerLeaseRenewDecision =
  | { readonly kind: 'renewed'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: ManagerLeaseAuthorizationFailure };

export interface ManagerLeaseReleaseInput {
  readonly lease?: ManagerLeaseRecord;
  readonly proof: ManagerLeaseAuthorizationProof;
  readonly now: number;
}

export type ManagerLeaseReleaseDecision =
  | { readonly kind: 'released'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'already-released'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: ManagerLeaseAuthorizationFailure };

export interface AuthorizeManagerLeaseWriteInput {
  readonly lease?: ManagerLeaseRecord;
  readonly proof: ManagerLeaseAuthorizationProof;
  readonly now: number;
}

export type ManagerLeaseWriteDecision =
  | { readonly kind: 'authorized'; readonly lease: ManagerLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: ManagerLeaseAuthorizationFailure };

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidDuration(now: number, ttlMs: number): boolean {
  return isSafeNonNegativeInteger(now)
    && Number.isSafeInteger(ttlMs)
    && ttlMs > 0
    && Number.isSafeInteger(now + ttlMs);
}

function isValidLease(lease: ManagerLeaseRecord): boolean {
  return lease.managementRunId.length > 0
    && lease.workerId.length > 0
    && lease.host.deviceId.length > 0
    && lease.host.profileId.length > 0
    && lease.leaseTokenHash.length > 0
    && lease.leaseFingerprint.length > 0
    && Number.isSafeInteger(lease.fencingToken)
    && lease.fencingToken > 0
    && isSafeNonNegativeInteger(lease.acquiredAt)
    && isSafeNonNegativeInteger(lease.heartbeatAt)
    && isSafeNonNegativeInteger(lease.expiresAt)
    && lease.acquiredAt <= lease.heartbeatAt
    && lease.heartbeatAt < lease.expiresAt
    && (lease.releasedAt === undefined
      || (isSafeNonNegativeInteger(lease.releasedAt)
        && lease.releasedAt >= lease.acquiredAt
        && lease.releasedAt < lease.expiresAt));
}

function clockRegressed(lease: ManagerLeaseRecord, now: number): boolean {
  return !isSafeNonNegativeInteger(now)
    || now < lease.acquiredAt
    || now < lease.heartbeatAt
    || (lease.releasedAt !== undefined && now < lease.releasedAt);
}

function sameHost(left: ManagerLeaseHost, right: ManagerLeaseHost): boolean {
  return left.deviceId === right.deviceId && left.profileId === right.profileId;
}

export function inspectManagerLease(
  lease: ManagerLeaseRecord | undefined,
  now: number,
): ManagerLeaseStatus {
  if (!lease) return { kind: 'unleased' };
  if (!isValidLease(lease) || clockRegressed(lease, now)) return { kind: 'invalid', lease };
  if (lease.releasedAt !== undefined) return { kind: 'released', lease };
  if (now >= lease.expiresAt) return { kind: 'expired', lease };
  return { kind: 'active', lease };
}

function grantedLease(
  input: ManagerLeaseAcquireInput,
  fencingToken: number,
): ManagerLeaseRecord {
  return {
    managementRunId: input.managementRunId,
    workerId: input.workerId,
    host: { ...input.host },
    leaseTokenHash: input.leaseTokenHash,
    leaseFingerprint: input.leaseFingerprint,
    fencingToken,
    acquiredAt: input.now,
    heartbeatAt: input.now,
    expiresAt: input.now + input.ttlMs,
  };
}

function acquireIdentityIsValid(input: ManagerLeaseAcquireInput): boolean {
  return input.managementRunId.length > 0
    && input.workerId.length > 0
    && input.host.deviceId.length > 0
    && input.host.profileId.length > 0
    && input.leaseTokenHash.length > 0
    && input.leaseFingerprint.length > 0;
}

export function evaluateManagerLeaseAcquire(
  input: ManagerLeaseAcquireInput,
): ManagerLeaseAcquireDecision {
  if (!isValidDuration(input.now, input.ttlMs)) {
    return { kind: 'rejected', reason: 'invalid-duration' };
  }
  if (!acquireIdentityIsValid(input)) {
    return { kind: 'rejected', reason: 'invalid-lease-state' };
  }
  if (!input.current) {
    return { kind: 'granted', reason: 'initial', lease: grantedLease(input, 1) };
  }
  const current = input.current;
  if (!isValidLease(current)) return { kind: 'rejected', reason: 'invalid-lease-state' };
  if (clockRegressed(current, input.now)) return { kind: 'rejected', reason: 'clock-regressed' };
  if (current.managementRunId !== input.managementRunId) {
    return { kind: 'rejected', reason: 'invalid-lease-state' };
  }
  const status = inspectManagerLease(current, input.now);
  if (status.kind === 'active') {
    const duplicate = current.workerId === input.workerId
      && sameHost(current.host, input.host)
      && current.leaseTokenHash === input.leaseTokenHash
      && current.leaseFingerprint === input.leaseFingerprint;
    return duplicate
      ? { kind: 'existing', lease: current }
      : { kind: 'rejected', reason: 'active-lease-held' };
  }
  if (status.kind !== 'expired' && status.kind !== 'released') {
    return { kind: 'rejected', reason: 'invalid-lease-state' };
  }
  if (!sameHost(current.host, input.host)) {
    return { kind: 'rejected', reason: 'cross-host-recovery-not-supported' };
  }
  if (current.fencingToken === Number.MAX_SAFE_INTEGER) {
    return { kind: 'rejected', reason: 'fencing-overflow' };
  }
  return {
    kind: 'granted',
    reason: status.kind === 'expired' ? 'expired-same-host' : 'released-same-host',
    lease: grantedLease(input, current.fencingToken + 1),
  };
}

function validateProof(
  lease: ManagerLeaseRecord | undefined,
  proof: ManagerLeaseAuthorizationProof,
  now: number,
  allowReleased = false,
): ManagerLeaseAuthorizationFailure | undefined {
  if (!lease) return 'lease-missing';
  if (!isValidLease(lease)) return 'invalid-lease-state';
  if (clockRegressed(lease, now)) return 'clock-regressed';
  if (proof.managementRunId !== lease.managementRunId) return 'management-run-mismatch';
  if (proof.workerId !== lease.workerId) return 'worker-mismatch';
  if (proof.presentedLeaseTokenHash !== lease.leaseTokenHash) return 'lease-token-mismatch';
  if (!Number.isSafeInteger(proof.fencingToken) || proof.fencingToken < lease.fencingToken) {
    return 'stale-fencing-token';
  }
  if (proof.fencingToken > lease.fencingToken) return 'future-fencing-token';
  if (lease.releasedAt !== undefined) return allowReleased ? undefined : 'lease-released';
  if (now >= lease.expiresAt) return 'lease-expired';
  return undefined;
}

export function evaluateManagerLeaseRenew(
  input: ManagerLeaseRenewInput,
): ManagerLeaseRenewDecision {
  if (!isValidDuration(input.now, input.ttlMs)) {
    return { kind: 'rejected', reason: 'invalid-duration' };
  }
  const failure = validateProof(input.lease, input.proof, input.now);
  if (failure) return { kind: 'rejected', reason: failure };
  const lease = input.lease!;
  return {
    kind: 'renewed',
    lease: {
      ...lease,
      heartbeatAt: input.now,
      expiresAt: input.now + input.ttlMs,
    },
  };
}

export function evaluateManagerLeaseRelease(
  input: ManagerLeaseReleaseInput,
): ManagerLeaseReleaseDecision {
  const failure = validateProof(input.lease, input.proof, input.now, true);
  if (failure) return { kind: 'rejected', reason: failure };
  const lease = input.lease!;
  if (lease.releasedAt !== undefined) return { kind: 'already-released', lease };
  if (input.now >= lease.expiresAt) return { kind: 'rejected', reason: 'lease-expired' };
  return { kind: 'released', lease: { ...lease, releasedAt: input.now } };
}

export function authorizeManagerLeaseWrite(
  input: AuthorizeManagerLeaseWriteInput,
): ManagerLeaseWriteDecision {
  const failure = validateProof(input.lease, input.proof, input.now);
  return failure
    ? { kind: 'rejected', reason: failure }
    : { kind: 'authorized', lease: input.lease! };
}
