import { beforeEach, describe, expect, test } from 'vitest';

import type { ServerNextRepositories } from '../src/index.js';
import { createMemoryGovernanceService } from '../src/application/memory-governance-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('Memory governance snapshot', () => {
  let repositories: ServerNextRepositories;

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    await repositories.teams.create({
      id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-2', username: 'member', role: 'member', joinedAt: 1,
    });
    await repositories.memory.items.create({
      schemaVersion: 1, id: 'team-memory', teamId: 'team-1', kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content: 'Use Node 24', createdByUserId: 'user-1',
      createdAt: 1, updatedAt: 2,
    });
    await repositories.memory.items.create({
      schemaVersion: 1, id: 'private-memory', teamId: 'team-1', kind: 'preference', status: 'active',
      scopeType: 'user', scopeRef: 'user-1', content: 'Private preference', createdByUserId: 'user-1',
      createdAt: 1, updatedAt: 3,
    });
    await repositories.memory.sources.create({
      memoryId: 'team-memory', teamId: 'team-1', sourceKind: 'manual', sourceId: 'manual-1',
      snapshotHash: 'sha256:manual', sourceScopeType: 'team', sourceScopeRef: 'team-1',
      sourceVisibility: 'team', createdAt: 1,
    });
  });

  test('returns body-bearing collaborative Memory only for currently visible scopes', async () => {
    const service = createMemoryGovernanceService({ repositories, clock: { now: () => 100 } });
    const owner = await service.getSnapshot({ teamId: 'team-1', userId: 'user-1' });
    const member = await service.getSnapshot({ teamId: 'team-1', userId: 'user-2' });

    expect(owner.memories.map((memory) => memory.id)).toEqual(['private-memory', 'team-memory']);
    expect(member.memories.map((memory) => memory.id)).toEqual(['team-memory']);
    expect(member.memories[0]).toMatchObject({
      content: 'Use Node 24',
      sourceState: 'valid',
      sourceRefs: [{ sourceKind: 'manual', sourceId: 'manual-1' }],
    });
  });

  test('fails closed after Team membership is removed', async () => {
    const service = createMemoryGovernanceService({ repositories, clock: { now: () => 100 } });
    await repositories.teams.removeMember({ teamId: 'team-1', userId: 'user-2' });
    await expect(service.getSnapshot({ teamId: 'team-1', userId: 'user-2' }))
      .rejects.toThrow('MEMORY_PERMISSION_DENIED');
  });
});
