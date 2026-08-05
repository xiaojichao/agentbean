import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MAX_READ_FILE_BYTES,
  createReadFileRateLimiter,
  readFile,
} from '../src/file-reader';

// #1084 切片3 fs:read 核心安全闸测试：
// - readpath 白名单 = snapshots 子树（越界专用 OUTSIDE_SNAPSHOTS）
// - realpath 防符号链接逃逸
// - 大小上限 + sha256 回包
// - 限速器
//
// 关键不变量（gotcha #1）：readpath 白名单是 snapshots 子树，越界一律 OUTSIDE_SNAPSHOTS，
// 不暴露文件存在性（与 denylist-only 的 fs:list 语义有别）。

function setupSnapshot(home: string, teamId = 'team1', channelId = 'chan1', revisionId = 'rev1') {
  const root = join(home, 'workspaces', teamId, 'channels', channelId, 'snapshots', revisionId);
  mkdirSync(root, { recursive: true });
  return root;
}

describe('readFile happy path', () => {
  test('读 snapshots 子树内文件返回 contentBase64 + sha256 + sizeBytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    const content = 'hello agentbean';
    writeFileSync(join(root, 'report.md'), content);

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'report.md' },
      { home },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sizeBytes).toBe(Buffer.byteLength(content));
    expect(res.contentBase64).toBe(Buffer.from(content).toString('base64'));
    // sha256 是 64 位 hex
    expect(res.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('支持子目录相对路径', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'note.txt'), 'nested');

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'docs/note.txt' },
      { home },
    );

    expect(res.ok).toBe(true);
  });
});

describe('readFile readpath 白名单（snapshots 子树）', () => {
  test('path 含 .. 越界 snapshots root → OUTSIDE_SNAPSHOTS', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    // 在 snapshots 父目录放一个诱饵文件
    writeFileSync(join(home, 'workspaces', 'team1', 'channels', 'chan1', 'secret.txt'), 'nope');
    writeFileSync(join(root, 'real.md'), 'ok');

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: '../secret.txt' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('OUTSIDE_SNAPSHOTS');
  });

  test('path 绝对路径 → OUTSIDE_SNAPSHOTS', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    setupSnapshot(home);
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'etc.txt'), 'x');

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: `${join(outside, 'etc.txt')}` },
      { home },
    );

    // 绝对路径在 resolve 后逃离 snapshotRoot；同时 path 校验也拒绝绝对前缀。
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('OUTSIDE_SNAPSHOTS');
  });

  test('revisionId 含遍历段 → OUTSIDE_SNAPSHOTS（id 段 safe-segment 闸）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    setupSnapshot(home);
    writeFileSync(join(home, 'workspaces', 'team1', 'channels', 'chan1', 'snapshots', 'rev1', 'a.md'), 'x');

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: '../..', path: 'a.md' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('OUTSIDE_SNAPSHOTS');
  });

  test('符号链接逃逸 snapshots 子树 → OUTSIDE_SNAPSHOTS（realpath 闸）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    // snapshots 内放一个指向 home 外的符号链接
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'leak.txt'), 'secret');
    // realpath 校验在 target 叶子：符号链接 → 真实路径在 snapshotRoot 外
    try {
      symlinkSync(join(outside, 'leak.txt'), join(root, 'leak.md'));
    } catch {
      // 某些 CI 沙箱无符号链接权限 → 跳过该用例（test 内 return）。
      return;
    }

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'leak.md' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 符号链接 realpath 在 snapshots root 外 → 越界专用码。
    expect(res.error).toBe('OUTSIDE_SNAPSHOTS');
  });
});

describe('readFile 错误码细分', () => {
  test('文件不存在 → PATH_NOT_FOUND（不暴露类型细节）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    setupSnapshot(home);

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'missing.md' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('目标是目录 → PATH_NOT_FOUND', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    mkdirSync(join(root, 'subdir'));

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'subdir' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('超过大小上限 → PATH_NOT_FOUND（触发 web 回退 server）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(MAX_READ_FILE_BYTES + 1, 0));

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'big.bin' },
      { home },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('PATH_NOT_FOUND');
  });
});

describe('readFile sha256 回包正确性', () => {
  test('回包 sha256 与文件真实 sha256 一致', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
    const root = setupSnapshot(home);
    const content = 'sha check';
    writeFileSync(join(root, 'f.txt'), content);

    const res = await readFile(
      { teamId: 'team1', channelId: 'chan1', revisionId: 'rev1', path: 'f.txt' },
      { home },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const expected = await import('node:crypto').then((m) => m.createHash('sha256').update(content).digest('hex'));
    expect(res.sha256).toBe(expected);
  });
});

describe('createReadFileRateLimiter', () => {
  test('窗口内放行 max 次，超出拒绝', () => {
    let t = 1000;
    const limiter = createReadFileRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
  });

  test('滑出窗口后恢复', () => {
    let t = 1000;
    const limiter = createReadFileRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    t += 1500; // 超出窗口
    expect(limiter.allow()).toBe(true);
  });
});
