import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createLocalMemoryStore } from '../src/memory/local-memory-store';
import { scanWorkspaceMemory } from '../src/memory/workspace-scan';

describe('scanWorkspaceMemory', () => {
  test('只读取确定性项目元数据并按稳定 scan key 更新', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-workspace-scan-'));
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'docs'));
    mkdirSync(join(cwd, 'node_modules'));
    writeFileSync(join(cwd, 'package-lock.json'), '{}');
    writeFileSync(join(cwd, 'tsconfig.json'), '{}');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', next: '15.0.0' },
      devDependencies: { typescript: '5.0.0', vitest: '3.0.0' },
      scripts: { test: 'vitest run', secret: 'tool --api_key=super-secret-value' },
    }));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, 'home') });

    const first = await scanWorkspaceMemory({ store, cwd, agentId: 'agent-1' });
    const second = await scanWorkspaceMemory({ store, cwd, agentId: 'agent-1' });

    expect(first.map((item) => item.action)).toEqual(['created', 'created', 'created']);
    expect(second.map((item) => item.action)).toEqual(['updated', 'updated', 'updated']);
    expect(store.list()).toHaveLength(3);
    const tech = store.list().find((item) => item.dedupeKey === 'scan:tech-stack');
    expect(tech?.structured?.techStack).toEqual(expect.arrayContaining(['Node.js', 'TypeScript', 'React', 'Next.js', 'Vitest', 'npm']));
    const scripts = store.list().find((item) => item.dedupeKey === 'scan:scripts');
    expect(scripts?.content).toContain('npm run test');
    expect(scripts?.content).not.toContain('super-secret-value');
    const layout = store.list().find((item) => item.dedupeKey === 'scan:layout');
    expect(layout?.structured?.paths).toEqual(['docs', 'src']);
  });

  test('空目录不生成猜测型 Memory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-workspace-empty-'));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, '.home') });

    await expect(scanWorkspaceMemory({ store, cwd })).resolves.toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test('跳过超大 package.json，并限制目录扫描与输出规模', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentbean-workspace-bounded-'));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: { secret: `tool --token ${'x'.repeat(1024 * 1024)}` },
    }));
    for (let index = 0; index < 250; index += 1) mkdirSync(join(cwd, `dir-${String(index).padStart(3, '0')}`));
    const store = await createLocalMemoryStore({ profileId: 'p', cwd, baseDir: join(cwd, '.home') });

    await scanWorkspaceMemory({ store, cwd });

    expect(store.list().find((item) => item.dedupeKey === 'scan:scripts')).toBeUndefined();
    const layout = store.list().find((item) => item.dedupeKey === 'scan:layout');
    expect(layout?.structured?.paths?.length).toBeLessThanOrEqual(30);
  });
});
