import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { ServerNextRepositories } from '../src/index.js';
import {
  type CollaborativeMemorySourceInput,
  createCollaborativeMemoryService,
  type MemoryPermissions,
} from '../src/application/collaborative-memory-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

/** 默认放行的权限 collaborator；测试可覆盖 assertWriteAuthority 模拟拒绝。 */
function permissivePermissions(): MemoryPermissions {
  return {
    assertWriteAuthority: async () => undefined,
    assertSourceAuthority: async () => undefined,
    assertGrantAuthority: async () => undefined,
  };
}

function denyingPermissions(): MemoryPermissions {
  return {
    ...permissivePermissions(),
    assertWriteAuthority: async () => { throw new Error('MEMORY_SCOPE_NOT_AUTHORIZED'); },
  };
}

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly service: ReturnType<typeof createCollaborativeMemoryService>;
  readonly close(): void;
}

function makeHarness(
  repositories: ServerNextRepositories,
  permissions: MemoryPermissions = permissivePermissions(),
  now?: () => number,
): Harness {
  let tick = 1_000;
  let counter = 0;
  const clock = { now: now ?? (() => (tick += 1_000)) };
  const ids = { nextId: () => `id-${++counter}` };
  const service = createCollaborativeMemoryService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions,
    clock,
    ids,
  });
  return { repositories, service, close() {} };
}

const sourceRef = (id = 'message-1'): CollaborativeMemorySourceInput => ({
  schemaVersion: 1,
  sourceKind: 'message',
  sourceId: id,
  snapshotHash: 'sha256:source-1',
  sourceScopeType: 'dm',
  sourceScopeRef: 'dm-1',
  sourceVisibility: 'dm-participants',
});

describe.each([
  ['memory', (permissions?: MemoryPermissions, now?: () => number) => ({
    ...makeHarness(createInMemoryRepositories(), permissions, now), close() {},
  })],
  ['sqlite', (permissions?: MemoryPermissions, now?: () => number) => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return {
      ...makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db }), permissions, now),
      close: () => db.close(),
    };
  }],
] as const)('Phase 3 Collaborative Memory Service (%s)', (_name, createHarness) => {
  test('createMemory creates an active item with sources, tags and body-free audit', async () => {
    const harness = createHarness();
    try {
      const view = await harness.service.createMemory({
        teamId: 'team-1',
        actorId: 'user-1',
        kind: 'decision',
        scopeType: 'task',
        scopeRef: 'task-1',
        content: 'Use Node 24 for every package',
        summary: 'Runtime decision',
        tags: ['node-runtime', 'release-policy'],
        sourceRefs: [sourceRef()],
      });

      expect(view.item.status).toBe('active');
      expect(view.item.createdByUserId).toBe('user-1');
      expect(view.item.approvedByUserId).toBe('user-1');
      expect([...view.tags].sort()).toEqual(['node-runtime', 'release-policy']);
      expect(view.sources).toHaveLength(1);
      expect(view.sources[0]).toEqual({
        schemaVersion: 1,
        sourceKind: 'message',
        sourceId: 'message-1',
        snapshotHash: 'sha256:source-1',
      });
      const storedSources = await harness.repositories.memory.sources.listByMemory({
        teamId: 'team-1', memoryId: view.item.id,
      });
      expect(storedSources[0]).toMatchObject({
        sourceScopeType: 'dm',
        sourceScopeRef: 'dm-1',
        sourceVisibility: 'dm-participants',
      });

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: view.item.id,
      });
      expect(audit.map((event) => event.eventType)).toContain('memory-created');
      expect(audit[0].actorKind).toBe('user');
      expect(audit[0].actorId).toBe('user-1');
      // 正文三重防御：审计记录永不携带敏感正文字段。
      expect(audit[0]).not.toHaveProperty('content');
      expect(audit[0]).not.toHaveProperty('body');
    } finally {
      harness.close();
    }
  });

  test('createMemory honors asCandidate and leaves approval unset', async () => {
    const harness = createHarness();
    try {
      const view = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'preference',
        scopeType: 'team', scopeRef: 'team-1',
        content: 'Prefer tabs over spaces', asCandidate: true,
      });
      expect(view.item.status).toBe('candidate');
      expect(view.item.approvedByUserId).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  test('createMemory deduplicates identical normalized content in the same scope', async () => {
    const harness = createHarness();
    try {
      await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: '  Use Node 24  ',
      });
      await expect(harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'Use Node 24',
      })).rejects.toThrow(/MEMORY_DUPLICATE_CONTENT/);
    } finally {
      harness.close();
    }
  });

  test('createMemory rejects non-server scope', async () => {
    const harness = createHarness();
    try {
      await expect(harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        // local-workspace 属于 Device，绝不能进入 Server memory。
        scopeType: 'local-workspace' as never,
        scopeRef: 'cwd-1', content: 'leak',
      })).rejects.toThrow(/scope/i);
    } finally {
      harness.close();
    }
  });

  test('createMemory refuses unauthorized actors before touching storage', async () => {
    const denied = createHarness(denyingPermissions());
    try {
      await expect(denied.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'denied',
      })).rejects.toThrow(/MEMORY_SCOPE_NOT_AUTHORIZED/);
      // 授权失败必须发生在任何写入之前：不应残留 item。
      const items = await denied.repositories.memory.items.listByScope({
        teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
      });
      expect(items).toHaveLength(0);
    } finally {
      denied.close();
    }
  });

  test('createMemory rejects source promotion when source authority fails', async () => {
    const denied = createHarness({
      ...permissivePermissions(),
      assertSourceAuthority: async () => { throw new Error('MEMORY_SOURCE_NOT_AUTHORIZED'); },
    });
    try {
      await expect(denied.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'denied source promotion',
        sourceRefs: [sourceRef()],
      })).rejects.toThrow(/MEMORY_SOURCE_NOT_AUTHORIZED/);
      const items = await denied.repositories.memory.items.listByScope({
        teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
      });
      expect(items).toHaveLength(0);
    } finally {
      denied.close();
    }
  });

  test('updateMemory edits content and tags with optimistic concurrency', async () => {
    const harness = createHarness();
    try {
      const created = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'original', tags: ['a'],
      });
      const updated = await harness.service.updateMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.item.id,
        expectedUpdatedAt: created.item.updatedAt,
        content: 'revised', tags: ['b'],
      });
      expect(updated.item.content).toBe('revised');
      expect(updated.item.updatedAt).toBeGreaterThan(created.item.updatedAt);
      expect(updated.tags).toEqual(['b']);

      // 过期的 expectedUpdatedAt 必须失败，防止覆盖并发写入。
      await expect(harness.service.updateMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.item.id,
        expectedUpdatedAt: created.item.updatedAt, content: 'stale',
      })).rejects.toThrow(/MEMORY_UPDATE_CONFLICT/);

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: created.item.id,
      });
      expect(audit.map((event) => event.eventType)).toContain('memory-updated');
      expect(audit.map((event) => event.eventType)).toContain('tag-unlinked');
      expect(audit.map((event) => event.eventType)).toContain('tag-linked');
    } finally {
      harness.close();
    }
  });

  test('same-tick writes advance the optimistic timestamp', async () => {
    const harness = createHarness(undefined, () => 10_000);
    try {
      const created = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'same tick update',
      });
      const updated = await harness.service.updateMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.item.id,
        expectedUpdatedAt: created.item.updatedAt, content: 'updated in the same tick',
      });
      expect(updated.item.updatedAt).toBe(created.item.updatedAt + 1);

      const candidate = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'same tick candidate', asCandidate: true,
      });
      const activated = await harness.service.activateCandidate({
        teamId: 'team-1', actorId: 'user-1', memoryId: candidate.item.id,
      });
      expect(activated.item.updatedAt).toBe(candidate.item.updatedAt + 1);
    } finally {
      harness.close();
    }
  });

  test('updateMemory cannot create normalized duplicate content', async () => {
    const harness = createHarness();
    try {
      await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'canonical memory',
      });
      const editable = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'other memory',
      });

      await expect(harness.service.updateMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: editable.item.id,
        expectedUpdatedAt: editable.item.updatedAt, content: '  CANONICAL   MEMORY ',
      })).rejects.toThrow(/MEMORY_DUPLICATE_CONTENT/);
      const unchanged = await harness.repositories.memory.items.getById({
        teamId: 'team-1', id: editable.item.id,
      });
      expect(unchanged?.content).toBe('other memory');
    } finally {
      harness.close();
    }
  });

  test('activate / reject / expire enforce the status machine', async () => {
    const harness = createHarness();
    try {
      const candidate = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'candidate one', asCandidate: true,
      });
      const active = await harness.service.activateCandidate({
        teamId: 'team-1', actorId: 'user-1', memoryId: candidate.item.id,
      });
      expect(active.item.status).toBe('active');
      // 已 active 再激活非法。
      await expect(harness.service.activateCandidate({
        teamId: 'team-1', actorId: 'user-1', memoryId: candidate.item.id,
      })).rejects.toThrow(/MEMORY_INVALID_TRANSITION/);

      const candidateTwo = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'candidate two', asCandidate: true,
      });
      const rejected = await harness.service.rejectCandidate({
        teamId: 'team-1', actorId: 'user-1', memoryId: candidateTwo.item.id,
      });
      expect(rejected.item.status).toBe('rejected');
      // rejected 是终态，不能再过期。
      await expect(harness.service.expireMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: candidateTwo.item.id,
      })).rejects.toThrow(/MEMORY_INVALID_TRANSITION/);

      const expired = await harness.service.expireMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: active.item.id,
      });
      expect(expired.item.status).toBe('expired');

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: candidate.item.id,
      });
      expect(audit.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(['memory-activated']),
      );
    } finally {
      harness.close();
    }
  });

  test('supersedeMemory atomically marks the old row and creates a new active one', async () => {
    const harness = createHarness();
    try {
      const old = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'old decision',
      });
      const result = await harness.service.supersedeMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: old.item.id,
        content: 'new decision', summary: 'revised',
      });
      expect(result.created.item.status).toBe('active');
      expect(result.created.item.content).toBe('new decision');

      const reloaded = await harness.repositories.memory.items.getById({
        teamId: 'team-1', id: old.item.id,
      });
      expect(reloaded?.status).toBe('superseded');
      expect(reloaded?.supersededById).toBe(result.created.item.id);

      const oldAudit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: old.item.id,
      });
      expect(oldAudit.map((event) => event.eventType)).toContain('memory-superseded');
      const newAudit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: result.created.item.id,
      });
      expect(newAudit.map((event) => event.eventType)).toContain('memory-created');
    } finally {
      harness.close();
    }
  });

  test('supersedeMemory refuses terminal memories', async () => {
    const harness = createHarness();
    try {
      const active = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'will expire',
      });
      await harness.service.expireMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: active.item.id,
      });
      await expect(harness.service.supersedeMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: active.item.id, content: 'nope',
      })).rejects.toThrow(/MEMORY_INVALID_TRANSITION/);
    } finally {
      harness.close();
    }
  });

  test('deleteMemory soft-deletes active and candidate memories', async () => {
    const harness = createHarness();
    try {
      const active = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'to delete',
      });
      const deleted = await harness.service.deleteMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: active.item.id,
      });
      expect(deleted.item.status).toBe('deleted');
      // 已删除是终态。
      await expect(harness.service.deleteMemory({
        teamId: 'team-1', actorId: 'user-1', memoryId: active.item.id,
      })).rejects.toThrow(/MEMORY_INVALID_TRANSITION/);
      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: active.item.id,
      });
      expect(audit.map((event) => event.eventType)).toContain('memory-deleted');
    } finally {
      harness.close();
    }
  });

  test('issueGrant and revokeGrant form an immutable sequential version chain', async () => {
    const harness = createHarness();
    try {
      const issued = await harness.service.issueGrant({
        teamId: 'team-1', issuedByUserId: 'user-1',
        sourceScopeType: 'dm', sourceScopeRef: 'dm-1', targetAgentId: 'agent-1',
        authorizedContentKind: 'decision', authorizedRedactionLevel: 'summary-only',
        expiresAt: 100_000,
      });
      expect(issued.version).toBe(1);
      expect(issued.status).toBe('active');
      // 同一 grantId 不能重复签发。
      await expect(harness.service.issueGrant({
        teamId: 'team-1', issuedByUserId: 'user-1', grantId: issued.id,
        sourceScopeType: 'dm', sourceScopeRef: 'dm-1', targetAgentId: 'agent-1',
        authorizedContentKind: 'decision', authorizedRedactionLevel: 'summary-only',
        expiresAt: 100_000,
      })).rejects.toThrow(/MEMORY_GRANT_EXISTS/);

      const revoked = await harness.service.revokeGrant({
        teamId: 'team-1', actorId: 'user-1', grantId: issued.id,
      });
      expect(revoked.version).toBe(2);
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).toBeGreaterThan(issued.issuedAt);

      // 已 terminal 不能再撤销。
      await expect(harness.service.revokeGrant({
        teamId: 'team-1', actorId: 'user-1', grantId: issued.id,
      })).rejects.toThrow(/MEMORY_GRANT_NOT_ACTIVE/);
      await expect(harness.service.revokeGrant({
        teamId: 'team-1', actorId: 'user-1', grantId: 'missing',
      })).rejects.toThrow(/MEMORY_GRANT_NOT_FOUND/);

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'grant', subjectId: issued.id,
      });
      expect(audit.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(['grant-issued', 'grant-revoked']),
      );
    } finally {
      harness.close();
    }
  });

  test('issueGrant rejects an expiry that is not in the future', async () => {
    const harness = createHarness(permissivePermissions(), () => 5_000);
    try {
      await expect(harness.service.issueGrant({
        teamId: 'team-1', issuedByUserId: 'user-1', grantId: 'grant-expired',
        sourceScopeType: 'dm', sourceScopeRef: 'dm-1', targetAgentId: 'agent-1',
        authorizedContentKind: 'decision', authorizedRedactionLevel: 'summary-only',
        expiresAt: 5_000,
      })).rejects.toThrow(/MEMORY_GRANT_INVALID_EXPIRY/);
      await expect(harness.repositories.memory.grants.getCurrent({
        teamId: 'team-1', id: 'grant-expired',
      })).resolves.toBeNull();
    } finally {
      harness.close();
    }
  });

  test('issueGrant rejects a target Agent outside the source visibility', async () => {
    const denied = createHarness({
      ...permissivePermissions(),
      assertGrantAuthority: async () => { throw new Error('MEMORY_GRANT_TARGET_NOT_AUTHORIZED'); },
    });
    try {
      await expect(denied.service.issueGrant({
        teamId: 'team-1', issuedByUserId: 'user-1', grantId: 'grant-denied',
        sourceScopeType: 'dm', sourceScopeRef: 'dm-1', targetAgentId: 'agent-outsider',
        authorizedContentKind: 'decision', authorizedRedactionLevel: 'summary-only',
        expiresAt: 100_000,
      })).rejects.toThrow(/MEMORY_GRANT_TARGET_NOT_AUTHORIZED/);
      await expect(denied.repositories.memory.grants.getCurrent({
        teamId: 'team-1', id: 'grant-denied',
      })).resolves.toBeNull();
    } finally {
      denied.close();
    }
  });

  test('operations fail closed across Team boundaries', async () => {
    const harness = createHarness();
    try {
      const view = await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
        scopeType: 'team', scopeRef: 'team-1', content: 'team-1 only',
      });
      // 跨 Team 读取直接返回 not found，不泄漏存在性。
      await expect(harness.service.updateMemory({
        teamId: 'team-2', actorId: 'user-2', memoryId: view.item.id,
        expectedUpdatedAt: view.item.updatedAt, content: 'hijack',
      })).rejects.toThrow(/MEMORY_NOT_FOUND/);
      await expect(harness.service.deleteMemory({
        teamId: 'team-2', actorId: 'user-2', memoryId: view.item.id,
      })).rejects.toThrow(/MEMORY_NOT_FOUND/);
      // 原 Team 仍可操作。
      const reloaded = await harness.repositories.memory.items.getById({
        teamId: 'team-1', id: view.item.id,
      });
      expect(reloaded?.status).toBe('active');
    } finally {
      harness.close();
    }
  });

  test('linkSources attaches additional sources and audits source-linked', async () => {
    const harness = createHarness();
    try {
      await harness.service.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'task', scopeRef: 'task-1', content: 'original decision',
        sourceRefs: [sourceRef('msg-1')],
      });
      const linked = await harness.service.linkSources({
        teamId: 'team-1', actorId: 'user-1', memoryId: 'id-1',
        sourceRefs: [sourceRef('msg-2'), sourceRef('msg-3')],
      });
      expect(linked.sources.map((source) => source.sourceId).sort()).toEqual(['msg-1', 'msg-2', 'msg-3']);
      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: 'id-1',
      });
      expect(audit.map((event) => event.eventType)).toContain('source-linked');
      expect(audit.find((event) => event.eventType === 'source-linked')).not.toHaveProperty('content');
    } finally {
      harness.close();
    }
  });
});

test('createMemory and issueGrant authorize inside the Memory unit of work', async () => {
  const repositories = createInMemoryRepositories();
  let insideUnitOfWork = false;
  let counter = 0;
  const service = createCollaborativeMemoryService({
    unitOfWork: {
      async run(operation) {
        insideUnitOfWork = true;
        try {
          return await repositories.memoryUnitOfWork.run(operation);
        } finally {
          insideUnitOfWork = false;
        }
      },
    },
    permissions: {
      assertWriteAuthority: async () => {
        expect(insideUnitOfWork).toBe(true);
      },
      assertSourceAuthority: async () => {
        expect(insideUnitOfWork).toBe(true);
      },
      assertGrantAuthority: async () => {
        expect(insideUnitOfWork).toBe(true);
      },
    },
    clock: { now: () => 10_000 },
    ids: { nextId: () => `transaction-id-${++counter}` },
  });

  await service.createMemory({
    teamId: 'team-1', actorId: 'user-1', kind: 'semantic',
    scopeType: 'team', scopeRef: 'team-1', content: 'transactional authorization',
    sourceRefs: [sourceRef()],
  });
  await service.issueGrant({
    teamId: 'team-1', issuedByUserId: 'user-1', sourceScopeType: 'team',
    sourceScopeRef: 'team-1', targetAgentId: 'agent-1', authorizedContentKind: 'summary',
    authorizedRedactionLevel: 'summary-only', expiresAt: 20_000,
  });
});
