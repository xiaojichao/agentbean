import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import {
  createDaemonProtocolClient,
  type DaemonDeviceConfig,
  type DaemonDispatchResult,
  type DispatchRequestPayload,
  type DaemonProtocolSocket,
  type StubExecutor,
} from '../src/index';

describe('daemon-next protocol client', () => {
  test('announces device, runtimes, agents, and returns stub dispatch results', async () => {
    const socket = new FakeAgentSocket();
    const executor: StubExecutor = async (request) => `stub:${request.prompt}`;
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();

    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default', protocolCapabilities: { dispatchClaim: true } }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
    ]);

    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });

    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.result,
        { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'stub:hello' },
      ]);
    });
  });

  test('beginDrain rejects new dispatch and waits for active execution plus outbox delivery', async () => {
    const socket = new FakeAgentSocket();
    let finishExecution: (() => void) | undefined;
    const executor = vi.fn<StubExecutor>(async () => {
      await new Promise<void>((resolve) => { finishExecution = resolve; });
      return 'done';
    });
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });
    await client.start();
    const first = socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', requestId: 'request-1', prompt: 'first',
    });
    await vi.waitFor(() => expect(client.activeWorkCount()).toBe(1));

    const draining = client.beginDrain(1000);
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2',
      agentId: 'agent-2', requestId: 'request-2', prompt: 'second',
    });
    expect(executor).toHaveBeenCalledTimes(1);
    finishExecution?.();
    await first;
    await draining;

    expect(client.activeWorkCount()).toBe(0);
    expect(client.outboxPendingCount()).toBe(0);
  });

  test('stop cancels an in-flight dispatch drain loop', async () => {
    const socket = new FakeAgentSocket();
    let finishExecution: (() => void) | undefined;
    const client = createDaemonProtocolClient({
      socket,
      executor: vi.fn(async () => new Promise<string>((resolve) => { finishExecution = () => resolve('done'); })),
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [], agents: [],
    });
    await client.start();
    const executing = socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', requestId: 'request-1', prompt: 'first',
    });
    await vi.waitFor(() => expect(client.activeWorkCount()).toBe(1));
    const draining = client.beginDrain(60_000);
    client.stop();
    await expect(draining).resolves.toBeUndefined();
    finishExecution?.();
    await executing;
  });

  test('retries a claim-required wake and executes only the accepted request snapshot', async () => {
    const socket = new FakeAgentSocket();
    socket.dispatchAcceptedAcks.push(
      { ok: true, ready: false, retryAfterMs: 250 },
      {
        ok: true,
        ready: true,
        dispatch: { id: 'dispatch-1', status: 'accepted' },
        request: {
          id: 'dispatch-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          messageId: 'message-1',
          agentId: 'agent-1',
          requestId: 'request-1',
          prompt: 'first\n\nsecond\n\nthird',
        },
      },
    );
    const executor = vi.fn<StubExecutor>(async (request) => `stub:${request.prompt}`);
    const sleep = vi.fn(async () => undefined);
    const client = createDaemonProtocolClient({
      socket,
      executor,
      sleep,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'wake-only',
      claimRequired: true,
    });

    expect(sleep).toHaveBeenCalledWith(250);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dispatch-1',
      prompt: 'first\n\nsecond\n\nthird',
    }));
    expect(socket.emitted.filter(([event]) => event === AGENT_EVENTS.dispatch.accepted)).toEqual([
      [AGENT_EVENTS.dispatch.accepted, { dispatchId: 'dispatch-1', agentId: 'agent-1' }],
      [AGENT_EVENTS.dispatch.accepted, { dispatchId: 'dispatch-1', agentId: 'agent-1' }],
    ]);
    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.result,
      { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'stub:first\n\nsecond\n\nthird' },
    ]);
  });

  test('keeps same-agent follow-ups queued until the active executor actually stops after cancellation', async () => {
    const socket = new FakeAgentSocket();
    const executionOrder: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor: StubExecutor = async (request) => {
      executionOrder.push(`start:${request.id}`);
      if (request.id === 'dispatch-1') {
        await firstCanFinish;
      }
      executionOrder.push(`end:${request.id}`);
      return `stub:${request.prompt}`;
    };
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });
    const request = (id: string, prompt: string): DispatchRequestPayload => ({
      id,
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: `message-${id}`,
      agentId: 'agent-1',
      requestId: `request-${id}`,
      prompt,
    });

    await client.start();
    const first = socket.trigger(AGENT_EVENTS.dispatch.request, request('dispatch-1', 'first'));
    await vi.waitFor(() => expect(executionOrder).toEqual(['start:dispatch-1']));
    const second = socket.trigger(AGENT_EVENTS.dispatch.request, request('dispatch-2', 'second'));
    await socket.trigger(AGENT_EVENTS.dispatch.cancel, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(executionOrder).toEqual(['start:dispatch-1']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(executionOrder).toEqual([
      'start:dispatch-1',
      'end:dispatch-1',
      'start:dispatch-2',
      'end:dispatch-2',
    ]);
    expect(socket.emitted.some(([event, payload]) =>
      event === AGENT_EVENTS.dispatch.result &&
      (payload as { dispatchId?: string }).dispatchId === 'dispatch-1'
    )).toBe(false);
  });

  test('stops claim retries when the dispatch is cancelled during the quiet window', async () => {
    const socket = new FakeAgentSocket();
    socket.dispatchAcceptedAcks.push({ ok: true, ready: false, retryAfterMs: 250 });
    const executor = vi.fn<StubExecutor>(async () => 'should not run');
    const client = createDaemonProtocolClient({
      socket,
      executor,
      sleep: async () => {
        await socket.trigger(AGENT_EVENTS.dispatch.cancel, {
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
        });
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'wake-only',
      claimRequired: true,
    });

    expect(executor).not.toHaveBeenCalled();
    expect(socket.emitted.filter(([event]) => event === AGENT_EVENTS.dispatch.accepted)).toHaveLength(1);
    expect(socket.emitted.some(([event]) =>
      event === AGENT_EVENTS.dispatch.result || event === AGENT_EVENTS.dispatch.error
    )).toBe(false);
  });

  test('forwards structured executor workspace run metadata with dispatch results', async () => {
    const socket = new FakeAgentSocket();
    const executor: StubExecutor = async (request): Promise<DaemonDispatchResult> => ({
      body: `stub:${request.prompt}`,
      artifacts: [
        {
          id: 'workspace-log-dispatch-1',
          filename: 'workspace-run.log',
          mimeType: 'text/plain',
          relativePath: 'logs/workspace-run.log',
          pathKind: 'workspace',
          contentBase64: Buffer.from('stdout:\nhello').toString('base64'),
        },
      ],
      workspaceRun: {
        status: 'succeeded',
        cwd: '/workspace',
        command: 'codex --model gpt-5.4',
        logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
        exitCode: 0,
        startedAt: 1000,
        completedAt: 1010,
      },
    });
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });

    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.result,
        {
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          body: 'stub:hello',
          artifacts: [
            {
              id: 'workspace-log-dispatch-1',
              filename: 'workspace-run.log',
              mimeType: 'text/plain',
              relativePath: 'logs/workspace-run.log',
              pathKind: 'workspace',
              contentBase64: Buffer.from('stdout:\nhello').toString('base64'),
            },
          ],
          workspaceRun: {
            status: 'succeeded',
            cwd: '/workspace',
            command: 'codex --model gpt-5.4',
            logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
            exitCode: 0,
            startedAt: 1000,
            completedAt: 1010,
          },
        },
      ]);
    });
  });

  test('re-announces device, runtimes, and agents after reconnect', async () => {
    const socket = new FakeAgentSocket();
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();
    await socket.triggerReconnect();

    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default', protocolCapabilities: { dispatchClaim: true } }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default', protocolCapabilities: { dispatchClaim: true } }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-2', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-2', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
    ]);
  });

  test('reconnect uses the latest successful scan snapshot', async () => {
    const socket = new FakeAgentSocket();
    const latest = {
      runtimes: [{ adapterKind: 'claude-code', name: 'Claude Code' }],
      agents: [{ name: 'Claude', adapterKind: 'claude-code', category: 'executor-hosted' as const }],
    };
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      scan: async () => latest,
    });

    await client.start();
    await vi.waitFor(() => expect(socket.emitted).toContainEqual([
      AGENT_EVENTS.agent.registerBatch,
      { teamId: 'team-1', deviceId: 'device-1', agents: latest.agents },
    ]));
    await socket.triggerReconnect();

    expect(socket.emitted.slice(-2)).toEqual([
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-2', runtimes: latest.runtimes }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-2', agents: latest.agents }],
    ]);
    client.stop?.();
  });

  test('uses refreshed device credentials from hello acknowledgements for env resolution', async () => {
    const socket = new FakeAgentSocket();
    socket.helloAcks.push({
      ok: true,
      device: { id: 'device-1' },
      credentials: { token: 'fresh-device-token' },
    });
    const device: DaemonDeviceConfig = { teamId: 'team-1', ownerId: 'user-1' };
    const resolvedTokens: string[] = [];
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => 'ok',
      device,
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      envResolver: async () => {
        resolvedTokens.push(device.token ?? '');
        return { SECRET_TOKEN: 'secret-value' };
      },
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(resolvedTokens).toEqual(['fresh-device-token']);
  });

  test('reports refreshed device credentials from initial hello and reconnect acknowledgements', async () => {
    const socket = new FakeAgentSocket();
    socket.helloAcks.push(
      {
        ok: true,
        device: { id: 'device-1' },
        credentials: { token: 'fresh-token-1', teamId: 'team-1', ownerId: 'user-1' },
      },
      {
        ok: true,
        device: { id: 'device-1' },
        credentials: { token: 'fresh-token-2', teamId: 'team-1', ownerId: 'user-2' },
      },
    );
    const onCredentialsChanged = vi.fn();
    const device: DaemonDeviceConfig = { teamId: 'team-1', ownerId: 'user-1', token: 'stale-token' };
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => 'ok',
      device,
      runtimes: [],
      agents: [],
      onCredentialsChanged,
    });

    await client.start();
    await socket.triggerReconnect();

    expect(onCredentialsChanged).toHaveBeenNthCalledWith(1, {
      token: 'fresh-token-1',
      teamId: 'team-1',
      ownerId: 'user-1',
    });
    expect(onCredentialsChanged).toHaveBeenNthCalledWith(2, {
      token: 'fresh-token-2',
      teamId: 'team-1',
      ownerId: 'user-2',
    });
    expect(device.token).toBe('fresh-token-2');
  });

  test('keeps refreshed credentials and latest scan snapshot across the reconnect lifecycle', async () => {
    const socket = new FakeAgentSocket();
    socket.helloAcks.push(
      {
        ok: true,
        device: { id: 'device-stable' },
        credentials: { token: 'fresh-token-1', teamId: 'team-1', ownerId: 'user-1' },
      },
      {
        ok: true,
        device: { id: 'device-stable' },
        credentials: { token: 'fresh-token-2', teamId: 'team-1', ownerId: 'user-1' },
      },
    );
    const latest = {
      runtimes: [{ adapterKind: 'agentos-gateway', name: 'AgentOS Gateway' }],
      agents: [{
        name: 'AgentOS Hosted',
        adapterKind: 'agentos-gateway',
        category: 'agentos-hosted' as const,
        discoverySource: 'gateway' as const,
        gatewayInstanceKey: 'agentos://stable',
      }],
    };
    const device: DaemonDeviceConfig = {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      token: 'stale-invite-token',
    };
    const onCredentialsChanged = vi.fn();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => 'ok',
      device,
      runtimes: [{ adapterKind: 'codex-cli', name: 'Bootstrap Codex' }],
      agents: [{ name: 'Bootstrap Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      scan: async () => latest,
      onCredentialsChanged,
      rescanIntervalMs: 60000,
    });

    await client.start();
    await vi.waitFor(() => expect(socket.emitted).toContainEqual([
      AGENT_EVENTS.agent.registerBatch,
      { teamId: 'team-1', deviceId: 'device-stable', agents: latest.agents },
    ]));

    await socket.triggerReconnect();

    expect(socket.helloPayloads).toEqual([
      {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
        token: 'stale-invite-token',
        protocolCapabilities: { dispatchClaim: true },
      },
      {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
        token: 'fresh-token-1',
        protocolCapabilities: { dispatchClaim: true },
      },
    ]);
    expect(socket.emitted.slice(-2)).toEqual([
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-stable', runtimes: latest.runtimes }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-stable', agents: latest.agents }],
    ]);
    expect(onCredentialsChanged).toHaveBeenCalledTimes(2);
    expect(device.token).toBe('fresh-token-2');
    client.stop?.();
  });

  test('handles targeted scan requests by reporting fresh runtimes and agents', async () => {
    const socket = new FakeAgentSocket();
    let scanCount = 0;
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      scan: async () => {
        scanCount += 1;
        return {
          runtimes: [{ adapterKind: 'claude-code', name: 'Claude Code' }],
          agents: [{ name: 'Claude', adapterKind: 'claude-code', category: 'executor-hosted' }],
        };
      },
      rescanIntervalMs: 60000,
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.device.scanRequested, {
      requestId: 'scan-1',
      deviceId: 'device-1',
    });

    // Background rescan tick (started in start()) runs scan once, plus this explicit request.
    expect(scanCount).toBeGreaterThanOrEqual(1);
    expect(socket.emitted.slice(-2)).toEqual([
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'claude-code', name: 'Claude Code' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Claude', adapterKind: 'claude-code', category: 'executor-hosted' }] }],
    ]);
    client.stop?.();
  });

  test('ignores scan requests for a different device id', async () => {
    const socket = new FakeAgentSocket();
    let scanCount = 0;
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      scan: async () => {
        scanCount += 1;
        return {
          runtimes: [],
          agents: [],
        };
      },
      rescanIntervalMs: 60000,
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.device.scanRequested, {
      requestId: 'scan-1',
      deviceId: 'other-device',
    });

    // Background rescan tick runs scan once on start (reporting empty snapshot);
    // the explicit request targets another device, so it is ignored.
    expect(scanCount).toBe(1);
    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', protocolCapabilities: { dispatchClaim: true } }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [] }],
    ]);
    client.stop?.();
  });

  test('reports dispatch errors without swallowing executor failures', async () => {
    const socket = new FakeAgentSocket();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => {
        throw new Error('executor failed');
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });

    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.error,
        { dispatchId: 'dispatch-1', agentId: 'agent-1', error: 'executor failed' },
      ]);
    });
  });

  test('resolves custom agent env references before executing a dispatch', async () => {
    const socket = new FakeAgentSocket();
    const received: DispatchRequestPayload[] = [];
    const resolvedRefs: unknown[] = [];
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => {
        received.push(request);
        return 'ok';
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      envResolver: async (envRef) => {
        resolvedRefs.push(envRef);
        return { SECRET_TOKEN: 'secret-value' };
      },
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(resolvedRefs).toEqual([{ agentId: 'agent-1', teamId: 'team-1' }]);
    expect(received[0]?.customAgent).toMatchObject({
      command: 'codex',
      env: { SECRET_TOKEN: 'secret-value' },
      envRef: { agentId: 'agent-1', teamId: 'team-1' },
    });
    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.result,
        { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'ok' },
      ]);
    });
  });

  test('merges resolved custom agent env with workspace env before executing', async () => {
    const socket = new FakeAgentSocket();
    const received: DispatchRequestPayload[] = [];
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'proto-envref-workspace-')));
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => {
        received.push(request);
        return 'ok';
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      serverUrl: 'http://server.test',
      envResolver: async () => ({ SECRET_TOKEN: 'secret-value' }),
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        cwd,
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(received[0]?.customAgent?.env).toEqual({
      AGENTBEAN_RUN_ID: 'dispatch-1',
      AGENTBEAN_WORKSPACE: `${cwd}/.agentbean/runs/dispatch-1`,
      AGENTBEAN_INPUT_DIR: `${cwd}/.agentbean/runs/dispatch-1/inputs`,
      AGENTBEAN_OUTPUT_DIR: `${cwd}/.agentbean/runs/dispatch-1/outputs`,
      SECRET_TOKEN: 'secret-value',
    });
  });

  test('reports a dispatch error when an env reference cannot be resolved locally', async () => {
    const socket = new FakeAgentSocket();
    const executor = vi.fn(async () => 'ok');
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(executor).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.error,
        {
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          error: 'Custom agent env resolver is not configured',
        },
      ]);
    });
  });

  test('does not execute a dispatch cancelled while env resolution is pending', async () => {
    const socket = new FakeAgentSocket();
    const executor = vi.fn(async () => 'ok');
    let resolveEnv: ((env: Record<string, string>) => void) | undefined;
    let envStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      envStarted = resolve;
    });
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      envResolver: async () => {
        envStarted();
        return new Promise((envResolve) => {
          resolveEnv = envResolve;
        });
      },
    });

    await client.start();
    const running = socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });
    await started;
    await socket.trigger(AGENT_EVENTS.dispatch.cancel, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    });
    resolveEnv?.({ SECRET_TOKEN: 'secret-value' });
    await running;

    expect(executor).not.toHaveBeenCalled();
    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.dispatch.result)).toBe(false);
    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.dispatch.error)).toBe(false);
  });

  test('ignores dispatch results after a cancel request', async () => {
    const socket = new FakeAgentSocket();
    let resolveExecutor: ((body: string) => void) | undefined;
    let executorStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      executorStarted = resolve;
    });
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => {
        executorStarted?.();
        return new Promise<string>((resolve) => {
          resolveExecutor = resolve;
        });
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    const running = socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });
    await started;
    await socket.trigger(AGENT_EVENTS.dispatch.cancel, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    });
    resolveExecutor?.('late result');
    await running;

    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.dispatch.result)).toBe(false);
  });

  test('passes raw custom agent env only inside selected dispatch request', async () => {
    const socket = new FakeAgentSocket();
    const received: DispatchRequestPayload[] = [];
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'proto-env-')));
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => {
        received.push(request);
        return 'ok';
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();

    const announcePayloads = socket.emitted.map(([, payload]) => JSON.stringify(payload));
    expect(announcePayloads.join('\n')).not.toContain('SECRET_TOKEN');

    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        args: ['--model', 'gpt-5.4'],
        cwd,
        env: { SECRET_TOKEN: 'secret-value' },
      },
    });

    // The user's secret env reaches the executor merged with the per-run workspace env.
    expect(received[0]?.customAgent?.env).toEqual({
      AGENTBEAN_RUN_ID: 'dispatch-1',
      AGENTBEAN_WORKSPACE: `${cwd}/.agentbean/runs/dispatch-1`,
      AGENTBEAN_INPUT_DIR: `${cwd}/.agentbean/runs/dispatch-1/inputs`,
      AGENTBEAN_OUTPUT_DIR: `${cwd}/.agentbean/runs/dispatch-1/outputs`,
      SECRET_TOKEN: 'secret-value',
    });
    await vi.waitFor(() => {
      expect(socket.emitted.at(-1)).toEqual([
        AGENT_EVENTS.dispatch.result,
        { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'ok' },
      ]);
    });
  });

  test('invokes onDeviceRemoved when the server notifies the device was removed', async () => {
    const socket = new FakeAgentSocket();
    const onDeviceRemoved = vi.fn();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => '',
      device: { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' },
      runtimes: [],
      agents: [],
      onDeviceRemoved,
    });

    await client.start();

    await socket.trigger(AGENT_EVENTS.device.removed, { deviceId: 'device-1' });

    // 收到 device:removed → 上抛 onDeviceRemoved，由 cli 层负责关重连+退出进程。
    expect(onDeviceRemoved).toHaveBeenCalledTimes(1);
  });
});

class FakeAgentSocket implements DaemonProtocolSocket {
  readonly emitted: Array<[string, unknown]> = [];
  readonly helloPayloads: unknown[] = [];
  readonly helloAcks: unknown[] = [];
  readonly dispatchAcceptedAcks: unknown[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();
  private reconnectHandler: (() => Promise<void>) | undefined;
  private deviceCounter = 0;

  get connected(): boolean { return true; }

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    if (event === AGENT_EVENTS.device.hello) {
      this.helloPayloads.push(JSON.parse(JSON.stringify(payload)));
      const ack = this.helloAcks.shift();
      if (ack) {
        return ack;
      }
      this.deviceCounter += 1;
      return { ok: true, device: { id: `device-${this.deviceCounter}` } };
    }
    if (event === AGENT_EVENTS.dispatch.accepted) {
      return this.dispatchAcceptedAcks.shift() ?? { ok: false, error: 'NO_CLAIM_ACK' };
    }
    return { ok: true };
  }

  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  async trigger(event: string, payload: unknown, ack?: (result: unknown) => void): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    await handler(payload, ack);
  }

  async triggerReconnect(): Promise<void> {
    if (!this.reconnectHandler) {
      throw new Error('No reconnect handler');
    }
    await this.reconnectHandler();
  }
}
