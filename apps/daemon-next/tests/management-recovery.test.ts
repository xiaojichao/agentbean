import { describe, expect, test, vi } from 'vitest';
import { hashManagementToolRequest, replayManagementOutboxForLease } from '../src/pi-manager-worker-host';
import type { ManagementDurableOutboxItem } from '../src/management-durable-outbox';

describe('management worker recovery', () => {
  test('同 profile 重启后用当前 lease 查询原 idempotency result，不重发旧 authority', async () => {
    const item: ManagementDurableOutboxItem = {
      schemaVersion: 1,
      managementRunId: 'run-1',
      commandId: 'command-1',
      idempotencyKey: 'invoke-1',
      requestHash: 'request-hash-1',
      toolName: 'agents.invoke',
      createdAt: 1,
    };
    const remove = vi.fn(async () => undefined);
    const replayOutbox = vi.fn(async (payload) => ({
      schemaVersion: 1 as const,
      commandId: payload.commandId,
      managementRunId: payload.managementRunId,
      idempotencyKey: payload.idempotencyKey,
      disposition: 'existing' as const,
      resultReferenceId: 'invocation-1',
    }));

    await expect(replayManagementOutboxForLease({
      authority: {
        managementRunId: 'run-1', workerId: 'worker-new',
        leaseToken: 'current-lease-token', fencingToken: 2,
      },
      protocol: { replayOutbox } as never,
      outbox: { list: () => [item], remove } as never,
    })).resolves.toEqual({ unresolvedMemoryWriteCount: 0 });

    expect(replayOutbox).toHaveBeenCalledWith({
      schemaVersion: 1,
      managementRunId: 'run-1',
      workerId: 'worker-new',
      leaseToken: 'current-lease-token',
      fencingToken: 2,
      idempotencyKey: 'invoke-1',
      commandId: 'command-1',
      requestHash: 'request-hash-1',
    });
    expect(remove).toHaveBeenCalledWith(item);
  });

  test('Memory 副作用与 receipt 之间崩溃时保留 rejected outbox，等待后续权威确认', async () => {
    const item: ManagementDurableOutboxItem = {
      schemaVersion: 1, managementRunId: 'run-1', commandId: 'command-memory',
      idempotencyKey: 'memory-1', requestHash: 'request-hash-memory',
      toolName: 'memory.create_capsule', createdAt: 1,
    };
    const remove = vi.fn(async () => undefined);
    await expect(replayManagementOutboxForLease({
      authority: { managementRunId: 'run-1', workerId: 'worker-new',
        leaseToken: 'current-lease-token', fencingToken: 2 },
      protocol: { replayOutbox: vi.fn(async (payload) => ({ schemaVersion: 1 as const,
        commandId: payload.commandId, managementRunId: payload.managementRunId,
        idempotencyKey: payload.idempotencyKey, disposition: 'rejected' as const })) } as never,
      outbox: { list: () => [item], remove } as never,
    })).resolves.toEqual({ unresolvedMemoryWriteCount: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  test('daemon 与 server 对 undefined 可选键使用相同 canonical request hash', () => {
    expect(hashManagementToolRequest('memory.create_capsule', {
      targetAgentId: 'agent-1', prompt: '目标', limit: 3, taskId: undefined,
    })).toBe(hashManagementToolRequest('memory.create_capsule', {
      targetAgentId: 'agent-1', prompt: '目标', limit: 3,
    }));
  });
});
