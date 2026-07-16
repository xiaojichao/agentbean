import { describe, expect, test } from 'vitest';

import type { MemoryItemRecord, ServerNextRepositories } from '../src/index.js';
import { createCollaborativeMemorySearchService } from '../src/application/collaborative-memory-search-service.js';
import { createMemoryCapsuleService } from '../src/application/memory-capsule-service.js';
import { createCapsuleInjectionValidator } from '../src/application/capsule-injection-validator.js';
import { createPhase3ManagementToolHandlers } from '../src/application/management/management-tool-executor.js';
import { createServerCapsuleRuntimeContextService } from '../src/application/server-capsule-runtime-context-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

// P3-17 跨 Agent / Task Memory smoke（代码链路）：Agent A 经 phase3 create_capsule 工具把
// Task A 来源的记忆打包并绑定 Task B，授权给目标 Agent B；B 经 capsule inject 复用。
// 负场景：Task A 来源失效后 B 注入被拒。
// 注：permissions 放宽（mock），聚焦 handler/capsule/inject 链路；真实两个 LLM Agent 需用户环境跑。

const POLICY_VERSION = 7;

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly handler: ReturnType<typeof createPhase3ManagementToolHandlers>;
  readonly runtime: ReturnType<typeof createServerCapsuleRuntimeContextService>;
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
  const validator = createCapsuleInjectionValidator({ unitOfWork: repositories.memoryUnitOfWork, permissions, ids });
  const handler = createPhase3ManagementToolHandlers({
    repositories, searchService, capsuleService,
    candidateService: { async proposeCandidate() { return { candidate: {} as never, sources: [] }; } } as never,
    collaborativeService: { async linkSources() { return {} as never; } } as never,
    clock, currentPolicyVersion: POLICY_VERSION,
  });
  return {
    repositories,
    handler,
    runtime: createServerCapsuleRuntimeContextService({
      unitOfWork: repositories.memoryUnitOfWork,
      validator,
      ids,
      currentPolicyVersion: () => POLICY_VERSION,
    }),
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
    rootTaskId: 'task-b', rootMessageId: 'msg-1', mode: 'managed', status: 'running',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    checkpointRevision: 0, budget: { maxSubtasks: 2, maxDepth: 1, maxExternalInvocations: 2 },
    createdAt: 1, updatedAt: 1,
  } as never);
  return 'run-p3';
}

async function seedMemory(harness: Harness, memoryId: string, sourceTaskId: string): Promise<void> {
  await harness.repositories.memoryUnitOfWork.run(async (memory) => {
    const item: MemoryItemRecord = {
      schemaVersion: 1, id: memoryId, teamId: 'team-1', kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content: `决策结论 ${memoryId}`, summary: '关于 X',
      createdByUserId: 'user-1', approvedByUserId: 'user-1', validFrom: 1, createdAt: 1, updatedAt: 1,
    };
    await memory.items.create(item);
    await memory.sources.create({
      memoryId, teamId: 'team-1', sourceKind: 'task', sourceId: sourceTaskId,
      snapshotHash: `sha256:${sourceTaskId}`, sourceScopeType: 'task', sourceScopeRef: sourceTaskId,
      sourceVisibility: 'team', createdAt: 1,
    });
  });
}

describe('P3-17 跨 Agent Memory smoke', () => {
  test('正场景：A 经 create_capsule 打包授权 → B inject 复用记忆', async () => {
    const harness = makeHarness();
    const runId = await seedRun(harness);
    await seedMemory(harness, 'mem-a', 'task-a');

    // Agent A 经 phase3 create_capsule 工具把记忆打包，授权目标 Agent B。
    const result = await harness.handler['memory.create_capsule']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c1', managementRunId: runId, workerId: 'agent-a',
      toolCallId: 'call-capsule', toolName: 'memory.create_capsule', leaseToken: 'tok', fencingToken: 1,
      idempotencyKey: 'capsule-a-to-b',
      input: { targetAgentId: 'agent-b', taskId: 'task-b', prompt: '为 B 打包授权', limit: 5 },
    });
    expect(result.capsuleRef).toMatchObject({ taskId: 'task-b', targetAgentId: 'agent-b' });
    const manifests = await harness.repositories.memory.capsuleItems.listByCapsule({
      teamId: 'team-1', capsuleId: result.capsuleRef.id,
    });
    expect(manifests.map((manifest) => manifest.memoryId)).toEqual(['mem-a']);

    // B 经生产 runtime 路径重建并 inject A 创建的同一个 Capsule。
    const context = await harness.runtime.resolve({
      teamId: 'team-1', managementRunId: runId, taskId: 'task-b', targetAgentId: 'agent-b',
      memoryCapsuleRef: result.capsuleRef, now: 5_000,
    });
    expect(context).toMatchObject([{
      id: 'mem-a',
      provenance: {
        origin: 'server',
        capsuleId: result.capsuleRef.id,
        sourceRefs: [{ sourceKind: 'task', sourceId: 'task-a' }],
      },
    }]);
  });

  test('负场景：来源失效后 B inject 被拒绝', async () => {
    const harness = makeHarness();
    const runId = await seedRun(harness);
    await seedMemory(harness, 'mem-a', 'task-a');

    const result = await harness.handler['memory.create_capsule']!({
      schemaVersion: 2, managementPhase: 3, commandId: 'c1', managementRunId: runId, workerId: 'agent-a',
      toolCallId: 'call-capsule', toolName: 'memory.create_capsule', leaseToken: 'tok', fencingToken: 1,
      idempotencyKey: 'capsule-a-to-b',
      input: { targetAgentId: 'agent-b', taskId: 'task-b', prompt: '为 B 打包授权', limit: 5 },
    });
    expect(result.capsuleRef).toMatchObject({ taskId: 'task-b', targetAgentId: 'agent-b' });
    const manifests = await harness.repositories.memory.capsuleItems.listByCapsule({
      teamId: 'team-1', capsuleId: result.capsuleRef.id,
    });
    expect(manifests.map((manifest) => manifest.memoryId)).toEqual(['mem-a']);

    // Capsule 创建后 Task A 来源失效，B 在 Task B 注入同一个 Capsule 时必须被拒。
    harness.markSourceUnavailable('task-a');
    await expect(harness.runtime.resolve({
      teamId: 'team-1', managementRunId: runId, taskId: 'task-b', targetAgentId: 'agent-b',
      memoryCapsuleRef: result.capsuleRef, now: 5_000,
    })).rejects.toMatchObject({ code: 'SERVER_CAPSULE_REVALIDATION_FAILED' });
    await expect(harness.repositories.memory.capsuleRefs.getById({
      teamId: 'team-1', id: result.capsuleRef.id,
    })).resolves.toMatchObject({ deniedAt: 5_000 });
  });
});
