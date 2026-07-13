import { describe, expect, test, vi } from 'vitest';
import {
  AGENT_EVENTS,
  type ManagementLeaseOfferV1,
  type ManagementWorkerRegisterV1,
} from '../../../packages/contracts/src/index.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementToolExecutor } from '../src/application/management/management-tool-executor.js';
import { createDeviceWorkerScheduler } from '../src/application/management/device-worker-scheduler.js';
import type { ServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { attachServerNextNamespaces, type NamespaceLike, type SocketServerLike } from '../src/transport/socket-server.js';
import type { SocketHandler, SocketLike } from '../src/transport/socket-handlers.js';

describe('management worker socket integration', () => {
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
    handlers: { 'context.get_management_state': toolHandler },
  });
  let schedulerId = 0;
  let leaseId = 0;
  const scheduler = createDeviceWorkerScheduler({
    devices: repositories.devices,
    management: repositories.management,
    kernel,
    executeTool,
    clock: { now: () => clock.now },
    ids: { nextId: () => `scheduler-${++schedulerId}` },
    leaseTokens: { nextToken: () => `lease-secret-${++leaseId}` },
    leaseTtlMs: 100,
  });
  const run = await kernel.createOrResumeRun({
    teamId: 'team-1',
    channelId: 'channel-1',
    rootMessageId: 'message-1',
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
    runId: run.run.id,
    toolHandler,
    createRun,
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
