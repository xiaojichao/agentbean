import type {
  MemoryCapsuleAuthorizationDto,
  MemoryCapsuleScopeType,
  MemoryContentKind,
  MemoryRedactionLevel,
  MemorySourceVisibility,
  MemoryStatus,
} from '@agentbean/contracts';

export type MemoryInjectionDenialReason =
  | 'MEMORY_NOT_ACTIVE'
  | 'MEMORY_EXPIRED'
  | 'MEMORY_SCOPE_NOT_VISIBLE'
  | 'MEMORY_SOURCE_UNAVAILABLE';

export type MemoryInjectionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: MemoryInjectionDenialReason };

export interface EvaluateMemoryInjectionInput {
  readonly status: MemoryStatus;
  readonly validUntil?: number;
  readonly now: number;
  readonly scopeVisible: boolean;
  readonly allSourcesAvailable: boolean;
}

/** Permission and source validity are hard gates; ranking must happen afterwards. */
export function evaluateMemoryInjection(input: EvaluateMemoryInjectionInput): MemoryInjectionDecision {
  if (input.status !== 'active') return { allowed: false, reason: 'MEMORY_NOT_ACTIVE' };
  if (input.validUntil !== undefined && input.validUntil <= input.now) {
    return { allowed: false, reason: 'MEMORY_EXPIRED' };
  }
  if (!input.scopeVisible) return { allowed: false, reason: 'MEMORY_SCOPE_NOT_VISIBLE' };
  if (!input.allSourcesAvailable) return { allowed: false, reason: 'MEMORY_SOURCE_UNAVAILABLE' };
  return { allowed: true };
}

export type MemoryCapsuleAuthorizationDenialReason =
  | 'CAPSULE_TARGET_MISMATCH'
  | 'CAPSULE_SCOPE_MISMATCH'
  | 'CAPSULE_SOURCE_REFS_HASH_MISMATCH'
  | 'CAPSULE_CONTENT_HASH_MISMATCH'
  | 'CAPSULE_CONTENT_KIND_MISMATCH'
  | 'CAPSULE_REDACTION_MISMATCH'
  | 'CAPSULE_AUTHORIZATION_NOT_YET_VALID'
  | 'CAPSULE_AUTHORIZATION_EXPIRED'
  | 'CAPSULE_POLICY_VERSION_STALE'
  | 'CAPSULE_EXPLICIT_GRANT_REQUIRED'
  | 'CAPSULE_GRANT_MISSING'
  | 'CAPSULE_GRANT_MISMATCH'
  | 'CAPSULE_GRANT_REVOKED'
  | 'CAPSULE_GRANT_EXPIRED'
  | 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN';

export type MemoryCapsuleAuthorizationDecision =
  | { readonly allowed: true; readonly decisionId: string }
  | { readonly allowed: false; readonly reason: MemoryCapsuleAuthorizationDenialReason };

export interface CurrentMemoryGrant {
  readonly id: string;
  readonly version: number;
  readonly revoked: boolean;
  readonly expiresAt?: number;
}

export interface EvaluateMemoryCapsuleAuthorizationInput {
  readonly authorization: MemoryCapsuleAuthorizationDto;
  readonly targetAgentId: string;
  readonly sourceScopeType: MemoryCapsuleScopeType;
  readonly sourceScopeRef: string;
  readonly sourceVisibility: MemorySourceVisibility;
  readonly sourceRefsHash: string;
  readonly contentHash: string;
  readonly contentKind: MemoryContentKind;
  readonly redactionLevel: MemoryRedactionLevel;
  readonly currentPolicyVersion: number;
  readonly currentGrant?: CurrentMemoryGrant;
  readonly delivery: 'server-hosted' | 'device-only';
  readonly now: number;
}

function requiresExplicitGrant(input: EvaluateMemoryCapsuleAuthorizationInput): boolean {
  if (input.delivery === 'device-only') return false;
  return input.sourceScopeType === 'dm'
    || input.sourceVisibility === 'private'
    || input.sourceVisibility === 'dm-participants'
    || input.sourceVisibility === 'local-only'
    || input.sourceScopeType === 'local-workspace';
}

/** Revalidates a Server-issued authorization at every create/inject boundary. */
export function evaluateMemoryCapsuleAuthorization(
  input: EvaluateMemoryCapsuleAuthorizationInput,
): MemoryCapsuleAuthorizationDecision {
  const authorization = input.authorization;
  if (authorization.targetAgentId !== input.targetAgentId) {
    return { allowed: false, reason: 'CAPSULE_TARGET_MISMATCH' };
  }
  if (
    authorization.sourceScopeType !== input.sourceScopeType
    || authorization.sourceScopeRef !== input.sourceScopeRef
  ) {
    return { allowed: false, reason: 'CAPSULE_SCOPE_MISMATCH' };
  }
  if (authorization.sourceRefsHash !== input.sourceRefsHash) {
    return { allowed: false, reason: 'CAPSULE_SOURCE_REFS_HASH_MISMATCH' };
  }
  if (authorization.contentHash !== input.contentHash) {
    return { allowed: false, reason: 'CAPSULE_CONTENT_HASH_MISMATCH' };
  }
  if (authorization.authorizedContentKind !== input.contentKind) {
    return { allowed: false, reason: 'CAPSULE_CONTENT_KIND_MISMATCH' };
  }
  if (authorization.authorizedRedactionLevel !== input.redactionLevel) {
    return { allowed: false, reason: 'CAPSULE_REDACTION_MISMATCH' };
  }
  if (authorization.issuedAt > input.now) {
    return { allowed: false, reason: 'CAPSULE_AUTHORIZATION_NOT_YET_VALID' };
  }
  if (authorization.expiresAt <= input.now) {
    return { allowed: false, reason: 'CAPSULE_AUTHORIZATION_EXPIRED' };
  }
  if (authorization.policyVersion !== input.currentPolicyVersion) {
    return { allowed: false, reason: 'CAPSULE_POLICY_VERSION_STALE' };
  }
  if (input.sourceVisibility === 'local-only' && input.delivery === 'server-hosted') {
    return { allowed: false, reason: 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN' };
  }

  if (requiresExplicitGrant(input) && authorization.mode !== 'explicit-grant') {
    return { allowed: false, reason: 'CAPSULE_EXPLICIT_GRANT_REQUIRED' };
  }
  if (authorization.mode === 'explicit-grant') {
    if (!authorization.grantId || authorization.grantVersion === undefined || !input.currentGrant) {
      return { allowed: false, reason: 'CAPSULE_GRANT_MISSING' };
    }
    if (
      input.currentGrant.id !== authorization.grantId
      || input.currentGrant.version !== authorization.grantVersion
    ) {
      return { allowed: false, reason: 'CAPSULE_GRANT_MISMATCH' };
    }
    if (input.currentGrant.revoked) return { allowed: false, reason: 'CAPSULE_GRANT_REVOKED' };
    if (input.currentGrant.expiresAt !== undefined && input.currentGrant.expiresAt <= input.now) {
      return { allowed: false, reason: 'CAPSULE_GRANT_EXPIRED' };
    }
  }
  return { allowed: true, decisionId: authorization.decisionId };
}
