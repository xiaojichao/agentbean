import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createManagementDurableOutbox,
  type ManagementDurableOutboxItem,
  type ManagementOutboxStorage,
} from '../src/management-durable-outbox';
import { managementOutboxFile } from '../src/profile-paths';

const ITEM: ManagementDurableOutboxItem = {
  schemaVersion: 1,
  managementRunId: 'run-1',
  commandId: 'command-1',
  idempotencyKey: 'invoke-1',
  requestHash: 'hash-1',
  toolName: 'agents.invoke',
  createdAt: 10,
};

describe('ManagementDurableOutbox', () => {
  test('write-before-ack：enqueue 返回前已原子持久化，重启可恢复', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'agentbean-management-outbox-'));
    const outbox = await createManagementDurableOutbox({ profileId: 'team-a', baseDir });

    await outbox.enqueue(ITEM);

    const reloaded = await createManagementDurableOutbox({ profileId: 'team-a', baseDir });
    expect(reloaded.list()).toEqual([ITEM]);
    expect(statSync(managementOutboxFile('team-a', baseDir)).mode & 0o777).toBe(0o600);
  });

  test('Phase 3 Memory write command uses the same durable replay boundary', async () => {
    let snapshot: unknown = { schemaVersion: 1, items: [] };
    const outbox = await createManagementDurableOutbox({
      storage: {
        load: async () => snapshot,
        save: async (next) => { snapshot = structuredClone(next); },
      },
    });
    const phase3Item: ManagementDurableOutboxItem = {
      ...ITEM,
      commandId: 'command-memory-1',
      idempotencyKey: 'capsule-1',
      toolName: 'memory.create_capsule',
    };

    await outbox.enqueue(phase3Item);

    expect(outbox.list()).toEqual([phase3Item]);
  });

  test('crash-before-write：持久化失败时不把未落盘项加入内存队列', async () => {
    let snapshot: unknown = { schemaVersion: 1, items: [] };
    const storage: ManagementOutboxStorage = {
      load: async () => snapshot,
      save: async () => { throw new Error('disk full'); },
    };
    const outbox = await createManagementDurableOutbox({ storage });

    await expect(outbox.enqueue(ITEM)).rejects.toThrow('MANAGEMENT_OUTBOX_WRITE_FAILED');
    expect(outbox.size()).toBe(0);
    expect(snapshot).toEqual({ schemaVersion: 1, items: [] });
  });

  test('ack-before-delete：删除落盘失败时保留原项供下次 idempotency replay', async () => {
    let snapshot: unknown = { schemaVersion: 1, items: [ITEM] };
    const storage: ManagementOutboxStorage = {
      load: async () => snapshot,
      save: async () => { throw new Error('rename interrupted'); },
    };
    const outbox = await createManagementDurableOutbox({ storage });

    await expect(outbox.remove(ITEM)).rejects.toThrow('MANAGEMENT_OUTBOX_WRITE_FAILED');
    expect(outbox.list()).toEqual([ITEM]);
  });

  test('损坏文件 fail closed，不让 daemon 崩溃或加载半条命令', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'agentbean-management-outbox-corrupt-'));
    const file = managementOutboxFile('team-a', baseDir);
    const parent = file.slice(0, file.lastIndexOf('/'));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(parent, { recursive: true }));
    writeFileSync(file, '{broken', 'utf8');
    chmodSync(file, 0o600);

    const outbox = await createManagementDurableOutbox({ profileId: 'team-a', baseDir });

    expect(outbox.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('"items": []');
  });

  test('拒绝持久化 raw lease token、模型密钥和绝对 cwd', async () => {
    const outbox = await createManagementDurableOutbox({
      storage: {
        load: async () => ({ schemaVersion: 1, items: [] }),
        save: async () => undefined,
      },
    });

    await expect(outbox.enqueue({ ...ITEM, leaseToken: 'raw-token' } as never))
      .rejects.toThrow('MANAGEMENT_OUTBOX_ITEM_INVALID');
    await expect(outbox.enqueue({ ...ITEM, cwd: '/Users/test/project' } as never))
      .rejects.toThrow('MANAGEMENT_OUTBOX_ITEM_INVALID');
    await expect(outbox.enqueue({ ...ITEM, apiKey: 'sk-secret' } as never))
      .rejects.toThrow('MANAGEMENT_OUTBOX_ITEM_INVALID');
  });

  test('相同 idempotency key 的不同 request hash fail closed，不覆盖原命令', async () => {
    const outbox = await createManagementDurableOutbox({
      storage: {
        load: async () => ({ schemaVersion: 1, items: [] }),
        save: async () => undefined,
      },
    });
    await outbox.enqueue(ITEM);

    await expect(outbox.enqueue({ ...ITEM, requestHash: 'different-hash' }))
      .rejects.toThrow('MANAGEMENT_OUTBOX_IDEMPOTENCY_CONFLICT');
    expect(outbox.list()).toEqual([ITEM]);
  });

  test('并发 enqueue 串行落盘，不丢失不同命令', async () => {
    let snapshot: unknown = { schemaVersion: 1, items: [] };
    const outbox = await createManagementDurableOutbox({
      storage: {
        load: async () => snapshot,
        save: async (next) => { snapshot = structuredClone(next); },
      },
    });

    await Promise.all([
      outbox.enqueue(ITEM),
      outbox.enqueue({ ...ITEM, commandId: 'command-2', idempotencyKey: 'invoke-2' }),
    ]);

    expect((snapshot as { items: unknown[] }).items).toHaveLength(2);
    expect(outbox.size()).toBe(2);
  });
});
