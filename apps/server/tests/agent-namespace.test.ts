import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppHandle } from '../src/index.js';
import { io as ioClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { AddressInfo } from 'node:net';
import { newId } from '../src/ids.js';

let app: AppHandle;
let url: string;

beforeEach(async () => {
  process.env.AGENT_BEAN_AGENT_TOKEN = 'default:default:tok';
  app = await buildApp({ dbPath: ':memory:', agentToken: 'default:default:tok' });
  await new Promise<void>((resolve) => app.http.listen(0, resolve));
  const port = (app.http.address() as AddressInfo).port;
  url = `http://localhost:${port}/agent`;
});

afterEach(async () => { await app.close(); });

function connect(token: string, payload: Record<string, unknown>): Socket {
  return ioClient(url, {
    auth: { token, ...payload },
    reconnection: false,
    transports: ['websocket'],
  });
}

describe('/agent namespace', () => {
  it('rejects connections with bad token', async () => {
    const s = connect('wrong', { deviceId: 'd1', networkId: 'default', agents: [] });
    await new Promise<void>((resolve, reject) => {
      s.on('connect', () => reject(new Error('should not connect')));
      s.on('connect_error', (err) => {
        expect(err.message).toMatch(/auth/i);
        resolve();
      });
      setTimeout(() => reject(new Error('no error event')), 2_000);
    });
    s.close();
  });

  it('register puts the agent online and broadcasts to /web', async () => {
    const webUrl = url.replace('/agent', '/web');
    const web = ioClient(webUrl, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((resolve) => web.on('connect', () => resolve()));

    const ag = connect('default:default:tok', {
      deviceId: 'd1',
      networkId: 'default',
      agents: [{ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', visibility: 'public' }],
    });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));

    const statusPromise = new Promise<any>((resolve) => web.once('agent:status', resolve));
    ag.emit('register');

    const status = await statusPromise;
    expect(status.id).toBe('a1');
    expect(status.status).toBe('online');
    expect(status.connectCommand).toContain('npx @agentbean/daemon@latest');

    const snapshotPromise = new Promise<any[]>((resolve) => web.once('agents:snapshot', resolve));
    web.emit('agents:subscribe', {});
    const snap = await snapshotPromise;
    expect(snap.find((s) => s.id === 'a1')).toBeDefined();

    ag.close(); web.close();
  });

  it('heartbeat updates lastSeenAt', async () => {
    const ag = connect('default:default:tok', {
      deviceId: 'd1',
      networkId: 'default',
      agents: [{ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', visibility: 'public' }],
    });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));
    ag.emit('register');
    await new Promise((r) => setTimeout(r, 50));
    const before = app.registry!.snapshot('a1')!.lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 30));
    ag.emit('heartbeat');
    await new Promise((r) => setTimeout(r, 50));
    expect(app.registry!.snapshot('a1')!.lastHeartbeatAt).toBeGreaterThan(before);
    ag.close();
  });
});

describe('device:register-agents', () => {
  it('persists scanned agents to DB and registers in AgentRegistry', async () => {
    const ag = connect('default:default:tok', {
      deviceId: 'd-scan1',
      networkId: 'default',
      agents: [],
    });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));
    ag.emit('register');
    await new Promise((r) => setTimeout(r, 50));

    // Device registers scanned agents
    const ackPromise = new Promise<any>((resolve) => {
      ag.emit('device:register-agents', {
        agents: [
          { name: 'Claude Code', category: 'executor-hosted', adapterKind: 'claude-code', command: '/usr/bin/claude', args: [], source: 'scanned' },
          { name: 'Hermes Agent', category: 'agentos-hosted', adapterKind: 'hermes', command: '/usr/bin/hermes', args: ['gateway', 'run'], source: 'scanned' },
        ],
      }, resolve);
    });
    const ack = await ackPromise;
    expect(ack.ok).toBe(true);
    expect(ack.agents).toHaveLength(2);

    // Verify in DB
    const dbAgents = app.db!.agents.listByDevice('d-scan1');
    expect(dbAgents).toHaveLength(2);
    expect(dbAgents.map((a) => a.name).sort()).toEqual(['Claude-Code', 'Hermes-Agent']);
    expect(dbAgents.every((a) => a.source === 'scanned')).toBe(true);

    // Verify in AgentRegistry
    const claudeAgent = ack.agents.find((a: any) => a.name === 'Claude-Code');
    expect(claudeAgent).toBeDefined();
    const rt = app.registry!.snapshot(claudeAgent.id);
    expect(rt).toBeTruthy();
    expect(rt!.status).toBe('online');

    ag.close();
  });

  it('deduplicates agents by name+deviceId on re-scan', async () => {
    const ag = connect('default:default:tok', {
      deviceId: 'd-scan2',
      networkId: 'default',
      agents: [],
    });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));
    ag.emit('register');
    await new Promise((r) => setTimeout(r, 50));

    // First scan
    await new Promise<any>((resolve) => {
      ag.emit('device:register-agents', {
        agents: [
          { name: 'Claude Code', category: 'executor-hosted', adapterKind: 'claude-code', command: '/usr/bin/claude', args: [], source: 'scanned' },
        ],
      }, resolve);
    });

    // Second scan (same agent, different command path)
    const ack2 = await new Promise<any>((resolve) => {
      ag.emit('device:register-agents', {
        agents: [
          { name: 'Claude Code', category: 'executor-hosted', adapterKind: 'claude-code', command: '/opt/homebrew/bin/claude', args: [], source: 'scanned' },
        ],
      }, resolve);
    });
    expect(ack2).toMatchObject({ ok: true });

    // Should still be 1 agent, not duplicated
    const dbAgents = app.db!.agents.listByDevice('d-scan2');
    expect(dbAgents).toHaveLength(1);
    expect(dbAgents[0].command).toBe('/opt/homebrew/bin/claude'); // updated

    ag.close();
  });
});

describe('/agent dispatch round-trip', () => {
  it('routes server dispatch to daemon and resolves on reply', async () => {
    const local = await buildApp({ dbPath: ':memory:', agentToken: 'default:default:tok' });
    await new Promise<void>((r) => local.http.listen(0, r));
    const port = (local.http.address() as AddressInfo).port;
    const lurl = `http://localhost:${port}/agent`;

    const ag = ioClient(lurl, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd1',
        networkId: 'default',
        agents: [{ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    await new Promise((r) => setTimeout(r, 50));
    ag.on('dispatch', (req: any) => {
      ag.emit('reply', { agentId: 'a1', channelId: req.channelId, body: 'hello-reply', requestId: req.requestId });
    });

    const requestId = newId();
    const reply = await local.dispatch!({ agentId: 'a1', channelId: 'c1', prompt: 'hi', requestId });
    expect(reply).toEqual({ ok: true, body: 'hello-reply' });

    ag.close();
    await local.close();
  });
});
