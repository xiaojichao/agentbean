import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const checker = join(root, 'scripts/check-phase-3-memory-boundary.mjs');
const run = (workspace) => spawnSync(process.execPath, [checker, '--workspace-root', workspace], { encoding: 'utf8' });

function withFixture(prefix, mutate) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  try {
    cpSync(root, fixture, {
      recursive: true,
      filter: (source) => !source.split('/').includes('node_modules') && !source.split('/').includes('.git'),
    });
    mutate(fixture);
    return run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('accepts the repository Phase 3 Memory boundary scaffold', () => {
  const result = run(root);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('fails closed when local-workspace enters the Server scope list', () => {
  const result = withFixture('agentbean-phase3-contract-', (fixture) => {
    const path = join(fixture, 'packages/contracts/src/management-memory.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      "'team', 'channel', 'dm', 'task', 'agent', 'user'",
      "'team', 'channel', 'dm', 'task', 'agent', 'user', 'local-workspace'",
    ));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CONTRACT_BOUNDARY_INVALID/);
});

test('fails closed when Capsule grant revocation stops being checked', () => {
  const result = withFixture('agentbean-phase3-domain-', (fixture) => {
    const path = join(fixture, 'packages/domain/src/memory-policy.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('CAPSULE_GRANT_REVOKED', 'REMOVED_GRANT_REVOKED'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_DOMAIN_POLICY_INVALID/);
});

test('fails closed when Phase 2 exposes memory.search', () => {
  const result = withFixture('agentbean-phase3-isolation-', (fixture) => {
    const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      'export const PHASE_2_MANAGEMENT_TOOL_NAMES = [',
      "export const PHASE_2_MANAGEMENT_TOOL_NAMES = [\n  'memory.search',",
    ));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_PHASE2_ISOLATION_INVALID/);
});
