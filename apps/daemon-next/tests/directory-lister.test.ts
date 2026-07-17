import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listDirectory } from '../src/directory-lister';

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
