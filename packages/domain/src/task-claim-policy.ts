export interface TaskClaimLeaseRecord {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: string;
  readonly leaseTokenHash: string;
  readonly leaseFingerprint: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly expiresAt: number;
  readonly releasedAt?: number;
}

export type TaskClaimStatus =
  | { readonly kind: 'unclaimed' }
  | { readonly kind: 'active'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'expired'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'released'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'invalid'; readonly lease: TaskClaimLeaseRecord };

export interface TaskClaimAcquireInput {
  readonly current?: TaskClaimLeaseRecord;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: string;
  readonly leaseTokenHash: string;
  readonly leaseFingerprint: string;
  readonly ancestorAgentIds: readonly string[];
  readonly now: number;
  readonly ttlMs: number;
}

export type TaskClaimAcquireRejection =
  | 'active-claim-held'
  | 'ancestor-agent-loop'
  | 'invalid-claim-state'
  | 'invalid-duration'
  | 'clock-regressed'
  | 'fencing-overflow';

export type TaskClaimAcquireDecision =
  | {
      readonly kind: 'granted';
      readonly reason: 'initial' | 'reopened-expired' | 'reopened-released';
      readonly lease: TaskClaimLeaseRecord;
    }
  | { readonly kind: 'existing'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: TaskClaimAcquireRejection };

export interface TaskClaimAuthorizationProof {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly agentId: string;
  readonly presentedLeaseTokenHash: string;
  readonly fencingToken: number;
}

export type TaskClaimAuthorizationFailure =
  | 'claim-missing'
  | 'claim-expired'
  | 'claim-released'
  | 'task-mismatch'
  | 'stale-task-revision'
  | 'future-task-revision'
  | 'stale-task-attempt'
  | 'future-task-attempt'
  | 'agent-mismatch'
  | 'lease-token-mismatch'
  | 'stale-fencing-token'
  | 'future-fencing-token'
  | 'invalid-claim-state'
  | 'clock-regressed';

export interface TaskClaimRenewInput {
  readonly lease?: TaskClaimLeaseRecord;
  readonly proof: TaskClaimAuthorizationProof;
  readonly now: number;
  readonly ttlMs: number;
}

export type TaskClaimRenewDecision =
  | { readonly kind: 'renewed'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: TaskClaimAuthorizationFailure | 'invalid-duration' };

export interface TaskClaimReleaseInput {
  readonly lease?: TaskClaimLeaseRecord;
  readonly proof: TaskClaimAuthorizationProof;
  readonly now: number;
}

export type TaskClaimReleaseDecision =
  | { readonly kind: 'released'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'already-released'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: TaskClaimAuthorizationFailure };

export interface AuthorizeTaskClaimWriteInput {
  readonly lease?: TaskClaimLeaseRecord;
  readonly proof: TaskClaimAuthorizationProof;
  readonly now: number;
}

export type TaskClaimWriteDecision =
  | { readonly kind: 'authorized'; readonly lease: TaskClaimLeaseRecord }
  | { readonly kind: 'rejected'; readonly reason: TaskClaimAuthorizationFailure };

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidDuration(now: number, ttlMs: number): boolean {
  return isSafeNonNegativeInteger(now)
    && isPositiveSafeInteger(ttlMs)
    && Number.isSafeInteger(now + ttlMs);
}

function isValidLease(lease: TaskClaimLeaseRecord): boolean {
  return lease.taskId.length > 0
    && isPositiveSafeInteger(lease.taskRevision)
    && isPositiveSafeInteger(lease.taskAttempt)
    && lease.agentId.length > 0
    && lease.leaseTokenHash.length > 0
    && lease.leaseFingerprint.length > 0
    && isPositiveSafeInteger(lease.fencingToken)
    && isSafeNonNegativeInteger(lease.acquiredAt)
    && isSafeNonNegativeInteger(lease.renewedAt)
    && isSafeNonNegativeInteger(lease.expiresAt)
    && lease.acquiredAt <= lease.renewedAt
    && lease.renewedAt < lease.expiresAt
    && (lease.releasedAt === undefined
      || (isSafeNonNegativeInteger(lease.releasedAt)
        && lease.releasedAt >= lease.acquiredAt
        && lease.releasedAt < lease.expiresAt));
}

function clockRegressed(lease: TaskClaimLeaseRecord, now: number): boolean {
  return !isSafeNonNegativeInteger(now)
    || now < lease.acquiredAt
    || now < lease.renewedAt
    || (lease.releasedAt !== undefined && now < lease.releasedAt);
}

export function inspectTaskClaim(
  lease: TaskClaimLeaseRecord | undefined,
  now: number,
): TaskClaimStatus {
  if (!lease) return { kind: 'unclaimed' };
  if (!isValidLease(lease) || clockRegressed(lease, now)) return { kind: 'invalid', lease };
  if (lease.releasedAt !== undefined) return { kind: 'released', lease };
  if (now >= lease.expiresAt) return { kind: 'expired', lease };
  return { kind: 'active', lease };
}

function acquireIdentityIsValid(input: TaskClaimAcquireInput): boolean {
  return input.taskId.length > 0
    && isPositiveSafeInteger(input.taskRevision)
    && isPositiveSafeInteger(input.taskAttempt)
    && input.agentId.length > 0
    && input.leaseTokenHash.length > 0
    && input.leaseFingerprint.length > 0;
}

function grantedLease(input: TaskClaimAcquireInput, fencingToken: number): TaskClaimLeaseRecord {
  return {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    taskAttempt: input.taskAttempt,
    agentId: input.agentId,
    leaseTokenHash: input.leaseTokenHash,
    leaseFingerprint: input.leaseFingerprint,
    fencingToken,
    acquiredAt: input.now,
    renewedAt: input.now,
    expiresAt: input.now + input.ttlMs,
  };
}

export function evaluateTaskClaimAcquire(
  input: TaskClaimAcquireInput,
): TaskClaimAcquireDecision {
  if (!isValidDuration(input.now, input.ttlMs)) {
    return { kind: 'rejected', reason: 'invalid-duration' };
  }
  if (!acquireIdentityIsValid(input)) return { kind: 'rejected', reason: 'invalid-claim-state' };
  if (input.ancestorAgentIds.includes(input.agentId)) {
    return { kind: 'rejected', reason: 'ancestor-agent-loop' };
  }
  if (!input.current) {
    return { kind: 'granted', reason: 'initial', lease: grantedLease(input, 1) };
  }
  const current = input.current;
  if (!isValidLease(current)) return { kind: 'rejected', reason: 'invalid-claim-state' };
  if (clockRegressed(current, input.now)) return { kind: 'rejected', reason: 'clock-regressed' };
  if (current.taskId !== input.taskId
    || current.taskRevision !== input.taskRevision
    || current.taskAttempt !== input.taskAttempt) {
    return { kind: 'rejected', reason: 'invalid-claim-state' };
  }
  const status = inspectTaskClaim(current, input.now);
  if (status.kind === 'active') {
    const duplicate = current.agentId === input.agentId
      && current.leaseTokenHash === input.leaseTokenHash
      && current.leaseFingerprint === input.leaseFingerprint;
    return duplicate
      ? { kind: 'existing', lease: current }
      : { kind: 'rejected', reason: 'active-claim-held' };
  }
  if (status.kind !== 'expired' && status.kind !== 'released') {
    return { kind: 'rejected', reason: 'invalid-claim-state' };
  }
  if (current.fencingToken === Number.MAX_SAFE_INTEGER) {
    return { kind: 'rejected', reason: 'fencing-overflow' };
  }
  return {
    kind: 'granted',
    reason: status.kind === 'expired' ? 'reopened-expired' : 'reopened-released',
    lease: grantedLease(input, current.fencingToken + 1),
  };
}

function validateProof(
  lease: TaskClaimLeaseRecord | undefined,
  proof: TaskClaimAuthorizationProof,
  now: number,
  allowReleased = false,
): TaskClaimAuthorizationFailure | undefined {
  if (!lease) return 'claim-missing';
  if (!isValidLease(lease)) return 'invalid-claim-state';
  if (clockRegressed(lease, now)) return 'clock-regressed';
  if (!Number.isSafeInteger(proof.taskRevision)
    || !Number.isSafeInteger(proof.taskAttempt)
    || !Number.isSafeInteger(proof.fencingToken)) return 'invalid-claim-state';
  if (proof.taskId !== lease.taskId) return 'task-mismatch';
  if (proof.taskRevision < lease.taskRevision) return 'stale-task-revision';
  if (proof.taskRevision > lease.taskRevision) return 'future-task-revision';
  if (proof.taskAttempt < lease.taskAttempt) return 'stale-task-attempt';
  if (proof.taskAttempt > lease.taskAttempt) return 'future-task-attempt';
  if (proof.agentId !== lease.agentId) return 'agent-mismatch';
  if (proof.presentedLeaseTokenHash !== lease.leaseTokenHash) return 'lease-token-mismatch';
  if (proof.fencingToken < lease.fencingToken) return 'stale-fencing-token';
  if (proof.fencingToken > lease.fencingToken) return 'future-fencing-token';
  if (lease.releasedAt !== undefined) return allowReleased ? undefined : 'claim-released';
  if (now >= lease.expiresAt) return 'claim-expired';
  return undefined;
}

export function evaluateTaskClaimRenew(input: TaskClaimRenewInput): TaskClaimRenewDecision {
  if (!isValidDuration(input.now, input.ttlMs)) {
    return { kind: 'rejected', reason: 'invalid-duration' };
  }
  const failure = validateProof(input.lease, input.proof, input.now);
  if (failure) return { kind: 'rejected', reason: failure };
  const lease = input.lease!;
  return {
    kind: 'renewed',
    lease: { ...lease, renewedAt: input.now, expiresAt: input.now + input.ttlMs },
  };
}

export function evaluateTaskClaimRelease(input: TaskClaimReleaseInput): TaskClaimReleaseDecision {
  const failure = validateProof(input.lease, input.proof, input.now, true);
  if (failure) return { kind: 'rejected', reason: failure };
  const lease = input.lease!;
  if (lease.releasedAt !== undefined) return { kind: 'already-released', lease };
  if (input.now >= lease.expiresAt) return { kind: 'rejected', reason: 'claim-expired' };
  return { kind: 'released', lease: { ...lease, releasedAt: input.now } };
}

export function authorizeTaskClaimWrite(
  input: AuthorizeTaskClaimWriteInput,
): TaskClaimWriteDecision {
  const failure = validateProof(input.lease, input.proof, input.now);
  return failure
    ? { kind: 'rejected', reason: failure }
    : { kind: 'authorized', lease: input.lease! };
}
