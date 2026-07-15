import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  createLocalMemoryStore,
  profileMemoryFile,
  workspaceMemoryFile,
} from '../src/memory/local-memory-store';
import { workspaceCwdHash } from '../src/memory/workspace-identity';

describe('LocalMemoryStore', () => {
  test('按 workspace/profile 分文件持久化，并在重启后恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-local-memory-'));
    const cwd = join(root, 'workspace');
    const baseDir = join(root, 'home');
    const store = await createLocalMemoryStore({ profileId: 'Team A', cwd, baseDir,
      now: () => 10, nextId: sequenceIds() });
    await store.upsert(workspaceInput(cwd, { dedupeKey: 'scan:tech-stack' }));
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'Prefer Node 24' });

    const reloaded = await createLocalMemoryStore({ profileId: 'Team A', cwd, baseDir });

    expect(reloaded.list()).toHaveLength(2);
    expect(statSync(workspaceMemoryFile(cwd)).mode & 0o777).toBe(0o600);
    expect(statSync(profileMemoryFile('Team A', baseDir)).mode & 0o777).toBe(0o600);
  });

  test('自动条目按 cwdHash + kind + dedupeKey 更新并合并来源，不新增重复项', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-dedupe-'));
    let now = 10;
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home'),
      now: () => now, nextId: sequenceIds() });
    const created = await store.upsert(workspaceInput(cwd, {
      dedupeKey: 'run-ok:abc', sourceKind: 'workspace_run', structured: { sourceRunIds: ['run-1'] },
    }));
    now = 20;
    const updated = await store.upsert(workspaceInput(cwd, {
      dedupeKey: 'run-ok:abc', sourceKind: 'workspace_run', content: 'new content',
      structured: { sourceRunIds: ['run-2'] },
    }));

    expect(updated.action).toBe('updated');
    expect(updated.item.id).toBe(created.item.id);
    expect(updated.item.createdAt).toBe(10);
    expect(updated.item.updatedAt).toBe(20);
    expect(updated.item.structured?.sourceRunIds).toEqual(['run-1', 'run-2']);
    expect(store.list()).toHaveLength(1);
  });

  test('排除过期与非 active 条目，并拒绝自动积累敏感内容', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-expiry-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home'),
      now: () => 100, nextId: sequenceIds() });
    const active = await store.upsert(workspaceInput(cwd, { dedupeKey: 'scan:layout' }));
    await store.setStatus(active.item.id, 'deleted');
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'temporary', validUntil: 110 });

    expect(store.listActive(105)).toHaveLength(1);
    expect(store.listActive(110)).toEqual([]);
    await expect(store.upsert(workspaceInput(cwd, {
      dedupeKey: 'run-ok:secret', sourceKind: 'workspace_run',
      content: 'command uses api_key=super-secret-value',
    }))).rejects.toThrow('LOCAL_MEMORY_SENSITIVE_CONTENT');
    await expect(store.upsert(workspaceInput(cwd, {
      dedupeKey: 'run-ok:structured-secret', sourceKind: 'workspace_run',
      structured: { commands: ['TOKEN=super-secret-value tool run'] },
    }))).rejects.toThrow('LOCAL_MEMORY_SENSITIVE_CONTENT');
  });

  test('超过 workspace 自动条目上限时优先过期最旧 run，manual 不被淘汰', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-cap-'));
    let now = 1;
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home'),
      maxAutoWorkspaceItems: 50, now: () => now++, nextId: sequenceIds() });
    const oldest = await store.upsert(workspaceInput(cwd, {
      dedupeKey: 'run-ok:oldest', sourceKind: 'workspace_run',
    }));
    for (let index = 0; index < 49; index += 1) {
      await store.upsert(workspaceInput(cwd, { dedupeKey: `scan:item-${index}` }));
    }
    await store.upsert({ ...workspaceInput(cwd, { dedupeKey: undefined, sourceKind: 'manual' }),
      dedupeKey: undefined });
    const overflow = await store.upsert(workspaceInput(cwd, { dedupeKey: 'scan:overflow' }));

    expect(overflow.expired.map((item) => item.id)).toContain(oldest.item.id);
    expect(store.getById(oldest.item.id)?.status).toBe('expired');
    expect(store.list().find((item) => item.sourceKind === 'manual')?.status).toBe('active');
  });
});

function workspaceInput(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'semantic' as const,
    scopeType: 'local-workspace' as const,
    sourceKind: 'scan' as const,
    content: 'workspace memory',
    cwd,
    cwdHash: workspaceCwdHash(cwd),
    dedupeKey: 'scan:default',
    ...overrides,
  };
}

function sequenceIds(): () => string {
  let sequence = 0;
  return () => `memory-${++sequence}`;
}
