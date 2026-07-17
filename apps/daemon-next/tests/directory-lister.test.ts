import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createListDirectoryRateLimiter, listDirectory } from '../src/directory-lister';

// 切片1 的目录列表核心逻辑：裸 readdir，返回 entries + homePath。
// 安全闸（denylist / 遍历防护 / 限速截断）留给切片3，此处只验 happy path 与错误码骨架。
describe('listDirectory', () => {
  test('空路径或 ~ 返回 $HOME 下一层目录列表 + homePath', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, 'projects'));
    mkdirSync(join(home, 'docs'));
    writeFileSync(join(home, 'README.md'), 'hi');

    const res = await listDirectory('~', { home });

    expect(res.ok).toBe(true);
    expect(res.homePath).toBe(home);
    const names = res.entries!.map((e) => e.name).sort();
    expect(names).toEqual(['README.md', 'docs', 'projects']);
    const docs = res.entries!.find((e) => e.name === 'docs')!;
    expect(docs.isDir).toBe(true);
    const readme = res.entries!.find((e) => e.name === 'README.md')!;
    expect(readme.isDir).toBe(false);
  });

  test('空串同 ~ 处理（首参锚点）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, 'a'));
    const res = await listDirectory('', { home });
    expect(res.ok).toBe(true);
    expect(res.homePath).toBe(home);
    expect(res.entries!.map((e) => e.name)).toEqual(['a']);
  });

  test('显式绝对路径返回该路径下一层', async () => {
    const root = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'file.txt'), 'x');

    const res = await listDirectory(root, { home: '/unused' });

    expect(res.ok).toBe(true);
    expect(res.entries!.map((e) => e.name).sort()).toEqual(['file.txt', 'sub']);
  });

  test('不存在的路径返回 PATH_NOT_FOUND', async () => {
    const res = await listDirectory(join(tmpdir(), 'definitely-missing-xyz'), { home: '/unused' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });
});

// 切片3 安全闸：denylist / `..` 遍历防护 / 条目截断 / 限速 / 错误码细分。
// 核心不变量：denylist 命中统一返回 PATH_NOT_FOUND，绝不暴露敏感目录的存在性
// （否则等于侧信道确认「这台机器有 ~/.ssh」）。
describe('listDirectory 安全闸（切片3）', () => {
  test('denylist 直接命中返回 PATH_NOT_FOUND（目录真实存在也不暴露）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, '.ssh', 'keys'));

    const res = await listDirectory('~/.ssh', { home });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('denylist 子树命中返回 PATH_NOT_FOUND', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, '.ssh', 'keys'));

    const res = await listDirectory('~/.ssh/keys', { home });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('denylist 清单各项：.aws / .config/gcloud / .codex/auth.json / .claude', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.aws'));
    mkdirSync(join(home, '.config'));
    mkdirSync(join(home, '.config', 'gcloud'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.claude', 'projects'));

    for (const p of ['~/.aws', '~/.config/gcloud', '~/.codex/auth.json', '~/.claude', '~/.claude/projects']) {
      const res = await listDirectory(p, { home });
      expect(res.ok, `${p} 应被拒绝`).toBe(false);
      expect(res.error, `${p} 应返回 PATH_NOT_FOUND`).toBe('PATH_NOT_FOUND');
    }
  });

  test('`..` 遍历无法绕过 denylist（resolve 规范化后再比对）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, 'innocent'));

    // `~/innocent/../.ssh` resolve 后 = `~/.ssh`，仍必须命中 denylist
    const res = await listDirectory('~/innocent/../.ssh', { home });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('大小写变体 ~/.SSH 被挡（macOS APFS 大小写不敏感，readdir 本可成功）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh'));

    // 在大小写不敏感 FS（macOS 默认）上，`~/.SSH` 的 readdir 会成功列出 .ssh 内容；
    // denylist 双侧小写归一后仍命中。Linux 上该路径不存在，同样归一 PATH_NOT_FOUND。
    const res = await listDirectory('~/.SSH', { home });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('符号链接指向 denylist 目录被挡（realpath 真实路径兜底）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh'));
    symlinkSync(join(home, '.ssh'), join(home, 'innocent-link'));

    // 词法上 `~/innocent-link` 不命中 denylist，但 realpath 解析到 .ssh → 必须拒
    const res = await listDirectory('~/innocent-link', { home });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('PATH_NOT_FOUND');
  });

  test('denylist 不误伤相似前缀目录（.ssh-backup 不是 .ssh 子树）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.ssh-backup'));

    const res = await listDirectory('~/.ssh-backup', { home });

    expect(res.ok).toBe(true);
  });

  test('超 1000 条目截断并标记 truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'big-'));
    for (let i = 0; i < 1005; i += 1) {
      writeFileSync(join(root, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }

    const res = await listDirectory(root, { home: '/unused' });

    expect(res.ok).toBe(true);
    expect(res.entries!.length).toBe(1000);
    expect(res.truncated).toBe(true);
  });

  test('未超阈值不标记 truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'small-'));
    writeFileSync(join(root, 'a.txt'), 'x');

    const res = await listDirectory(root, { home: '/unused' });

    expect(res.ok).toBe(true);
    expect(res.truncated).toBeUndefined();
  });

  test('无权限目录返回 PERMISSION_DENIED（错误码细分，不再归一 PATH_NOT_FOUND）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'locked-'));
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const res = await listDirectory(locked, { home: '/unused' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('PERMISSION_DENIED');
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe('createListDirectoryRateLimiter', () => {
  test('窗口内 10 次放行、第 11 次拒绝、窗口过后恢复', () => {
    let now = 1000;
    const limiter = createListDirectoryRateLimiter({ max: 10, windowMs: 1000, now: () => now });

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.allow(), `第 ${i + 1} 次应放行`).toBe(true);
    }
    expect(limiter.allow()).toBe(false); // 第 11 次超限

    now += 1001; // 滑出窗口
    expect(limiter.allow()).toBe(true);
  });
});
