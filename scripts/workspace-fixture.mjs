import { cpSync } from 'node:fs';
import { relative, sep } from 'node:path';

// 拷贝工作区快照时一律跳过的目录名。共两类，都不受版本控制（`git ls-files` 对它们为空），
// 因此跳过后的 fixture 反而更接近 CI 的 checkout：
//
//   1. worktree 根目录（`.worktrees/`、`.claude/worktrees/` 等）。本机常年挂着几十个
//      worktree，每个都是完整仓库副本。不排除有两个后果：整条 boundary 链慢到不可用；
//      更糟的是并行会话随时创建/删除 worktree，拷贝进行中目标消失，cpSync 直接
//      ENOENT 崩溃，本地几乎必然撞上。
//   2. 依赖与构建产物（node_modules / dist / coverage / .next / …）。体积占大头，
//      且没有任何 boundary checker 会去读它们。
//
// 注意：这里**不能**含 `docs`。phase-2 / phase-3 的 checker 要读
// `docs/superpowers/**` 与 `agentbean-next/docs/**`；把 docs 排掉会让负向 fixture 缺文件，
// 变异写不进去或 checker 因文件缺失而失败——测试看着红/绿都不再说明门禁本身有效。
// 只扫描源码的 checker（如 check-phase-0-pi-boundary.mjs）可以在此基础上再加 `docs`。
export const WORKSPACE_FIXTURE_IGNORED_SEGMENTS = Object.freeze([
  '.agents', '.claude', '.codex', '.git', '.next', '.omc', '.omx', '.worktrees',
  'coverage', 'dist', 'node_modules', 'playwright-report', 'test-results',
]);

const ignoredSegments = new Set(WORKSPACE_FIXTURE_IGNORED_SEGMENTS);

// 判定必须落在**仓库相对路径**上，不能用绝对路径：工作区自身就可能位于
// `/Users/x/repo/.claude/worktrees/<name>/` 之下，绝对路径前缀里带着 `.claude`，
// 拿绝对路径匹配会把整棵树判成忽略，fixture 拷成空目录。
export function isIgnoredWorkspacePath(repoRelativePath) {
  return repoRelativePath.split(sep).some((segment) => ignoredSegments.has(segment));
}

// 把工作区拷贝成一份可变异的 fixture，供 boundary checker 的负向测试使用。
export function copyWorkspaceFixture(sourceRoot, targetRoot) {
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => !isIgnoredWorkspacePath(relative(sourceRoot, source)),
  });
}
