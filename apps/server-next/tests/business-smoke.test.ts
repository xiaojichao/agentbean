import { describe, expect, test } from 'vitest';
import { runAgentBeanNextBusinessSmoke } from '../../../scripts/smoke-agentbean-next-business.mjs';
import { startServerNextDevServer } from '../src/dev-server';

const WEB_EVENTS = {
  auth: { register: 'auth:register' },
  device: { list: 'device:list' },
  agent: { subscribe: 'agents:subscribe', create: 'agent:create' },
  channel: { subscribe: 'channels:subscribe', message: 'channel:message' },
  message: { send: 'message:send' },
};

const AGENT_EVENTS = {
  device: { hello: 'device:hello', runtimes: 'device:runtimes' },
  dispatch: { request: 'dispatch:request', result: 'dispatch:result' },
};

describe('AgentBean Next business smoke', () => {
  test('runs register -> daemon -> custom agent -> message -> reply against server-next', async () => {
    const server = await startServerNextDevServer({
      messageIngestionMode: 'legacy',
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir: '.agentbean-next-test',
        sessionSecret: 'business-smoke-test-secret',
      },
    });

    try {
      const summary = await runAgentBeanNextBusinessSmoke({
        baseUrl: server.baseUrl,
        suffix: 'test',
        timeoutMs: 20_000,
      });

      expect(summary).toMatchObject({
        ok: true,
        failed: 0,
        total: 8,
      });
      expect(summary.checks.map((check) => check.id)).toEqual([
        'business-url-present',
        'business-sockets-connected',
        'business-register-login',
        'business-daemon-hello',
        'business-runtime-report',
        'business-custom-agent-create',
        'business-message-dispatch',
        'business-agent-reply-visible',
      ]);
    } finally {
      await server.close();
    }
  }, 25_000);

  test('reports a missing target URL without connecting sockets', async () => {
    const summary = await runAgentBeanNextBusinessSmoke();

    expect(summary).toEqual({
      ok: false,
      total: 1,
      failed: 1,
      checks: [
        {
          id: 'business-url-present',
          ok: false,
          message: 'AgentBean Next business smoke needs --url or AGENTBEAN_NEXT_ENTRY_URL',
        },
      ],
    });
  });

  test('waits for the synthetic daemon dispatch result before disconnecting sockets', async () => {
    const webSocket = new FakeSocket('web');
    const agentSocket = new FakeSocket('agent');
    const ioFactory = (url: string) => url.endsWith('/web') ? webSocket : agentSocket;

    webSocket.acks.set(WEB_EVENTS.auth.register, {
      ok: true,
      user: { id: 'user-1' },
      currentTeam: { id: 'team-1' },
      defaultChannel: { id: 'channel-1' },
    });
    webSocket.acks.set(WEB_EVENTS.channel.subscribe, { ok: true });
    webSocket.acks.set(WEB_EVENTS.agent.subscribe, { ok: true });
    webSocket.acks.set(WEB_EVENTS.device.list, { ok: true });
    webSocket.acks.set(WEB_EVENTS.agent.create, { ok: true, agent: { id: 'agent-1' } });
    webSocket.acks.set(WEB_EVENTS.message.send, () => {
      setTimeout(() => {
        agentSocket.trigger(AGENT_EVENTS.dispatch.request, {
          id: 'dispatch-1',
          agentId: 'agent-1',
          prompt: '@SmokeCodextest hello',
        });
      }, 0);
      return {
        ok: true,
        dispatches: [{ id: 'dispatch-1' }],
      };
    });
    agentSocket.acks.set(AGENT_EVENTS.device.hello, { ok: true, device: { id: 'device-1' } });
    agentSocket.acks.set(AGENT_EVENTS.device.runtimes, { ok: true, runtimes: [{ id: 'runtime-1' }] });
    agentSocket.acks.set(AGENT_EVENTS.dispatch.result, () => new Promise((resolve, reject) => {
      setTimeout(() => {
        webSocket.trigger(WEB_EVENTS.channel.message, {
          channelId: 'channel-1',
          body: 'business-smoke:@SmokeCodextest hello',
        });
        setTimeout(() => {
          if (agentSocket.disconnected) {
            reject(new Error('socket has been disconnected'));
            return;
          }
          resolve({ ok: true });
        }, 0);
      }, 0);
    }));

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const summary = await runAgentBeanNextBusinessSmoke({
        baseUrl: 'https://example.test',
        ioFactory,
        suffix: 'test',
        timeoutMs: 1_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(summary.ok).toBe(true);
      expect(unhandled).toEqual([]);
      expect(agentSocket.emits).toContain(AGENT_EVENTS.dispatch.result);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

class FakeSocket {
  readonly handlers = new Map<string, Array<(payload?: unknown) => void>>();
  readonly acks = new Map<string, unknown>();
  readonly emits: string[] = [];
  disconnected = false;

  constructor(readonly kind: 'web' | 'agent') {}

  connect(): void {
    queueMicrotask(() => this.trigger('connect'));
  }

  disconnect(): void {
    this.disconnected = true;
  }

  on(event: string, handler: (payload?: unknown) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (payload?: unknown) => void): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
    );
  }

  timeout(): this {
    return this;
  }

  async emitWithAck(event: string, payload?: unknown): Promise<unknown> {
    this.emits.push(event);
    const ack = this.acks.get(event);
    if (typeof ack === 'function') {
      return (ack as (payload?: unknown) => unknown)(payload);
    }
    return ack;
  }

  trigger(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }
}
