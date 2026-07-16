import { describe, expect, test, vi } from 'vitest';
import {
  AGENT_EVENTS,
  type ManagementLeaseOfferV1,
  type ManagementWorkerRegisterV1,
  type ManagementWorkerRegisterV2,
} from '../../../packages/contracts/src/index.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementToolExecutor } from '../src/application/management/management-tool-executor.js';
import { createDeviceWorkerScheduler } from '../src/application/management/device-worker-scheduler.js';
import type { TaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import type { ServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { attachServerNextNamespaces, type NamespaceLike, type SocketServerLike } from '../src/transport/socket-server.js';
import type { SocketHandler, SocketLike } from '../src/transport/socket-handlers.js';

describe('management worker socket integration', () => {
  test('managed Invocation 创建的 Dispatch 可通过 realtime bridge 下发到目标 Device', async () => {
    const harness = await createHarness({ devices: [device('device-1', 'profile-1')] });
    const socket = harness.connect('device-1');
    await socket.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-1' });

    await harness.realtime.dispatchRequest('dispatch-managed-1');

    expect(socket.outbound(AGENT_EVENTS.dispatch.request)).toMatchObject([
      { payload: { id: 'dispatch-managed-1', deviceId: 'device-1', agentId: 'agent-1' } },
    ]);
  });

  test('keeps Dispatch claim separate and offers only to an eligible Device worker', async () => {
    const harness = await createHarness({
      devices: [
        device('device-allowed', 'profile-1'),
        device('device-blocked', 'profile-1'),
        device('device-wrong-profile', 'profile-2'),
        device('device-unready', 'profile-1'),
        device('device-full', 'profile-1'),
      ],
      allowedDeviceIds: ['device-allowed', 'device-wrong-profile', 'device-unready', 'device-full'],
    });
    const allowed = harness.connect('device-allowed');
    const blocked = harness.connect('device-blocked');
    const wrongProfile = harness.connect('device-wrong-profile');
    const unready = harness.connect('device-unready');
    const full = harness.connect('device-full');

    await allowed.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-allowed', capabilities: { runDispatches: false } });
    await blocked.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-blocked', capabilities: { runDispatches: true } });
    await wrongProfile.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-wrong-profile', capabilities: { runDispatches: true } });
    await unready.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-unready', capabilities: { runDispatches: true } });
    await full.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-full', capabilities: { runDispatches: true } });
    await expect(allowed.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration())).resolves.toMatchObject({ ok: true });
    await expect(blocked.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration())).resolves.toMatchObject({ ok: true });
    await expect(wrongProfile.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration({ profileId: 'profile-2' }))).resolves.toMatchObject({ ok: true });
    await expect(unready.trigger(AGENT_EVENTS.managementWorker.register, unavailableWorkerRegistration())).resolves.toMatchObject({ ok: true });
    await expect(full.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration({
      workerInstanceId: 'worker-instance-full',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 1 },
    }))).resolves.toMatchObject({ ok: true });

    const scheduled = await harness.realtime.scheduleManagementRun({
      managementRunId: harness.runId,
      profileId: 'profile-1',
      offerTimeoutMs: 20,
    });

    expect(scheduled).toMatchObject({ ok: true, workerId: expect.any(String), deviceId: 'device-allowed' });
    expect(allowed.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(1);
    expect(blocked.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(0);
    expect(wrongProfile.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(0);
    expect(unready.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(0);
    expect(full.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(0);
  });

  test('acks acquire, heartbeat/renew, tool RPC, release and offer timeout', async () => {
    const harness = await createHarness({ devices: [device('device-1', 'profile-1')] });
    const socket = harness.connect('device-1');
    await socket.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-1' });
    const registration = await socket.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration());
    expect(registration).toMatchObject({ ok: true, protocolVersion: 1 });

    const scheduled = await harness.realtime.scheduleManagementRun({ managementRunId: harness.runId, profileId: 'profile-1' });
    expect(scheduled).toMatchObject({ ok: true });
    const offer = socket.outbound(AGENT_EVENTS.managementWorker.leaseOffer)[0]?.payload as ManagementLeaseOfferV1;
    const acquired = await socket.trigger(AGENT_EVENTS.managementWorker.leaseAcquire, {
      schemaVersion: 1,
      offerId: offer.offerId,
      workerInstanceId: 'worker-instance-1',
    });
    expect(acquired).toMatchObject({ ok: true, fencingToken: 1, leaseToken: 'lease-secret-1' });

    harness.clock.now = 20;
    const authority = {
      schemaVersion: 1 as const,
      managementRunId: harness.runId,
      workerId: (registration as { workerId: string }).workerId,
      leaseToken: 'lease-secret-1',
      fencingToken: 1,
      idempotencyKey: 'heartbeat-1',
    };
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.leaseRenew, authority)).resolves.toMatchObject({ ok: true, expiresAt: 120 });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.toolRequest, {
      schemaVersion: 1,
      commandId: 'command-1',
      managementRunId: harness.runId,
      workerId: authority.workerId,
      toolCallId: 'tool-1',
      toolName: 'context.get_management_state',
      input: {},
    })).resolves.toMatchObject({ ok: true, output: { status: 'running' } });
    expect(harness.toolHandler).toHaveBeenCalledOnce();
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.toolRequest, {
      schemaVersion: 2,
      managementPhase: 3,
      commandId: 'command-phase-3',
      managementRunId: harness.runId,
      workerId: authority.workerId,
      toolCallId: 'tool-phase-3',
      toolName: 'memory.search',
      leaseToken: 'lease-secret-1',
      fencingToken: 1,
      idempotencyKey: 'memory-search-1',
      input: { targetAgentId: 'agent-1', query: '目标', limit: 5 },
    })).resolves.toMatchObject({
      schemaVersion: 2,
      managementPhase: 3,
      ok: false,
      errorCode: 'NOT_AUTHORIZED',
      diagnosticCode: 'MANAGEMENT_WORKER_PHASE_MISMATCH',
    });
    const phase1Checkpoint = await socket.trigger(AGENT_EVENTS.managementWorker.checkpointFetch, {
      schemaVersion: 1,
      managementRunId: harness.runId,
      workerId: authority.workerId,
      leaseToken: 'lease-secret-1',
      fencingToken: 1,
    });
    expect(phase1Checkpoint).toMatchObject({
      managementRunId: harness.runId,
      checkpoint: { authoritative: { memoryCapsuleIds: ['capsule-current'] } },
      context: {
        frozenTarget: { agentId: 'agent-1', kind: 'custom' },
        visibleThread: { messages: [{ id: 'message-1', body: '执行目标' }] },
      },
    });
    expect((phase1Checkpoint as { context: object }).context).not.toHaveProperty('managementPhase');
    expect(harness.memoryCapsules.listValidMemoryCapsuleIds).toHaveBeenCalledWith({
      teamId: 'team-1', managementRunId: harness.runId, now: 20,
    });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority,
      commandId: 'missing-command',
      idempotencyKey: 'missing-command',
      requestHash: 'request-hash',
    })).resolves.toMatchObject({ disposition: 'rejected' });
    const handoffIntent = { schemaVersion: 1 as const, managementRunId: harness.runId,
      fromAgentId: 'agent-1', toAgentId: 'agent-2', kind: 'consult' as const,
      objective: '咨询 Agent 2', reason: '需要复核', contextRefs: [], dependencyResults: [],
      acceptanceCriteria: [], attachmentIds: [], returnMode: 'return_to_manager' as const };
    await harness.repositories.management.handoffs.create({ schemaVersion: 1, id: 'handoff-1',
      managementRunId: harness.runId, intent: handoffIntent, intentHash: 'handoff-hash',
      idempotencyKey: 'handoff-command', status: 'requested', createdAt: 20, updatedAt: 20 });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority,
      commandId: 'handoff-command',
      idempotencyKey: 'handoff-command',
      requestHash: 'handoff-request-hash',
    })).resolves.toMatchObject({ disposition: 'existing', resultReferenceId: 'handoff-1' });
    let markTransactionStarted!: () => void;
    let releaseTransaction!: () => void;
    const transactionStarted = new Promise<void>((resolve) => { markTransactionStarted = resolve; });
    const transactionRelease = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const inFlightMemoryWrite = harness.repositories.managementMemoryUnitOfWork.run(async ({ management }) => {
      markTransactionStarted();
      await transactionRelease;
      await harness.kernel.recordMemoryToolReceiptInTransaction(management, {
        authority, idempotencyKey: 'racing-memory-command', toolName: 'memory.create_capsule',
        resultReferenceId: 'capsule-racing', requestHash: 'racing-memory-request-hash',
        output: { capsuleRef: { schemaVersion: 1, id: 'capsule-racing', teamId: 'team-1',
          managementRunId: harness.runId, targetAgentId: 'agent-1', contentHash: 'sha256:racing',
          authorizationDecisionId: 'decision-racing', expiresAt: 100 } },
      });
    });
    await transactionStarted;
    const racingReplay = socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority, commandId: 'racing-memory-command', idempotencyKey: 'racing-memory-command',
      requestHash: 'racing-memory-request-hash', toolName: 'memory.create_capsule',
    });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    releaseTransaction();
    await inFlightMemoryWrite;
    await expect(racingReplay).resolves.toMatchObject({
      disposition: 'committed', resultReferenceId: 'capsule-racing',
    });
    await harness.kernel.recordMemoryToolReceipt({
      authority, idempotencyKey: 'memory-command', toolName: 'memory.create_capsule',
      resultReferenceId: 'capsule-1', requestHash: 'memory-request-hash',
      output: { capsuleRef: { schemaVersion: 1, id: 'capsule-1', teamId: 'team-1',
        managementRunId: harness.runId, targetAgentId: 'agent-1', contentHash: 'sha256:content',
        authorizationDecisionId: 'decision-1', expiresAt: 100 } },
    });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority, commandId: 'memory-command', idempotencyKey: 'memory-command',
      requestHash: 'memory-request-hash', toolName: 'memory.create_capsule',
    })).resolves.toMatchObject({ disposition: 'committed', resultReferenceId: 'capsule-1' });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority, commandId: 'memory-command', idempotencyKey: 'memory-command',
      requestHash: 'changed-request-hash', toolName: 'memory.create_capsule',
    })).resolves.toMatchObject({ disposition: 'conflict' });
    await harness.repositories.management.events.append({
      event: {
        schemaVersion: 1, id: 'legacy-memory-receipt', managementRunId: harness.runId, sequence: 99,
        type: 'memory-tool-completed', actorKind: 'manager', actorId: authority.workerId,
        idempotencyKey: 'legacy-memory-command', payload: {
          toolName: 'memory.create_capsule', resultReferenceId: 'capsule-legacy',
          requestHash: 'legacy-memory-request-hash',
        }, createdAt: 20,
      },
      payloadHash: 'legacy-memory-payload-hash',
    });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.outboxReplay, {
      ...authority, commandId: 'legacy-memory-command', idempotencyKey: 'legacy-memory-command',
      requestHash: 'legacy-memory-request-hash', toolName: 'memory.create_capsule',
    })).resolves.toMatchObject({ disposition: 'rejected' });
    await expect(socket.trigger(AGENT_EVENTS.managementWorker.leaseRelease, {
      ...authority,
      idempotencyKey: 'release-1',
      reasonCode: 'COMPLETED',
    })).resolves.toMatchObject({ ok: true, releasedAt: 20 });

    const secondRun = await harness.createRun('run-request-2');
    socket.offerAck = () => Promise.reject(new Error('operation has timed out'));
    await expect(harness.realtime.scheduleManagementRun({
      managementRunId: secondRun,
      profileId: 'profile-1',
      offerTimeoutMs: 5,
    })).resolves.toMatchObject({ ok: false, diagnosticCode: 'MANAGEMENT_WORKER_OFFER_TIMEOUT' });
  });

  test('disconnect never falls back directly and reconnect recovers only after lease expiry', async () => {
    const harness = await createHarness({ devices: [device('device-1', 'profile-1')] });
    const first = harness.connect('device-1');
    await first.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-1' });
    const registered = await first.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration());
    await harness.realtime.scheduleManagementRun({ managementRunId: harness.runId, profileId: 'profile-1' });
    const offer = first.outbound(AGENT_EVENTS.managementWorker.leaseOffer)[0]?.payload as ManagementLeaseOfferV1;
    await first.trigger(AGENT_EVENTS.managementWorker.leaseAcquire, {
      schemaVersion: 1,
      offerId: offer.offerId,
      workerInstanceId: 'worker-instance-1',
    });

    await first.disconnect();
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'running' });
    await expect(harness.repositories.management.events.list(harness.runId)).resolves.toHaveLength(2);

    const reconnected = harness.connect('device-1');
    await reconnected.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-1' });
    await expect(reconnected.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration())).resolves.toMatchObject({
      ok: true,
      workerId: (registered as { workerId: string }).workerId,
    });
    harness.clock.now = 99;
    await expect(harness.realtime.scheduleManagementRun({ managementRunId: harness.runId, profileId: 'profile-1' }))
      .resolves.toMatchObject({ ok: false, diagnosticCode: 'MANAGEMENT_RUN_LEASE_ACTIVE' });

    harness.clock.now = 111;
    await expect(harness.realtime.scheduleManagementRun({ managementRunId: harness.runId, profileId: 'profile-1' }))
      .resolves.toMatchObject({ ok: true });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({ status: 'recovering' });
    const recoveryOffer = reconnected.outbound(AGENT_EVENTS.managementWorker.leaseOffer)[0]?.payload as ManagementLeaseOfferV1;
    await expect(reconnected.trigger(AGENT_EVENTS.managementWorker.leaseAcquire, {
      schemaVersion: 1,
      offerId: recoveryOffer.offerId,
      workerInstanceId: 'worker-instance-1',
    })).resolves.toMatchObject({ ok: true, fencingToken: 2 });
    await expect(harness.repositories.management.events.list(harness.runId)).resolves.toMatchObject([
      { event: { type: 'run-started' } },
      { event: { type: 'worker-leased' } },
      { event: { type: 'worker-lost', payload: { reasonCode: 'LEASE_EXPIRED' } } },
      { event: { type: 'worker-leased' } },
    ]);
  });

  test('Task claim offer/ack 与 acquire/renew/release/expire 走独立 transport', async () => {
    const fakeServer = new FakeServer();
    const acquire = vi.fn(async () => ({ schemaVersion: 1, ok: false, errorCode: 'CONFLICT',
      diagnosticCode: 'TASK_CLAIM_ACTIVE_CLAIM_HELD', retryable: true }));
    const renew = vi.fn(async () => ({ schemaVersion: 1, ok: true, expiresAt: 200 }));
    const release = vi.fn(async () => ({ schemaVersion: 1, ok: true, releasedAt: 100 }));
    const disconnectDevice = vi.fn();
    const reconnectDevice = vi.fn();
    const broker: TaskClaimBroker = {
      resolveCandidates: vi.fn(async () => ({ taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
        ancestorAgentIds: [], candidates: [{ agentId: 'agent-1', deviceId: 'device-1', eligible: true,
          diagnosticCodes: [], missingCapabilities: [] }] })),
      prepareOffers: vi.fn(async () => [{ schemaVersion: 1, offerId: 'offer-1', deviceId: 'device-1',
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1',
        requiredCapabilities: ['code-review'], offerExpiresAt: 100 }]),
      acquire, renew, release,
      expireClaims: vi.fn(async () => [{ schemaVersion: 1, claimLeaseId: 'lease-1',
        taskId: 'task-1', agentId: 'agent-1', expiredAt: 100 }]),
      disconnectDevice,
      reconnectDevice,
    };
    const app = {
      deviceHello: vi.fn(async () => ({ ok: true, device: device('device-1', 'profile-1'), affectedTeamIds: [] })),
      buildDeviceScanRequest: vi.fn(async () => ({ ok: true, skipped: true })),
      markDeviceOffline: vi.fn(async () => ({ ok: true, affectedTeamIds: [] })),
    } as unknown as ServerNextUseCases;
    const realtime = attachServerNextNamespaces(fakeServer, app, { taskClaimBroker: broker });
    const socket = new FakeSocket();
    fakeServer.agent.connect(socket);
    await socket.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-1' });

    await expect(realtime.offerTaskClaims('task-1')).resolves.toEqual({ taskId: 'task-1', offered: 1, accepted: 1 });
    expect(socket.outbound(AGENT_EVENTS.taskClaim.offer)).toMatchObject([{ payload: {
      offerId: 'offer-1', taskId: 'task-1', agentId: 'agent-1',
    } }]);
    await expect(socket.trigger(AGENT_EVENTS.taskClaim.acquire, {
      schemaVersion: 1, offerId: 'offer-1', agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: false, diagnosticCode: 'TASK_CLAIM_ACTIVE_CLAIM_HELD' });
    expect(acquire).toHaveBeenCalledOnce();
    await expect(realtime.expireTaskClaims()).resolves.toHaveLength(1);
    expect(socket.outbound(AGENT_EVENTS.taskClaim.expired)).toHaveLength(1);

    await socket.disconnect();
    expect(disconnectDevice).toHaveBeenCalledWith('device-1');
    expect(reconnectDevice).toHaveBeenCalledWith('device-1');
  });

  test('Phase 2 preflight 与调度只选择声明 V2 capability 的真实 Device worker', async () => {
    const harness = await createHarness({
      devices: [device('device-v1', 'profile-1'), device('device-v2', 'profile-1')],
      allowedDeviceIds: ['device-v1', 'device-v2'],
    });
    const legacy = harness.connect('device-v1');
    const phase2 = harness.connect('device-v2');
    await legacy.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-v1' });
    await phase2.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-v2' });
    await expect(legacy.trigger(AGENT_EVENTS.managementWorker.register, workerRegistration()))
      .resolves.toMatchObject({ ok: true });

    await expect(harness.scheduler.managementPhase2Preflight({
      teamId: 'team-1',
      placementPolicy: { placement: 'device', allowedDeviceIds: ['device-v1', 'device-v2'],
        allowServerContext: false, requireLocalModelCredentials: true },
      targetAvailable: true,
    })).resolves.toMatchObject({
      preflight: { workerAvailable: false, credentialAvailable: false },
    });

    await expect(phase2.trigger(AGENT_EVENTS.managementWorker.register, {
      ...phase2WorkerRegistration(), supportedPhases: [1],
    })).resolves.toMatchObject({
      ok: false, errorCode: 'INVALID_REQUEST', diagnosticCode: 'MANAGEMENT_WORKER_V2_PAYLOAD_INVALID',
    });
    const phase2Registration = await phase2.trigger(AGENT_EVENTS.managementWorker.register,
      phase2WorkerRegistration());
    expect(phase2Registration).toMatchObject({ ok: true });
    await expect(harness.scheduler.managementPhase2Preflight({
      teamId: 'team-1',
      placementPolicy: { placement: 'device', allowedDeviceIds: ['device-v1', 'device-v2'],
        allowServerContext: false, requireLocalModelCredentials: true },
      targetAvailable: true,
    })).resolves.toMatchObject({
      preflight: { workerAvailable: true, credentialAvailable: true, placementAllowed: true },
      profileId: 'profile-1',
    });

    const runId = await harness.createPhase2Run();
    await expect(harness.realtime.scheduleManagementRun({ managementRunId: runId, profileId: 'profile-1' }))
      .resolves.toMatchObject({ ok: true, deviceId: 'device-v2' });
    expect(legacy.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(0);
    expect(phase2.outbound(AGENT_EVENTS.managementWorker.leaseOffer)).toHaveLength(1);
    const offer = phase2.outbound(AGENT_EVENTS.managementWorker.leaseOffer)[0]?.payload as ManagementLeaseOfferV1;
    const acquired = await phase2.trigger(AGENT_EVENTS.managementWorker.leaseAcquire, {
      schemaVersion: 1, offerId: offer.offerId, workerInstanceId: 'worker-instance-v2',
    });
    expect(acquired).toMatchObject({ ok: true, leaseToken: expect.any(String), fencingToken: 1 });
    const phase2Checkpoint = await phase2.trigger(AGENT_EVENTS.managementWorker.checkpointFetch, {
      schemaVersion: 1, managementRunId: runId,
      workerId: (phase2Registration as { workerId: string }).workerId,
      leaseToken: (acquired as { leaseToken: string }).leaseToken, fencingToken: 1,
    });
    expect(phase2Checkpoint).toMatchObject({ managementRunId: runId,
      context: { rootTaskId: 'root-task', visibleThread: { messages: expect.any(Array) } } });
    expect((phase2Checkpoint as { context: object }).context).not.toHaveProperty('managementPhase');
    expect((phase2Checkpoint as { context: object }).context).not.toHaveProperty('frozenTarget');
  });

  test('Phase 3 preflight 只选择明确声明 V3 capability 的真实 Device worker', async () => {
    const harness = await createHarness({
      devices: [device('device-v2', 'profile-1'), device('device-v3', 'profile-1')],
      allowedDeviceIds: ['device-v2', 'device-v3'],
    });
    const phase2 = harness.connect('device-v2');
    const phase3 = harness.connect('device-v3');
    await phase2.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-v2' });
    await phase3.trigger(AGENT_EVENTS.device.hello, { deviceId: 'device-v3' });
    await expect(phase2.trigger(AGENT_EVENTS.managementWorker.register, phase2WorkerRegistration()))
      .resolves.toMatchObject({ ok: true });

    await expect(harness.scheduler.managementPhase3Preflight({
      teamId: 'team-1',
      placementPolicy: { placement: 'device', allowedDeviceIds: ['device-v2', 'device-v3'],
        allowServerContext: false, requireLocalModelCredentials: true },
      targetAvailable: true,
    })).resolves.toMatchObject({
      preflight: { workerAvailable: false, credentialAvailable: false },
    });

    await expect(phase3.trigger(AGENT_EVENTS.managementWorker.register, phase3WorkerRegistration()))
      .resolves.toMatchObject({ ok: true });
    await expect(harness.scheduler.managementPhase3Preflight({
      teamId: 'team-1',
      placementPolicy: { placement: 'device', allowedDeviceIds: ['device-v2', 'device-v3'],
        allowServerContext: false, requireLocalModelCredentials: true },
      targetAvailable: true,
    })).resolves.toMatchObject({
      preflight: { workerAvailable: true, credentialAvailable: true, placementAllowed: true },
      profileId: 'profile-1',
    });

    const runId = await harness.createPhase3Run();
    await expect(harness.realtime.scheduleManagementRun({ managementRunId: runId, profileId: 'profile-1' }))
      .resolves.toMatchObject({ ok: true, deviceId: 'device-v3' });
    const offer = phase3.outbound(AGENT_EVENTS.managementWorker.leaseOffer)[0]?.payload as ManagementLeaseOfferV1;
    const acquired = await phase3.trigger(AGENT_EVENTS.managementWorker.leaseAcquire, {
      schemaVersion: 1, offerId: offer.offerId, workerInstanceId: 'worker-instance-v3',
    });
    await expect(phase3.trigger(AGENT_EVENTS.managementWorker.checkpointFetch, {
      schemaVersion: 1, managementRunId: runId,
      workerId: (await phase3.trigger(AGENT_EVENTS.managementWorker.register, phase3WorkerRegistration()) as { workerId: string }).workerId,
      leaseToken: (acquired as { leaseToken: string }).leaseToken, fencingToken: 1,
    })).resolves.toMatchObject({
      managementRunId: runId,
      context: { managementPhase: 3, rootTaskId: 'root-task' },
      checkpoint: { authoritative: { memoryCapsuleIds: ['capsule-current'] } },
    });
    expect(harness.memoryCapsules.listValidMemoryCapsuleIds).toHaveBeenCalledWith({
      teamId: 'team-1', managementRunId: runId, now: 10,
    });
  });
});

function workerRegistration(overrides: Partial<ManagementWorkerRegisterV1> = {}): ManagementWorkerRegisterV1 {
  return {
    schemaVersion: 1,
    workerInstanceId: 'worker-instance-1',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1],
    supportedPhases: [1],
    credentialStatus: 'production_ready',
    providerId: 'test-provider',
    modelId: 'test-model',
    capacity: { maxConcurrentLeases: 2, activeLeaseCount: 0 },
    ...overrides,
  };
}

function unavailableWorkerRegistration(): ManagementWorkerRegisterV1 {
  return {
    schemaVersion: 1,
    workerInstanceId: 'worker-instance-unready',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1],
    supportedPhases: [1],
    credentialStatus: 'unavailable',
    capacity: { maxConcurrentLeases: 2, activeLeaseCount: 0 },
  };
}

function phase2WorkerRegistration(): ManagementWorkerRegisterV2 {
  return {
    schemaVersion: 2,
    workerInstanceId: 'worker-instance-v2',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1, 2],
    supportedPhases: [1, 2],
    credentialStatus: 'production_ready',
    providerId: 'test-provider',
    modelId: 'test-model',
    capacity: { maxConcurrentLeases: 2, activeLeaseCount: 0 },
  };
}

function phase3WorkerRegistration(): ManagementWorkerRegisterV2 {
  return {
    ...phase2WorkerRegistration(),
    workerInstanceId: 'worker-instance-v3',
    supportedPhases: [1, 2, 3],
  };
}

function device(id: string, profileId: string) {
  return {
    id,
    teamId: 'team-1',
    ownerId: 'user-1',
    status: 'online' as const,
    machineId: `machine-${id}`,
    profileId,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function createHarness(input: { devices: ReturnType<typeof device>[]; allowedDeviceIds?: string[] }) {
  const repositories = createInMemoryRepositories();
  for (const record of input.devices) await repositories.devices.upsertHello(record);
  const clock = { now: 10 };
  let kernelId = 0;
  const kernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock: { now: () => clock.now },
    ids: { nextId: () => `kernel-${++kernelId}` },
  });
  const toolHandler = vi.fn(async () => ({ status: 'running' as const, checkpointRevision: 0, lastEventSequence: 2 }));
  const executeTool = createManagementToolExecutor({
    kernel,
    managementMemoryUnitOfWork: repositories.managementMemoryUnitOfWork,
    handlers: { 'context.get_management_state': toolHandler },
  });
  let schedulerId = 0;
  let leaseId = 0;
  const memoryCapsules = {
    listValidMemoryCapsuleIds: vi.fn(async () => ['capsule-current']),
  };
  const scheduler = createDeviceWorkerScheduler({
    devices: repositories.devices,
    messages: repositories.messages,
    management: repositories.management,
    managementMemoryUnitOfWork: repositories.managementMemoryUnitOfWork,
    memoryCapsules,
    kernel,
    executeTool,
    clock: { now: () => clock.now },
    ids: { nextId: () => `scheduler-${++schedulerId}` },
    leaseTokens: { nextToken: () => `lease-secret-${++leaseId}` },
    leaseTtlMs: 100,
  });
  await repositories.messages.append({
    id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
    senderKind: 'human', senderId: 'user-1', body: '执行目标', createdAt: 1,
  });
  const run = await kernel.createOrResumeRun({
    teamId: 'team-1',
    channelId: 'channel-1',
    rootMessageId: 'message-1',
    frozenTarget: { agentId: 'agent-1', kind: 'custom' },
    requestKey: 'run-request-1',
    requestHash: 'hash-run-request-1',
    placementPolicy: {
      placement: 'device',
      allowedDeviceIds: input.allowedDeviceIds,
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  const fakeServer = new FakeServer();
  const app = {
    deviceHello: vi.fn(async (payload: { deviceId: string }) => ({
      ok: true,
      device: input.devices.find((candidate) => candidate.id === payload.deviceId),
      affectedTeamIds: [],
    })),
    buildDeviceScanRequest: vi.fn(async () => ({ ok: true, skipped: true })),
    markDeviceOffline: vi.fn(async () => ({ ok: true, affectedTeamIds: [] })),
    getDispatchRequest: vi.fn(async ({ dispatchId }: { dispatchId: string }) => ({
      ok: true,
      request: {
        id: dispatchId,
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        agentId: 'agent-1',
        deviceId: 'device-1',
        requestId: `request-${dispatchId}`,
        body: '执行目标',
        createdAt: 1,
      },
    })),
  } as unknown as ServerNextUseCases;
  const realtime = attachServerNextNamespaces(fakeServer, app, {
    dispatchRequestCoalesceMs: 0,
    managementWorkerScheduler: scheduler,
  });

  async function createRun(requestKey: string) {
    const created = await kernel.createOrResumeRun({
      teamId: 'team-1', channelId: 'channel-1', rootMessageId: `${requestKey}-message`, requestKey,
      requestHash: `hash-${requestKey}`,
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
    });
    return created.run.id;
  }

  return {
    repositories,
    clock,
    realtime,
    scheduler,
    kernel,
    runId: run.run.id,
    memoryCapsules,
    toolHandler,
    createRun,
    async createPhase2Run() {
      const created = await kernel.createOrResumeRun({
        teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', rootTaskId: 'root-task',
        requestKey: 'phase2-run-request', requestHash: 'phase2-run-hash', managementPhase: 2,
        placementPolicy: { placement: 'device', allowedDeviceIds: input.allowedDeviceIds,
          allowServerContext: false, requireLocalModelCredentials: true },
        budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
      });
      return created.run.id;
    },
    async createPhase3Run() {
      const created = await kernel.createOrResumeRun({
        teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', rootTaskId: 'root-task',
        requestKey: 'phase3-run-request', requestHash: 'phase3-run-hash', managementPhase: 3,
        placementPolicy: { placement: 'device', allowedDeviceIds: input.allowedDeviceIds,
          allowServerContext: false, requireLocalModelCredentials: true },
        budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
      });
      return created.run.id;
    },
    connect(deviceId: string) {
      const socket = new FakeSocket();
      socket.deviceId = deviceId;
      fakeServer.agent.connect(socket);
      return socket;
    },
  };
}

class FakeSocket implements SocketLike {
  private readonly handlers = new Map<string, SocketHandler>();
  private readonly outboundEvents: Array<{ event: string; payload: unknown }> = [];
  deviceId = '';
  offerAck: (payload: unknown) => Promise<unknown> = async () => ({ ok: true });

  on(event: string, handler: SocketHandler): void { this.handlers.set(event, handler); }
  emit(event: string, payload: unknown): void { this.outboundEvents.push({ event, payload }); }
  timeout(): this { return this; }
  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.outboundEvents.push({ event, payload });
    return this.offerAck(payload);
  }
  async trigger(event: string, payload: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`Missing socket handler: ${event}`);
    let ack: unknown;
    await handler(payload, (value) => { ack = value; });
    return ack;
  }
  outbound(event: string) { return this.outboundEvents.filter((entry) => entry.event === event); }
  async disconnect(): Promise<void> { await this.trigger('disconnect'); }
}

class FakeNamespace implements NamespaceLike {
  private connection?: (socket: SocketLike) => void;
  on(_event: 'connection', handler: (socket: SocketLike) => void): void { this.connection = handler; }
  connect(socket: SocketLike): void { this.connection?.(socket); }
}

class FakeServer implements SocketServerLike {
  readonly web = new FakeNamespace();
  readonly agent = new FakeNamespace();
  of(namespace: '/web' | '/agent'): FakeNamespace { return namespace === '/web' ? this.web : this.agent; }
}
