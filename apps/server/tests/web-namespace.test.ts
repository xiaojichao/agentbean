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
      web.emit('channel:create', { name: `demo-${Date.now()}`, agentIds: ['a1'] }, resolve);
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

  it('routes DM messages directly to the custom agent target', async () => {
    const now = Date.now();
    const owner = app.globalDb.users.listAll()[0]!;
    app.globalDb.devices.upsert({
      id: 'd-custom',
      userId: owner.id,
      networkId: 'default',
      hostname: 'test-device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'custom-drama',
      name: 'drama',
      role: 'executor-agent',
      adapterKind: 'codex',
      deviceId: 'd-custom',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      command: '/opt/homebrew/bin/codex',
      args: JSON.stringify([]),
      cwd: '/private/tmp',
      ownerId: null,
      description: 'Drama agent',
    });

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-custom',
        networkId: 'default',
        capabilities: { customAgentDispatch: true },
        agents: [],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    await new Promise<any>((resolve) => {
      ag.emit('device:register-runtimes', {
        runtimes: [{ name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true }],
      }, resolve);
    });

    let uploadedArtifactId = '';
    const dispatchSeen = new Promise<any>((resolve) => {
      ag.on('dispatch', (req: any) => {
        resolve(req);
      });
    });

    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const statuses: any[] = [];
    web.on('agent:status', (status: any) => statuses.push(status));
    const dmRes = await new Promise<any>((resolve) => {
      web.emit('dm:start', { agentId: 'custom-drama' }, resolve);
    });
    expect(dmRes.ok).toBe(true);

    const form = new FormData();
    form.append('channelId', dmRes.dm.id);
    form.append('uploaderId', 'custom-drama');
    form.append('file', new Blob(['fake image']), 'drama.png');
    const uploadRes = await fetch(`${baseUrl}/api/networks/default/artifacts/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer default:default:tok' },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = await uploadRes.json() as { id: string };
    uploadedArtifactId = uploaded.id;

    const messages: any[] = [];
    web.emit('channel:join', { channelId: dmRes.dm.id });
    web.on('channel:message', (m: any) => messages.push(m));
    await new Promise((r) => setTimeout(r, 50));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: dmRes.dm.id, body: 'hello drama', clientMsgId: 'dm-1' }, resolve);
    });
    expect(ack.ok).toBe(true);

    const req = await dispatchSeen;
    expect(req.agentId).toBe('custom-drama');
    expect(req.customAgent).toMatchObject({ id: 'custom-drama', name: 'drama', adapterKind: 'codex' });
    expect(statuses.some((s) => s.id === 'custom-drama' && s.status === 'busy')).toBe(true);

    ag.emit('reply', {
      agentId: req.agentId,
      channelId: req.channelId,
      body: 'custom dm ok',
      requestId: req.requestId,
      artifactIds: [uploadedArtifactId],
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(statuses.some((s) => s.id === 'custom-drama' && s.status === 'online')).toBe(true);
    const reply = messages.find((m) => m.senderKind === 'agent' && m.senderId === 'custom-drama' && m.body === 'custom dm ok');
    expect(reply).toBeTruthy();
    expect(reply.artifacts?.[0]).toMatchObject({
      id: uploadedArtifactId,
      filename: 'drama.png',
      previewUrl: `/api/networks/default/artifacts/${uploadedArtifactId}/preview`,
      downloadUrl: `/api/networks/default/artifacts/${uploadedArtifactId}/download`,
    });

    ag.close(); web.close();
  });

  it('routes channel mentions to online custom agent candidates', async () => {
    const now = Date.now();
    const owner = app.globalDb.users.listAll()[0]!;
    app.globalDb.devices.upsert({
      id: 'd-custom-mention',
      userId: owner.id,
      networkId: 'default',
      hostname: 'custom-mention-device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'custom-drama-mention',
      name: 'drama',
      role: 'executor-agent',
      adapterKind: 'codex',
      deviceId: 'd-custom-mention',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      command: '/opt/homebrew/bin/codex',
      args: JSON.stringify([]),
      cwd: '/private/tmp',
      ownerId: null,
      description: 'Drama agent',
    });

    const agentos = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-agentos',
        networkId: 'default',
        agents: [{ id: 'hermes-agent', name: 'Hermes-Agent', role: 'r', adapterKind: 'hermes', category: 'agentos-hosted', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => agentos.on('connect', () => r()));
    agentos.emit('register');
    let hermesDispatches = 0;
    agentos.on('dispatch', (req: any) => {
      hermesDispatches += 1;
      agentos.emit('reply', { agentId: 'hermes-agent', channelId: req.channelId, body: 'hermes reply', requestId: req.requestId });
    });

    const custom = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-custom-mention',
        networkId: 'default',
        capabilities: { customAgentDispatch: true },
        agents: [],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => custom.on('connect', () => r()));
    custom.emit('register');
    await new Promise<any>((resolve) => {
      custom.emit('device:register-runtimes', {
        runtimes: [{ name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true }],
      }, resolve);
    });
    const dispatchSeen = new Promise<any>((resolve) => {
      custom.on('dispatch', (req: any) => {
        resolve(req);
        custom.emit('reply', { agentId: req.agentId, channelId: req.channelId, body: 'custom mention ok', requestId: req.requestId });
      });
    });

    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const ch = app.channels.ensureDefault('default');
    web.emit('channel:join', { channelId: ch.id });
    const messages: any[] = [];
    web.on('channel:message', (m: any) => messages.push(m));
    await new Promise((r) => setTimeout(r, 50));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: ch.id, body: '@drama 生成一张图', clientMsgId: 'mention-1' }, resolve);
    });
    expect(ack.ok).toBe(true);

    const req = await dispatchSeen;
    expect(req.agentId).toBe('custom-drama-mention');
    expect(req.customAgent).toMatchObject({ id: 'custom-drama-mention', name: 'drama', adapterKind: 'codex' });
    await new Promise((r) => setTimeout(r, 100));
    expect(hermesDispatches).toBe(0);
    expect(messages.some((m) => m.senderKind === 'agent' && m.senderId === 'custom-drama-mention' && m.body === 'custom mention ok')).toBe(true);

    custom.close(); agentos.close(); web.close();
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
