import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  MemoryAuditEventRecord,
  MemoryCandidateRecord,
  MemoryCapsuleRefRecord,
  MemoryGrantRecord,
  MemoryItemRecord,
  MemorySourceRecord,
  ServerNextRepositories,
} from '../src/index.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

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
] as const)('Phase 3 Memory Unit of Work (%s)', (_name, createFixture) => {
  test('atomically creates item, immutable source, tag, grant, and body-free audit', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.items.create(item());
        await memory.sources.create(source());
        await memory.tags.create(tag());
        await memory.grants.create(grant());
        await memory.auditEvents.append(audit());
      });

      await expect(fixture.repositories.memory.items.getById({ teamId: 'team-1', id: 'memory-1' }))
        .resolves.toMatchObject({ scopeType: 'task', scopeRef: 'task-1', status: 'active' });
      await expect(fixture.repositories.memory.sources.listByMemory({
        teamId: 'team-1', memoryId: 'memory-1',
      })).resolves.toMatchObject([{ sourceId: 'message-1', snapshotHash: 'sha256:source-1' }]);
      await expect(fixture.repositories.memory.tags.listByMemory({
        teamId: 'team-1', memoryId: 'memory-1',
      })).resolves.toMatchObject([{ tag: 'node-runtime' }]);
      await expect(fixture.repositories.memory.grants.getCurrent({ teamId: 'team-1', id: 'grant-1' }))
        .resolves.toMatchObject({ version: 1, status: 'active' });
      await expect(fixture.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: 'memory-1',
      })).resolves.toMatchObject([{ eventType: 'memory-created', contentHash: 'sha256:content' }]);
    } finally {
      fixture.close();
    }
  });

  test('fails closed across Team boundaries', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.items.create(item());
        await memory.sources.create(source());
        await memory.tags.create(tag());
        await memory.grants.create(grant());
        await memory.auditEvents.append(audit());
      });

      await expect(fixture.repositories.memory.items.getById({ teamId: 'team-2', id: 'memory-1' }))
        .resolves.toBeNull();
      await expect(fixture.repositories.memory.sources.listByMemory({
        teamId: 'team-2', memoryId: 'memory-1',
      })).resolves.toEqual([]);
      await expect(fixture.repositories.memory.tags.listByMemory({
        teamId: 'team-2', memoryId: 'memory-1',
      })).resolves.toEqual([]);
      await expect(fixture.repositories.memory.grants.getCurrent({ teamId: 'team-2', id: 'grant-1' }))
        .resolves.toBeNull();
      await expect(fixture.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-2', subjectKind: 'memory', subjectId: 'memory-1',
      })).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('rolls back every Memory table when one write fails', async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.items.create(item('memory-rollback'));
        const firstSource = source('memory-rollback');
        await memory.sources.create(firstSource);
        await memory.tags.create(tag('memory-rollback'));
        await memory.grants.create(grant('grant-rollback'));
        await memory.auditEvents.append(audit('memory-rollback', 'audit-rollback'));
        await memory.sources.create({ ...firstSource, snapshotHash: 'sha256:drifted-source' });
      })).rejects.toThrow(/memory source|unique/i);

      await expect(fixture.repositories.memory.items.getById({
        teamId: 'team-1', id: 'memory-rollback',
      })).resolves.toBeNull();
      await expect(fixture.repositories.memory.sources.listByMemory({
        teamId: 'team-1', memoryId: 'memory-rollback',
      })).resolves.toEqual([]);
      await expect(fixture.repositories.memory.tags.listByMemory({
        teamId: 'team-1', memoryId: 'memory-rollback',
      })).resolves.toEqual([]);
      await expect(fixture.repositories.memory.grants.getCurrent({
        teamId: 'team-1', id: 'grant-rollback',
      })).resolves.toBeNull();
      await expect(fixture.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: 'memory-rollback',
      })).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('uses optimistic item updates and immutable sequential grant versions', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memory.items.create(item());
      const updated = { ...item(), summary: 'Updated', updatedAt: 2 };
      await expect(fixture.repositories.memory.items.update({
        record: updated, expectedUpdatedAt: 1,
      })).resolves.toMatchObject({ summary: 'Updated', updatedAt: 2 });
      await expect(fixture.repositories.memory.items.update({
        record: { ...updated, updatedAt: 3 }, expectedUpdatedAt: 1,
      })).resolves.toBeNull();
      await expect(fixture.repositories.memory.items.update({
        record: { ...updated, createdAt: 2, updatedAt: 3 }, expectedUpdatedAt: 2,
      })).rejects.toThrow(/immutable identity/);
      await expect(fixture.repositories.memory.items.update({
        record: updated, expectedUpdatedAt: 2,
      })).rejects.toThrow(/update time must advance/);

      await fixture.repositories.memory.grants.create(grant());
      await fixture.repositories.memory.grants.create({
        ...grant(), version: 2, status: 'revoked', issuedAt: 2, expiresAt: 101, revokedAt: 3,
      });
      await expect(fixture.repositories.memory.grants.getCurrent({ teamId: 'team-1', id: 'grant-1' }))
        .resolves.toMatchObject({ version: 2, status: 'revoked', revokedAt: 3 });
      await expect(fixture.repositories.memory.grants.create({
        ...grant(), version: 4, issuedAt: 4, expiresAt: 104,
      })).rejects.toThrow(/sequential/);
      await expect(fixture.repositories.memory.grants.create({
        ...grant(), version: 3, status: 'active', issuedAt: 4, expiresAt: 104,
      })).rejects.toThrow(/terminal/);
    } finally {
      fixture.close();
    }
  });

  test('rejects local-only Server data, invalid tags, cross-Team sources, and audit bodies', async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.repositories.memory.items.create({
        ...item(), scopeType: 'local-workspace',
      } as unknown as MemoryItemRecord)).rejects.toThrow(/scope/);

      await fixture.repositories.memory.items.create(item());
      await expect(fixture.repositories.memory.sources.create({
        ...source(), sourceVisibility: 'local-only',
      })).rejects.toThrow(/Device/);
      await expect(fixture.repositories.memory.sources.create({
        ...source(), teamId: 'team-2',
      })).rejects.toThrow(/Team|foreign key/i);
      await expect(fixture.repositories.memory.tags.create({
        ...tag(), tag: 'Invalid Tag',
      })).rejects.toThrow(/lowercase slug|check constraint/i);
      await expect(fixture.repositories.memory.auditEvents.append({
        ...audit(), content: 'must never persist',
      } as MemoryAuditEventRecord & { content: string })).rejects.toThrow(/sensitive body/);

      await expect(fixture.repositories.memory.auditEvents.append({
        ...audit('cwd-hash-1', 'audit-local-deny'),
        subjectKind: 'capsule',
        eventType: 'capsule-denied',
        scopeType: 'local-workspace',
        scopeRef: 'cwd-hash-1',
      })).resolves.toMatchObject({ eventType: 'capsule-denied' });
    } finally {
      fixture.close();
    }
  });

  test('persists Capsule refs with Team isolation, denial window and run scoping', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.capsuleRefs.create(capsuleRef('cap-1', 'run-1'));
      });
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.capsuleRefs.create(capsuleRef('cap-1', 'run-1'));
      })).rejects.toThrow(/already exists/i);
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.capsuleRefs.create({ ...capsuleRef('cap-bad', 'run-1'), expiresAt: 1 });
          // expiresAt <= issuedAt 校验应失败。
      })).rejects.toThrow(/expiry must follow issue time/i);

      const loaded = await fixture.repositories.memory.capsuleRefs.getById({ teamId: 'team-1', id: 'cap-1' });
      expect(loaded).toMatchObject({ id: 'cap-1', targetAgentId: 'agent-1' });
      expect(loaded?.deniedAt).toBeUndefined();
      await expect(fixture.repositories.memory.capsuleRefs.getById({ teamId: 'team-2', id: 'cap-1' }))
        .resolves.toBeNull();
      await expect(fixture.repositories.memory.capsuleRefs.listByRun({ teamId: 'team-1', managementRunId: 'run-1' }))
        .resolves.toMatchObject([{ id: 'cap-1' }]);
      await expect(fixture.repositories.memory.capsuleRefs.listByRun({ teamId: 'team-1', managementRunId: 'run-2' }))
        .resolves.toEqual([]);

      // deniedAt 必须落在 [issuedAt, expiresAt] 内且不可重复 deny。
      await expect(fixture.repositories.memory.capsuleRefs.markDenied({
        teamId: 'team-1', id: 'cap-1', deniedAt: 99_999,
      })).rejects.toThrow(/validity window/i);
      const denied = await fixture.repositories.memory.capsuleRefs.markDenied({
        teamId: 'team-1', id: 'cap-1', deniedAt: 5_000,
      });
      expect(denied).toMatchObject({ deniedAt: 5_000 });
      await expect(fixture.repositories.memory.capsuleRefs.markDenied({
        teamId: 'team-1', id: 'cap-1', deniedAt: 6_000,
      })).rejects.toThrow(/already denied/i);
      await expect(fixture.repositories.memory.capsuleRefs.markDenied({
        teamId: 'team-1', id: 'missing', deniedAt: 5_000,
      })).resolves.toBeNull();
    } finally {
      fixture.close();
    }
  });

  test('persists Candidates with projection-hash dedup, Team isolation and run scoping', async () => {
    const fixture = createFixture();
    try {
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create(candidate('cand-1', 'run-1', 'sha256:proj-a'));
      });
      // 同 projectionHash 重复（去重闸门）—— 不同 id 也拒。
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create(candidate('cand-2', 'run-1', 'sha256:proj-a'));
      })).rejects.toThrow(/projection hash already exists/i);
      // 同 id 重复也拒。
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create(candidate('cand-1', 'run-1', 'sha256:proj-a'));
      })).rejects.toThrow(/already exists/i);
      // projectionHash 不同 → 允许。
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create(candidate('cand-3', 'run-1', 'sha256:proj-b'));
      });
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create({
          ...candidate('cand-decided-without-time', 'run-1', 'sha256:proj-c'),
          status: 'accepted',
        });
      })).rejects.toThrow(/decision time must match a terminal status/i);
      await expect(fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create({
          ...candidate('cand-pending-with-time', 'run-1', 'sha256:proj-d'),
          decidedAt: 1_001,
        });
      })).rejects.toThrow(/decision time must match a terminal status/i);
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        await memory.candidates.create({
          ...candidate('cand-decided', 'run-decided', 'sha256:proj-e'),
          status: 'accepted',
          decidedAt: 1_001,
        });
      });

      await expect(fixture.repositories.memory.candidates.getById({ teamId: 'team-1', id: 'cand-1' }))
        .resolves.toMatchObject({ id: 'cand-1', status: 'candidate', proposedContent: 'Use Node 24' });
      await expect(fixture.repositories.memory.candidates.getById({ teamId: 'team-1', id: 'cand-decided' }))
        .resolves.toMatchObject({ status: 'accepted', decidedAt: 1_001 });
      await expect(fixture.repositories.memory.candidates.getById({ teamId: 'team-2', id: 'cand-1' }))
        .resolves.toBeNull();
      await expect(fixture.repositories.memory.candidates.getByProjectionHash({
        teamId: 'team-1', projectionHash: 'sha256:proj-a',
      })).resolves.toMatchObject({ id: 'cand-1' });
      await expect(fixture.repositories.memory.candidates.getByProjectionHash({
        teamId: 'team-1', projectionHash: 'sha256:missing',
      })).resolves.toBeNull();
      await expect(fixture.repositories.memory.candidates.listByRun({ teamId: 'team-1', managementRunId: 'run-1' }))
        .resolves.toMatchObject([{ id: 'cand-1' }, { id: 'cand-3' }]);
      await expect(fixture.repositories.memory.candidates.listByRun({ teamId: 'team-1', managementRunId: 'run-2' }))
        .resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

describe('Phase 3 Memory migration', () => {
  test('applies 0015, 0016 and 0017 once with Team/scope constraints and no content in audit', () => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      applyTeamMigrations(db);
      applyTeamMigrations(db);

      expect(db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations
        WHERE id = 'team/0015_management_phase_3_memory.sql'`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations
        WHERE id = 'team/0016_management_phase_3_capsule_refs.sql'`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations
        WHERE id = 'team/0017_management_phase_3_candidates.sql'`).get()).toEqual({ count: 1 });
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name LIKE 'memory_%' ORDER BY name`).all().map((value) => (value as { name: string }).name);
      expect(tables).toEqual([
        'memory_audit_events', 'memory_candidates', 'memory_capsule_refs', 'memory_grants',
        'memory_items', 'memory_sources', 'memory_tags',
      ]);
      const auditColumns = db.prepare("SELECT name FROM pragma_table_info('memory_audit_events')")
        .all().map((value) => (value as { name: string }).name);
      expect(auditColumns).not.toEqual(expect.arrayContaining(['content', 'body', 'prompt', 'before_json', 'after_json']));
    } finally {
      db.close();
    }
  });

  test('rolls back all Memory schema when the 0015 ledger write fails', () => {
    const db = legacyTeamDatabase();
    try {
      db.exec(`CREATE TRIGGER reject_0015_ledger BEFORE INSERT ON schema_migrations
        WHEN NEW.id = 'team/0015_management_phase_3_memory.sql'
        BEGIN SELECT RAISE(ABORT, 'reject 0015 ledger'); END;`);
      expect(() => applyTeamMigrations(db)).toThrow(/reject 0015 ledger/);
      expect(db.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'memory_items'`).get()).toBeUndefined();
      expect(db.prepare(`SELECT id FROM schema_migrations
        WHERE id = 'team/0015_management_phase_3_memory.sql'`).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

function item(id = 'memory-1'): MemoryItemRecord {
  return {
    schemaVersion: 1,
    id,
    teamId: 'team-1',
    kind: 'decision',
    status: 'active',
    scopeType: 'task',
    scopeRef: 'task-1',
    content: 'Use Node 24',
    summary: 'Runtime decision',
    confidence: 1,
    createdByUserId: 'user-1',
    approvedByUserId: 'user-1',
    validFrom: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function source(memoryId = 'memory-1'): MemorySourceRecord {
  return {
    memoryId,
    teamId: 'team-1',
    sourceKind: 'message',
    sourceId: 'message-1',
    snapshotHash: 'sha256:source-1',
    sourceScopeType: 'task',
    sourceScopeRef: 'task-1',
    sourceVisibility: 'team',
    createdAt: 1,
  };
}

function tag(memoryId = 'memory-1') {
  return { memoryId, teamId: 'team-1', tag: 'node-runtime', createdAt: 1 };
}

function grant(id = 'grant-1'): MemoryGrantRecord {
  return {
    id,
    version: 1,
    teamId: 'team-1',
    sourceScopeType: 'task',
    sourceScopeRef: 'task-1',
    targetAgentId: 'agent-1',
    authorizedContentKind: 'decision',
    authorizedRedactionLevel: 'summary-only',
    status: 'active',
    issuedByUserId: 'user-1',
    issuedAt: 1,
    expiresAt: 100,
  };
}

function audit(subjectId = 'memory-1', id = 'audit-1'): MemoryAuditEventRecord {
  return {
    id,
    teamId: 'team-1',
    subjectKind: 'memory',
    subjectId,
    eventType: 'memory-created',
    actorKind: 'user',
    actorId: 'user-1',
    scopeType: 'task',
    scopeRef: 'task-1',
    sourceRefs: [{
      schemaVersion: 1,
      sourceKind: 'message',
      sourceId: 'message-1',
      snapshotHash: 'sha256:source-1',
    }],
    sourceRefsHash: 'sha256:refs',
    contentHash: 'sha256:content',
    redactionLevel: 'summary-only',
    createdAt: 1,
  };
}

function capsuleRef(id = 'cap-1', managementRunId = 'run-1'): MemoryCapsuleRefRecord {
  return {
    id,
    teamId: 'team-1',
    managementRunId,
    targetAgentId: 'agent-1',
    contentHash: 'sha256:capsule-content',
    authorizationDecisionId: 'decision-1',
    issuedAt: 1_000,
    expiresAt: 10_000,
    createdAt: 1_000,
  };
}

function candidate(id = 'cand-1', managementRunId = 'run-1', projectionHash = 'sha256:proj-a'): MemoryCandidateRecord {
  return {
    id,
    teamId: 'team-1',
    managementRunId,
    sourceAgentId: 'agent-1',
    sourceInvocationId: 'invocation-1',
    sourceRefs: [{
      schemaVersion: 1,
      sourceKind: 'invocation',
      sourceId: 'invocation-1',
      snapshotHash: 'sha256:invocation-1',
    }],
    contentKind: 'decision',
    proposedContent: 'Use Node 24',
    projectionHash,
    status: 'candidate',
    conflictMemoryIds: [],
    createdAt: 1_000,
  };
}

function legacyTeamDatabase(): DatabaseWithClose {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);
  const migrations = [
    '0001_first_slice',
    '0002_artifacts_workspace_runs',
    '0003_tasks',
    '0004_reactions_saved',
    '0005_workspace_run_command',
    '0006_workspace_run_log_excerpt',
    '0007_workspace_run_pagination_index',
    '0008_artifact_workspace_boundary_index',
    '0009_pinned_messages',
    '0010_management_phase_1',
    '0011_management_shadow_namespace',
    '0012_management_frozen_target',
    '0013_management_phase_2_task_dag',
    '0014_management_phase_2_rollout',
  ];
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, 1)');
  for (const migration of migrations) insert.run(`team/${migration}.sql`);
  return db;
}
