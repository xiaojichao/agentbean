import { describe, expect, test, vi } from 'vitest';
import { createPhase3ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import { hashManagementCommandInput } from '../src/application/management/management-event-validator.js';
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

const ROOT_MESSAGE = {
  id: 'root-message', teamId: 'team-1', channelId: 'chan-1', threadId: 'root-message',
  senderKind: 'human' as const, senderId: 'user-1', body: '目标', createdAt: 1,
};
const SOURCE_MESSAGE = {
  id: 'msg-1', teamId: 'team-1', channelId: 'chan-1', threadId: 'root-message',
  senderKind: 'agent' as const, senderId: 'agent-source', body: '证据', createdAt: 2,
  meta: { dispatchId: 'dispatch-1' },
};
const SOURCE_TASK = {
  id: 'task-1', teamId: 'team-1', title: '任务', description: undefined,
  assigneeId: 'agent-source', channelId: undefined, revision: 1,
};

function messageSnapshotHash(message = SOURCE_MESSAGE): string {
  return hashManagementCommandInput({
    kind: 'message', id: message.id, teamId: message.teamId, channelId: message.channelId,
    threadId: message.threadId, senderKind: message.senderKind, senderId: message.senderId,
    body: message.body, dispatchId: message.meta.dispatchId, createdAt: message.createdAt,
  });
}

function taskSnapshotHash(task = SOURCE_TASK): string {
  return hashManagementCommandInput(Object.fromEntries(Object.entries({
    kind: 'task', id: task.id, teamId: task.teamId, channelId: task.channelId,
    title: task.title, description: task.description, assigneeId: task.assigneeId, revision: task.revision,
  }).filter(([, value]) => value !== undefined)));
}

function makeRepositories(overrides: {
  readonly run?: { readonly teamId: string };
  readonly message?: typeof SOURCE_MESSAGE | null;
  readonly channel?: { readonly teamId: string; readonly kind: 'channel' | 'direct'; readonly visibility: 'public' | 'private' } | null;
  readonly task?: typeof SOURCE_TASK | null;
  readonly invocations?: readonly Record<string, unknown>[];
  readonly capsuleRef?: Record<string, unknown> | null;
  readonly runMissing?: boolean;
} = {}): ServerNextRepositories {
  const teamId = overrides.run?.teamId ?? 'team-1';
  const run = overrides.runMissing ? null : {
    id: 'run-1', teamId, channelId: 'chan-1', rootMessageId: 'root-message',
  };
  const invocation = {
    id: 'inv-source', managementRunId: 'run-1', createdAt: 100,
    intent: { teamId: 'team-1', targetAgentId: 'agent-source', taskContext: { taskId: 'task-1' } },
  };
  return {
    management: {
      runs: { getById: vi.fn(async () => run) },
      invocations: { listByRun: vi.fn(async () => overrides.invocations ?? [invocation]) },
      dispatchAttempts: { list: vi.fn(async (invocationId: string) => invocationId === 'inv-source'
        ? [{ dispatchId: 'dispatch-1' }] : []) },
    },
    messages: { getById: vi.fn(async (id: string) => id === 'root-message'
      ? { ...ROOT_MESSAGE, teamId }
      : overrides.message === undefined ? SOURCE_MESSAGE : overrides.message) },
    channels: { getById: vi.fn(async () => overrides.channel === undefined ? { id: 'chan-1', teamId: 'team-1', kind: 'channel' as const, visibility: 'public' as const } : overrides.channel) },
    tasks: { getById: vi.fn(async () => overrides.task === undefined ? SOURCE_TASK : overrides.task) },
    teams: { isMember: vi.fn(async () => true) },
    memory: { capsuleRefs: { getById: vi.fn(async () => overrides.capsuleRef ?? null) } },
  } as unknown as ServerNextRepositories;
}

describe('createPhase3ManagementToolHandlers', () => {
  test('memory.search 从 root message 派生 requesterUserId，不使用 workerId', async () => {
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
      teamId: 'team-99', requesterUserId: 'user-1', targetAgentId: 'agent-target',
      prompt: 'q', now: 5_000, limit: 5,
    }));
  });

  test('memory.create_capsule 传 root user + currentPolicyVersion, 返回 toMemoryCapsuleRef 投影', async () => {
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
      idempotencyKey: 'capsule-call',
      input: { targetAgentId: 'agent-target', prompt: 'summarize', limit: 3 },
    });
    expect(capsuleService.createCapsule).toHaveBeenCalledWith(expect.objectContaining({
      capsuleId: expect.stringMatching(/^capsule-/), teamId: 'team-1', requesterUserId: 'user-1',
      currentPolicyVersion: 7, prompt: 'summarize',
    }));
    expect(result.capsuleRef).toMatchObject({ id: 'capsule-1' });
  });

  test('memory.propose_candidate 从真实 message dispatch 解析 invocation 与 sourceAgentId', async () => {
    const repositories = makeRepositories({
      channel: { id: 'chan-1', teamId: 'team-1', kind: 'channel', visibility: 'private' },
      invocations: [
        { id: 'inv-unrelated', managementRunId: 'run-1', createdAt: 300,
          intent: { teamId: 'team-1', targetAgentId: 'agent-other', taskContext: { taskId: 'task-other' } } },
        { id: 'inv-source', managementRunId: 'run-1', createdAt: 50,
          intent: { teamId: 'team-1', targetAgentId: 'agent-source', taskContext: { taskId: 'task-1' } } },
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
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: messageSnapshotHash() }],
      },
    });
    expect(candidateService.proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', sourceAgentId: 'agent-source', sourceInvocationId: 'inv-source',
      sourceRequesterUserId: 'user-1',
      targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
      sourceRefs: [expect.objectContaining({
        sourceKind: 'message', sourceScopeType: 'channel', sourceScopeRef: 'chan-1',
        sourceVisibility: 'private',
      })],
    }));
    expect(result).toMatchObject({ candidateId: 'cand-1', status: 'candidate' });
  });

  test('memory.propose_candidate 重放终态 Candidate 时规范化为可解析结果', async () => {
    const repositories = makeRepositories({
      channel: { id: 'chan-1', teamId: 'team-1', kind: 'channel', visibility: 'private' },
      invocations: [{ id: 'inv-source', managementRunId: 'run-1', createdAt: 50,
        intent: { teamId: 'team-1', targetAgentId: 'agent-source', taskContext: { taskId: 'task-1' } } }],
    });
    const handlers = createPhase3ManagementToolHandlers({
      repositories,
      searchService: { search: vi.fn() } as never,
      capsuleService: { createCapsule: vi.fn() } as never,
      candidateService: { proposeCandidate: vi.fn(async () => ({
        candidate: { id: 'cand-terminal', status: 'accepted' }, sources: [],
      })) } as never,
      collaborativeService: { linkSources: vi.fn() } as never,
      clock: { now: () => 5_000 },
      currentPolicyVersion: 1,
    });
    await expect(handlers['memory.propose_candidate']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c', managementRunId: 'run-1',
      workerId: 'worker-agent', toolCallId: 'call', toolName: 'memory.propose_candidate',
      leaseToken: 'tok', fencingToken: 1,
      input: {
        targetAgentId: 'agent-target', scopeType: 'task', scopeRef: 'task-1',
        contentKind: 'fact', proposedContent: 'proposed',
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1',
          snapshotHash: messageSnapshotHash() }],
      },
    })).resolves.toEqual({ candidateId: 'cand-terminal', status: 'candidate' });
  });

  test('memory.propose_candidate private channel task 来源保持 private visibility', async () => {
    const task = { ...SOURCE_TASK, channelId: 'chan-1' };
    const repositories = makeRepositories({
      task,
      channel: { id: 'chan-1', teamId: 'team-1', kind: 'channel', visibility: 'private' },
    });
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
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'task', sourceId: 'task-1', snapshotHash: taskSnapshotHash(task) }],
      },
    });
    expect(candidateService.proposeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      sourceRefs: [expect.objectContaining({
        sourceKind: 'task', sourceScopeType: 'task', sourceScopeRef: 'task-1', sourceVisibility: 'private',
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
      message: { ...SOURCE_MESSAGE, teamId: 'team-other', channelId: 'chan-x' },
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

  test('memory.propose_candidate 来源 snapshotHash 漂移时 fail-closed', async () => {
    const handlers = createPhase3ManagementToolHandlers({
      repositories: makeRepositories(),
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
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: 'stale' }],
      },
    })).rejects.toThrow('MEMORY_SOURCE_SNAPSHOT_STALE');
  });

  test('memory.link_sources 解析来源 + actorId=root user', async () => {
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
        sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'msg-1', snapshotHash: messageSnapshotHash() }],
      },
    });
    expect(collaborativeService.linkSources).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', actorId: 'user-1', memoryId: 'mem-1',
      sourceRefs: [expect.objectContaining({ sourceScopeType: 'channel', sourceVisibility: 'team' })],
    }));
    expect(result).toMatchObject({ memoryId: 'mem-1' });
  });
});
