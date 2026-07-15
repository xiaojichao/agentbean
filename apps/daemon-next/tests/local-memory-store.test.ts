import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
    mkdirSync(cwd);
    const baseDir = join(root, 'home');
    const store = await createLocalMemoryStore({ profileId: 'Team A', cwd, baseDir,
      now: () => 10, nextId: sequenceIds() });
    await store.upsert(workspaceInput(cwd, { dedupeKey: 'scan:tech-stack' }));
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'Prefer Node 24' });

    const reloaded = await createLocalMemoryStore({ profileId: 'Team A', cwd, baseDir });

    expect(reloaded.list()).toHaveLength(2);
    expect(statSync(workspaceMemoryFile(cwd, 'Team A')).mode & 0o777).toBe(0o600);
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

  test('同一 cwd 的不同 profile 使用独立文件，重启不会互相抹除', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-profiles-'));
    const baseDir = join(cwd, 'home');
    const first = await createLocalMemoryStore({ profileId: 'team-a', cwd, baseDir });
    const second = await createLocalMemoryStore({ profileId: 'team-b', cwd, baseDir });

    await first.upsert(workspaceInput(cwd, { content: 'team-a memory', dedupeKey: 'scan:a' }));
    await second.upsert(workspaceInput(cwd, { content: 'team-b memory', dedupeKey: 'scan:b' }));

    const firstReloaded = await createLocalMemoryStore({ profileId: 'team-a', cwd, baseDir });
    const secondReloaded = await createLocalMemoryStore({ profileId: 'team-b', cwd, baseDir });
    expect(firstReloaded.list().map((item) => item.content)).toEqual(['team-a memory']);
    expect(secondReloaded.list().map((item) => item.content)).toEqual(['team-b memory']);
    expect(workspaceMemoryFile(cwd, 'team-a')).not.toBe(workspaceMemoryFile(cwd, 'team-b'));
  });

  test('两个 Store 并发写同一文件时在锁内 reload/merge，不丢更新或残留临时文件', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-concurrent-'));
    const baseDir = join(cwd, 'home');
    const first = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    const second = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });

    await Promise.all([
      first.upsert(workspaceInput(cwd, { content: 'first', dedupeKey: 'scan:first' })),
      second.upsert(workspaceInput(cwd, { content: 'second', dedupeKey: 'scan:second' })),
    ]);
    const third = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    const fourth = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    await Promise.all([
      third.upsert(workspaceInput(cwd, { content: 'shared', dedupeKey: 'run-ok:shared',
        sourceKind: 'workspace_run', structured: { sourceRunIds: ['run-a'] } })),
      fourth.upsert(workspaceInput(cwd, { content: 'shared', dedupeKey: 'run-ok:shared',
        sourceKind: 'workspace_run', structured: { sourceRunIds: ['run-b'] } })),
    ]);

    const reloaded = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    expect(reloaded.list().map((item) => item.content).sort()).toEqual(['first', 'second', 'shared']);
    expect([...(reloaded.list().find((item) => item.dedupeKey === 'run-ok:shared')
      ?.structured?.sourceRunIds ?? [])].sort()).toEqual(['run-a', 'run-b']);
    expect(readdirSync(join(cwd, '.agentbean', 'memory')).some((name) => name.includes('.tmp-') || name.endsWith('.lock')))
      .toBe(false);
  });

  test('拒绝 workspace .agentbean/memory symlink 逃逸', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'agentbean-memory-outside-'));
    symlinkSync(outside, join(cwd, '.agentbean'));

    await expect(createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') }))
      .rejects.toThrow('LOCAL_MEMORY_PATH_ESCAPE');
    expect(readdirSync(outside)).toEqual([]);
  });

  test('拒绝 profileTarget 任一目录段的 symlink 逃逸', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentbean-memory-profile-symlink-'));
    const baseDir = join(root, 'home');
    const outside = mkdtempSync(join(tmpdir(), 'agentbean-memory-profile-outside-'));
    mkdirSync(baseDir);
    symlinkSync(outside, join(baseDir, 'teams'));

    await expect(createLocalMemoryStore({ profileId: 'p', baseDir }))
      .rejects.toThrow('LOCAL_MEMORY_PATH_ESCAPE');
    expect(readdirSync(outside)).toEqual([]);
  });

  test('load 按 FileTarget 严格拒绝 workspace scope/canonical cwd/hash 错配', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-target-workspace-'));
    const baseDir = join(cwd, 'home');
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    await store.upsert(workspaceInput(cwd));
    const file = workspaceMemoryFile(cwd, 'p');
    const original = JSON.parse(readFileSync(file, 'utf8')) as { items: Array<Record<string, unknown>> };
    const mismatches: Array<(item: Record<string, unknown>) => void> = [
      (item) => { item.scopeType = 'local-profile'; },
      (item) => { item.cwd = join(cwd, '..', 'other'); },
      (item) => { item.cwdHash = 'forged-canonical-hash'; },
    ];

    for (const mutate of mismatches) {
      const snapshot = structuredClone(original);
      mutate(snapshot.items[0]!);
      writeFileSync(file, JSON.stringify(snapshot), 'utf8');
      await expect(createLocalMemoryStore({ profileId: 'p', cwd, baseDir }))
        .rejects.toThrow('LOCAL_MEMORY_FILE_INVALID');
    }
  });

  test('load 拒绝 profile 文件混入 local-workspace scope', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-target-profile-'));
    const baseDir = join(cwd, 'home');
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'profile memory' });
    const file = profileMemoryFile('p', baseDir);
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { items: Array<Record<string, unknown>> };
    Object.assign(snapshot.items[0]!, {
      scopeType: 'local-workspace', cwd, cwdHash: workspaceCwdHash(cwd), dedupeKey: 'manual:wrong-file',
    });
    writeFileSync(file, JSON.stringify(snapshot), 'utf8');

    await expect(createLocalMemoryStore({ profileId: 'p', cwd, baseDir }))
      .rejects.toThrow('LOCAL_MEMORY_FILE_INVALID');
  });

  test('损坏或 schema 不合法的文件 fail closed，后续写入不得覆盖', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-invalid-'));
    const file = workspaceMemoryFile(cwd, 'p');
    mkdirSync(join(cwd, '.agentbean', 'memory'), { recursive: true });
    const invalidSchema = '{"schemaVersion":1,"items":[{"bad":true}]}';
    writeFileSync(file, invalidSchema, 'utf8');

    await expect(createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') }))
      .rejects.toThrow('LOCAL_MEMORY_FILE_INVALID');
    expect(readFileSync(file, 'utf8')).toBe(invalidSchema);

    const liveCwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-corrupt-after-load-'));
    const live = await createLocalMemoryStore({ profileId: 'p', cwd: liveCwd, baseDir: join(liveCwd, 'home') });
    await live.upsert(workspaceInput(liveCwd));
    const liveFile = workspaceMemoryFile(liveCwd, 'p');
    writeFileSync(liveFile, '{corrupted-after-load', 'utf8');
    await expect(live.upsert(workspaceInput(liveCwd, { dedupeKey: 'scan:second' })))
      .rejects.toThrow('LOCAL_MEMORY_FILE_INVALID');
    expect(readFileSync(liveFile, 'utf8')).toBe('{corrupted-after-load');
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
    await expect(store.upsert({ ...workspaceInput(cwd), profileId: 'other', apiKey: 'secret' } as never))
      .rejects.toThrow('LOCAL_MEMORY_ITEM_INVALID');
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

  test('压缩终态记录并对无法淘汰的 active 数据执行总量硬限制', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-retention-'));
    const baseDir = join(cwd, 'home');
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir,
      maxTotalItems: 3, maxTerminalItems: 1, maxFileBytes: 8_192, nextId: sequenceIds() });
    const first = await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'one' });
    const second = await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'two' });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'three' });
    await store.setStatus(first.item.id, 'expired');
    await store.setStatus(second.item.id, 'deleted');

    expect(store.list().filter((item) => item.status !== 'active')).toHaveLength(1);
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'four' });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'five' });
    await expect(store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual', content: 'six' }))
      .rejects.toThrow('LOCAL_MEMORY_CAPACITY_EXCEEDED');
    expect((await createLocalMemoryStore({ profileId: 'p', cwd, baseDir,
      maxTotalItems: 3, maxTerminalItems: 1, maxFileBytes: 8_192 })).list()).toHaveLength(3);
  });

  test('Store 以内 canonical cwd 派生 hash，拒绝 caller 伪造 cwdHash', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-hash-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });

    await expect(store.upsert(workspaceInput(cwd, { cwdHash: 'forged' })))
      .rejects.toThrow('LOCAL_MEMORY_CWD_HASH_INVALID');
    const created = await store.upsert({ ...workspaceInput(cwd), cwdHash: undefined });
    expect(created.item.cwdHash).toBe(workspaceCwdHash(cwd));
    expect(existsSync(workspaceMemoryFile(cwd, 'p'))).toBe(true);
  });

  test('文件大小达到硬上限且没有可淘汰终态时拒绝写入', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-file-cap-'));
    const baseDir = join(cwd, 'home');
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir,
      maxTotalItems: 10, maxTerminalItems: 2, maxFileBytes: 1_024 });

    await expect(store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'x'.repeat(2_000) })).rejects.toThrow('LOCAL_MEMORY_CAPACITY_EXCEEDED');
    expect(existsSync(profileMemoryFile('p', baseDir))).toBe(false);
  });

  test('压缩按与 save 相同的 pretty serializer 实际字节淘汰终态', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-memory-pretty-cap-'));
    const baseDir = join(cwd, 'home');
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir,
      maxTotalItems: 10, maxTerminalItems: 10, maxFileBytes: 1_024, nextId: sequenceIds() });
    const terminal = await store.upsert({ kind: 'preference', scopeType: 'local-profile',
      sourceKind: 'manual', content: `old-${'x'.repeat(220)}` });
    await store.setStatus(terminal.item.id, 'expired');

    await expect(store.upsert({ kind: 'preference', scopeType: 'local-profile',
      sourceKind: 'manual', content: `new-${'y'.repeat(220)}` })).resolves.toMatchObject({ action: 'created' });
    expect(store.list().map((item) => item.content)).toEqual([`new-${'y'.repeat(220)}`]);
    expect(Buffer.byteLength(readFileSync(profileMemoryFile('p', baseDir)))).toBeLessThanOrEqual(1_024);
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
