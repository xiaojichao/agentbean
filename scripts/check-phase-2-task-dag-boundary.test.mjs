import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { copyWorkspaceFixture } from './workspace-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = join(root, 'scripts/check-phase-2-task-dag-boundary.mjs');
const run = (workspace) => spawnSync(process.execPath, [checker, '--workspace-root', workspace], { encoding: 'utf8' });

test('accepts the repository Phase 2 boundary scaffold', () => {
  const result = run(root);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('fails closed when the controlled Green verdict drops the default Phase 1 boundary', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-matrix-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('`maxManagementPhase=1`', '`maxManagementPhase=2`'));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_MATRIX_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the controlled Green verdict leaves P2-18 incomplete', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-matrix-status-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('| P2-18 | Green |', '| P2-18 | Yellow |'));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_MATRIX_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the controlled Green verdict drifts from the design spec', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-design-status-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      '最终 verdict 已冻结为 Green / Ready（受控 opt-in）',
      '最终 verdict 仍等待 production truth',
    ));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_MATRIX_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the Phase 2 tool surface exposes Memory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      'export const PHASE_2_MANAGEMENT_TOOL_NAMES = [',
      "export const PHASE_2_MANAGEMENT_TOOL_NAMES = [\n  'memory.search',",
    ));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_RUNTIME_BOUNDARY_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when a Phase 2 Domain policy disappears', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-domain-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'packages/domain/src/task-claim-policy.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('evaluateTaskClaimAcquire', 'removedTaskClaimAcquire'));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_DOMAIN_POLICY_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the Phase 2 atomic persistence boundary disappears', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-persistence-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'apps/server-next/src/infra/sqlite/migrations/team/0013_management_phase_2_task_dag.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replace('DEFERRABLE INITIALLY DEFERRED', ''));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_PERSISTENCE_BOUNDARY_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the Task coordination command boundary disappears', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-kernel-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'apps/server-next/src/application/management/task-coordination-kernel.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('createRootCoordination', 'removedRootCoordination'));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_COORDINATION_KERNEL_BOUNDARY_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('fails closed when the Phase 2 rollout preflight stops being fail closed', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentbean-phase2-rollout-boundary-'));
  try {
    copyWorkspaceFixture(root, fixture);
    const path = join(fixture, 'apps/server-next/src/application/management/management-router.ts');
    const source = readFileSync(path, 'utf8');
    // 与 checker 同一套按缩进配对的框选逻辑；不要写死绝对缩进，否则 router 重构平移
    // 缩进后这里会框到块首，变异退化成空操作，负向测试变成侥幸通过（#836）。
    const phase2Block = source.match(/^( *)if \(policy\.maxManagementPhase === 2\) \{\n[\s\S]*?\n\1\}$/m)?.[0];
    assert.ok(phase2Block, 'Phase 2 route block not found');
    const mutated = phase2Block.replace("requestShape: 'multi-agent'", "requestShape: 'single-agent'");
    assert.notEqual(mutated, phase2Block, 'Phase 2 requestShape marker not found in the block');
    // 用函数形式的替换值，避免块内出现 `$` 时被当成替换模式解释。
    writeFileSync(path, source.replace(phase2Block, () => mutated));
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P2_ROLLOUT_WEB_BOUNDARY_INVALID/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
