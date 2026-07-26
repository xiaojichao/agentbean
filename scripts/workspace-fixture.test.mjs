import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  WORKSPACE_FIXTURE_IGNORED_SEGMENTS,
  copyWorkspaceFixture,
  isIgnoredWorkspacePath,
} from './workspace-fixture.mjs';

function write(root, path, source) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

// 在 tmp 下搭一个"位于 worktree 里的工作区"：路径前缀本身就含 .claude/worktrees。
function scaffoldWorkspace(prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const root = join(base, '.claude/worktrees/feature-a');
  write(root, 'package.json', '{"name":"agentbean"}\n');
  write(root, 'docs/superpowers/specs/design.md', 'spec\n');
  write(root, 'agentbean-next/docs/matrix.md', 'matrix\n');
  write(root, 'packages/domain/src/policy.ts', 'export const policy = 1;\n');
  write(root, 'node_modules/example/index.js', 'module.exports = 1;\n');
  write(root, 'packages/domain/dist/policy.js', 'exports.policy = 1;\n');
  write(root, '.worktrees/sibling/packages/domain/src/policy.ts', 'export const policy = 2;\n');
  write(root, '.claude/worktrees/nested/packages/domain/src/policy.ts', 'export const policy = 3;\n');
  return { base, root };
}

test('拷贝排除集覆盖 worktree 根与依赖/构建产物', () => {
  for (const segment of ['.worktrees', '.claude', '.git', 'node_modules', 'dist', 'coverage']) {
    assert.ok(WORKSPACE_FIXTURE_IGNORED_SEGMENTS.includes(segment), `缺少 ${segment}`);
  }
});

// 负向钉子：phase-2 / phase-3 的 checker 要读 docs/superpowers/** 与 agentbean-next/docs/**。
// 若有人为了"和 check-phase-0-pi-boundary.mjs 的忽略集对齐"把 docs 加进来，负向 fixture
// 会缺文件，变异写不进去——测试仍然红，但红的原因不再是门禁生效，门禁就此失守。
test('拷贝排除集不含 docs', () => {
  assert.ok(!WORKSPACE_FIXTURE_IGNORED_SEGMENTS.includes('docs'));
});

test('按目录名精确匹配，不做子串匹配', () => {
  assert.ok(isIgnoredWorkspacePath(join('packages', 'domain', 'dist', 'policy.js')));
  assert.ok(!isIgnoredWorkspacePath(join('packages', 'dist-config', 'policy.ts')));
  assert.ok(!isIgnoredWorkspacePath(join('apps', 'server-next', 'src', 'distribution.ts')));
});

// 回归钉：cpSync 的 filter 收到的是绝对路径，而工作区自身就可能位于
// `<repo>/.claude/worktrees/<name>/` 之下。若拿绝对路径做匹配，前缀里的 .claude 会把
// 整棵树判成忽略，fixture 拷成空目录，54 个负向用例全部退化成 "ENOENT 写不进去"。
test('工作区位于 .claude/worktrees 之下时仍然拷贝完整', () => {
  const { base, root } = scaffoldWorkspace('workspace-fixture-nested-');
  const fixture = mkdtempSync(join(tmpdir(), 'workspace-fixture-out-'));
  try {
    copyWorkspaceFixture(root, fixture);
    for (const kept of [
      'package.json',
      'docs/superpowers/specs/design.md',
      'agentbean-next/docs/matrix.md',
      'packages/domain/src/policy.ts',
    ]) {
      assert.ok(existsSync(join(fixture, kept)), `应保留 ${kept}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('拷贝跳过 worktree 根与依赖/构建产物', () => {
  const { base, root } = scaffoldWorkspace('workspace-fixture-skip-');
  const fixture = mkdtempSync(join(tmpdir(), 'workspace-fixture-out-'));
  try {
    copyWorkspaceFixture(root, fixture);
    for (const dropped of ['.worktrees', '.claude', 'node_modules', 'packages/domain/dist']) {
      assert.ok(!existsSync(join(fixture, dropped)), `应跳过 ${dropped}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
