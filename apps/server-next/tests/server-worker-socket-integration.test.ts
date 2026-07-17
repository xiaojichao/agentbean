import { describe, expect, test, vi } from 'vitest';

import { AGENT_EVENTS, type ManagementWorkerRegisterV2 } from '../../../packages/contracts/src/index.js';
import { createServerWorkerPool } from '../src/application/management/server-worker-pool.js';
import type { ServerWorkerScheduler } from '../src/application/management/server-worker-scheduler.js';
import type { ServerNextUseCases } from '../src/application/usecases.js';
import { attachServerNextNamespaces, type NamespaceLike, type SocketServerLike } from '../src/transport/socket-server.js';
import type { SocketHandler, SocketLike } from '../src/transport/socket-handlers.js';

describe('trusted Server Worker socket transport', () => {
  test('fails closed for untrusted sockets and routes register, heartbeat, and disconnect for trusted sockets', async () => {
    const clock = { now: 10 };
    const pool = createServerWorkerPool({
      workerPoolId: 'pool-1',
      providerCredentialRef: 'credential-ref-1',
      clock: { now: () => clock.now },
      ids: { nextId: () => 'server-worker-1' },
    });
    const server = new FakeServer();
    const scheduler = {
      registerWorker: vi.fn(async (input) => pool.registerWorker(input)),
      acquireLease: vi.fn(async () => ({ schemaVersion: 1, ok: true, operation: 'acquire' })),
      renewLease: vi.fn(async () => ({ schemaVersion: 1, ok: true, operation: 'renew' })),
      releaseLease: vi.fn(async () => ({ schemaVersion: 1, ok: true, operation: 'release' })),
      abortLease: vi.fn(async () => ({ schemaVersion: 1, ok: true, operation: 'abort' })),
      fetchCheckpoint: vi.fn(async () => ({ schemaVersion: 1, operation: 'checkpoint' })),
      disconnect: vi.fn(() => ({ activeManagementRunIds: [] })),
    } as unknown as ServerWorkerScheduler;
    attachServerNextNamespaces(server, {} as ServerNextUseCases, {
      serverWorkerPool: pool,
      serverWorkerScheduler: scheduler,
      serverWorkerAuthToken: 'trusted-token-at-least-32-characters',
    });

    const rejected = new FakeSocket('wrong-token');
    server.serverWorker.connect(rejected);
    expect(await rejected.trigger(AGENT_EVENTS.serverWorker.register, capability()))
      .toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });

    const trusted = new FakeSocket('trusted-token-at-least-32-characters');
    server.serverWorker.connect(trusted);
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.register, capability()))
      .toMatchObject({ ok: true, workerId: 'server-worker-1' });
    clock.now = 20;
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.heartbeat, {
      workerInstanceId: 'server-instance-1', activeLeaseCount: 0,
    })).toMatchObject({ ok: true, lastHeartbeatAt: 20 });
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.leaseAcquire, {
      schemaVersion: 1, offerId: 'offer-1', workerInstanceId: 'server-instance-1',
    }))
      .toMatchObject({ ok: true, operation: 'acquire' });
    const authority = {
      schemaVersion: 1 as const,
      managementRunId: 'run-1',
      workerId: 'server-worker-1',
      leaseToken: 'lease-token-1',
      fencingToken: 1,
      idempotencyKey: 'operation-1',
    };
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.leaseRenew, authority))
      .toMatchObject({ ok: true, operation: 'renew' });
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.leaseRelease, { ...authority, reasonCode: 'COMPLETED' }))
      .toMatchObject({ ok: true, operation: 'release' });
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.abort, { ...authority, reasonCode: 'ABORTED' }))
      .toMatchObject({ ok: true, operation: 'abort' });
    const { idempotencyKey: _idempotencyKey, ...leaseProof } = authority;
    expect(await trusted.trigger(AGENT_EVENTS.serverWorker.checkpointFetch, leaseProof))
      .toMatchObject({ operation: 'checkpoint' });
    expect(scheduler.acquireLease).toHaveBeenCalledWith(expect.stringMatching(/^server-worker:/), {
      schemaVersion: 1, offerId: 'offer-1', workerInstanceId: 'server-instance-1',
    });

    for (const event of [
      AGENT_EVENTS.serverWorker.leaseAcquire,
      AGENT_EVENTS.serverWorker.leaseRenew,
      AGENT_EVENTS.serverWorker.leaseRelease,
      AGENT_EVENTS.serverWorker.abort,
      AGENT_EVENTS.serverWorker.checkpointFetch,
    ]) {
      expect(await trusted.trigger(event, null)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
        retryable: false,
      });
    }
    expect(scheduler.acquireLease).toHaveBeenCalledTimes(1);
    expect(scheduler.renewLease).toHaveBeenCalledTimes(1);
    expect(scheduler.releaseLease).toHaveBeenCalledTimes(1);
    expect(scheduler.abortLease).toHaveBeenCalledTimes(1);
    expect(scheduler.fetchCheckpoint).toHaveBeenCalledTimes(1);
    await trusted.trigger('disconnect');
    expect(scheduler.disconnect).toHaveBeenCalledOnce();

    expect(await rejected.trigger(AGENT_EVENTS.serverWorker.leaseAcquire, { offerId: 'offer-2' }))
      .toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
  });
});

function capability(): ManagementWorkerRegisterV2 {
  return {
    schemaVersion: 2,
    workerInstanceId: 'server-instance-1',
    profileId: 'profile-1',
    runtimeVersion: '0.1.0',
    supportedProtocolVersions: [1, 2],
    supportedPhases: [1, 2, 3],
    credentialStatus: 'production_ready',
    providerId: 'provider-1',
    modelId: 'model-1',
    host: { kind: 'server', workerPoolId: 'pool-1' },
    providerCredentialRef: 'credential-ref-1',
    capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
  };
}

class FakeSocket implements SocketLike {
  private readonly handlers = new Map<string, SocketHandler>();
  readonly handshake: { auth: { serverWorkerToken: string } };
  constructor(token: string) { this.handshake = { auth: { serverWorkerToken: token } }; }
  on(event: string, handler: SocketHandler): void { this.handlers.set(event, handler); }
  async trigger(event: string, payload: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`Missing socket handler: ${event}`);
    let ack: unknown;
    await handler(payload, (value) => { ack = value; });
    return ack;
  }
}

class FakeNamespace implements NamespaceLike {
  private connection?: (socket: SocketLike) => void;
  on(_event: 'connection', handler: (socket: SocketLike) => void): void { this.connection = handler; }
  connect(socket: SocketLike): void { this.connection?.(socket); }
}

class FakeServer implements SocketServerLike {
  readonly web = new FakeNamespace();
  readonly agent = new FakeNamespace();
  readonly serverWorker = new FakeNamespace();
  of(namespace: '/web' | '/agent' | '/server-worker'): FakeNamespace {
    if (namespace === '/web') return this.web;
    if (namespace === '/agent') return this.agent;
    return this.serverWorker;
  }
}
