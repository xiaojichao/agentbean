import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppHandle } from '../src/index.js';
import { io as ioClient } from 'socket.io-client';
import { AddressInfo } from 'node:net';

let app: AppHandle;
let baseUrl: string;

beforeEach(async () => {
  process.env.AGENT_BEAN_AGENT_TOKEN = 'default:default:tok';
  process.env.AGENT_BEAN_WEB_TOKEN = 'web-only-token';
  app = await buildApp({ dbPath: ':memory:', globalDbPath: ':memory:', agentToken: 'default:default:tok' });
  await new Promise<void>((r) => app.http.listen(0, r));
  const port = (app.http.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}`;
});

afterEach(async () => { await app.close(); });

describe('/web namespace', () => {
  it('emits empty snapshot when no agents are registered', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const snap = await new Promise<any[]>((resolve) => {
      web.emit('agents:subscribe', {});
      web.on('agents:snapshot', resolve);
    });
    expect(snap).toEqual([]);
    web.close();
  });

  it('emits agent:status when a daemon registers', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const got = new Promise<any>((resolve) => web.on('agent:status', resolve));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd1',
        networkId: 'default',
        agents: [{ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', category: 'agentos-hosted', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const status = await got;
    expect(status.id).toBe('a1');
    expect(status.status).toBe('online');

    ag.close(); web.close();
  });
});

describe('message:send', () => {
  it('rejects empty bodies', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const res = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: 'c', body: '   ', clientMsgId: 'x' }, resolve);
    });
    expect(res).toEqual({ ok: false, error: 'EMPTY' });
    web.close();
  });

  it('persists the human message and dispatches to the first online member', async () => {
    const local = await buildApp({ dbPath: ':memory:', globalDbPath: ':memory:', agentToken: 'default:default:tok' });
    await new Promise<void>((r) => local.http.listen(0, r));
    const port = (local.http.address() as AddressInfo).port;
    const lbase = `http://localhost:${port}`;

    const ag = ioClient(`${lbase}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd1',
        networkId: 'default',
        agents: [{ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', category: 'agentos-hosted', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    ag.on('dispatch', (req: any) => {
      if (req.prompt.includes('自我介绍')) {
        ag.emit('reply', { agentId: 'a1', channelId: req.channelId, body: 'hi I am A1', requestId: req.requestId });
        return;
      }
      ag.emit('reply', { agentId: 'a1', channelId: req.channelId, body: 'echo: ' + req.prompt, requestId: req.requestId });
    });

    const web = ioClient(`${lbase}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const ch = await new Promise<any>((resolve) => {
      web.emit('channel:create', { name: 'demo', agentIds: ['a1'] }, resolve);
    });
    expect(ch.ok).toBe(true);

    const messages: any[] = [];
    web.emit('channel:join', { channelId: ch.channel.id });
    web.on('channel:message', (m: any) => messages.push(m));
    await new Promise((r) => setTimeout(r, 200));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', {
        channelId: ch.channel.id, body: 'hello', clientMsgId: 'cli-1',
      }, resolve);
    });
    expect(ack.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const human = messages.find((m) => m.senderKind === 'human');
    const reply = messages.find((m) => m.senderKind === 'agent' && m.body.startsWith('echo'));
    expect(human?.body).toBe('hello');
    expect(reply).toBeTruthy();

    ag.close(); web.close();
    await local.close();
  });
});

describe('agent:create with publishedNetworkIds', () => {
  it('creates agent and registers in registry', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const createRes = await new Promise<any>((resolve) => {
      web.emit('agent:create', {
        name: 'My Custom Agent',
        adapterKind: 'claude-code',
        command: 'echo hello',
        category: 'executor-hosted',
      }, resolve);
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.agent.name).toBe('My-Custom-Agent');
    expect(createRes.agent.source).toBe('custom');

    const snap = await new Promise<any[]>((resolve) => {
      web.on('agents:snapshot', resolve);
      web.emit('agents:subscribe', {});
    });
    const found = snap.find((a: any) => a.id === createRes.agent.id);
    expect(found).toBeTruthy();
    expect(found.name).toBe('My-Custom-Agent');
    expect(found.source).toBe('custom');

    web.close();
  });

  it('creates agent with publishedNetworkIds and auto-publishes', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));

    // Create a local network (user is auto-added as owner)
    const netRes = await new Promise<any>((resolve) => {
      web.emit('network:create', { name: 'TestNet', path: 'testnet' }, resolve);
    });
    expect(netRes.ok).toBe(true);
    const testNetId = netRes.network.id;

    // Create agent with publishedNetworkIds pointing to the new network
    const createRes = await new Promise<any>((resolve) => {
      web.emit('agent:create', {
        name: 'Published Agent',
        adapterKind: 'claude-code',
        command: 'echo hello',
        publishedNetworkIds: [testNetId],
      }, resolve);
    });
    expect(createRes.ok).toBe(true);
    const agentId = createRes.agent.id;

    // Switch to test network
    const switchRes = await new Promise<any>((resolve) => {
      web.emit('network:switch', { networkId: testNetId }, resolve);
    });
    expect(switchRes.ok).toBe(true);

    // Subscribe and verify agent appears via publishedNetworkIds
    const snap = await new Promise<any[]>((resolve) => {
      web.on('agents:snapshot', resolve);
      web.emit('agents:subscribe', {});
    });
    const found = snap.find((a: any) => a.id === agentId);
    expect(found).toBeTruthy();
    expect(found.publishedNetworkIds).toContain(testNetId);

    web.close();
  });
});
