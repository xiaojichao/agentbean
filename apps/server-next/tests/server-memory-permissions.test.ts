import { beforeEach, describe, expect, test } from 'vitest';

import type { MemorySourceRecord, ServerNextRepositories } from '../src/index.js';
import {
  canReadMemoryCapsule,
  canReadMemoryScope,
  canWriteMemoryScope,
  createServerMemorySearchPermissions,
  createServerMemoryWritePermissions,
} from '../src/application/server-memory-permissions.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('production Server Memory permissions', () => {
  let repositories: ServerNextRepositories;

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    await repositories.teams.create({
      id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-1', username: 'user', role: 'owner', joinedAt: 1,
    });
    await repositories.agents.upsert({
      id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent',
      adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online',
    });
    await repositories.channels.create({
      id: 'public-1', teamId: 'team-1', kind: 'channel', name: 'public', visibility: 'public',
      humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1,
    });
    await repositories.channels.create({
      id: 'private-1', teamId: 'team-1', kind: 'channel', name: 'private', visibility: 'private',
      humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1,
    });
    await repositories.channels.create({
      id: 'dm-1', teamId: 'team-1', kind: 'direct', name: 'dm', visibility: 'private',
      dmTargetAgentId: 'agent-1', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1,
    });
    await repositories.tasks.create({
      id: 'task-1', teamId: 'team-1', title: 'Task', status: 'in_progress', creatorId: 'user-1',
      assigneeId: 'agent-1', channelId: 'public-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
    });
  });

  test('derives team, task, channel, user and agent visibility from current truth', async () => {
    const permissions = createServerMemorySearchPermissions(repositories);
    expect(await permissions.canSearchTeam(base())).toBe(true);
    await expect(permissions.evaluateScopeVisibility(scope('team', 'team-1'))).resolves.toBe('visible');
    await expect(permissions.evaluateScopeVisibility(scope('task', 'task-1'))).resolves.toBe('visible');
    await expect(permissions.evaluateScopeVisibility(scope('channel', 'public-1'))).resolves.toBe('visible');
    await expect(permissions.evaluateScopeVisibility(scope('user', 'user-1'))).resolves.toBe('visible');
    await expect(permissions.evaluateScopeVisibility(scope('agent', 'agent-1'))).resolves.toBe('visible');
    await expect(permissions.evaluateScopeVisibility(scope('team', 'team-other'))).resolves.toBe('hidden');
  });

  test('requires an explicit grant for private/DM scopes and rejects local-only provenance', async () => {
    const permissions = createServerMemorySearchPermissions(repositories);
    await expect(permissions.evaluateScopeVisibility(scope('channel', 'private-1')))
      .resolves.toBe('explicit-grant');
    await expect(permissions.evaluateScopeVisibility(scope('dm', 'dm-1')))
      .resolves.toBe('explicit-grant');
    await expect(permissions.evaluateScopeVisibility({
      ...scope('channel', 'public-1'), source: source('manual', 'manual-1', 'local-only'),
    })).resolves.toBe('hidden');
    await expect(permissions.evaluateScopeVisibility(scope('channel', 'missing'))).resolves.toBe('hidden');
  });

  test('re-reads backing source state and fails closed when it disappears or is deleted', async () => {
    const permissions = createServerMemorySearchPermissions(repositories);
    await repositories.messages.append({
      id: 'message-1', teamId: 'team-1', channelId: 'public-1', senderKind: 'human',
      senderId: 'user-1', body: 'source', createdAt: 1,
    });
    const messageSource = source('message', 'message-1');
    await expect(permissions.isSourceAvailable({ ...base(), source: messageSource })).resolves.toBe(true);
    await repositories.messages.updateMeta({ messageId: 'message-1', meta: { deletedAt: 2 } });
    await expect(permissions.isSourceAvailable({ ...base(), source: messageSource })).resolves.toBe(false);
    await expect(permissions.isSourceAvailable({ ...base(), source: source('message', 'missing') }))
      .resolves.toBe(false);
    await expect(permissions.isSourceAvailable({ ...base(), source: source('manual', 'manual-1') }))
      .resolves.toBe(true);
  });

  test('treats an expired Memory provenance source as unavailable', async () => {
    const permissions = createServerMemorySearchPermissions(repositories);
    await repositories.memory.items.create({
      schemaVersion: 1, id: 'source-memory', teamId: 'team-1', kind: 'semantic', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content: 'source', validUntil: 100,
      createdByUserId: 'user-1', createdAt: 1, updatedAt: 1,
    });
    const memorySource = source('memory', 'source-memory');
    await expect(permissions.isSourceAvailable({ ...base(), now: 99, source: memorySource }))
      .resolves.toBe(true);
    await expect(permissions.isSourceAvailable({ ...base(), now: 100, source: memorySource }))
      .resolves.toBe(false);
  });

  test('allows public-scope reads but requires explicit channel membership for governance writes', async () => {
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-2', username: 'member', role: 'member', joinedAt: 2,
    });
    await expect(canReadMemoryScope(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', scopeType: 'channel', scopeRef: 'public-1',
    })).resolves.toBe(true);
    await expect(canReadMemoryScope(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', scopeType: 'task', scopeRef: 'task-1',
    })).resolves.toBe(true);
    await expect(canReadMemoryScope(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', scopeType: 'channel', scopeRef: 'private-1',
    })).resolves.toBe(false);
    await expect(canWriteMemoryScope(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', scopeType: 'channel', scopeRef: 'public-1',
    })).resolves.toBe(false);
    await expect(canWriteMemoryScope(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', scopeType: 'task', scopeRef: 'task-1',
    })).resolves.toBe(false);

    const writes = createServerMemoryWritePermissions(repositories);
    await expect(writes.assertWriteAuthority({
      teamId: 'team-1', actorId: 'user-2', scopeType: 'channel', scopeRef: 'public-1',
    })).rejects.toThrow('MEMORY_PERMISSION_DENIED');
    await expect(writes.assertSourceAuthority({
      teamId: 'team-1', actorId: 'user-2', sourceScopeType: 'channel', sourceScopeRef: 'public-1',
      sourceVisibility: 'team', targetScopeType: 'team', targetScopeRef: 'team-1',
    })).resolves.toBeUndefined();
    await expect(writes.assertSourceAuthority({
      teamId: 'team-1', actorId: 'user-2', sourceScopeType: 'channel', sourceScopeRef: 'public-1',
      sourceVisibility: 'team', targetScopeType: 'channel', targetScopeRef: 'public-1',
    })).rejects.toThrow('MEMORY_PERMISSION_DENIED');
    await expect(writes.assertGrantAuthority({
      teamId: 'team-1', actorId: 'user-2', sourceScopeType: 'task', sourceScopeRef: 'task-1',
      targetAgentId: 'agent-1',
    })).rejects.toThrow('MEMORY_PERMISSION_DENIED');
  });

  test('requires every Capsule manifest scope to remain visible', async () => {
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-2', username: 'member', role: 'member', joinedAt: 2,
    });
    for (const [id, scopeRef] of [
      ['memory-capsule-public-public-1', 'public-1'],
      ['memory-capsule-mixed-public-1', 'public-1'],
      ['memory-private', 'private-1'],
    ] as const) {
      await repositories.memory.items.create({
        schemaVersion: 1, id, teamId: 'team-1', kind: 'semantic', status: 'active',
        scopeType: 'channel', scopeRef, content: id, createdByUserId: 'user-1',
        createdAt: 1, updatedAt: 1,
      });
    }
    for (const capsuleId of ['capsule-public', 'capsule-mixed']) {
      await repositories.memory.capsuleRefs.create({
        id: capsuleId, teamId: 'team-1', managementRunId: 'run-1', targetAgentId: 'agent-1',
        contentHash: `sha256:${capsuleId}`, authorizationDecisionId: `decision-${capsuleId}`,
        issuedAt: 1, expiresAt: 100, createdAt: 1,
      });
    }
    await repositories.memory.capsuleItems.create(capsuleManifest('capsule-public', 'public-1'));
    await repositories.memory.capsuleItems.create(capsuleManifest('capsule-mixed', 'public-1'));
    await repositories.memory.capsuleItems.create({
      ...capsuleManifest('capsule-mixed', 'private-1'), position: 1, memoryId: 'memory-private',
    });

    await expect(canReadMemoryCapsule(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', capsuleId: 'capsule-public',
    })).resolves.toBe(true);
    await expect(canReadMemoryCapsule(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', capsuleId: 'capsule-mixed',
    })).resolves.toBe(false);
    await expect(canReadMemoryCapsule(repositories, {
      teamId: 'team-1', requesterUserId: 'user-2', capsuleId: 'capsule-empty',
    })).resolves.toBe(false);
  });
});

function capsuleManifest(capsuleId: string, scopeRef: string) {
  return {
    capsuleId, teamId: 'team-1', requesterUserId: 'user-1', memoryId: `memory-${capsuleId}-${scopeRef}`,
    position: 0, scopeType: 'channel' as const, scopeRef, sourceVisibility: 'team' as const,
    contentKind: 'summary' as const, redactionLevel: 'summary-only' as const, contentField: 'summary' as const,
    authorization: {
      schemaVersion: 1 as const, decisionId: `decision-${capsuleId}`, mode: 'scope-policy' as const,
      policyVersion: 1, targetAgentId: 'agent-1', sourceScopeType: 'channel' as const, sourceScopeRef: scopeRef,
      sourceRefsHash: 'sha256:refs', contentHash: 'sha256:content', authorizedContentKind: 'summary' as const,
      authorizedRedactionLevel: 'summary-only' as const, issuedAt: 1, expiresAt: 100,
    },
    createdAt: 1,
  };
}

function base() {
  return { teamId: 'team-1', requesterUserId: 'user-1', targetAgentId: 'agent-1', now: 50 } as const;
}

function scope(scopeType: MemorySourceRecord['sourceScopeType'], scopeRef: string) {
  return { ...base(), memoryId: 'memory-1', scopeType, scopeRef };
}

function source(
  sourceKind: MemorySourceRecord['sourceKind'],
  sourceId: string,
  sourceVisibility: MemorySourceRecord['sourceVisibility'] = 'team',
): MemorySourceRecord {
  return {
    memoryId: 'memory-1', teamId: 'team-1', sourceKind, sourceId, snapshotHash: 'hash',
    sourceScopeType: 'channel', sourceScopeRef: 'public-1', sourceVisibility, createdAt: 1,
  };
}
