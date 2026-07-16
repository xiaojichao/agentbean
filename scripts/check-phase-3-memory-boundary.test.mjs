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

test('fails closed when Candidate lifecycle disappears', () => {
  const result = withFixture('agentbean-phase3-candidate-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/infra/sqlite/migrations/team/0019_management_phase_3_candidate_lifecycle.sql');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('memory_candidates', 'removed_candidates'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CANDIDATE_LIFECYCLE_INVALID/);
});

test('fails closed when Capsule↔Invocation/checkpoint binding disappears', () => {
  const result = withFixture('agentbean-phase3-binding-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-checkpoint.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('capsuleRefs.listByRun', 'removedListByRun'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INVOCATION_BINDING_INVALID/);
});

test('fails closed when Invocation accepts an untrusted Capsule ref', () => {
  const result = withFixture('agentbean-phase3-capsule-authority-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/invocation-gateway.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('INVOCATION_MEMORY_CAPSULE_REF_INVALID', 'REMOVED_CAPSULE_REF_VALIDATION'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INVOCATION_BINDING_INVALID/);
});

test('fails closed when Capsule denial stops updating the authoritative ref', () => {
  const result = withFixture('agentbean-phase3-capsule-denial-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/capsule-injection-validator.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('capsuleRefs.markDenied', 'removedMarkDenied'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INVOCATION_BINDING_INVALID/);
});

test('fails closed when runtime Capsule revalidation is bypassed', () => {
  const result = withFixture('agentbean-phase3-runtime-context-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/server-capsule-runtime-context-service.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('validateCapsuleForInjection', 'removedRuntimeRevalidation'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_RUNTIME_CONTEXT_INVALID/);
});

test('fails closed when production runtime Capsule wiring is removed', () => {
  const result = withFixture('agentbean-phase3-runtime-wiring-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/dev-server.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('createDefaultServerCapsuleRuntimeContextResolver', 'removedRuntimeResolver'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_RUNTIME_CONTEXT_INVALID/);
});

test('fails closed when the Phase 3 build omits pi-management-runtime before daemon-next', () => {
  const result = withFixture('agentbean-phase3-runtime-build-', (fixture) => {
    const path = join(fixture, 'package.json');
    const packageJson = JSON.parse(readFileSync(path, 'utf8'));
    packageJson.scripts['build:phase3-memory'] = packageJson.scripts['build:phase3-memory']
      .replace('npm run build:pi-management-runtime && ', '');
    writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_ROOT_CI_GATE_INVALID/);
});

test('fails closed when Phase 2 agents.invoke drops the Capsule ref wire contract', () => {
  const result = withFixture('agentbean-phase3-capsule-wire-', (fixture) => {
    const path = join(fixture, 'packages/contracts/src/management-worker-v2.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('memoryCapsuleRef?: MemoryCapsuleRefDto', 'removedMemoryCapsuleRef?: never'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INVOCATION_BINDING_INVALID/);
});

test('fails closed when Phase 2 agents.invoke drops the Capsule ref model schema', () => {
  const result = withFixture('agentbean-phase3-capsule-schema-', (fixture) => {
    const path = join(fixture, 'packages/pi-management-runtime/src/management-tool-catalog.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('memoryCapsuleRef: Type.Optional(Type.Object', 'removedMemoryCapsuleRef: Type.Optional(Type.Object'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPSULE_INVOCATION_BINDING_INVALID/);
});

test('fails closed when Phase 3 Memory tool definitions disappear', () => {
  const result = withFixture('agentbean-phase3-definitions-', (fixture) => {
    const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('PHASE_3_MANAGEMENT_TOOL_NAMES', 'REMOVED_PHASE_3_TOOL_NAMES'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_DEFINITIONS_INVALID/);
});

test('fails closed when the V3 capability gate wiring disappears', () => {
  const result = withFixture('agentbean-phase3-gate-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/device-worker-scheduler.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('managementPhase3Preflight', 'removedPhase3Preflight'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when daemon stops advertising Phase 3', () => {
  const result = withFixture('agentbean-phase3-daemon-register-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/management-worker-protocol.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('supportedPhases: [1, 2, 3]', 'supportedPhases: [1, 2]'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when daemon checkpoint phase restoration disappears', () => {
  const result = withFixture('agentbean-phase3-daemon-checkpoint-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('checkpointManagementPhase', 'removedCheckpointManagementPhase'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when Phase 3 Memory write receipts disappear', () => {
  const result = withFixture('agentbean-phase3-memory-receipt-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-tool-executor.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('recordMemoryToolReceipt', 'removedMemoryToolReceipt'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when an existing Memory receipt no longer short-circuits the handler', () => {
  const result = withFixture('agentbean-phase3-memory-receipt-short-circuit-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-tool-executor.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace("receipt.disposition === 'existing'", "receipt.disposition === 'removed'"));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when terminal runs can start new Memory writes', () => {
  const result = withFixture('agentbean-phase3-memory-terminal-run-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-kernel.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('assertMemoryToolRunWritable(run)', 'allowTerminalMemoryWrite(run)'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when legacy Memory receipts without output are treated as success', () => {
  const result = withFixture('agentbean-phase3-memory-legacy-receipt-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-kernel.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('MEMORY_TOOL_RECEIPT_OUTPUT_UNAVAILABLE', 'REMOVED_RECEIPT_OUTPUT_GUARD'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when a run can become terminal before receipt append', () => {
  const result = withFixture('agentbean-phase3-memory-terminal-race-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/management-kernel.ts');
    const source = readFileSync(path, 'utf8');
    const marker = 'assertMemoryToolRunWritable(run);';
    const index = source.lastIndexOf(marker);
    writeFileSync(path, `${source.slice(0, index)}${source.slice(index + marker.length)}`);
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when legacy V2 checkpoint phase inference disappears', () => {
  const result = withFixture('agentbean-phase3-v2-checkpoint-compat-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/device-worker-scheduler.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('legacyPhase2Context', 'removedLegacyPhase2Context'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when rejected Memory outbox entries are discarded', () => {
  const result = withFixture('agentbean-phase3-memory-outbox-retention-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace('PHASE_3_MEMORY_WRITE_TOOL_NAMES.has(item.toolName)', 'false'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when replay errors no longer block Session recovery for Memory writes', () => {
  const result = withFixture('agentbean-phase3-memory-outbox-replay-error-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      'if (PHASE_3_MEMORY_WRITE_TOOL_NAMES.has(item.toolName)) unresolvedMemoryWriteCount += 1;',
      '',
    ));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when replay treats legacy Memory receipts without output as committed', () => {
  const result = withFixture('agentbean-phase3-memory-legacy-receipt-replay-', (fixture) => {
    const path = join(fixture, 'apps/server-next/src/application/management/device-worker-scheduler.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('event.event.payload.output', 'true'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when unresolved Memory outbox no longer blocks Session recovery', () => {
  const result = withFixture('agentbean-phase3-memory-outbox-session-gate-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace('replay.unresolvedMemoryWriteCount > 0', 'false'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when daemon Memory request hashing retains undefined keys', () => {
  const result = withFixture('agentbean-phase3-memory-hash-canonical-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace('.filter(([, nested]) => nested !== undefined)', ''));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when restored V3 sessions lose Capsule IDs', () => {
  const result = withFixture('agentbean-phase3-capsule-recovery-', (fixture) => {
    const path = join(fixture, 'apps/daemon-next/src/pi-manager-worker-host.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('includeMemoryCapsules', 'omitMemoryCapsules'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_GATE_INVALID/);
});

test('fails closed when the Phase 3 Memory parser stops enforcing exact keys', () => {
  const result = withFixture('agentbean-phase3-exact-parser-', (fixture) => {
    const path = join(fixture, 'packages/contracts/src/management-worker-v2.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('assertExactMemoryKeys', 'allowUnknownMemoryKeys'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_DEFINITIONS_INVALID/);
});

test('fails closed when the Phase 3 Memory result parser disappears', () => {
  const result = withFixture('agentbean-phase3-result-parser-', (fixture) => {
    const path = join(fixture, 'packages/contracts/src/management-worker-v2.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('parsePhase3MemoryToolResultV3', 'removedPhase3MemoryToolResultV3'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_DEFINITIONS_INVALID/);
});

test('fails closed when the Phase 3 Memory result output validator disappears', () => {
  const result = withFixture('agentbean-phase3-result-output-', (fixture) => {
    const path = join(fixture, 'packages/contracts/src/management-worker-v2.ts');
    writeFileSync(path, readFileSync(path, 'utf8')
      .replaceAll('assertPhase3MemoryToolOutput', 'removedPhase3MemoryToolOutput'));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_DEFINITIONS_INVALID/);
});

test('fails closed when the Phase 3 tool list drops a Memory tool', () => {
  const result = withFixture('agentbean-phase3-tool-list-', (fixture) => {
    const path = join(fixture, 'packages/pi-management-runtime/src/types.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      "  'memory.link_sources',\n] as const satisfies readonly ManagementToolName[];",
      '] as const satisfies readonly ManagementToolName[];',
    ));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /P3_CAPABILITY_DEFINITIONS_INVALID/);
});
