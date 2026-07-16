import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { MemoryGrantRecord, MemoryItemRecord, MemorySourceRecord } from '../src/index.js';
import {
  createCollaborativeMemorySearchService,
  type MemorySearchPermissions,
} from '../src/application/collaborative-memory-search-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const permissions: MemorySearchPermissions = {
  canSearchTeam: async (input) => input.teamId === 'team-1'
    && input.requesterUserId === 'user-1'
    && (input.targetAgentId === 'agent-1' || input.targetAgentId === 'agent-2'),
  evaluateScopeVisibility: async (input) => {
    if (input.requesterUserId !== 'user-1' || input.targetAgentId !== 'agent-1') return 'hidden';
    if (input.memoryId === 'hidden') return 'hidden';
    if (input.source?.sourceVisibility === 'private'
      || input.source?.sourceVisibility === 'dm-participants') return 'explicit-grant';
    if (input.scopeType === 'dm') return 'explicit-grant';
    if (input.scopeType === 'task' && input.scopeRef !== 'task-1') return 'hidden';
    if (input.scopeType === 'channel' && input.scopeRef !== 'channel-1') return 'hidden';
    if (input.scopeType === 'user' && input.scopeRef !== input.requesterUserId) return 'hidden';
    if (input.scopeType === 'agent' && input.scopeRef !== input.targetAgentId) return 'hidden';
    return 'visible';
  },
  isSourceAvailable: async (input) => input.requesterUserId === 'user-1'
    && input.targetAgentId === 'agent-1' && input.source.sourceId !== 'source-invalid',
};

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return {
      repositories: createSqliteRepositories({ globalDb: db, teamDb: db }),
      close: () => db.close(),
    };
  }],
] as const)('Phase 3 Collaborative Memory Search (%s)', (_name, createFixture) => {
  test('filters before deterministic Task, Channel, Agent and Team ranking', async () => {
    const fixture = createFixture();
    try {
      for (const record of [
        item('team', 'team', 'team-1'),
        item('agent', 'agent', 'agent-1'),
        item('channel', 'channel', 'channel-1'),
        item('task', 'task', 'task-1'),
        item('candidate', 'task', 'task-1', { status: 'candidate' }),
        item('expired', 'task', 'task-1', { validUntil: 1_000 }),
        item('hidden', 'channel', 'channel-1'),
        item('invalid-source', 'task', 'task-1'),
      ]) await fixture.repositories.memory.items.create(record);
      await fixture.repositories.memory.sources.create(source('invalid-source', 'source-invalid'));

      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });
      const result = await service.search({
        teamId: 'team-1', requesterUserId: 'user-1', targetAgentId: 'agent-1', taskId: 'task-1',
        channelId: 'channel-1', prompt: 'node runtime', now: 1_000, limit: 10,
      });

      expect(result.matches.map((entry) => entry.item.id)).toEqual(['task', 'channel', 'agent', 'team']);
      expect(result.matches[0]?.reasons).toContainEqual({ code: 'TASK_SCOPE_MATCH', score: 400 });
      expect(result.excluded).toEqual(expect.arrayContaining([
        { memoryId: 'candidate', reason: 'MEMORY_NOT_ACTIVE' },
        { memoryId: 'expired', reason: 'MEMORY_EXPIRED' },
        { memoryId: 'invalid-source', reason: 'MEMORY_SOURCE_UNAVAILABLE' },
      ]));
      expect(result.excluded).not.toContainEqual(expect.objectContaining({ memoryId: 'hidden' }));
    } finally {
      fixture.close();
    }
  });

  test('applies the projection gate before ranking limit truncation', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('task-unsafe', 'task', 'task-1'));
      await fixture.repositories.memory.items.create(item('team-safe', 'team', 'team-1'));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      const result = await service.search({
        ...query(), taskId: 'task-1', prompt: 'raw secret content', limit: 1,
        matchFilter: (match) => match.item.id !== 'task-unsafe',
      });

      expect(result.matches.map((entry) => entry.item.id)).toEqual(['team-safe']);
    } finally {
      fixture.close();
    }
  });

  test('uses only the current live grant and fails closed on version drift', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('private', 'dm', 'dm-1'));
      await fixture.repositories.memory.grants.create(grant(1));
      await fixture.repositories.memory.grants.create(grant(2));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search(query())).resolves.toMatchObject({
        matches: [{
          item: { id: 'private', content: 'Safe summary' }, accessMode: 'explicit-grant',
          grants: [{ id: 'grant-1', version: 2 }],
        }],
      });
      await expect(service.search({ ...query(), expectedGrantVersions: [{ id: 'grant-1', version: 1 }] }))
        .resolves.toMatchObject({
          matches: [], excluded: [],
        });
    } finally {
      fixture.close();
    }
  });

  test('does not let a task-scoped Memory bypass a private source grant', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('private-source', 'task', 'task-1'));
      await fixture.repositories.memory.sources.create(source('private-source', 'message-private', {
        sourceScopeType: 'channel', sourceScopeRef: 'private-channel', sourceVisibility: 'private',
      }));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search({ ...query(), taskId: 'task-1' })).resolves.toMatchObject({
        matches: [], excluded: [],
      });
    } finally {
      fixture.close();
    }
  });

  test('excludes revoked and expired grants', async () => {
    for (const status of ['revoked', 'expired'] as const) {
      const fixture = createFixture();
      try {
        await fixture.repositories.memory.items.create(item('private', 'dm', 'private-dm'));
        await fixture.repositories.memory.grants.create(grant(1, 'active', { sourceScopeRef: 'private-dm' }));
        await fixture.repositories.memory.grants.create(grant(2, status, { sourceScopeRef: 'private-dm' }));
        const service = createCollaborativeMemorySearchService({
          repositories: fixture.repositories.memory,
          permissions,
        });
        const result = await service.search(query());
        expect(result.matches).toEqual([]);
        expect(result.excluded).toEqual([]);
      } finally {
        fixture.close();
      }
    }
  });

  test('does not activate a future grant or leak the private Memory id', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('future-private', 'dm', 'future-dm'));
      await fixture.repositories.memory.grants.create(grant(1, 'active', {
        sourceScopeRef: 'future-dm', issuedAt: 1_500, expiresAt: 2_000,
      }));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search(query())).resolves.toEqual({ matches: [], excluded: [] });
    } finally {
      fixture.close();
    }
  });

  test('fails closed when sensitive-removed projection is not available', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('redacted-private', 'dm', 'redacted-dm'));
      await fixture.repositories.memory.grants.create(grant(1, 'active', {
        sourceScopeRef: 'redacted-dm', authorizedRedactionLevel: 'sensitive-removed',
      }));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search(query())).resolves.toEqual({ matches: [], excluded: [] });
    } finally {
      fixture.close();
    }
  });

  test('requires both requester and target Agent visibility', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('task-visible', 'task', 'task-1'));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search({ ...query(), taskId: 'task-1', requesterUserId: 'user-2' }))
        .resolves.toEqual({ matches: [], excluded: [] });
      await expect(service.search({ ...query(), taskId: 'task-1', targetAgentId: 'agent-2' }))
        .resolves.toEqual({ matches: [], excluded: [] });
    } finally {
      fixture.close();
    }
  });

  test('does not trust caller-supplied Task, Channel or User scope ids', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('other-task', 'task', 'task-2'));
      await fixture.repositories.memory.items.create(item('other-channel', 'channel', 'channel-2'));
      await fixture.repositories.memory.items.create(item('other-user', 'user', 'user-2'));
      const service = createCollaborativeMemorySearchService({
        repositories: fixture.repositories.memory,
        permissions,
      });

      await expect(service.search({
        ...query(), taskId: 'task-2', channelId: 'channel-2', userId: 'user-2',
      })).resolves.toEqual({ matches: [], excluded: [] });
    } finally {
      fixture.close();
    }
  });

  test('never returns another Team records', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item('other-team', 'team', 'team-2', { teamId: 'team-2' }));
      const service = createCollaborativeMemorySearchService({ repositories: fixture.repositories.memory, permissions });
      await expect(service.search({ ...query(), teamId: 'team-2' }))
        .resolves.toEqual({ matches: [], excluded: [] });
    } finally {
      fixture.close();
    }
  });
});

function query() {
  return {
    teamId: 'team-1', requesterUserId: 'user-1', targetAgentId: 'agent-1', channelId: 'dm-1',
    prompt: '', now: 1_000, limit: 10,
  } as const;
}

function item(
  id: string,
  scopeType: MemoryItemRecord['scopeType'],
  scopeRef: string,
  overrides: Partial<MemoryItemRecord> = {},
): MemoryItemRecord {
  return {
    schemaVersion: 1, id, teamId: 'team-1', kind: 'decision', status: 'active',
    scopeType, scopeRef, content: 'raw secret content', summary: 'Safe summary', createdAt: 10, updatedAt: 10,
    ...overrides,
  };
}

function source(
  memoryId: string,
  sourceId: string,
  overrides: Partial<MemorySourceRecord> = {},
): MemorySourceRecord {
  return {
    memoryId, teamId: 'team-1', sourceKind: 'message', sourceId,
    snapshotHash: `sha256:${sourceId}`, sourceScopeType: 'task', sourceScopeRef: 'task-1',
    sourceVisibility: 'team', createdAt: 10,
    ...overrides,
  };
}

function grant(
  version: number,
  status: MemoryGrantRecord['status'] = 'active',
  overrides: Partial<MemoryGrantRecord> = {},
): MemoryGrantRecord {
  return {
    id: 'grant-1', version, teamId: 'team-1', sourceScopeType: 'dm', sourceScopeRef: 'dm-1',
    targetAgentId: 'agent-1', authorizedContentKind: 'summary',
    authorizedRedactionLevel: 'summary-only', status, issuedByUserId: 'user-1',
    issuedAt: version, expiresAt: status === 'expired' ? 900 : 2_000,
    ...(status === 'revoked' ? { revokedAt: 500 } : {}),
    ...overrides,
  };
}
