import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createLocalMemoryStore } from '../src/memory/local-memory-store';
import { listLocalMemoriesForDispatch } from '../src/memory/local-memory-search';
import { workspaceCwdHash } from '../src/memory/workspace-identity';

describe('listLocalMemoriesForDispatch', () => {
  test('严格执行 profile/cwd/agent 边界并排除过期记录', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-search-a-'));
    const otherCwd = mkdtempSync(join(tmpdir(), 'agentbean-search-b-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home'), now: () => 100 });
    await store.upsert(workspaceItem(cwd, 'workspace-current'));
    await store.upsert({ kind: 'procedural', scopeType: 'local-agent', sourceKind: 'manual',
      agentId: 'agent-1', content: 'agent command' });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'profile preference' });
    await store.upsert({ kind: 'preference', scopeType: 'local-agent', sourceKind: 'manual',
      agentId: 'agent-2', content: 'other agent' });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'expires soon', validUntil: 110 });

    const current = listLocalMemoriesForDispatch({ store, profileId: 'p', cwd, agentId: 'agent-1',
      prompt: 'command', now: 120 });
    const other = listLocalMemoriesForDispatch({ store, profileId: 'p', cwd: otherCwd, agentId: 'agent-2',
      prompt: '', now: 120 });

    expect(current.map((item) => item.content)).toEqual([
      'workspace-current', 'agent command', 'profile preference',
    ]);
    expect(other.map((item) => item.content)).toEqual(['other agent', 'profile preference']);
    expect(listLocalMemoriesForDispatch({ store, profileId: 'other', cwd, agentId: 'agent-1', prompt: '' }))
      .toEqual([]);
  });

  test('scope 优先且遵守条数与 token 预算', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-search-budget-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home'), now: () => 100 });
    await store.upsert(workspaceItem(cwd, 'short workspace'));
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'x'.repeat(1_000) });

    const selected = listLocalMemoriesForDispatch({ store, profileId: 'p', cwd, prompt: 'workspace',
      limit: 1, tokenBudget: 10, now: 100 });

    expect(selected.map((item) => item.content)).toEqual(['short workspace']);
  });

  test('检索沿用 canonical profile identity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-search-profile-'));
    const store = await createLocalMemoryStore({ profileId: 'Team A', cwd, baseDir: join(cwd, 'home') });
    await store.upsert({ kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
      content: 'profile preference' });

    expect(listLocalMemoriesForDispatch({ store, profileId: 'Team A', prompt: '' })).toHaveLength(1);
  });
});

function workspaceItem(cwd: string, content: string) {
  return { kind: 'procedural' as const, scopeType: 'local-workspace' as const,
    sourceKind: 'scan' as const, cwd, cwdHash: workspaceCwdHash(cwd),
    dedupeKey: `scan:${content}`, content };
}
