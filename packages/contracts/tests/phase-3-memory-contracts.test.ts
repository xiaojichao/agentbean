import { describe, expect, test } from 'vitest';

import {
  LOCAL_MEMORY_SCOPE_TYPES,
  MEMORY_SCOPE_TYPES,
  type MemoryCandidateDto,
  type MemoryCapsuleDto,
  type MemoryRecordDto,
} from '../src/index.js';

describe('Phase 3 Memory contracts', () => {
  test('keeps Device-local scopes out of Server Memory records', () => {
    expect(MEMORY_SCOPE_TYPES).toEqual(['team', 'channel', 'dm', 'task', 'agent', 'user']);
    expect(MEMORY_SCOPE_TYPES).not.toContain('local-workspace');
    expect(LOCAL_MEMORY_SCOPE_TYPES).toEqual(['local-workspace', 'local-agent', 'local-profile']);
  });

  test('binds a task-scoped record to immutable source snapshots', () => {
    const memory: MemoryRecordDto = {
      schemaVersion: 1,
      id: 'memory-1',
      teamId: 'team-1',
      kind: 'decision',
      status: 'active',
      scopeType: 'task',
      scopeRef: 'task-1',
      content: 'Use Node 24',
      tags: ['runtime'],
      sourceRefs: [{
        schemaVersion: 1,
        sourceKind: 'message',
        sourceId: 'message-1',
        snapshotHash: 'sha256:source',
      }],
      createdByUserId: 'user-1',
      createdAt: 10,
      updatedAt: 10,
    };

    expect(memory.scopeType).toBe('task');
    expect(memory.sourceRefs[0]?.snapshotHash).toBe('sha256:source');
  });

  test('binds Capsule content and authorization to the target Agent', () => {
    const capsule: MemoryCapsuleDto = {
      schemaVersion: 1,
      id: 'capsule-1',
      teamId: 'team-1',
      managementRunId: 'run-1',
      taskId: 'task-1',
      targetAgentId: 'agent-1',
      items: [{
        schemaVersion: 1,
        memoryId: 'memory-1',
        scopeType: 'task',
        scopeRef: 'task-1',
        sourceVisibility: 'team',
        contentKind: 'decision',
        redactionLevel: 'summary-only',
        content: 'Use Node 24',
        sourceRefs: [{
          schemaVersion: 1,
          sourceKind: 'message',
          sourceId: 'message-1',
          snapshotHash: 'sha256:source',
        }],
        authorization: {
          schemaVersion: 1,
          decisionId: 'decision-1',
          mode: 'scope-policy',
          policyVersion: 1,
          targetAgentId: 'agent-1',
          sourceScopeType: 'task',
          sourceScopeRef: 'task-1',
          sourceRefsHash: 'sha256:refs',
          contentHash: 'sha256:content',
          authorizedContentKind: 'decision',
          authorizedRedactionLevel: 'summary-only',
          issuedAt: 10,
          expiresAt: 20,
        },
      }],
      createdAt: 10,
      expiresAt: 20,
    };

    expect(capsule.items[0]?.authorization.targetAgentId).toBe(capsule.targetAgentId);
  });

  test('models an external Agent result as a candidate, not active Memory', () => {
    const candidate: MemoryCandidateDto = {
      schemaVersion: 1,
      id: 'candidate-1',
      teamId: 'team-1',
      managementRunId: 'run-1',
      taskId: 'task-1',
      sourceAgentId: 'agent-1',
      sourceInvocationId: 'invocation-1',
      sourceRefs: [{
        schemaVersion: 1,
        sourceKind: 'invocation',
        sourceId: 'invocation-1',
        snapshotHash: 'sha256:invocation',
      }],
      contentKind: 'fact',
      proposedContent: 'The verification command is npm test',
      projectionHash: 'sha256:candidate',
      status: 'candidate',
      conflictMemoryIds: [],
      createdAt: 10,
    };

    expect(candidate.status).toBe('candidate');
    expect(candidate).not.toHaveProperty('scopeType');
  });
});
