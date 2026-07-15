import { beforeEach, describe, expect, test } from 'vitest';

import type { MemorySourceRecord, ServerNextRepositories } from '../src/index.js';
import { createServerMemorySearchPermissions } from '../src/application/server-memory-permissions.js';
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
});

function base() {
  return { teamId: 'team-1', requesterUserId: 'user-1', targetAgentId: 'agent-1' } as const;
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
