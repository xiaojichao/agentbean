import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { executableSearchDirs } from '../src/executable-paths';

describe('executableSearchDirs', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('includes package-manager shims, version-manager static and versioned bin dirs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-exec-paths-'));
    tempDirs.push(home);
    await mkdir(join(home, '.nvm/versions/node/v24.15.0/bin'), { recursive: true });
    await mkdir(join(home, '.nvm/versions/node/v22.0.0/bin'), { recursive: true });
    await mkdir(join(home, '.fnm/node-versions/v20.10.0/installation/bin'), { recursive: true });

    const dirs = executableSearchDirs(home);

    // 包管理器全局 shim 与版本管理器静态目录
    expect(dirs).toContain(join(home, 'Library/pnpm'));
    expect(dirs).toContain(join(home, '.local/bin'));
    expect(dirs).toContain(join(home, '.volta/bin'));
    expect(dirs).toContain(join(home, '.nvm/current/bin'));
    // 版本管理器版本化目录（全量 glob，不截断最新 N 个）
    expect(dirs).toContain(join(home, '.nvm/versions/node/v24.15.0/bin'));
    expect(dirs).toContain(join(home, '.nvm/versions/node/v22.0.0/bin'));
    expect(dirs).toContain(join(home, '.fnm/node-versions/v20.10.0/installation/bin'));
    // 系统全局
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
  });

  test('returns only system global dirs when home is undefined', () => {
    // executor-helpers 以 home=undefined 调用时不附加任何 home 相对目录。
    expect(executableSearchDirs(undefined)).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
  });

  test('deduplicates entries', () => {
    const dirs = executableSearchDirs('/tmp/agentbean-exec-dedup');
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});
