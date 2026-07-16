import { describe, expect, test, vi } from 'vitest';
import { createPhase3ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { MemoryCapsuleDto } from '../../../../../packages/contracts/src/management-memory.js';

// phase3 worker handler 的职责是「上下文派生 + source 解析 + 调 service」，不是持久化或 service 内部逻辑。
// 故 mock repositories（精确控制 getById 返回）+ mock 4 service（验证调用参数）。

const baseCapsule: MemoryCapsuleDto = {
  schemaVersion: 1,
  id: 'capsule-1',
  teamId: 'team-1',
  managementRunId: 'run-1',
  taskId: 'task-1',
  targetAgentId: 'agent-target',
  contentHash: 'sha256:capsule',
  authorizationDecisionId: 'decision-1',
  expiresAt: 9_000,
  projectionHash: 'sha256:proj',
  createdAt: 1_000,
  items: [],
};

function makeRepositories(overrides: {
  readonly run?: { readonly teamId: string };
  readonly message?: { readonly teamId: string; readonly channelId: string } | null;
  readonly channel?: { readonly teamId: string; readonly kind: 'channel' | 'direct'; readonly visibility: 'public' | 'private' } | null;
  readonly task?: { readonly teamId: string } | null;
  readonly invocations?: readonly { readonly id: string; readonly managementRunId: string; readonly createdAt: number }[];
  readonly runMissing?: boolean;
} = {}): ServerNextRepositories {
  const run = overrides.runMissing ? null : { id: 'run-1', teamId: overrides.run?.teamId ?? 'team-1' };
  return {
    management: {
      runs: { getById: vi.fn(async () => run) },
      invocations: { listByRun: vi.fn(async () => overrides.invocations ?? [{ id: 'inv-1', managementRunId: 'run-1', createdAt: 100 }]) },
    },
    messages: { getById: vi.fn(async () => overrides.message === undefined ? { id: 'msg-1', teamId: 'team-1', channelId: 'chan-1' } : overrides.message) },
    channels: { getById: vi.fn(async () => overrides.channel === undefined ? { id: 'chan-1', teamId: 'team-1', kind: 'channel' as const, visibility: 'public' as const } : overrides.channel) },
    tasks: { getById: vi.fn(async () => overrides.task === undefined ? { id: 'task-1', teamId: 'team-1' } : overrides.task) },
  } as unknown as ServerNextRepositories;
}

describe('createPhase3ManagementToolHandlers', () => {
  test('memory.search 派生 teamId from run + 用 workerId 作 requesterUserId', async () => {
    const repositories = makeRepositories({ run: { teamId: 'team-99' } });
    const searchService = { search: vi.fn(async () => ({ matches: [], excluded: [] })) };
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService: { proposeCandidate: vi.fn() } as never,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 },
      currentPolicyVersion: 1,
    });
    await handlers['memory.search']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.search', leaseToken: 'tok', fencingToken: 1,
      input: { targetAgentId: 'agent-target', query: 'q', limit: 5 },
    });
    expect(searchService.search).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-99', requesterUserId: 'worker-agent', targetAgentId: 'agent-target',
      prompt: 'q', now: 5_000, limit: 5,
    }));
  });

  test('memory.create_capsule 传 workerId + currentPolicyVersion, 返回 toMemoryCapsuleRef 投影', async () => {
    const repositories = makeRepositories();
    const capsuleService = { createCapsule: vi.fn(async () => baseCapsule) };
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService,
      candidateService: { proposeCandidate: vi.fn() } as never,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 },
      currentPolicyVersion: 7,
    });
    const result = await handlers['memory.create_capsule']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.create_capsule', leaseToken: 'tok', fencingToken: 1,
      input: { targetAgentId: 'agent-target', prompt: 'summarize', limit: 3 },
    });
    expect(capsuleService.createCapsule).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', requesterUserId: 'worker-agent', currentPolicyVersion: 7, prompt: 'summarize',
    }));
    expect(result.capsuleRef).toMatchObject({ id: 'capsule-1' });
  });

  test('memory.propose_candidate 解析 message 来源 scope/visibility + sourceInvocationId + sourceAgentId=workerId', async () => {
    const repositories = makeRepositories({
      message: { teamId: 'team-1', channelId: 'chan-1' },
      channel: { id: 'chan-1', teamId: 'team-1', kind: 'channel', visibility: 'private' },
      invocations: [
        { id: 'inv-old', managementRunId: 'run-1', createdAt: 50 },
        { id: 'inv-new', managementRunId: 'run-1', createdAt: 300 },
      ],
    });
    const candidateService = { proposeCandidate: vi.fn(async () => ({ candidate: { id: 'cand-1', status: 'candidate' }, sources: [] })) };
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 },
      currentPolicyVersion: 1,
    });
    const result = await handlers['memory.propose_candidate']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.propose_candidate', leaseToken: 'tok', fencingToken: 1,
      input: {
        targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
        contentKind: 'fact', proposedContent: 'proposed', proposedSummary: 'sum',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: 'sha256:snap' }],
      },
    });
    // 取最新 invocation（createdAt 300 > 50）
    expect(candidateService.proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', sourceAgentId: 'worker-agent', sourceInvocationId: 'inv-new',
      targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
      sourceRefs: [expect.objectContaining({
        sourceKind: 'message', sourceScopeType: 'channel', sourceScopeRef: 'chan-1',
        sourceVisibility: 'private',
      })],
    }));
    expect(result).toMatchObject({ candidateId: 'cand-1', status: 'candidate' });
  });

  test('memory.propose_candidate task 来源 → task scope + team visibility', async () => {
    const repositories = makeRepositories({ task: { id: 'task-1', teamId: 'team-1' } });
    const candidateService = { proposeCandidate: vi.fn(async () => ({ candidate: { id: 'cand-2', status: 'candidate' }, sources: [] })) };
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 }, currentPolicyVersion: 1,
    });
    await handlers['memory.propose_candidate']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.propose_candidate', leaseToken: 'tok', fencingToken: 1,
      input: {
        targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
        contentKind: 'fact', proposedContent: 'p',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'task', sourceId: 'task-1', snapshotHash: 'sha256:snap' }],
      },
    });
    expect(candidateService.proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      sourceRefs: [expect.objectContaining({
        sourceKind: 'task', sourceScopeType: 'task', sourceScopeRef: 'task-1', sourceVisibility: 'team',
      })],
    }));
  });

  test('memory.propose_candidate 未知 sourceKind（artifact）→ fail-closed 抛错', async () => {
    const repositories = makeRepositories();
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService: { proposeCandidate: vi.fn() } as never,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 }, currentPolicyVersion: 1,
    });
    await expect(handlers['memory.propose_candidate']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.propose_candidate', leaseToken: 'tok', fencingToken: 1,
      input: {
        targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
        contentKind: 'fact', proposedContent: 'p',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'artifact', sourceId: 'art-1', snapshotHash: 'sha256:snap' }],
      },
    })).rejects.toThrow('MEMORY_SOURCE_KIND_UNSUPPORTED');
  });

  test('memory.propose_candidate 跨团队来源（message.teamId 不匹配）→ fail-closed 抛错', async () => {
    const repositories = makeRepositories({
      run: { teamId: 'team-1' },
      message: { teamId: 'team-other', channelId: 'chan-x' },
    });
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService: { proposeCandidate: vi.fn() } as never,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 }, currentPolicyVersion: 1,
    });
    await expect(handlers['memory.propose_candidate']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.propose_candidate', leaseToken: 'tok', fencingToken: 1,
      input: {
        targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
        contentKind: 'fact', proposedContent: 'p',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: 'sha256:snap' }],
      },
    })).rejects.toThrow('MEMORY_SOURCE_UNAVAILABLE');
  });

  test('memory.link_sources 解析来源 + actorId=workerId', async () => {
    const repositories = makeRepositories();
    const collaborativeService = { linkSources: vi.fn(async () => ({ item: {}, tags: [], sourceRefs: [] })) };
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService: { proposeCandidate: vi.fn() } as never,
      collaborativeService,
      clock: { now: () => 5_000 }, currentPolicyVersion: 1,
    });
    const result = await handlers['memory.link_sources']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1', workerId: 'worker-agent',
      toolCallId: 'call', toolName: 'memory.link_sources', leaseToken: 'tok', fencingToken: 1,
      input: {
        memoryId: 'mem-1',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: 'sha256:snap' }],
      },
    });
    expect(collaborativeService.linkSources).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', actorId: 'worker-agent', memoryId: 'mem-1',
      sourceRefs: [expect.objectContaining({ sourceScopeType: 'channel', sourceVisibility: 'team' })],
    }));
    expect(result).toMatchObject({ memoryId: 'mem-1' });
  });
});
