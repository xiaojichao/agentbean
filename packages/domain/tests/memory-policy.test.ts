import { describe, expect, test } from 'vitest';

import type { MemoryCapsuleAuthorizationDto } from '@agentbean/contracts';
import {
  evaluateMemoryCapsuleAuthorization,
  evaluateMemoryInjection,
  type EvaluateMemoryCapsuleAuthorizationInput,
} from '../src/index.js';

const authorization: MemoryCapsuleAuthorizationDto = {
  schemaVersion: 1,
  decisionId: 'decision-1',
  mode: 'scope-policy',
  policyVersion: 3,
  targetAgentId: 'agent-1',
  sourceScopeType: 'task',
  sourceScopeRef: 'task-1',
  sourceRefsHash: 'sha256:refs',
  contentHash: 'sha256:content',
  authorizedContentKind: 'decision',
  authorizedRedactionLevel: 'summary-only',
  issuedAt: 10,
  expiresAt: 100,
};

const baseInput: EvaluateMemoryCapsuleAuthorizationInput = {
  authorization,
  targetAgentId: 'agent-1',
  sourceScopeType: 'task',
  sourceScopeRef: 'task-1',
  sourceVisibility: 'team',
  sourceRefsHash: 'sha256:refs',
  contentHash: 'sha256:content',
  contentKind: 'decision',
  redactionLevel: 'summary-only',
  currentPolicyVersion: 3,
  delivery: 'server-hosted',
  now: 50,
};

describe('Phase 3 Memory policy', () => {
  test('filters permission and source validity before relevance ranking', () => {
    expect(evaluateMemoryInjection({
      status: 'candidate', now: 10, scopeVisible: true, allSourcesAvailable: true,
    })).toEqual({ allowed: false, reason: 'MEMORY_NOT_ACTIVE' });
    expect(evaluateMemoryInjection({
      status: 'active', validUntil: 10, now: 10, scopeVisible: true, allSourcesAvailable: true,
    })).toEqual({ allowed: false, reason: 'MEMORY_EXPIRED' });
    expect(evaluateMemoryInjection({
      status: 'active', now: 10, scopeVisible: false, allSourcesAvailable: true,
    })).toEqual({ allowed: false, reason: 'MEMORY_SCOPE_NOT_VISIBLE' });
    expect(evaluateMemoryInjection({
      status: 'active', now: 10, scopeVisible: true, allSourcesAvailable: false,
    })).toEqual({ allowed: false, reason: 'MEMORY_SOURCE_UNAVAILABLE' });
    expect(evaluateMemoryInjection({
      status: 'active', now: 10, scopeVisible: true, allSourcesAvailable: true,
    })).toEqual({ allowed: true });
  });

  test('allows an unchanged ordinary scope-policy decision', () => {
    expect(evaluateMemoryCapsuleAuthorization(baseInput)).toEqual({
      allowed: true,
      decisionId: 'decision-1',
    });
  });

  test.each([
    ['targetAgentId', 'agent-2', 'CAPSULE_TARGET_MISMATCH'],
    ['sourceScopeRef', 'task-2', 'CAPSULE_SCOPE_MISMATCH'],
    ['sourceRefsHash', 'sha256:other', 'CAPSULE_SOURCE_REFS_HASH_MISMATCH'],
    ['contentHash', 'sha256:other', 'CAPSULE_CONTENT_HASH_MISMATCH'],
    ['contentKind', 'fact', 'CAPSULE_CONTENT_KIND_MISMATCH'],
    ['redactionLevel', 'none', 'CAPSULE_REDACTION_MISMATCH'],
    ['currentPolicyVersion', 4, 'CAPSULE_POLICY_VERSION_STALE'],
  ] as const)('fails closed when %s drifts', (key, value, reason) => {
    expect(evaluateMemoryCapsuleAuthorization({ ...baseInput, [key]: value })).toEqual({
      allowed: false,
      reason,
    });
  });

  test('fails closed when the authorization expires', () => {
    expect(evaluateMemoryCapsuleAuthorization({ ...baseInput, now: 100 })).toEqual({
      allowed: false,
      reason: 'CAPSULE_AUTHORIZATION_EXPIRED',
    });
  });

  test('fails closed when the authorization was issued in the future', () => {
    expect(evaluateMemoryCapsuleAuthorization({
      ...baseInput,
      authorization: { ...authorization, issuedAt: 51 },
    })).toEqual({ allowed: false, reason: 'CAPSULE_AUTHORIZATION_NOT_YET_VALID' });
  });

  test('requires a live explicit grant for DM and private sources', () => {
    expect(evaluateMemoryCapsuleAuthorization({
      ...baseInput,
      sourceScopeType: 'dm',
      sourceScopeRef: 'dm-1',
      sourceVisibility: 'dm-participants',
      authorization: { ...authorization, sourceScopeType: 'dm', sourceScopeRef: 'dm-1' },
    })).toEqual({ allowed: false, reason: 'CAPSULE_EXPLICIT_GRANT_REQUIRED' });

    const explicitAuthorization: MemoryCapsuleAuthorizationDto = {
      ...authorization,
      mode: 'explicit-grant',
      grantId: 'grant-1',
      grantVersion: 2,
      sourceScopeType: 'dm',
      sourceScopeRef: 'dm-1',
    };
    const explicitInput: EvaluateMemoryCapsuleAuthorizationInput = {
      ...baseInput,
      authorization: explicitAuthorization,
      sourceScopeType: 'dm',
      sourceScopeRef: 'dm-1',
      sourceVisibility: 'dm-participants',
      currentGrant: { id: 'grant-1', version: 2, revoked: false },
    };

    expect(evaluateMemoryCapsuleAuthorization(explicitInput)).toEqual({
      allowed: true,
      decisionId: 'decision-1',
    });
    expect(evaluateMemoryCapsuleAuthorization({
      ...explicitInput,
      currentGrant: { id: 'grant-1', version: 2, revoked: true },
    })).toEqual({ allowed: false, reason: 'CAPSULE_GRANT_REVOKED' });
  });

  test('does not let device-only delivery bypass private-source grants', () => {
    expect(evaluateMemoryCapsuleAuthorization({
      ...baseInput,
      delivery: 'device-only',
      sourceScopeType: 'dm',
      sourceScopeRef: 'dm-1',
      sourceVisibility: 'dm-participants',
      authorization: { ...authorization, sourceScopeType: 'dm', sourceScopeRef: 'dm-1' },
    })).toEqual({ allowed: false, reason: 'CAPSULE_EXPLICIT_GRANT_REQUIRED' });
  });

  test('never puts local Workspace content into a Server-hosted Capsule', () => {
    const localInput: EvaluateMemoryCapsuleAuthorizationInput = {
      ...baseInput,
      sourceScopeType: 'local-workspace',
      sourceScopeRef: 'cwd-hash-1',
      sourceVisibility: 'local-only',
      authorization: {
        ...authorization,
        sourceScopeType: 'local-workspace',
        sourceScopeRef: 'cwd-hash-1',
      },
    };

    expect(evaluateMemoryCapsuleAuthorization(localInput)).toEqual({
      allowed: false,
      reason: 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN',
    });

    const explicitLocalInput: EvaluateMemoryCapsuleAuthorizationInput = {
      ...localInput,
      sourceVisibility: 'team',
      authorization: {
        ...localInput.authorization,
        mode: 'explicit-grant',
        grantId: 'grant-local',
        grantVersion: 1,
      },
      currentGrant: { id: 'grant-local', version: 1, revoked: false },
    };
    expect(evaluateMemoryCapsuleAuthorization(explicitLocalInput)).toEqual({
      allowed: false,
      reason: 'CAPSULE_LOCAL_ONLY_SERVER_FORBIDDEN',
    });
    expect(evaluateMemoryCapsuleAuthorization({ ...explicitLocalInput, delivery: 'device-only' })).toEqual({
      allowed: true,
      decisionId: 'decision-1',
    });
  });
});
