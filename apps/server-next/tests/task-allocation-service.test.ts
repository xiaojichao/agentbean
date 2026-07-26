import { describe, expect, test } from 'vitest';
import { resolveTaskAllocation } from '../src/application/management/task-allocation-service.js';

describe('resolveTaskAllocation（#807 AC#2 allocation 接线）', () => {
  function deps(input: {
    readonly claimPolicy: 'open' | 'targeted';
    readonly assigneeId?: string;
    readonly eligibleAgentIds: readonly string[];
    readonly ineligibleAgentIds?: readonly string[];
  }) {
    const candidates = [
      ...input.eligibleAgentIds.map((agentId) => ({
        agentId, eligible: true, missingCapabilities: [], diagnosticCodes: [],
      })),
      ...(input.ineligibleAgentIds ?? []).map((agentId) => ({
        agentId, eligible: false, missingCapabilities: [], diagnosticCodes: ['AGENT_NOT_READY' as const],
      })),
    ];
    return {
      taskId: 'task-a',
      broker: {
        resolveCandidates: async () => ({
          taskId: 'task-a', taskRevision: 1, taskAttempt: 1, candidates, ancestorAgentIds: [],
        }),
      },
      repositories: {
        tasks: {
          getById: async () => ({
            id: 'task-a', teamId: 'team-1', revision: 1,
            ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
          }),
        },
        taskCoordination: {
          coordinations: {
            getByTaskId: async () => ({ taskId: 'task-a', claimPolicy: input.claimPolicy }),
          },
        },
      },
    } as unknown as Parameters<typeof resolveTaskAllocation>[0];
  }

  test('显式指派且目标合格 → 保留 targeted，不被强转 open（#807 核心缺陷）', async () => {
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'targeted', assigneeId: 'agent-2', eligibleAgentIds: ['agent-1', 'agent-2'],
    }))).resolves.toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-2' });
  });

  test('显式指派但目标当前不合格 → 仍保留 targeted，不静默改派（#711 AC#6）', async () => {
    // 回落 open 会清空 assigneeId，等于把用户的 @Agent 指派悄悄改派给别人。
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'targeted', assigneeId: 'agent-2',
      eligibleAgentIds: ['agent-1'], ineligibleAgentIds: ['agent-2'],
    }))).resolves.toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-2' });
  });

  test('显式指派时 broker 抛错也不丢指派（executor 的 catch 会把异常压成 null → 强转 open）', async () => {
    // 显式指派路径不查候选，故不引入 broker 的失败面。若改成依赖 broker，
    // 任何 IO 抖动都会让 allocation 变 null → kernel 兜底清空 assigneeId → 静默改派。
    const base = deps({ claimPolicy: 'targeted', assigneeId: 'agent-2', eligibleAgentIds: ['agent-2'] });
    await expect(resolveTaskAllocation({
      ...base,
      broker: { resolveCandidates: async () => { throw new Error('SQLITE_BUSY'); } },
    } as unknown as Parameters<typeof resolveTaskAllocation>[0]))
      .resolves.toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-2' });
  });

  test('无显式指派 + 多个合格候选 → open，保持既有 fan-out（负载数据缺失不伪造排序）', async () => {
    // loadUncertain=true 如实反映 reliability/load 无持久化，故不把任务定向派给字典序第一者。
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'open', eligibleAgentIds: ['agent-1', 'agent-2', 'agent-3'],
    }))).resolves.toEqual({ claimPolicy: 'open' });
  });

  test('无显式指派 + 唯一合格候选 → targeted（ADR 0002 候选明确即定向）', async () => {
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'open', eligibleAgentIds: ['agent-1'],
    }))).resolves.toEqual({ claimPolicy: 'targeted', targetAgentId: 'agent-1' });
  });

  test('无合格候选 → null（不覆写，交回 kernel 既有路径）', async () => {
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'open', eligibleAgentIds: [], ineligibleAgentIds: ['agent-1'],
    }))).resolves.toBeNull();
  });

  test('claimPolicy=targeted 但无 assigneeId → 不视为显式指派', async () => {
    // 仅 claimPolicy 而无落库的 assigneeId 不构成用户指派意图，按普通多候选处理。
    await expect(resolveTaskAllocation(deps({
      claimPolicy: 'targeted', eligibleAgentIds: ['agent-1', 'agent-2'],
    }))).resolves.toEqual({ claimPolicy: 'open' });
  });

  test('task 或 coordination 缺失 → null（不覆写）', async () => {
    const base = deps({ claimPolicy: 'open', eligibleAgentIds: ['agent-1'] });
    await expect(resolveTaskAllocation({
      ...base,
      repositories: { ...base.repositories, tasks: { getById: async () => null } },
    } as unknown as Parameters<typeof resolveTaskAllocation>[0])).resolves.toBeNull();
  });
});
