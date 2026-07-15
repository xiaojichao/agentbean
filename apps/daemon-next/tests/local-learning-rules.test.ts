import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createLocalMemoryStore } from '../src/memory/local-memory-store';
import {
  classifyWorkspaceRunFailure,
  recordWorkspaceRunLearning,
} from '../src/memory/local-learning-rules';

describe('local learning rules', () => {
  test('只按明确模式分类失败，不从未知日志猜测根因', () => {
    expect(classifyWorkspaceRunFailure('Error: ENOENT config.json')).toBe('missing-file');
    expect(classifyWorkspaceRunFailure('npm ERR! command failed')).toBe('npm-error');
    expect(classifyWorkspaceRunFailure('TS2322: Type mismatch')).toBe('typescript-build');
    expect(classifyWorkspaceRunFailure('something went wrong')).toBeNull();
  });

  test('成功命令按稳定 key 更新并合并 run 来源', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-learning-ok-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });
    const base = { store, cwd, agentId: 'agent-1', adapterKind: 'codex',
      workspaceRun: { status: 'succeeded', command: 'npm test', exitCode: 0 } } as const;

    const first = await recordWorkspaceRunLearning({ ...base, runId: 'run-1' });
    const second = await recordWorkspaceRunLearning({ ...base, runId: 'run-2' });

    expect(first[0]?.action).toBe('created');
    expect(second[0]?.action).toBe('updated');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.structured?.sourceRunIds).toEqual(['run-1', 'run-2']);
  });

  test('已分类失败只保存类别和命令，不保存原始日志', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-learning-fail-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });
    const logExcerpt = 'npm ERR! token=must-not-be-persisted';

    const summaries = await recordWorkspaceRunLearning({ store, cwd, runId: 'run-1',
      workspaceRun: { status: 'failed', command: 'npm run build', exitCode: 1, logExcerpt } });

    expect(summaries).toHaveLength(1);
    expect(store.list()[0]?.content).toContain('npm 失败');
    expect(JSON.stringify(store.list()[0])).not.toContain('must-not-be-persisted');
  });

  test('未知失败和含 secret 的命令不自动积累', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-learning-safe-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });

    await expect(recordWorkspaceRunLearning({ store, cwd, runId: 'unknown',
      workspaceRun: { status: 'failed', command: 'tool run', exitCode: 1, logExcerpt: 'unknown' } }))
      .resolves.toEqual([]);
    await expect(recordWorkspaceRunLearning({ store, cwd, runId: 'secret',
      workspaceRun: { status: 'succeeded', command: 'tool --password=super-secret-value', exitCode: 0 } }))
      .resolves.toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
