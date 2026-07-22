import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-phase-1-management-boundary.mjs', import.meta.url));

function write(root, path, source) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker, '--workspace-root', root], { encoding: 'utf8' });
}

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-phase-1-boundary-'));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scaffoldRuntimeSlice(root, options = {}) {
  const runtimeVersion = options.runtimeVersion ?? '0.1.0';
  write(root, 'packages/pi-management-runtime/package.json', JSON.stringify({
    name: '@agentbean/pi-management-runtime',
    version: runtimeVersion,
    private: options.private ?? false,
    files: ['dist/**/*.js', 'dist/index.d.ts', 'dist/types.d.ts'],
    scripts: { prepublishOnly: 'npm run build' },
    dependencies: {
      '@earendil-works/pi-ai': '0.80.6',
      '@earendil-works/pi-coding-agent': '0.80.6',
    },
  }));
  write(root, 'apps/daemon-next/package.json', JSON.stringify({
    name: '@agentbean/daemon-next',
    version: '0.3.7',
    dependencies: {
      '@agentbean/pi-management-runtime': options.daemonRuntimeVersion ?? runtimeVersion,
    },
  }));
  write(root, 'packages/pi-management-runtime/src/types.ts', [
    'export const PHASE_1_MANAGEMENT_TOOL_NAMES = [];',
    'export interface ManagementSessionContextV1 {}',
  ].join('\n'));
}

function scaffoldFutureBoundaries(root) {
  scaffoldWorkerContracts(root);
  scaffoldManagementPersistence(root);
  scaffoldServerKernel(root);
  scaffoldInvocationGateway(root);
  scaffoldWorkerTransport(root);
  scaffoldDeviceWorkerHost(root);
  scaffoldManagementRouting(root);
  write(root, 'apps/server-next/tests/managed-single-agent.test.ts', '// scaffolded\n');
  write(root, 'apps/daemon-next/tests/managed-single-agent.test.ts', '// scaffolded\n');
}

function scaffoldManagementRouting(root) {
  write(root, 'apps/server-next/src/application/management/management-router.ts', [
    'createManagementRouter', 'getPolicy', 'updatePolicy', 'evaluateManagementRoute',
    'createOrResumeRun', 'shadowRequestKey', 'allowDirectFallbackBeforeBarrier: false',
  ].join('\n'));
  write(root, 'apps/server-next/src/application/usecases.ts', [
    'invocationGateway.completeAttempt', 'managedAttempt', 'managementRouter.route', "management.kind !== 'managed'",
  ].join('\n'));
  write(root, 'apps/server-next/src/transport/socket-handlers.ts', [
    'safeParseManagementWorkerPayload', 'AGENT_EVENTS.managementWorker.register',
    'WEB_EVENTS.managementPolicy.get', 'WEB_EVENTS.managementPolicy.update',
    'WEB_EVENTS.piPolicy.get', 'WEB_EVENTS.piPolicy.update',
  ].join('\n'));
  write(root, 'packages/contracts/src/socket.ts', [
    'managementWorker', 'management-worker:register', 'management-worker:lease-offer',
    'management-worker:lease-acquire', 'management-worker:lease-renew', 'management-worker:lease-release',
    'management-worker:abort', 'management-worker:tool-request', 'management-worker:checkpoint-fetch',
    'management-worker:outbox-replay', 'management-worker:shadow-evaluate', 'management-worker:shadow-result',
    'management-policy:get', 'management-policy:update',
    'pi-policy:get', 'pi-policy:update',
  ].join('\n'));
  write(root, 'apps/web-next/app/[teamPath]/settings/PiPolicyPanel.tsx', 'settings-pi-policy settings-pi-auto-coordination\n');
}

function scaffoldDeviceWorkerHost(root) {
  write(root, 'apps/daemon-next/src/device-service-core.ts', 'createDeviceServiceCore dispatchClient managementWorkerHost\n');
  write(root, 'apps/daemon-next/src/pi-manager-worker-host.ts', [
    'createPiManagerWorkerHost',
    'replayManagementOutboxForLease',
    'activeLeaseCount',
    'worker-disconnected',
    'taskGraphRevision',
  ].join('\n'));
  write(root, 'apps/daemon-next/src/management-worker-protocol.ts', [
    'createManagementWorkerProtocol', 'leaseOffer', 'acquireLease', 'fetchCheckpoint', 'replayOutbox', 'onDisconnect',
  ].join('\n'));
  write(root, 'apps/daemon-next/src/management-durable-outbox.ts', [
    'createManagementDurableOutbox', 'managementRunId', 'commandId', 'idempotencyKey', 'requestHash', '0o700', '0o600',
  ].join('\n'));
  write(root, 'apps/daemon-next/src/management-credential-provider.ts', [
    'createEnvironmentManagementCredentialProvider', 'managementCredentialCapability', 'test_only', 'unavailable',
  ].join('\n'));
  write(root, 'apps/daemon-next/src/management-model-adapter.ts', 'createManagementModelAdapter\n');
  write(root, 'apps/daemon-next/src/profile-paths.ts', 'managementOutboxFile\n');
  write(root, 'apps/daemon-next/src/cli.ts', 'createDefaultManagementWorkerHost createDeviceServiceCore\n');
}

function scaffoldWorkerTransport(root) {
  write(root, 'apps/server-next/src/application/management/device-worker-scheduler.ts', [
    'createDeviceWorkerScheduler',
    'registerWorker',
    'scheduleManagementRun',
    'acquireLease',
    'renewLease',
    'releaseLease',
    'expireLease',
    'abortLease',
    'executeTool',
    'MANAGEMENT_WORKER_OFFER_TIMEOUT',
  ].join('\n'));
  write(root, 'apps/server-next/src/application/management/management-kernel.ts', 'createOrResumeRun acquireLease renewLease releaseLease expireLease appendEvent authorizeManagementWrite\n');
  write(root, 'apps/server-next/src/transport/socket-handlers.ts', 'safeParseManagementWorkerPayload AGENT_EVENTS.managementWorker.register\n');
  write(root, 'apps/server-next/src/transport/socket-server.ts', 'managementWorkerScheduler scheduleManagementRun\n');
  write(root, 'apps/server-next/src/dev-server.ts', 'createDefaultManagementWorkerScheduler createDeviceWorkerScheduler\n');
}

function scaffoldInvocationGateway(root) {
  write(root, 'apps/server-next/src/application/management/invocation-gateway.ts', [
    'createInvocationGateway',
    'canonicalizeAgentInvocationIntent',
    'resolveInvocationIdempotency',
    'completeAttempt',
    'deriveInvocationView',
    'INVOCATION_ACTIVE_ATTEMPT',
  ].join('\n'));
  write(root, 'apps/server-next/src/application/repositories.ts', 'ManagementDispatchUnitOfWork managementDispatchUnitOfWork\n');
  write(root, 'apps/server-next/src/application/usecases.ts', 'invocationGateway.completeAttempt managedAttempt\n');
}

function scaffoldServerKernel(root) {
  write(root, 'apps/server-next/src/application/management/management-kernel.ts', 'createOrResumeRun acquireLease renewLease releaseLease expireLease appendEvent authorizeManagementWrite\n');
  write(root, 'apps/server-next/src/application/management/management-event-validator.ts', 'parsePhase1ManagementEvent hashManagementEventPayload\n');
  write(root, 'apps/server-next/src/application/management/management-checkpoint.ts', 'collectManagementCheckpointFacts restoreOrRebuildManagementCheckpoint\n');
  write(root, 'apps/server-next/src/application/management/management-tool-executor.ts', 'createManagementToolExecutor\n');
}

function scaffoldManagementPersistence(root) {
  write(root, 'apps/server-next/src/infra/sqlite/migrations/team/0010_management_phase_1.sql', [
    'team_management_policies', 'managed_request_reservations', 'management_runs', 'manager_leases',
    'management_events', 'management_checkpoints', 'agent_invocations', 'invocation_dispatch_attempts',
    'management_shadow_decisions', 'one_active_dispatch_attempt_per_invocation',
  ].join('\n'));
  write(root, 'apps/server-next/src/application/management-repositories.ts', 'export interface ManagementRepositories {}\n');
  write(root, 'apps/server-next/src/application/management-unit-of-work.ts', 'export interface ManagementUnitOfWork { createRun: unknown }\n');
}

function scaffoldWorkerContracts(root) {
  write(root, 'packages/contracts/src/management-worker.ts', [
    'PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES',
    'ManagementWorkerPayloadMapV1',
    'parseManagementWorkerPayload',
    'safeParseManagementWorkerPayload',
    'production_ready',
    'test_only',
    'unavailable',
    'leaseToken',
    'fencingToken',
    'idempotencyKey',
    'shadow-evaluate',
    'outbox-replay',
    'context.get_root_message',
    'context.get_root_task',
    'context.get_visible_thread',
    'context.get_management_state',
    'agents.list_capabilities',
    'agents.get_status',
    'agents.invoke',
    'agents.cancel_invocation',
    'channel.post_management_status',
    'user.request_input',
    'review.submit_root_delivery',
  ].join('\n'));
  write(root, 'packages/contracts/src/socket.ts', [
    'managementWorker',
    'management-worker:register',
    'management-worker:lease-offer',
    'management-worker:lease-acquire',
    'management-worker:lease-renew',
    'management-worker:lease-release',
    'management-worker:abort',
    'management-worker:tool-request',
    'management-worker:checkpoint-fetch',
    'management-worker:outbox-replay',
    'management-worker:shadow-evaluate',
    'management-worker:shadow-result',
  ].join('\n'));
  write(root, 'packages/contracts/src/index.ts', "export * from './management-worker.js';\n");
  write(root, 'packages/domain/src/manager-lease-policy.ts', [
    'evaluateManagerLeaseAcquire',
    'evaluateManagerLeaseRenew',
    'evaluateManagerLeaseRelease',
    'authorizeManagerLeaseWrite',
    'expired-same-host',
    'cross-host-recovery-not-supported',
    'stale-fencing-token',
    'future-fencing-token',
  ].join('\n'));
  write(root, 'packages/domain/src/index.ts', "export * from './manager-lease-policy.js';\n");
}

test('reports the runtime/package slice as not ready before it is publishable', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root, { private: true });
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_RUNTIME_PACKAGE_INVALID/);
  });
});

test('reports future Phase 1 boundaries as explicitly not implemented after the runtime slice is ready', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_WORKER_CONTRACTS_INVALID/);
    assert.match(result.stdout, /P1_RUNTIME_PACKAGE_READY/);
  });
});

test('reports the static Worker/lease surface while later boundaries remain Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_WORKER_CONTRACT_SURFACE_PRESENT/);
    assert.match(result.stderr, /P1_MANAGEMENT_PERSISTENCE_INVALID/);
    assert.doesNotMatch(result.stderr, /management-worker\.ts/);
  });
});

test('reports management persistence while Server kernel and WorkerHost remain Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_MANAGEMENT_PERSISTENCE_PRESENT/);
    assert.match(result.stderr, /P1_SERVER_KERNEL_INVALID/);
  });
});

test('reports Server kernel while Invocation Gateway remains Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    scaffoldServerKernel(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_SERVER_KERNEL_PRESENT/);
    assert.match(result.stderr, /P1_INVOCATION_GATEWAY_INVALID/);
  });
});

test('reports Invocation Gateway while Worker transport remains Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    scaffoldServerKernel(root);
    scaffoldInvocationGateway(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_INVOCATION_GATEWAY_PRESENT/);
    assert.match(result.stderr, /P1_WORKER_TRANSPORT_INVALID/);
  });
});

test('reports Worker transport while Device WorkerHost remains Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    scaffoldServerKernel(root);
    scaffoldInvocationGateway(root);
    scaffoldWorkerTransport(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_WORKER_TRANSPORT_PRESENT/);
    assert.match(result.stderr, /P1_DEVICE_WORKER_HOST_INVALID/);
  });
});

test('reports Device WorkerHost while managed routing remains Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    scaffoldServerKernel(root);
    scaffoldInvocationGateway(root);
    scaffoldWorkerTransport(root);
    scaffoldDeviceWorkerHost(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_DEVICE_WORKER_HOST_PRESENT/);
    assert.match(result.stderr, /P1_MANAGEMENT_ROUTING_INVALID/);
  });
});

test('reports managed routing while single-Agent vertical execution remains Red', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldWorkerContracts(root);
    scaffoldManagementPersistence(root);
    scaffoldServerKernel(root);
    scaffoldInvocationGateway(root);
    scaffoldWorkerTransport(root);
    scaffoldDeviceWorkerHost(root);
    scaffoldManagementRouting(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /P1_MANAGEMENT_ROUTING_PRESENT/);
    assert.match(result.stderr, /P1_NOT_IMPLEMENTED:.*managed-single-agent\.test\.ts/);
  });
});

test('passes when runtime/package and future management boundaries are present', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldFutureBoundaries(root);
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test('rejects imprecise daemon runtime dependencies', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root, { daemonRuntimeVersion: '^0.1.0' });
    scaffoldFutureBoundaries(root);
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_DAEMON_RUNTIME_VERSION/);
  });
});
