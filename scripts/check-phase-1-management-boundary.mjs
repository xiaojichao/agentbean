#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : defaultRoot);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  } catch {
    return null;
  }
}

function readSource(path) {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

const runtime = readJson('packages/pi-management-runtime/package.json');
const daemon = readJson('apps/daemon-next/package.json');
const runtimeTypes = readSource('packages/pi-management-runtime/src/types.ts');
const violations = [];

if (!runtime
  || runtime.private !== false
  || !runtime.version
  || runtime.version === '0.0.0'
  || !runtime.files?.includes('dist/**/*.js')
  || !runtime.files?.includes('dist/index.d.ts')
  || !runtime.files?.includes('dist/types.d.ts')
  || runtime.scripts?.prepublishOnly !== 'npm run build'
  || runtime.dependencies?.['@earendil-works/pi-ai'] !== '0.80.6'
  || runtime.dependencies?.['@earendil-works/pi-coding-agent'] !== '0.80.6'
  || !runtimeTypes.includes('PHASE_1_MANAGEMENT_TOOL_NAMES')
  || !runtimeTypes.includes('ManagementSessionContextV1')) {
  violations.push('P1_RUNTIME_PACKAGE_INVALID: PI management runtime publish/tool/context contract is incomplete');
}

if (!daemon || daemon.dependencies?.['@agentbean/pi-management-runtime'] !== runtime?.version) {
  violations.push('P1_DAEMON_RUNTIME_VERSION: daemon-next must use the exact PI management runtime version');
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`P1_RUNTIME_PACKAGE_READY: @agentbean/pi-management-runtime@${runtime.version}`);

const workerContract = readSource('packages/contracts/src/management-worker.ts');
const socketContract = readSource('packages/contracts/src/socket.ts');
const contractsIndex = readSource('packages/contracts/src/index.ts');
const leasePolicy = readSource('packages/domain/src/manager-lease-policy.ts');
const domainIndex = readSource('packages/domain/src/index.ts');
const phase1Tools = [
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
];
const workerMarkers = [
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
  ...phase1Tools,
];
const socketMarkers = [
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
];
const leaseMarkers = [
  'evaluateManagerLeaseAcquire',
  'evaluateManagerLeaseRenew',
  'evaluateManagerLeaseRelease',
  'authorizeManagerLeaseWrite',
  'expired-same-host',
  'cross-host-recovery-not-supported',
  'stale-fencing-token',
  'future-fencing-token',
];
const workerContractSurfacePresent = workerMarkers.every((marker) => workerContract.includes(marker))
  && socketMarkers.every((marker) => socketContract.includes(marker))
  && contractsIndex.includes("export * from './management-worker.js'")
  && leaseMarkers.every((marker) => leasePolicy.includes(marker))
  && domainIndex.includes("export * from './manager-lease-policy.js'")
  && !workerContract.includes('@earendil-works')
  && !leasePolicy.includes('@earendil-works');

if (!workerContractSurfacePresent) {
  console.error('P1_WORKER_CONTRACTS_INVALID: Worker RPC/parser and lease/fencing Domain rules are incomplete');
  process.exit(2);
}

console.log('P1_WORKER_CONTRACT_SURFACE_PRESENT: static Worker RPC and lease/fencing exports are present; semantic readiness is verified by package tests');

const managementMigration = readSource('apps/server-next/src/infra/sqlite/migrations/team/0010_management_phase_1.sql');
const managementRepositories = readSource('apps/server-next/src/application/management-repositories.ts');
const managementUnitOfWork = readSource('apps/server-next/src/application/management-unit-of-work.ts');
const persistenceMarkers = [
  'team_management_policies',
  'managed_request_reservations',
  'management_runs',
  'manager_leases',
  'management_events',
  'management_checkpoints',
  'agent_invocations',
  'invocation_dispatch_attempts',
  'management_shadow_decisions',
  'one_active_dispatch_attempt_per_invocation',
];
const managementPersistencePresent = persistenceMarkers.every((marker) => managementMigration.includes(marker))
  && managementRepositories.includes('export interface ManagementRepositories')
  && managementUnitOfWork.includes('export interface ManagementUnitOfWork')
  && managementUnitOfWork.includes('createRun');

if (!managementPersistencePresent) {
  console.error('P1_MANAGEMENT_PERSISTENCE_INVALID: schema, repository ports, or atomic Unit of Work are incomplete');
  process.exit(2);
}

console.log('P1_MANAGEMENT_PERSISTENCE_PRESENT: schema, repository ports, and atomic Unit of Work are present; semantic readiness is verified by server tests');

const managementKernel = readSource('apps/server-next/src/application/management/management-kernel.ts');
const managementEventValidator = readSource('apps/server-next/src/application/management/management-event-validator.ts');
const managementCheckpoint = readSource('apps/server-next/src/application/management/management-checkpoint.ts');
const managementToolExecutor = readSource('apps/server-next/src/application/management/management-tool-executor.ts');
const serverKernelPresent = [
  'createOrResumeRun',
  'acquireLease',
  'renewLease',
  'releaseLease',
  'expireLease',
  'appendEvent',
  'authorizeManagementWrite',
].every((marker) => managementKernel.includes(marker))
  && managementEventValidator.includes('parsePhase1ManagementEvent')
  && managementEventValidator.includes('hashManagementEventPayload')
  && managementCheckpoint.includes('collectManagementCheckpointFacts')
  && managementCheckpoint.includes('restoreOrRebuildManagementCheckpoint')
  && managementToolExecutor.includes('createManagementToolExecutor');

if (!serverKernelPresent) {
  console.error('P1_SERVER_KERNEL_INVALID: Collaboration Kernel, Event, Checkpoint, or tool boundary is incomplete');
  process.exit(2);
}

console.log('P1_SERVER_KERNEL_PRESENT: Collaboration Kernel, Event, Checkpoint, and tool boundaries are present; semantic readiness is verified by server tests');

const invocationGateway = readSource('apps/server-next/src/application/management/invocation-gateway.ts');
const serverRepositories = readSource('apps/server-next/src/application/repositories.ts');
const serverUseCases = readSource('apps/server-next/src/application/usecases.ts');
const invocationGatewayPresent = [
  'createInvocationGateway',
  'canonicalizeAgentInvocationIntent',
  'resolveInvocationIdempotency',
  'completeAttempt',
  'deriveInvocationView',
  'INVOCATION_ACTIVE_ATTEMPT',
].every((marker) => invocationGateway.includes(marker))
  && serverRepositories.includes('ManagementDispatchUnitOfWork')
  && serverRepositories.includes('managementDispatchUnitOfWork')
  && serverUseCases.includes('invocationGateway.completeAttempt')
  && serverUseCases.includes('managedAttempt');

if (!invocationGatewayPresent) {
  console.error('P1_INVOCATION_GATEWAY_INVALID: Invocation/Dispatch attempt bridge or canonical lifecycle integration is incomplete');
  process.exit(2);
}

console.log('P1_INVOCATION_GATEWAY_PRESENT: immutable Invocation, canonical Dispatch attempt, and terminal lifecycle bridge are present; semantic readiness is verified by server tests');

const deviceWorkerScheduler = readSource('apps/server-next/src/application/management/device-worker-scheduler.ts');
const socketHandlers = readSource('apps/server-next/src/transport/socket-handlers.ts');
const socketServer = readSource('apps/server-next/src/transport/socket-server.ts');
const devServer = readSource('apps/server-next/src/dev-server.ts');
const workerTransportPresent = [
  'createDeviceWorkerScheduler',
  'registerWorker',
  'scheduleManagementRun',
  'acquireLease',
  'renewLease',
  'releaseLease',
  'abortLease',
  'executeTool',
  'MANAGEMENT_WORKER_OFFER_TIMEOUT',
].every((marker) => deviceWorkerScheduler.includes(marker))
  && managementKernel.includes('expireLease')
  && socketHandlers.includes('safeParseManagementWorkerPayload')
  && socketHandlers.includes('AGENT_EVENTS.managementWorker.register')
  && socketServer.includes('managementWorkerScheduler')
  && socketServer.includes('scheduleManagementRun')
  && (devServer.includes('createDefaultManagementWorkerScheduler') || devServer.includes('createDefaultManagementRuntime'))
  && devServer.includes('createDeviceWorkerScheduler');

if (!workerTransportPresent) {
  console.error('P1_WORKER_TRANSPORT_INVALID: Device Worker scheduler or Socket transport integration is incomplete');
  process.exit(2);
}

console.log('P1_WORKER_TRANSPORT_PRESENT: Device eligibility, lease ACK, timeout, reconnect, and tool RPC boundaries are present; semantic readiness is verified by server tests');

const deviceServiceCore = readSource('apps/daemon-next/src/device-service-core.ts');
const piManagerWorkerHost = readSource('apps/daemon-next/src/pi-manager-worker-host.ts');
const managementWorkerProtocol = readSource('apps/daemon-next/src/management-worker-protocol.ts');
const managementDurableOutbox = readSource('apps/daemon-next/src/management-durable-outbox.ts');
const managementCredentialProvider = readSource('apps/daemon-next/src/management-credential-provider.ts');
const managementModelAdapter = readSource('apps/daemon-next/src/management-model-adapter.ts');
const daemonProfilePaths = readSource('apps/daemon-next/src/profile-paths.ts');
const daemonCli = readSource('apps/daemon-next/src/cli.ts');
const deviceWorkerHostPresent = [
  'createDeviceServiceCore',
  'dispatchClient',
  'managementWorkerHost',
].every((marker) => deviceServiceCore.includes(marker))
  && [
    'createPiManagerWorkerHost',
    'replayManagementOutboxForLease',
    'activeLeaseCount',
    'worker-disconnected',
    'taskGraphRevision',
  ].every((marker) => piManagerWorkerHost.includes(marker))
  && [
    'createManagementWorkerProtocol',
    'leaseOffer',
    'acquireLease',
    'fetchCheckpoint',
    'replayOutbox',
    'onDisconnect',
  ].every((marker) => managementWorkerProtocol.includes(marker))
  && [
    'createManagementDurableOutbox',
    'managementRunId',
    'commandId',
    'idempotencyKey',
    'requestHash',
    '0o700',
    '0o600',
  ].every((marker) => managementDurableOutbox.includes(marker))
  && [
    'createEnvironmentManagementCredentialProvider',
    'managementCredentialCapability',
    'test_only',
    'unavailable',
  ].every((marker) => managementCredentialProvider.includes(marker))
  && managementModelAdapter.includes('createManagementModelAdapter')
  && daemonProfilePaths.includes('managementOutboxFile')
  && daemonCli.includes('createDefaultManagementWorkerHost')
  && daemonCli.includes('createDeviceServiceCore');

if (!deviceWorkerHostPresent) {
  console.error('P1_DEVICE_WORKER_HOST_INVALID: DeviceServiceCore, credential provider, durable outbox, Worker protocol, or PI WorkerHost is incomplete');
  process.exit(2);
}

console.log('P1_DEVICE_WORKER_HOST_PRESENT: Device runtime composition, credential fail-closed capability, durable replay, lease fencing, and PI Session cleanup are present; semantic readiness is verified by daemon tests');

const managementRouter = readSource('apps/server-next/src/application/management/management-router.ts');
const managementPolicyPanel = readSource('apps/web-next/app/[teamPath]/settings/ManagementPolicyPanel.tsx');
const managementRoutingPresent = [
  'createManagementRouter',
  'getPolicy',
  'updatePolicy',
  'evaluateManagementRoute',
  'createOrResumeRun',
  'shadowRequestKey',
  'allowDirectFallbackBeforeBarrier: false',
].every((marker) => managementRouter.includes(marker))
  && serverUseCases.includes('managementRouter.route')
  && serverUseCases.includes("management.kind !== 'managed'")
  && socketHandlers.includes('WEB_EVENTS.managementPolicy.get')
  && socketHandlers.includes('WEB_EVENTS.managementPolicy.update')
  && socketContract.includes('management-policy:get')
  && socketContract.includes('management-policy:update')
  && managementPolicyPanel.includes('settings-management-policy')
  && managementPolicyPanel.includes('settings-management-preflight');

if (!managementRoutingPresent) {
  console.error('P1_MANAGEMENT_ROUTING_INVALID: Team policy, shadow namespace, managed fail-closed routing, or minimal settings control is incomplete');
  process.exit(2);
}

console.log('P1_MANAGEMENT_ROUTING_PRESENT: direct baseline, shadow decision isolation, managed reservation barrier, policy authorization, and minimal settings control are present; semantic readiness is verified by server/web tests');

const futureBoundaries = [
  'apps/server-next/tests/managed-single-agent.test.ts',
];
const missing = futureBoundaries.filter((path) => !existsSync(resolve(root, path)));
if (missing.length > 0) {
  console.error(missing.map((path) => `P1_NOT_IMPLEMENTED: ${path}`).join('\n'));
  process.exit(2);
}

console.log('Phase 1 management boundary check passed.');
