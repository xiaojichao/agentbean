import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import {
  type MemoryCandidatePermissions,
  type MemoryCandidateSourceInput,
  createMemoryCandidateService,
} from '../src/application/memory-candidate-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type { MemoryRepositories, MemoryUnitOfWork } from '../src/application/memory-repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

function permissivePermissions(): MemoryCandidatePermissions {
  return {
    assertProposeAuthority: async () => undefined,
    assertDecideAuthority: async () => undefined,
    assertWriteAuthority: async () => undefined,
    assertSourceAuthority: async () => undefined,
    isSourceAvailable: async () => true,
  };
}

function denyingDecidePermissions(): MemoryCandidatePermissions {
  return {
    ...permissivePermissions(),
    assertDecideAuthority: async () => { throw new Error('CANDIDATE_NOT_AUTHORIZED'); },
  };
}

const sourceRef = (id = 'msg-1'): MemoryCandidateSourceInput => ({
  schemaVersion: 1,
  sourceKind: 'message',
  sourceId: id,
  snapshotHash: 'sha256:snap-1',
  sourceScopeType: 'task',
  sourceScopeRef: 'task-1',
  sourceVisibility: 'team',
});

interface Harness {
  readonly service: ReturnType<typeof createMemoryCandidateService>;
  readonly memory: MemoryRepositories;
  readonly close(): void;
}

function makeHarness(
  repositories: { memoryUnitOfWork: MemoryUnitOfWork; memory: MemoryRepositories },
  permissions: MemoryCandidatePermissions,
): Harness {
  let tick = 1_000;
  let counter = 0;
  const service = createMemoryCandidateService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions,
    clock: { now: () => (tick += 1_000) },
    ids: { nextId: () => `id-${++counter}` },
  });
  return { service, memory: repositories.memory, close() {} };
}

async function seedActiveMemory(
  memory: Harness['memory'],
  teamId: string,
  memoryId: string,
  sourceId: string,
): Promise<void> {
  await memory.items.create({
    schemaVersion: 1, id: memoryId, teamId, kind: 'decision', status: 'active',
    scopeType: 'task', scopeRef: 'task-1', content: 'old conclusion',
    createdAt: 500, updatedAt: 500,
  });
  await memory.sources.create({
    memoryId, teamId, sourceKind: 'message', sourceId, snapshotHash: 'sha256:old',
    sourceScopeType: 'task', sourceScopeRef: 'task-1', sourceVisibility: 'team', createdAt: 500,
  });
}

describe.each([
  ['memory', (permissions: MemoryCandidatePermissions): Harness => ({
    ...makeHarness(createInMemoryRepositories(), permissions), close() {},
  })],
  ['sqlite', (permissions: MemoryCandidatePermissions): Harness => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { ...makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db }), permissions), close: () => db.close() };
  }],
] as const)('Phase 3 Memory Candidate service (%s)', (_name, createHarness) => {
  test('proposeCandidate creates a candidate with body-free audit', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      const view = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      expect(view.candidate.status).toBe('candidate');
      const audit = await memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'candidate', subjectId: view.candidate.id,
      });
      expect(audit[0]).not.toHaveProperty('proposedContent');
      expect(audit[0]).not.toHaveProperty('content');
    } finally {
      close();
    }
  });

  test('proposeCandidate dedupes an identical submission (acceptance #2)', async () => {
    const { service, close } = createHarness(permissivePermissions());
    try {
      const first = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      const second = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-2', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      expect(second.candidate.id).toBe(first.candidate.id);
    } finally {
      close();
    }
  });

  test('proposeCandidate marks conflict when a source overlaps an active Memory', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const view = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      expect(view.candidate.status).toBe('conflict');
      expect(view.candidate.conflictMemoryIds).toEqual(['mem-1']);
    } finally {
      close();
    }
  });

  test('acceptCandidate creates an active Memory and links acceptedMemoryId', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      const accepted = await service.acceptCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, kind: 'decision',
      });
      expect(accepted.candidate.status).toBe('accepted');
      expect(accepted.candidate.acceptedMemoryId).toBeDefined();
      const active = await memory.items.getById({
        teamId: 'team-1', id: accepted.candidate.acceptedMemoryId!,
      });
      expect(active?.status).toBe('active');
      expect(active?.content).toBe('use node-pty');
    } finally {
      close();
    }
  });

  test('acceptCandidate throws CANDIDATE_HAS_CONFLICT on a conflicting source', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      await expect(service.acceptCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, kind: 'decision',
      })).rejects.toThrow(/CANDIDATE_HAS_CONFLICT/);
    } finally {
      close();
    }
  });

  test('acceptCandidate throws when a source is no longer available', async () => {
    const denying = { ...permissivePermissions(), isSourceAvailable: async () => false };
    const { service, close } = createHarness(denying);
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      await expect(service.acceptCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, kind: 'decision',
      })).rejects.toThrow(/CANDIDATE_SOURCE_UNAVAILABLE/);
    } finally {
      close();
    }
  });

  test('rejectCandidate moves a candidate to rejected', async () => {
    const { service, close } = createHarness(permissivePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      const rejected = await service.rejectCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id,
      });
      expect(rejected.candidate.status).toBe('rejected');
    } finally {
      close();
    }
  });

  test('mergeCandidate supersedes the conflicting Memory and links mergedIntoMemoryId', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      const merged = await service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-1',
      });
      expect(merged.candidate.status).toBe('merged');
      expect(merged.candidate.mergedIntoMemoryId).toBeDefined();
      const old = await memory.items.getById({ teamId: 'team-1', id: 'mem-1' });
      expect(old?.status).toBe('superseded');
      expect(old?.supersededById).toBe(merged.candidate.mergedIntoMemoryId);
    } finally {
      close();
    }
  });

  test('mergeCandidate rejects a foreign conflict target', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      await expect(service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-other',
      })).rejects.toThrow(/CANDIDATE_CONFLICT_TARGET_INVALID/);
    } finally {
      close();
    }
  });

  test('decide authority denies an external Agent (acceptance #5)', async () => {
    const { service, close } = createHarness(denyingDecidePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      await expect(service.acceptCandidate({
        teamId: 'team-1', actorId: 'agent-1', candidateId: proposed.candidate.id, kind: 'decision',
      })).rejects.toThrow(/CANDIDATE_NOT_AUTHORIZED/);
    } finally {
      close();
    }
  });

  test('a foreign team candidate is not found (no existence leak)', async () => {
    const { service, close } = createHarness(permissivePermissions());
    try {
      await expect(service.acceptCandidate({
        teamId: 'team-2', actorId: 'user-1', candidateId: 'cand-x', kind: 'decision',
      })).rejects.toThrow(/CANDIDATE_NOT_FOUND/);
    } finally {
      close();
    }
  });
});
