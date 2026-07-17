import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// fs:list 目录列表的核心逻辑（切片1：裸 readdir happy path）。
// 刻意欠债（切片3 偿还）：denylist / `..` 遍历防护 / 限速 / 条目截断均未实现。
// 抽成独立模块是为了让 socket 接线（index.ts）与文件系统逻辑解耦，便于单测。
// （mattpocock「the interface is the test surface」：listDirectory 本身就是测试面。）

export interface DirectoryEntry {
  name: string;
  isDir: boolean;
}

export interface ListDirectoryResult {
  ok: boolean;
  entries?: DirectoryEntry[];
  homePath?: string;
  error?: string;
}

export interface ListDirectoryDeps {
  /** 首参锚点 `~` / 空串展开的根目录。生产用 os.homedir()，测试注入 tmpdir。 */
  home: string;
}

// 首参 path 为空串或字面量 `~` 时，列表 daemon 的 $HOME；否则视为绝对路径。
// 注：安全相关的规范化（path.resolve + denylist）在切片3 加，本切片保持 happy path。
function resolveListPath(rawPath: string, home: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '' || trimmed === '~') {
    return home;
  }
  // `~/foo` 形式展开 home（与 shell 一致）；其余按原样传给 readdir。
  if (trimmed.startsWith('~/')) {
    return resolve(home, trimmed.slice(2));
  }
  return trimmed;
}

export async function listDirectory(
  rawPath: string,
  deps: ListDirectoryDeps,
): Promise<ListDirectoryResult> {
  const target = resolveListPath(rawPath, deps.home);
  try {
    const dirents = readdirSync(target, { withFileTypes: true });
    const entries: DirectoryEntry[] = dirents.map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    }));
    return { ok: true, entries, homePath: deps.home };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT / ENOTDIR 统一为 PATH_NOT_FOUND（不暴露「目录不存在」vs「是文件」的区别）。
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, error: 'PATH_NOT_FOUND' };
    }
    // EACCES 等其余错误切片1 先归一为 PATH_NOT_FOUND（fail-closed，不泄漏细节）；
    // 切片3 会细分 PERMISSION/遍历等错误码。
    return { ok: false, error: 'PATH_NOT_FOUND' };
  }
}

/** 生产环境用的 deps 工厂：home = os.homedir()。 */
export function productionListDirectoryDeps(): ListDirectoryDeps {
  return { home: homedir() };
}
