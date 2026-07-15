import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { MemoryCandidateRecord, MemoryCandidateSourceRecord } from '../src/application/memory-repositories.js';
import {
  createInMemoryMemoryRepositories,
  createMemoryRepositoryMemoryState,
} from '../src/infra/memory/memory-repositories.js';
import {
  applyTeamMigrations,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createSqliteMemoryRepositories } from '../src/infra/sqlite/memory-repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

function candidateRecord(overrides: Partial<MemoryCandidateRecord> = {}): MemoryCandidateRecord {
  return {
    schemaVersion: 1,
    id: 'cand-1',
    teamId: 'team-1',
    managementRunId: 'run-1',
    sourceAgentId: 'agent-1',
    sourceInvocationId: 'inv-1',
    targetAgentId: 'target-agent-1',
    scopeType: 'task',
    scopeRef: 'task-1',
    contentKind: 'decision',
    proposedContent: '使用 node-pty spawn 子进程',
    projectionHash: 'sha256:proj-1',
    status: 'candidate',
    conflictMemoryIds: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function candidateSourceRecord(overrides: Partial<MemoryCandidateSourceRecord> = {}): MemoryCandidateSourceRecord {
  return {
    candidateId: 'cand-1',
    teamId: 'team-1',
    sourceKind: 'message',
    sourceId: 'msg-1',
    snapshotHash: 'sha256:snap-1',
    sourceScopeType: 'task',
    sourceScopeRef: 'task-1',
    sourceVisibility: 'team',
    createdAt: 1000,
    ...overrides,
  };
}

interface Harness {
  readonly repos: ReturnType<typeof createInMemoryMemoryRepositories>;
  readonly close(): void;
}

describe.each([
  ['memory', (): Harness => ({
    repos: createInMemoryMemoryRepositories(createMemoryRepositoryMemoryState()),
    close() {},
  })],
  ['sqlite', (): Harness => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repos: createSqliteMemoryRepositories(db), close: () => db.close() };
  }],
] as const)('Phase 3 Memory Candidate repositories (%s)', (_name, createRepos) => {
  test('create + getById round-trips a candidate with conflict ids', async () => {
    const { repos, close } = createRepos();
    try {
      const record = candidateRecord({
        proposedSummary: '运行时方案', conflictMemoryIds: ['mem-1', 'mem-2'],
      });
      await repos.candidates.create(record);
      const found = await repos.candidates.getById({ teamId: 'team-1', id: 'cand-1' });
      expect(found).toEqual(record);
    } finally {
      close();
    }
  });

  test('getById returns null for a foreign team (no existence leak)', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord());
      const found = await repos.candidates.getById({ teamId: 'team-2', id: 'cand-1' });
      expect(found).toBeNull();
    } finally {
      close();
    }
  });

  test('candidate ids are globally unique across Teams', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord());
      await expect(repos.candidates.create(candidateRecord({ teamId: 'team-2' })))
        .rejects.toThrow(/already exists|unique constraint/i);
    } finally {
      close();
    }
  });

  test('findByProjectionHash returns the undecided candidate (dedupe, acceptance #2)', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord({ id: 'cand-1' }));
      const found = await repos.candidates.findByProjectionHash({
        teamId: 'team-1',
        projectionHash: 'sha256:proj-1',
      });
      expect(found?.id).toBe('cand-1');
    } finally {
      close();
    }
  });

  test('findByProjectionHash excludes decided candidates', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord({
        id: 'cand-1', status: 'accepted', decidedAt: 2000, decidedBy: 'user-1', updatedAt: 2000,
      }));
      const found = await repos.candidates.findByProjectionHash({
        teamId: 'team-1',
        projectionHash: 'sha256:proj-1',
      });
      expect(found).toBeNull();
    } finally {
      close();
    }
  });

  test('update advances status through a valid transition', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord({ id: 'cand-1' }));
      const updated = await repos.candidates.update({
        record: candidateRecord({
          id: 'cand-1', status: 'conflict', conflictMemoryIds: ['mem-1'], updatedAt: 2000,
        }),
        expectedUpdatedAt: 1000,
      });
      expect(updated?.status).toBe('conflict');
      expect(updated?.conflictMemoryIds).toEqual(['mem-1']);
    } finally {
      close();
    }
  });

  test('update rejects an invalid transition from a terminal status', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord({
        id: 'cand-1', status: 'accepted', decidedAt: 2000, decidedBy: 'user-1', updatedAt: 2000,
      }));
      await expect(repos.candidates.update({
        record: candidateRecord({
          id: 'cand-1', status: 'rejected', decidedAt: 3000, decidedBy: 'user-1', updatedAt: 3000,
        }),
        expectedUpdatedAt: 2000,
      })).rejects.toThrow(/transition is invalid/);
    } finally {
      close();
    }
  });

  test('update rejects changes to immutable candidate projection fields', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord());
      await expect(repos.candidates.update({
        record: candidateRecord({ scopeRef: 'task-2', updatedAt: 2000, status: 'conflict' }),
        expectedUpdatedAt: 1000,
      })).rejects.toThrow(/immutable identity changed/);
    } finally {
      close();
    }
  });

  test('update returns null on stale expectedUpdatedAt', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord({ id: 'cand-1', updatedAt: 1000 }));
      const result = await repos.candidates.update({
        record: candidateRecord({ id: 'cand-1', status: 'conflict', updatedAt: 2000 }),
        expectedUpdatedAt: 999,
      });
      expect(result).toBeNull();
    } finally {
      close();
    }
  });

  test('candidateSources create + listByCandidate', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord());
      await repos.candidateSources.create(candidateSourceRecord({ sourceId: 'msg-1' }));
      await repos.candidateSources.create(candidateSourceRecord({ sourceId: 'msg-2' }));
      const sources = await repos.candidateSources.listByCandidate({
        teamId: 'team-1',
        candidateId: 'cand-1',
      });
      expect(sources).toHaveLength(2);
    } finally {
      close();
    }
  });

  test('create rejects an invalid server scope', async () => {
    const { repos, close } = createRepos();
    try {
      await expect(repos.candidates.create(
        candidateRecord({ scopeType: 'local-workspace' as MemoryCandidateRecord['scopeType'] }),
      )).rejects.toThrow(/scope is not allowed/);
    } finally {
      close();
    }
  });

  test('create rejects a local-only candidate source', async () => {
    const { repos, close } = createRepos();
    try {
      await repos.candidates.create(candidateRecord());
      await expect(repos.candidateSources.create(
        candidateSourceRecord({ sourceVisibility: 'local-only' as MemoryCandidateSourceRecord['sourceVisibility'] }),
      )).rejects.toThrow(/local-only/);
    } finally {
      close();
    }
  });
});
