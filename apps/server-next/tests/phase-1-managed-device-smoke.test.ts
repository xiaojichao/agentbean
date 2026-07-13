import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ManagementRuntimeFactory, ManagementSession } from '@agentbean/pi-management-runtime';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createDaemonProtocolClient,
  createDeviceServiceCore,
  createManagementDurableOutbox,
  createPiManagerWorkerHost,
  type DaemonProtocolSocket,
} from '../../daemon-next/src/index.js';
import { createManagementWorkerProtocol } from '../../daemon-next/src/management-worker-protocol.js';
import { createWebSocketClient, type WebSocketTransport } from '../../web-next/src/index.js';
import { startServerNextDevServer } from '../src/dev-server.js';

type ClientSocket = WebSocketTransport & DaemonProtocolSocket & {
  connect(): void;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('Phase 1 managed 真实 Device smoke', () => {
  test('通过真实 Socket、DeviceServiceCore、WorkerHost 和 custom Agent 完成一次 managed 调用', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-phase1-managed-device-'));
    cleanups.push(async () => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServerNextDevServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir,
        sessionSecret: 'phase-1-managed-device-smoke',
        webEntry: 'preview',
      },
      dispatchTimeout: { timeoutMs: 10_000, intervalMs: 100 },
    });
    cleanups.push(async () => {
      await withTimeout(server.close(), 2_000, 'SERVER_CLOSE_TIMEOUT').catch(() => undefined);
    });

    const webSocket = await connectClient(`${server.baseUrl}/web`);
    const agentSocket = await connectClient(`${server.baseUrl}/agent`);
    cleanups.push(async () => {
      webSocket.disconnect();
      agentSocket.disconnect();
    });
    const web = createWebSocketClient(webSocket);
    const registered = await web.register({ username: 'owner', password: 'secret', teamName: 'Team' }) as {
      user: { id: string };
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };
    const teamId = registered.currentTeam.id;
    const userId = registered.user.id;
    const channelId = registered.defaultChannel.id;

    const hello = await agentSocket.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId,
      ownerId: userId,
      machineId: 'phase-1-managed-device',
      profileId: 'default',
    }) as { device: { id: string } };
    const deviceId = hello.device.id;
    const reported = await agentSocket.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId,
      deviceId,
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
    }) as { runtimes: Array<{ id: string }> };
    const runtimeId = reported.runtimes[0]!.id;
    const created = await web.createAgent({
      userId,
      teamId,
      deviceId,
      runtimeId,
      name: 'Codex',
      env: { TEST_TOKEN: 'device-local-secret' },
    }) as { agent: { id: string } };

    const dispatchClient = createDaemonProtocolClient({
      socket: agentSocket,
      executor: async (request) => `managed-device:${request.prompt}`,
      device: {
        teamId,
        ownerId: userId,
        machineId: 'phase-1-managed-device',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [],
      envResolver: async () => ({ TEST_TOKEN: 'device-local-secret' }),
    });
    const protocol = createManagementWorkerProtocol({
      socket: agentSocket,
      workerInstanceId: 'phase-1-live-worker',
      profileId: 'default',
      runtimeVersion: '0.1.0',
      ackTimeoutMs: 5_000,
      toolAckTimeoutMs: 10_000,
    });
    const outbox = await createManagementDurableOutbox({ profileId: 'default', baseDir: dataDir });
    const toolResults: unknown[] = [];
    const managementWorkerHost = createPiManagerWorkerHost({
      profileId: 'default',
      runtimeVersion: '0.1.0',
      protocol,
      credentialProvider: {
        resolve: async () => ({
          credentialStatus: 'production_ready',
          providerId: 'smoke-provider',
          modelId: 'smoke-model',
          apiKey: 'device-local-model-secret',
        }),
      },
      outbox,
      createRuntimeFactory: ({ toolExecutor }): ManagementRuntimeFactory => ({
        async createSession({ context }) {
          const session: ManagementSession = {
            async prompt() {
              const result = await toolExecutor({
                toolCallId: 'live-invoke-1',
                name: 'agents.invoke',
                scope: context.scope,
                input: { objective: '真实 Device smoke', attachmentIds: [] },
                metadata: { name: 'agents.invoke', effect: 'write', phase: 1, inputSchemaVersion: 1 },
              });
              toolResults.push(result);
              if (result.isError) throw new Error(result.content);
            },
            async steer() {},
            async followUp() {},
            async compact() { return { compacted: false, reason: 'not_needed' }; },
            async abort() {},
            async waitForIdle() {},
            subscribe() { return () => undefined; },
            async dispose() {},
          };
          return session;
        },
      }),
    });
    const deviceService = createDeviceServiceCore({ dispatchClient, managementWorkerHost });
    await deviceService.start();
    cleanups.push(async () => {
      await withTimeout(deviceService.stop(), 2_000, 'DEVICE_SERVICE_STOP_TIMEOUT').catch(() => undefined);
    });

    const updatedPolicy = await withTimeout(webSocket.emitWithAck(WEB_EVENTS.managementPolicy.update, {
      userId,
      teamId,
      mode: 'managed',
      placementPolicy: {
        placement: 'device',
        allowedDeviceIds: [deviceId],
        allowServerContext: false,
        requireLocalModelCredentials: true,
      },
    }), 3_000, 'MANAGEMENT_POLICY_UPDATE_TIMEOUT');
    expect(updatedPolicy).toMatchObject({ ok: true, policy: { mode: 'managed' } });
    const channelMessages: Array<{ senderKind: string; senderId: string; body: string }> = [];
    web.onChannelMessage((message) => channelMessages.push(message));
    await web.subscribeChannels({ userId, teamId }, () => undefined);

    const sent = await withTimeout(web.sendMessage({
      userId,
      teamId,
      channelId,
      body: '@Codex 请处理',
      clientMessageId: 'phase-1-managed-device-message',
    }), 5_000, 'MANAGED_DEVICE_SEND_TIMEOUT');
    expect(sent).toMatchObject({
      ok: true,
      management: { mode: 'managed', disposition: 'created' },
    });

    await eventually(async () => {
      expect(channelMessages).toMatchObject([
        { senderKind: 'human', body: '@Codex 请处理' },
        { senderKind: 'agent', senderId: created.agent.id, body: 'managed-device:@Codex 请处理' },
      ]);
    });
    await eventually(async () => {
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).not.toMatchObject({ isError: true });
      expect(toolResults[0]).toMatchObject({ text: expect.stringContaining('"status":"succeeded"') });
      expect(outbox.size()).toBe(0);
      expect(managementWorkerHost.activeLeaseCount()).toBe(0);
    });
  }, 20_000);
});

async function connectClient(url: string): Promise<ClientSocket> {
  const socket = createClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
    socket.connect();
  });
  return socket;
}

async function eventually(assertion: () => Promise<void>, attempts = 100): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
