import { describe, expect, test, vi } from 'vitest';
import { replayManagementOutboxForLease } from '../src/pi-manager-worker-host';
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

    await replayManagementOutboxForLease({
      authority: {
        managementRunId: 'run-1', workerId: 'worker-new',
        leaseToken: 'current-lease-token', fencingToken: 2,
      },
      protocol: { replayOutbox } as never,
      outbox: { list: () => [item], remove } as never,
    });

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
});
