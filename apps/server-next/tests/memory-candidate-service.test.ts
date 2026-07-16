import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import {
  type MemoryCandidatePermissions,
  type MemoryCandidateSourceInput,
  createMemoryCandidateService,
} from '../src/application/memory-candidate-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type {
  MemoryItemRecord,
  MemoryRepositories,
  MemoryUnitOfWork,
} from '../src/application/memory-repositories.js';
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
  overrides: Partial<MemoryItemRecord> = {},
): Promise<void> {
  await memory.items.create({
    schemaVersion: 1, id: memoryId, teamId, kind: 'decision', status: 'active',
    scopeType: 'task', scopeRef: 'task-1', content: 'old conclusion',
    createdAt: 500, updatedAt: 500,
    ...overrides,
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
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      expect(view.candidate.status).toBe('candidate');
      const audit = await memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'candidate', subjectId: view.candidate.id,
      });
      expect(audit[0]).not.toHaveProperty('proposedContent');
      expect(audit[0]).not.toHaveProperty('content');
      expect(audit[0]?.targetAgentId).toBe('target-agent-1');
    } finally {
      close();
    }
  });

  test('proposeCandidate dedupes an identical submission (acceptance #2)', async () => {
    const { service, close } = createHarness(permissivePermissions());
    try {
      const first = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      const second = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-2', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      expect(view.candidate.status).toBe('conflict');
      expect(view.candidate.conflictMemoryIds).toEqual(['mem-1']);
    } finally {
      close();
    }
  });

  test('proposeCandidate validates source authority before exposing conflicts', async () => {
    const permissions = {
      ...permissivePermissions(),
      assertSourceAuthority: async () => { throw new Error('CANDIDATE_SOURCE_NOT_AUTHORIZED'); },
    };
    const { service, memory, close } = createHarness(permissions);
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-secret', 'msg-1');
      await expect(service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      })).rejects.toThrow(/CANDIDATE_SOURCE_NOT_AUTHORIZED/);
    } finally {
      close();
    }
  });

  test('proposeCandidate keeps Agent proposal authority separate from user source visibility', async () => {
    const proposedActors: string[] = [];
    const sourceActors: string[] = [];
    const permissions: MemoryCandidatePermissions = {
      ...permissivePermissions(),
      assertProposeAuthority: async ({ actorId }) => { proposedActors.push(actorId); },
      assertSourceAuthority: async ({ actorId }) => { sourceActors.push(actorId); },
    };
    const { service, close } = createHarness(permissions);
    try {
      await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceRequesterUserId: 'user-1',
        sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      expect(proposedActors).toEqual(['agent-1']);
      expect(sourceActors).toEqual(['user-1']);
    } finally {
      close();
    }
  });

  test('acceptCandidate creates an active Memory and links acceptedMemoryId', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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
    let available = true;
    const denying = { ...permissivePermissions(), isSourceAvailable: async () => available };
    const { service, close } = createHarness(denying);
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'use node-pty', sourceRefs: [sourceRef()],
      });
      available = false;
      await expect(service.acceptCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, kind: 'decision',
      })).rejects.toThrow(/CANDIDATE_SOURCE_UNAVAILABLE/);
    } finally {
      close();
    }
  });

  test('acceptCandidate rejects normalized duplicate active content', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-other', { content: 'Use   Node-PTY' });
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: ' use node-pty ', sourceRefs: [sourceRef('msg-1')],
      });
      await expect(service.acceptCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, kind: 'decision',
      })).rejects.toThrow(/MEMORY_DUPLICATE_CONTENT/);
    } finally {
      close();
    }
  });

  test('rejectCandidate moves a candidate to rejected', async () => {
    const { service, close } = createHarness(permissivePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1', {
        summary: '旧摘要', updatedAt: 10_000,
      });
      await memory.tags.create({
        memoryId: 'mem-1', teamId: 'team-1', tag: 'runtime', createdAt: 500,
      });
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', proposedSummary: '新摘要', sourceRefs: [sourceRef('msg-1')],
      });
      const merged = await service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-1',
      });
      expect(merged.candidate.status).toBe('merged');
      expect(merged.candidate.mergedIntoMemoryId).toBeDefined();
      const old = await memory.items.getById({ teamId: 'team-1', id: 'mem-1' });
      expect(old?.status).toBe('superseded');
      expect(old?.supersededById).toBe(merged.candidate.mergedIntoMemoryId);
      expect(old?.updatedAt).toBeGreaterThan(10_000);
      const created = await memory.items.getById({
        teamId: 'team-1', id: merged.candidate.mergedIntoMemoryId!,
      });
      expect(created?.summary).toBe('新摘要');
      await expect(memory.tags.listByMemory({ teamId: 'team-1', memoryId: created!.id }))
        .resolves.toMatchObject([{ tag: 'runtime' }]);
      await expect(memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: 'mem-1',
      })).resolves.toMatchObject([{ eventType: 'memory-superseded' }]);
    } finally {
      close();
    }
  });

  test('mergeCandidate rejects a foreign conflict target', async () => {
    const { service, memory, close } = createHarness(permissivePermissions());
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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

  test('mergeCandidate revalidates source availability and the current conflict set', async () => {
    let available = true;
    const permissions = {
      ...permissivePermissions(),
      isSourceAvailable: async () => available,
    };
    const { service, memory, close } = createHarness(permissions);
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1');
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      available = false;
      await expect(service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-1',
      })).rejects.toThrow(/CANDIDATE_SOURCE_UNAVAILABLE/);

      available = true;
      await seedActiveMemory(memory, 'team-1', 'mem-2', 'msg-1');
      await expect(service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-1',
      })).rejects.toThrow(/CANDIDATE_CONFLICT_SET_CHANGED/);
    } finally {
      close();
    }
  });

  test('mergeCandidate requires write authority for the superseded Memory scope', async () => {
    const permissions = {
      ...permissivePermissions(),
      assertWriteAuthority: async (input: Parameters<MemoryCandidatePermissions['assertWriteAuthority']>[0]) => {
        if (input.scopeRef === 'channel-secret') throw new Error('MEMORY_WRITE_NOT_AUTHORIZED');
      },
    };
    const { service, memory, close } = createHarness(permissions);
    try {
      await seedActiveMemory(memory, 'team-1', 'mem-1', 'msg-1', {
        scopeType: 'channel', scopeRef: 'channel-secret',
      });
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
        scopeType: 'task', scopeRef: 'task-1', contentKind: 'decision',
        proposedContent: 'new conclusion', sourceRefs: [sourceRef('msg-1')],
      });
      await expect(service.mergeCandidate({
        teamId: 'team-1', actorId: 'user-1', candidateId: proposed.candidate.id, conflictMemoryId: 'mem-1',
      })).rejects.toThrow(/MEMORY_WRITE_NOT_AUTHORIZED/);
    } finally {
      close();
    }
  });

  test('decide authority denies an external Agent (acceptance #5)', async () => {
    const { service, close } = createHarness(denyingDecidePermissions());
    try {
      const proposed = await service.proposeCandidate({
        teamId: 'team-1', sourceAgentId: 'agent-1', sourceInvocationId: 'inv-1', targetAgentId: 'target-agent-1', managementRunId: 'run-1',
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
