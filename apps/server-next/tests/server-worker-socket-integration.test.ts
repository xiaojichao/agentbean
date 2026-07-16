import { describe, expect, test } from 'vitest';

import { AGENT_EVENTS, type ManagementWorkerRegisterV2 } from '../../../packages/contracts/src/index.js';
import { createServerWorkerPool } from '../src/application/management/server-worker-pool.js';
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
    attachServerNextNamespaces(server, {} as ServerNextUseCases, {
      serverWorkerPool: pool,
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
    await trusted.trigger('disconnect');
    expect(pool.snapshot().workers).toMatchObject([{ connected: false }]);
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
