import { describe, expect, test } from 'vitest';

import type { MemoryItemRecord, ServerNextRepositories } from '../src/index.js';
import { createCollaborativeMemorySearchService } from '../src/application/collaborative-memory-search-service.js';
import { createMemoryCapsuleService } from '../src/application/memory-capsule-service.js';
import { createCapsuleInjectionValidator } from '../src/application/capsule-injection-validator.js';
import { createPhase3ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

// P3-17 跨 Agent Memory smoke（代码链路）：Agent A 经 phase3 create_capsule 工具把记忆打包
// 授权给目标 Agent B；B 经 capsule inject 复用。负场景：来源失效后 B 注入被拒。
// 注：permissions 放宽（mock），聚焦 handler/capsule/inject 链路；真实两个 LLM Agent 需用户环境跑。

const POLICY_VERSION = 7;

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly handler: ReturnType<typeof createPhase3ManagementToolHandlers>;
  readonly capsuleService: ReturnType<typeof createMemoryCapsuleService>;
  readonly validator: ReturnType<typeof createCapsuleInjectionValidator>;
  readonly markSourceUnavailable: (sourceId: string) => void;
}

function makeHarness(): Harness {
  const repositories = createInMemoryRepositories();
  let tick = 1_000;
  let counter = 0;
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `id-${++counter}` };
  const unavailableSources = new Set<string>();
  const permissions = {
    async canSearchTeam() { return true; },
    async evaluateScopeVisibility() { return 'visible' as const; },
    async isSourceAvailable(input: { source: { sourceId: string } }) {
      return !unavailableSources.has(input.source.sourceId);
    },
  };
  const searchService = createCollaborativeMemorySearchService({ repositories: repositories.memory, permissions });
  const capsuleService = createMemoryCapsuleService({ searchService, unitOfWork: repositories.memoryUnitOfWork, clock, ids });
  // createPhase3ManagementToolHandlers 需要 4 个 service；smoke 只用到 create_capsule，其余给空实现。
  const noopService = { async search() { return { matches: [], excluded: [] }; } } as never;
  const handler = createPhase3ManagementToolHandlers({
    repositories, searchService, capsuleService,
    candidateService: { async proposeCandidate() { return { candidate: {} as never, sources: [] }; } } as never,
    collaborativeService: { async linkSources() { return {} as never; } } as never,
    clock, currentPolicyVersion: POLICY_VERSION,
  });
  return {
    repositories,
    handler,
    capsuleService,
    validator: createCapsuleInjectionValidator({ unitOfWork: repositories.memoryUnitOfWork, permissions, ids }),
    markSourceUnavailable: (sourceId) => unavailableSources.add(sourceId),
  };
}

async function seedRun(harness: Harness): Promise<string> {
  await harness.repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', role: 'owner', joinedAt: 1 });
  await harness.repositories.messages.append({
    id: 'msg-1', teamId: 'team-1', channelId: 'chan-1', senderKind: 'human', senderId: 'user-1',
    body: 'source message', createdAt: 1, updatedAt: 1,
  } as never);
  await harness.repositories.management.runs.create({
    schemaVersion: 2, id: 'run-p3', managementPhase: 3, teamId: 'team-1', channelId: 'chan-1',
    rootTaskId: 'task-1', rootMessageId: 'msg-1', mode: 'managed', status: 'running',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    checkpointRevision: 0, budget: { maxSubtasks: 2, maxDepth: 1, maxExternalInvocations: 2 },
    createdAt: 1, updatedAt: 1,
  } as never);
  return 'run-p3';
}

async function seedMemory(harness: Harness, memoryId: string, sourceId: string): Promise<void> {
  await harness.repositories.memoryUnitOfWork.run(async (memory) => {
    const item: MemoryItemRecord = {
      schemaVersion: 1, id: memoryId, teamId: 'team-1', kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content: `决策结论 ${memoryId}`, summary: '关于 X',
      createdByUserId: 'user-1', approvedByUserId: 'user-1', validFrom: 1, createdAt: 1, updatedAt: 1,
    };
    await memory.items.create(item);
    await memory.sources.create({
      memoryId, teamId: 'team-1', sourceKind: 'message', sourceId,
      snapshotHash: `sha256:${sourceId}`, sourceScopeType: 'team', sourceScopeRef: 'team-1',
      sourceVisibility: 'team', createdAt: 1,
    });
  });
}

describe('P3-17 跨 Agent Memory smoke', () => {
  test('正场景：A 经 create_capsule 打包授权 → B inject 复用记忆', async () => {
    const harness = makeHarness();
    const runId = await seedRun(harness);
    await seedMemory(harness, 'mem-a', 'msg-1');

    // Agent A 经 phase3 create_capsule 工具把记忆打包，授权目标 Agent B。
    const result = await harness.handler['memory.create_capsule']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c1', managementRunId: runId, workerId: 'agent-a',
      toolCallId: 'call-capsule', toolName: 'memory.create_capsule', leaseToken: 'tok', fencingToken: 1,
      input: { targetAgentId: 'agent-b', prompt: '为 B 打包授权', limit: 5 },
    });
    expect(result.capsuleRef.id).toBeTruthy();

    // B 经 capsule inject 复用 A 的记忆（allowed）。
    const capsule = await harness.capsuleService.createCapsule({
      teamId: 'team-1', requesterUserId: 'agent-b', managementRunId: runId, targetAgentId: 'agent-b',
      prompt: 'B 接手', limit: 5, now: 5_000, currentPolicyVersion: POLICY_VERSION,
    });
    expect(capsule.items.length).toBeGreaterThan(0);
    const injection = await harness.validator.validateCapsuleForInjection({
      capsule, requesterUserId: 'agent-b', now: 6_000, currentPolicyVersion: POLICY_VERSION,
    });
    expect(injection.decisions.every((decision) => decision.allowed)).toBe(true);
  });

  test('负场景：来源失效后 B inject 被拒绝', async () => {
    const harness = makeHarness();
    const runId = await seedRun(harness);
    await seedMemory(harness, 'mem-a', 'msg-1');

    // 来源失效（msg-1 不可用）。
    harness.markSourceUnavailable('msg-1');

    const capsule = await harness.capsuleService.createCapsule({
      teamId: 'team-1', requesterUserId: 'agent-b', managementRunId: runId, targetAgentId: 'agent-b',
      prompt: 'B 接手', limit: 5, now: 5_000, currentPolicyVersion: POLICY_VERSION,
    });
    const injection = await harness.validator.validateCapsuleForInjection({
      capsule, requesterUserId: 'agent-b', now: 6_000, currentPolicyVersion: POLICY_VERSION,
    });
    expect(injection.decisions.every((decision) => !decision.allowed)).toBe(true);
  });
});
