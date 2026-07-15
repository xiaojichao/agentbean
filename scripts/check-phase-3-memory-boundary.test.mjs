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

for (const localScope of ['local-workspace', 'local-agent', 'local-profile']) {
  test(`fails closed when ${localScope} enters the Server scope list`, () => {
    const result = withFixture('agentbean-phase3-contract-', (fixture) => {
      const path = join(fixture, 'packages/contracts/src/management-memory.ts');
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        "'team', 'channel', 'dm', 'task', 'agent', 'user'",
        `'team', 'channel', 'dm', 'task', 'agent', 'user', '${localScope}'`,
      ));
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P3_CONTRACT_BOUNDARY_INVALID/);
  });
}

test('fails closed when Capsule grant revocation stops being checked', () => {
  const result = withFixture('agentbean-phase3-domain-', (fixture) => {
    const path = join(fixture, 'packages/domain/src/memory-policy.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('CAPSULE_GRANT_REVOKED', 'REMOVED_GRANT_REVOKED'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_DOMAIN_POLICY_INVALID/);
});

for (const memoryTool of [
  'memory.search',
  'memory.create_capsule',
  'memory.propose_candidate',
  'memory.link_sources',
]) {
  test(`fails closed when Phase 2 exposes ${memoryTool}`, () => {
    const result = withFixture('agentbean-phase3-isolation-', (fixture) => {
      const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        'export const PHASE_2_MANAGEMENT_TOOL_NAMES = [',
        `export const PHASE_2_MANAGEMENT_TOOL_NAMES = [\n  '${memoryTool}',`,
      ));
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /P3_PHASE2_ISOLATION_INVALID/);
  });
}

test('fails closed when Phase 1 exposes a Memory tool inherited by Phase 2', () => {
  const result = withFixture('agentbean-phase3-phase1-isolation-', (fixture) => {
    const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      'export const PHASE_1_MANAGEMENT_TOOL_NAMES = [',
      "export const PHASE_1_MANAGEMENT_TOOL_NAMES = [\n  'memory.search',",
    ));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_PHASE2_ISOLATION_INVALID/);
});

test('fails closed when the atomic Memory schema disappears', () => {
  const result = withFixture('agentbean-phase3-persistence-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/infra/sqlite/migrations/team/0015_management_phase_3_memory.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('memory_audit_events', 'removed_audit_events'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_PERSISTENCE_BOUNDARY_INVALID/);
});

test('fails closed when the collaborative Memory grant lifecycle disappears', () => {
  const result = withFixture('agentbean-phase3-usecase-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/collaborative-memory-service.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('revokeGrant', 'removedRevokeGrant'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_COLLABORATIVE_MEMORY_USECASE_INVALID/);
});

test('fails closed when reactive Memory source invalidation disappears', () => {
  const result = withFixture('agentbean-phase3-invalidation-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/memory-source-invalidation-service.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('invalidateSources', 'removedInvalidateSources'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_SOURCE_INVALIDATION_INVALID/);
});

test('fails closed when minimal Memory Capsule creation disappears', () => {
  const result = withFixture('agentbean-phase3-capsule-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/memory-capsule-service.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('createCapsule', 'removedCreateCapsule'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_CREATION_INVALID/);
});

test('fails closed when Capsule injection revalidation disappears', () => {
  const result = withFixture('agentbean-phase3-injection-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/capsule-injection-validator.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('validateCapsuleForInjection', 'removedValidate'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INJECTION_INVALID/);
});

test('fails closed when Capsule ref persistence disappears', () => {
  const result = withFixture('agentbean-phase3-capsuleref-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/infra/sqlite/migrations/team/0016_management_phase_3_capsule_refs.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('memory_capsule_refs', 'removed_capsule_refs'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_REF_PERSISTENCE_INVALID/);
});

test('fails closed when Candidate persistence disappears', () => {
  const result = withFixture('agentbean-phase3-candidate-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/infra/sqlite/migrations/team/0017_management_phase_3_candidates.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('memory_candidates', 'removed_candidates'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CANDIDATE_PERSISTENCE_INVALID/);
});
