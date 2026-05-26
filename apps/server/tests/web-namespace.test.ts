import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppHandle } from '../src/index.js';
import { generateToken } from '../src/auth.js';
import { io as ioClient } from 'socket.io-client';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: AppHandle;
let baseUrl: string;
let storageBaseDir: string;
let previousStorageBaseDir: string | undefined;

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  previousStorageBaseDir = process.env.STORAGE_BASE_DIR;
  storageBaseDir = mkdtempSync(join(tmpdir(), 'agentbean-web-namespace-'));
  process.env.STORAGE_BASE_DIR = storageBaseDir;
  process.env.AGENT_BEAN_AGENT_TOKEN = 'default:default:tok';
  process.env.AGENT_BEAN_WEB_TOKEN = 'web-only-token';
  process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.1.19';
  app = await buildApp({ dbPath: ':memory:', globalDbPath: ':memory:', agentToken: 'default:default:tok' });
  await new Promise<void>((r) => app.http.listen(0, r));
  const port = (app.http.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await app.close();
  if (previousStorageBaseDir === undefined) delete process.env.STORAGE_BASE_DIR;
  else process.env.STORAGE_BASE_DIR = previousStorageBaseDir;
  rmSync(storageBaseDir, { recursive: true, force: true });
});

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

  it('fills missing agent creator names from the owning device user in member lists', async () => {
    const now = Date.now();
    app.globalDb.users.create({ id: 'creator-device-user', username: 'creator-device-user', passwordHash: null, createdAt: now });
    app.globalDb.networkMembers.add('default', 'creator-device-user', 'member');
    app.globalDb.devices.upsert({
      id: 'creator-device',
      userId: 'creator-device-user',
      networkId: 'default',
      hostname: 'Creator Device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'agent-without-owner',
      name: 'Agent Without Owner',
      role: 'assistant',
      adapterKind: 'hermes',
      deviceId: 'creator-device',
      networkId: 'default',
      visibility: 'public',
      category: 'agentos-hosted',
      source: 'scanned',
      firstSeenAt: now,
      lastSeenAt: now,
      ownerId: null,
      command: 'hermes',
      cwd: null,
      description: null,
    });

    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const members = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(members.ok).toBe(true);
    expect(members.agents.find((agent: any) => agent.id === 'agent-without-owner')).toMatchObject({
      ownerId: 'creator-device-user',
      ownerName: 'creator-device-user',
      deviceName: 'Creator Device',
    });
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

  it('includes device names in member agent rows so duplicate names can be distinguished', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'members-device-1',
        networkId: 'default',
        agents: [{ id: 'members-a1', name: 'SameName', role: 'r', adapterKind: 'codex', category: 'agentos-hosted', visibility: 'public' }],
        systemInfo: { hostname: 'Studio-Mini' },
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const members = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(members.ok).toBe(true);
    expect(members.agents.find((agent: any) => agent.id === 'members-a1')).toMatchObject({
      name: 'SameName',
      deviceId: 'members-device-1',
      deviceName: 'Studio-Mini',
    });

    ag.close(); web.close();
  });

  it('forwards directory selection requests to the target device daemon', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'directory-device-1',
        networkId: 'default',
        agents: [],
        capabilities: { customAgentDispatch: true, directoryPicker: true },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    ag.on('device:select-directory', (_payload, ack) => {
      ack({ ok: true, path: '/Users/shaw/projects/drama' });
    });

    const selected = await new Promise<any>((resolve) => {
      web.emit('device:select-directory', { deviceId: 'directory-device-1' }, resolve);
    });

    expect(selected).toEqual({ ok: true, path: '/Users/shaw/projects/drama' });
    ag.close();
    web.close();
  });

  it('asks users to upgrade the daemon before remote directory browsing on old devices', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'old-directory-device',
        networkId: 'default',
        agents: [],
        capabilities: { customAgentDispatch: true },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const selected = await new Promise<any>((resolve) => {
      web.emit('device:select-directory', { deviceId: 'old-directory-device' }, resolve);
    });

    expect(selected).toEqual({ ok: false, error: 'DAEMON_UPGRADE_REQUIRED' });
    ag.close();
    web.close();
  });

  it('keeps device snapshots sorted by device name instead of last heartbeat time', async () => {
    const now = Date.now();
    app.globalDb.devices.upsert({
      id: 'stable-z',
      userId: 'admin',
      networkId: 'default',
      hostname: 'Zeta',
      lastSeenAt: now + 10_000,
      systemInfo: null,
    });
    app.globalDb.devices.upsert({
      id: 'stable-a',
      userId: 'admin',
      networkId: 'default',
      hostname: 'Alpha',
      lastSeenAt: now,
      systemInfo: null,
    });

    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: generateToken('admin', 'default') } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const snap = await new Promise<any[]>((resolve) => {
      web.emit('devices:subscribe', {});
      web.on('devices:snapshot', resolve);
    });

    expect(snap.map((device: any) => device.hostname)).toEqual(['Alpha', 'Zeta']);
    web.close();
  });

  it('lists all team devices instead of only devices owned by the current user', async () => {
    app.globalDb.users.create({
      id: 'team-device-owner',
      username: 'team-device-owner',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'team-device-owner', 'member');
    app.globalDb.devices.upsert({
      id: 'owned-by-team-member',
      userId: 'team-device-owner',
      networkId: 'default',
      hostname: 'Member Laptop',
      lastSeenAt: Date.now(),
      systemInfo: null,
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const snap = await new Promise<any[]>((resolve) => {
      web.once('devices:snapshot', resolve);
      web.emit('devices:subscribe', {});
    });
    const listed = await new Promise<any>((resolve) => {
      web.emit('devices:list', {}, resolve);
    });

    expect(snap.find((device: any) => device.id === 'owned-by-team-member')).toMatchObject({
      hostname: 'Member Laptop',
      networkId: 'default',
      userId: 'team-device-owner',
      ownerName: 'team-device-owner',
      userName: 'team-device-owner',
      canManage: true,
    });
    expect(listed.ok).toBe(true);
    expect(listed.devices.find((device: any) => device.id === 'owned-by-team-member')).toMatchObject({
      hostname: 'Member Laptop',
      networkId: 'default',
      userId: 'team-device-owner',
      ownerName: 'team-device-owner',
      userName: 'team-device-owner',
      canManage: true,
    });
    web.close();
  });

  it('allows only system admins or the owner to delete a device', async () => {
    const now = Date.now();
    app.globalDb.users.create({
      id: 'device-delete-owner',
      username: 'device-delete-owner',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.users.create({
      id: 'device-delete-member',
      username: 'device-delete-member',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.networkMembers.add('default', 'device-delete-owner', 'member');
    app.globalDb.networkMembers.add('default', 'device-delete-member', 'member');
    app.globalDb.devices.upsert({
      id: 'delete-owned-device',
      userId: 'device-delete-owner',
      networkId: 'default',
      hostname: 'Owner Device',
      lastSeenAt: now,
      systemInfo: null,
    });

    const member = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('device-delete-member', 'default') },
    });
    await new Promise<void>((r) => member.on('connect', () => r()));
    const denied = await new Promise<any>((resolve) => {
      member.emit('device:delete', { id: 'delete-owned-device' }, resolve);
    });
    expect(denied).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(app.globalDb.devices.get('delete-owned-device')).toMatchObject({ userId: 'device-delete-owner' });
    member.close();

    const owner = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('device-delete-owner', 'default') },
    });
    await new Promise<void>((r) => owner.on('connect', () => r()));
    const ownerDeleted = await new Promise<any>((resolve) => {
      owner.emit('device:delete', { id: 'delete-owned-device' }, resolve);
    });
    expect(ownerDeleted).toEqual({ ok: true });
    expect(app.globalDb.devices.get('delete-owned-device')).toBeNull();
    owner.close();

    app.globalDb.devices.upsert({
      id: 'delete-admin-device',
      userId: 'device-delete-owner',
      networkId: 'default',
      hostname: 'Admin Managed Device',
      lastSeenAt: now,
      systemInfo: null,
    });
    const admin = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => admin.on('connect', () => r()));
    const adminDeleted = await new Promise<any>((resolve) => {
      admin.emit('device:delete', { id: 'delete-admin-device' }, resolve);
    });
    expect(adminDeleted).toEqual({ ok: true });
    expect(app.globalDb.devices.get('delete-admin-device')).toBeNull();
    admin.close();
  });

  it('prevents team members from removing agents that belong to another member device', async () => {
    const now = Date.now();
    app.globalDb.users.create({
      id: 'agent-device-owner',
      username: 'agent-device-owner',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.users.create({
      id: 'agent-device-member',
      username: 'agent-device-member',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.networkMembers.add('default', 'agent-device-owner', 'member');
    app.globalDb.networkMembers.add('default', 'agent-device-member', 'member');
    app.globalDb.devices.upsert({
      id: 'agent-owned-device',
      userId: 'agent-device-owner',
      networkId: 'default',
      hostname: 'Agent Owner Device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'agent-owned-by-device',
      name: 'Owner Agent',
      role: 'assistant',
      adapterKind: 'hermes',
      deviceId: 'agent-owned-device',
      networkId: 'default',
      visibility: 'public',
      category: 'agentos-hosted',
      source: 'scanned',
      firstSeenAt: now,
      lastSeenAt: now,
      ownerId: null,
      command: 'hermes',
      cwd: null,
      description: null,
    });
    app.globalDb.agentPublishes.publish('agent-owned-by-device', 'default', 'agent-device-owner');

    const member = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('agent-device-member', 'default') },
    });
    await new Promise<void>((r) => member.on('connect', () => r()));
    const denied = await new Promise<any>((resolve) => {
      member.emit('agent:unpublish', { agentId: 'agent-owned-by-device', networkId: 'default' }, resolve);
    });
    expect(denied).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(app.globalDb.agentPublishes.isPublished('agent-owned-by-device', 'default')).toBe(true);
    member.close();

    const owner = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('agent-device-owner', 'default') },
    });
    await new Promise<void>((r) => owner.on('connect', () => r()));
    const allowed = await new Promise<any>((resolve) => {
      owner.emit('agent:unpublish', { agentId: 'agent-owned-by-device', networkId: 'default' }, resolve);
    });
    expect(allowed).toEqual({ ok: true });
    expect(app.globalDb.agentPublishes.isPublished('agent-owned-by-device', 'default')).toBe(false);
    owner.close();
  });

  it('allows agent config changes only from the agent owner or an admin', async () => {
    const now = Date.now();
    app.globalDb.users.create({
      id: 'agent-config-device-owner',
      username: 'agent-config-device-owner',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.users.create({
      id: 'agent-config-creator',
      username: 'agent-config-creator',
      passwordHash: null,
      createdAt: now,
    });
    app.globalDb.networkMembers.add('default', 'agent-config-device-owner', 'member');
    app.globalDb.networkMembers.add('default', 'agent-config-creator', 'member');
    app.globalDb.devices.upsert({
      id: 'agent-config-device',
      userId: 'agent-config-device-owner',
      networkId: 'default',
      hostname: 'Config Device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'agent-config-on-other-device',
      name: 'Creator-Agent',
      role: 'assistant',
      adapterKind: 'codex',
      deviceId: 'agent-config-device',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      ownerId: 'agent-config-creator',
      command: 'codex',
      cwd: '/Users/device/project',
      description: 'Owned by creator, hosted on another device',
    });

    const creator = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('agent-config-creator', 'default') },
    });
    await new Promise<void>((r) => creator.on('connect', () => r()));
    const allowed = await new Promise<any>((resolve) => {
      creator.emit('agent:config:update', {
        id: 'agent-config-on-other-device',
        name: 'Creator-Agent-Changed',
        adapterKind: 'codex',
        command: 'codex',
        cwd: '/Users/device/project',
        description: 'Changed by creator',
      }, resolve);
    });
    expect(allowed.ok).toBe(true);
    expect(app.globalDb.agents.getFull('agent-config-on-other-device')?.name).toBe('Creator-Agent-Changed');
    creator.close();

    const deviceOwner = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('agent-config-device-owner', 'default') },
    });
    await new Promise<void>((r) => deviceOwner.on('connect', () => r()));
    const denied = await new Promise<any>((resolve) => {
      deviceOwner.emit('agent:config:update', {
        id: 'agent-config-on-other-device',
        name: 'Device-Agent',
        adapterKind: 'codex',
        command: 'codex',
        cwd: '/Users/device/project',
        description: 'Changed by device owner',
      }, resolve);
    });
    expect(denied).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(app.globalDb.agents.getFull('agent-config-on-other-device')?.name).toBe('Creator-Agent-Changed');
    deviceOwner.close();
  });

  it('pushes device status as soon as a daemon registers', async () => {
    app.globalDb.users.create({
      id: 'daemon-device-owner',
      username: 'daemon-device-owner',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'daemon-device-owner', 'member');
    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const gotStatus = new Promise<any>((resolve) => web.once('device:status', resolve));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: generateToken('daemon-device-owner', 'default'),
        deviceId: 'fresh-live-device',
        networkId: 'default',
        agents: [],
        systemInfo: { hostname: 'Fresh Live Device', daemonVersion: '0.1.27' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const status = await gotStatus;
    expect(status).toMatchObject({
      id: 'fresh-live-device',
      userId: 'daemon-device-owner',
      ownerName: 'daemon-device-owner',
      userName: 'daemon-device-owner',
      networkId: 'default',
      hostname: 'Fresh-Live-Device',
      status: 'online',
    });

    const snap = await new Promise<any[]>((resolve) => {
      web.once('devices:snapshot', resolve);
      web.emit('devices:subscribe', {});
    });
    expect(snap.find((device: any) => device.id === 'fresh-live-device')).toMatchObject({
      userId: 'daemon-device-owner',
      ownerName: 'daemon-device-owner',
      userName: 'daemon-device-owner',
      networkId: 'default',
      status: 'online',
      canManage: true,
    });
    ag.close();
    web.close();
  });

  it('repairs an existing device owner from the saved command when the daemon reconnects', async () => {
    const now = Date.now();
    app.globalDb.users.create({ id: 'repair-test01', username: 'repair-test01', passwordHash: null, createdAt: now });
    app.globalDb.users.create({ id: 'repair-demo1', username: 'repair-demo1', passwordHash: null, createdAt: now });
    app.globalDb.networkMembers.add('default', 'repair-test01', 'member');
    app.globalDb.networkMembers.add('default', 'repair-demo1', 'member');
    app.globalDb.devices.upsert({
      id: 'repair-mybmp-device',
      userId: 'repair-demo1',
      networkId: 'default',
      hostname: 'MyMBP',
      lastSeenAt: now,
      systemInfo: { hostname: 'MyMBP' },
    });
    app.globalDb.devices.setConnectCommand(
      'repair-mybmp-device',
      'npx @agentbean/daemon@latest --server-url https://api.agentbean.dev --token repair-test01:default:original',
    );

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: generateToken('repair-test01', 'default'),
        deviceId: 'repair-mybmp-device',
        networkId: 'default',
        agents: [],
        systemInfo: { hostname: 'MyMBP', daemonVersion: '0.1.31' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    await new Promise((r) => setTimeout(r, 50));

    expect(app.globalDb.devices.get('repair-mybmp-device')).toMatchObject({ userId: 'repair-test01' });
    ag.close();
  });

  it('repairs an existing device owner from the current daemon token when no saved command exists', async () => {
    const now = Date.now();
    app.globalDb.users.create({ id: 'token-repair-test01', username: 'token-repair-test01', passwordHash: null, createdAt: now });
    app.globalDb.users.create({ id: 'token-repair-demo1', username: 'token-repair-demo1', passwordHash: null, createdAt: now });
    app.globalDb.networkMembers.add('default', 'token-repair-test01', 'member');
    app.globalDb.networkMembers.add('default', 'token-repair-demo1', 'member');
    app.globalDb.devices.upsert({
      id: 'token-repair-device',
      userId: 'token-repair-demo1',
      networkId: 'default',
      hostname: 'MyMBP',
      lastSeenAt: now,
      systemInfo: { hostname: 'MyMBP' },
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('token-repair-test01', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const gotStatus = new Promise<any>((resolve) => web.once('device:status', resolve));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: generateToken('token-repair-test01', 'default'),
        deviceId: 'token-repair-device',
        networkId: 'default',
        agents: [],
        systemInfo: { hostname: 'MyMBP', daemonVersion: '0.1.31' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const status = await gotStatus;
    expect(status).toMatchObject({
      id: 'token-repair-device',
      userId: 'token-repair-test01',
      ownerName: 'token-repair-test01',
    });
    expect(app.globalDb.devices.get('token-repair-device')).toMatchObject({ userId: 'token-repair-test01' });
    ag.close();
    web.close();
  });

  it('lets the repaired device owner rename a scanned AgentOS agent while preserving its directory', async () => {
    const now = Date.now();
    app.globalDb.users.create({ id: 'agentos-owner-test01', username: 'agentos-owner-test01', passwordHash: null, createdAt: now });
    app.globalDb.users.create({ id: 'agentos-owner-demo1', username: 'agentos-owner-demo1', passwordHash: null, createdAt: now });
    app.globalDb.networkMembers.add('default', 'agentos-owner-test01', 'member');
    app.globalDb.networkMembers.add('default', 'agentos-owner-demo1', 'member');
    app.globalDb.devices.upsert({
      id: 'agentos-config-device',
      userId: 'agentos-owner-test01',
      networkId: 'default',
      hostname: 'MyMBP',
      lastSeenAt: now,
      systemInfo: { hostname: 'MyMBP' },
    });
    app.globalDb.agents.upsert({
      id: 'scan-agentos-config-device-hermes-agent',
      name: 'Hermes-Agent',
      role: 'gateway-agent',
      adapterKind: 'hermes',
      deviceId: 'agentos-config-device',
      networkId: 'default',
      visibility: 'public',
      category: 'agentos-hosted',
      source: 'scanned',
      firstSeenAt: now,
      lastSeenAt: now,
      ownerId: 'agentos-owner-demo1',
      command: '/opt/homebrew/bin/hermes',
      args: '[]',
      cwd: '/opt/homebrew/bin',
      description: 'before',
    });

    const owner = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('agentos-owner-test01', 'default') },
    });
    await new Promise<void>((r) => owner.on('connect', () => r()));
    const allowed = await new Promise<any>((resolve) => {
      owner.emit('agent:config:update', {
        id: 'scan-agentos-config-device-hermes-agent',
        name: 'Hermes-Renamed',
        cwd: '/tmp/should-not-overwrite',
        description: 'after',
      }, resolve);
    });

    expect(allowed.ok).toBe(true);
    expect(app.globalDb.agents.getFull('scan-agentos-config-device-hermes-agent')).toMatchObject({
      name: 'Hermes-Renamed',
      cwd: '/opt/homebrew/bin',
      description: 'after',
    });
    owner.close();
  });

  it('binds newly created custom agents to the selected team device immediately', async () => {
    app.globalDb.users.create({
      id: 'remote-device-owner',
      username: 'remote-owner',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'remote-device-owner', 'member');
    app.globalDb.devices.upsert({
      id: 'remote-device-1',
      userId: 'remote-device-owner',
      networkId: 'default',
      hostname: 'Remote Studio',
      lastSeenAt: Date.now(),
      systemInfo: { hostname: 'remote-studio.local' },
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const createRes = await new Promise<any>((resolve) => {
      web.emit('agent:create', {
        name: 'Device Bound Agent',
        adapterKind: 'codex',
        command: 'codex',
        category: 'executor-hosted',
        deviceId: 'remote-device-1',
        cwd: '/Users/remote/project',
        env: { OPENAI_BASE_URL: 'https://api.example.test' },
      }, resolve);
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.agent).toMatchObject({
      name: 'Device-Bound-Agent',
      deviceId: 'remote-device-1',
      source: 'custom',
      env: JSON.stringify({ OPENAI_BASE_URL: 'https://api.example.test' }),
    });

    const missingCwdRes = await new Promise<any>((resolve) => {
      web.emit('agent:create', {
        name: 'Missing Cwd',
        adapterKind: 'codex',
        command: 'codex',
        category: 'executor-hosted',
        deviceId: 'remote-device-1',
      }, resolve);
    });
    expect(missingCwdRes).toMatchObject({ ok: false, error: 'EMPTY_CWD' });

    const customList = await new Promise<any>((resolve) => {
      web.emit('agent:custom:list', { deviceId: 'remote-device-1' }, resolve);
    });
    expect(customList.ok).toBe(true);
    expect(customList.agents.find((agent: any) => agent.id === createRes.agent.id)).toMatchObject({
      deviceId: 'remote-device-1',
      deviceName: 'Remote Studio',
    });

    const ownerWeb = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('remote-device-owner', 'default') },
    });
    await new Promise<void>((r) => ownerWeb.on('connect', () => r()));
    const ownerCustomList = await new Promise<any>((resolve) => {
      ownerWeb.emit('agent:custom:list', { deviceId: 'remote-device-1' }, resolve);
    });
    expect(ownerCustomList.ok).toBe(true);
    expect(ownerCustomList.agents.find((agent: any) => agent.id === createRes.agent.id)).toMatchObject({
      deviceId: 'remote-device-1',
      deviceName: 'Remote Studio',
    });
    ownerWeb.close();

    app.globalDb.users.create({
      id: 'same-team-viewer',
      username: 'same-team-viewer',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'same-team-viewer', 'member');
    const viewerWeb = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('same-team-viewer', 'default') },
    });
    await new Promise<void>((r) => viewerWeb.on('connect', () => r()));
    const viewerCustomList = await new Promise<any>((resolve) => {
      viewerWeb.emit('agent:custom:list', { deviceId: 'remote-device-1' }, resolve);
    });
    expect(viewerCustomList.ok).toBe(true);
    expect(viewerCustomList.agents.find((agent: any) => agent.id === createRes.agent.id)).toMatchObject({
      deviceId: 'remote-device-1',
      deviceName: 'Remote Studio',
    });
    viewerWeb.close();

    const snap = await new Promise<any[]>((resolve) => {
      web.on('agents:snapshot', resolve);
      web.emit('agents:subscribe', {});
    });
    expect(snap.find((agent: any) => agent.id === createRes.agent.id)).toMatchObject({
      deviceId: 'remote-device-1',
      deviceName: 'Remote Studio',
    });
    web.close();
  });

  it('does not mark remote custom agents offline because their cwd is not on the server host', async () => {
    const now = Date.now();
    const owner = app.globalDb.users.listAll()[0]!;
    app.globalDb.devices.upsert({
      id: 'remote-custom-device',
      userId: owner.id,
      networkId: 'default',
      hostname: 'MyMBP',
      lastSeenAt: now,
      systemInfo: { hostname: 'MyMBP' },
    });
    app.globalDb.agents.upsert({
      id: 'remote-custom-agent',
      name: 'test-Agent',
      role: 'executor-agent',
      adapterKind: 'codex',
      deviceId: 'remote-custom-device',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      command: '/opt/homebrew/bin/codex',
      args: JSON.stringify([]),
      cwd: '/Users/shaw/drama',
      ownerId: owner.id,
      description: 'Remote custom agent',
    });

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'remote-custom-device',
        networkId: 'default',
        capabilities: { customAgentDispatch: true },
        agents: [],
        systemInfo: { hostname: 'MyMBP' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    await new Promise<any>((resolve) => {
      ag.emit('device:register-runtimes', {
        runtimes: [{ name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true }],
      }, resolve);
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const members = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(members.ok).toBe(true);
    expect(members.agents.find((agent: any) => agent.id === 'remote-custom-agent')).toMatchObject({
      name: 'test-Agent',
      deviceName: 'MyMBP',
      status: 'online',
    });

    ag.close();
    web.close();
  });

  it('marks custom agents offline when their device daemon is not running', async () => {
    const now = Date.now();
    const owner = app.globalDb.users.listAll()[0]!;
    app.globalDb.devices.upsert({
      id: 'stopped-custom-device',
      userId: owner.id,
      networkId: 'default',
      hostname: 'Stopped Device',
      lastSeenAt: now,
      systemInfo: { hostname: 'Stopped Device' },
    });
    app.globalDb.devices.setRuntimes('stopped-custom-device', [
      { name: 'Codex CLI', adapterKind: 'codex', command: '/opt/homebrew/bin/codex', installed: true },
    ]);
    app.globalDb.agents.upsert({
      id: 'stopped-custom-agent',
      name: 'stopped-agent',
      role: 'executor-agent',
      adapterKind: 'codex',
      deviceId: 'stopped-custom-device',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      command: '/opt/homebrew/bin/codex',
      args: JSON.stringify([]),
      cwd: '/Users/shaw/drama',
      ownerId: owner.id,
      description: 'Custom agent on stopped daemon',
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const members = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });

    expect(members.ok).toBe(true);
    expect(members.agents.find((agent: any) => agent.id === 'stopped-custom-agent')).toMatchObject({
      name: 'stopped-agent',
      deviceName: 'Stopped Device',
      status: 'offline',
    });

    web.close();
  });

  it('reports AgentOS agents as busy in member lists while dispatch is running', async () => {
    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const statuses: any[] = [];
    web.on('agent:status', (status: any) => statuses.push(status));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'my-mbp-hermes-device',
        networkId: 'default',
        agents: [{
          id: 'scan-my-mbp-hermes-device-hermes-agent',
          name: 'Hermes-Agent',
          role: 'gateway-agent',
          adapterKind: 'hermes',
          category: 'agentos-hosted',
          visibility: 'public',
        }],
        systemInfo: { hostname: 'MyMBP' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');

    const dmRes = await new Promise<any>((resolve) => {
      web.emit('dm:start', { agentId: 'scan-my-mbp-hermes-device-hermes-agent' }, resolve);
    });
    expect(dmRes.ok).toBe(true);

    const dispatchSeen = new Promise<any>((resolve) => {
      ag.once('dispatch', resolve);
    });
    const sendAck = await new Promise<any>((resolve) => {
      web.emit('message:send', {
        channelId: dmRes.dm.id,
        body: '介绍一下你自己',
        clientMsgId: 'hermes-busy-1',
      }, resolve);
    });
    expect(sendAck.ok).toBe(true);

    const req = await dispatchSeen;
    expect(req.agentId).toBe('scan-my-mbp-hermes-device-hermes-agent');
    expect(statuses.some((status: any) =>
      status.id === 'scan-my-mbp-hermes-device-hermes-agent' && status.status === 'busy'
    )).toBe(true);

    const membersWhileBusy = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(membersWhileBusy.ok).toBe(true);
    expect(membersWhileBusy.agents.find((agent: any) => agent.id === 'scan-my-mbp-hermes-device-hermes-agent')).toMatchObject({
      name: 'Hermes-Agent',
      deviceName: 'MyMBP',
      status: 'busy',
    });

    ag.emit('reply', {
      agentId: req.agentId,
      channelId: req.channelId,
      body: 'Hermes ok',
      requestId: req.requestId,
    });
    await new Promise((r) => setTimeout(r, 50));
    ag.close();
    web.close();
  });

  it('keeps published AgentOS status events visible in the target team', async () => {
    const setupSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => setupSocket.on('connect', () => r()));
    const created = await new Promise<any>((resolve) => {
      setupSocket.emit('network:create', { name: 'OpenSNS Team', path: 'opensns-status' }, resolve);
    });
    expect(created.ok).toBe(true);
    const targetNetworkId = created.network.id;

    const registeredStatus = new Promise<any>((resolve) => {
      setupSocket.once('agent:status', resolve);
    });
    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'published-hermes-device',
        networkId: 'default',
        agents: [{
          id: 'scan-published-hermes-device-hermes-agent',
          name: 'Hermes-Agent',
          role: 'gateway-agent',
          adapterKind: 'hermes',
          category: 'agentos-hosted',
          visibility: 'public',
        }],
        systemInfo: { hostname: 'MyMBP' },
      },
      reconnection: false,
      transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register');
    await registeredStatus;
    const scanned = await new Promise<any>((resolve) => {
      ag.emit('device:register-agents', {
        agents: [{
          name: 'Hermes-Agent',
          category: 'agentos-hosted',
          adapterKind: 'hermes',
          command: 'hermes',
          args: [],
          source: 'scanned',
        }],
      }, resolve);
    });
    expect(scanned.ok).toBe(true);
    expect(app.globalDb.agents.getFull('scan-published-hermes-device-hermes-agent')).toBeTruthy();
    app.globalDb.agentPublishes.publish('scan-published-hermes-device-hermes-agent', targetNetworkId, 'admin');
    app.registry.updatePublishedNetworks('scan-published-hermes-device-hermes-agent', [targetNetworkId]);

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', targetNetworkId) },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const statuses: any[] = [];
    const busyStatusSeen = new Promise<any>((resolve) => {
      web.on('agent:status', (status: any) => {
        statuses.push(status);
        if (status.id === 'scan-published-hermes-device-hermes-agent' && status.status === 'busy') {
          resolve(status);
        }
      });
    });

    const dmRes = await new Promise<any>((resolve) => {
      web.emit('dm:start', { agentId: 'scan-published-hermes-device-hermes-agent' }, resolve);
    });
    expect(dmRes.ok).toBe(true);

    const dispatchSeen = new Promise<any>((resolve) => {
      ag.once('dispatch', resolve);
    });
    const sendAck = await new Promise<any>((resolve) => {
      web.emit('message:send', {
        channelId: dmRes.dm.id,
        body: '介绍一下你自己',
        clientMsgId: 'published-hermes-busy-1',
      }, resolve);
    });
    expect(sendAck.ok).toBe(true);

    const [req, busyStatus] = await Promise.all([dispatchSeen, busyStatusSeen]);
    expect(busyStatus).toMatchObject({
      networkId: 'default',
      status: 'busy',
    });
    expect(busyStatus.publishedNetworkIds).toContain(targetNetworkId);

    const membersWhileBusy = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(membersWhileBusy.ok).toBe(true);
    expect(membersWhileBusy.agents.find((agent: any) => agent.id === 'scan-published-hermes-device-hermes-agent')).toMatchObject({
      name: 'Hermes-Agent',
      status: 'busy',
    });

    const listedDevices = await new Promise<any>((resolve) => {
      web.emit('devices:list', {}, resolve);
    });
    expect(listedDevices.ok).toBe(true);
    expect(listedDevices.devices.find((device: any) => device.id === 'published-hermes-device')).toMatchObject({
      hostname: 'MyMBP',
      networkId: 'default',
      status: 'online',
    });

    const deviceSnapshot = await new Promise<any[]>((resolve) => {
      web.once('devices:snapshot', resolve);
      web.emit('devices:subscribe', {});
    });
    expect(deviceSnapshot.find((device: any) => device.id === 'published-hermes-device')).toMatchObject({
      hostname: 'MyMBP',
      networkId: 'default',
      status: 'online',
    });

    ag.emit('reply', {
      agentId: req.agentId,
      channelId: req.channelId,
      body: 'Hermes ok',
      requestId: req.requestId,
    });
    await new Promise((r) => setTimeout(r, 50));
    ag.close();
    web.close();
    setupSocket.close();
  });

  it('returns every team member for the default all channel', async () => {
    app.globalDb.users.create({
      id: 'u-all',
      username: 'all-user',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'u-all', 'member');
    app.registry.register('s-all-1', { id: 'all-a1', name: 'All A1', role: 'r', adapterKind: 'codex', category: 'agentos-hosted', networkId: 'default' });
    app.registry.register('s-all-2', { id: 'all-a2', name: 'All A2', role: 'r', adapterKind: 'codex', category: 'agentos-hosted', networkId: 'default' });
    const ch = app.channels.ensureDefault('default');

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('u-all', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const res = await new Promise<any>((resolve) => {
      web.emit('channel:members', { channelId: ch.id }, resolve);
    });

    expect(res.ok).toBe(true);
    expect(res.humans.map((human: any) => human.userId)).toContain('u-all');
    expect(res.agents.map((agent: any) => agent.id).sort()).toEqual(['all-a1', 'all-a2']);
    web.close();
  });

  it('keeps existing default all members after a new user registers', async () => {
    const registerSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: 'web-only-token' },
    });
    await new Promise<void>((r) => registerSocket.on('connect', () => r()));
    const registerRes = await new Promise<any>((resolve) => {
      registerSocket.emit('auth:register', {
        username: 'fresh-user',
        password: 'secret123',
        email: 'fresh@example.com',
      }, resolve);
    });
    expect(registerRes.ok).toBe(true);

    const all = app.channels.ensureDefault('default');
    const adminSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => adminSocket.on('connect', () => r()));
    const membersRes = await new Promise<any>((resolve) => {
      adminSocket.emit('channel:members', { channelId: all.id }, resolve);
    });

    expect(membersRes.ok).toBe(true);
    expect(membersRes.humans.map((human: any) => human.username).sort()).toEqual(['admin', 'fresh-user']);
    registerSocket.close();
    adminSocket.close();
  });

  it('does not list default team agents in a newly created private team', async () => {
    app.registry.register('socket-default-agent', {
      id: 'default-only-agent',
      name: 'Default Agent',
      role: 'r',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      networkId: 'default',
    });
    const adminSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => adminSocket.on('connect', () => r()));
    const created = await new Promise<any>((resolve) => {
      adminSocket.emit('network:create', { name: 'Clean Team', path: 'clean-team' }, resolve);
    });
    expect(created.ok).toBe(true);
    const switched = await new Promise<any>((resolve) => {
      adminSocket.emit('network:switch', { networkId: created.network.id }, resolve);
    });
    expect(switched.ok).toBe(true);
    const members = await new Promise<any>((resolve) => {
      adminSocket.emit('members:list', {}, resolve);
    });

    expect(members.ok).toBe(true);
    expect(members.agents).toEqual([]);
    expect(members.humans.map((human: any) => human.username)).toEqual(['admin']);
    adminSocket.close();
  });

  it('registers a new user into the team from a join link and returns that team', async () => {
    const adminSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => adminSocket.on('connect', () => r()));
    const created = await new Promise<any>((resolve) => {
      adminSocket.emit('network:create', { name: 'Invite Team', path: 'invite-team' }, resolve);
    });
    expect(created.ok).toBe(true);
    const targetNetwork = created.network;
    const switched = await new Promise<any>((resolve) => {
      adminSocket.emit('network:switch', { networkId: targetNetwork.id }, resolve);
    });
    expect(switched.ok).toBe(true);
    const linkRes = await new Promise<any>((resolve) => {
      adminSocket.emit('join:create', { maxUses: 5 }, resolve);
    });
    expect(linkRes.ok).toBe(true);

    const inviteSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { invite: true },
    });
    await new Promise<void>((r) => inviteSocket.on('connect', () => r()));
    const registerRes = await new Promise<any>((resolve) => {
      inviteSocket.emit('auth:register', {
        username: 'new-joiner',
        password: 'secret123',
        email: 'new-joiner@example.com',
        inviteToken: linkRes.link.code,
      }, resolve);
    });

    expect(registerRes.ok).toBe(true);
    expect(registerRes.networkId).toBe(targetNetwork.id);
    expect(registerRes.networkPath).toBe(targetNetwork.path);
    const user = app.globalDb.users.getByName('new-joiner');
    expect(user?.currentNetworkId).toBe(targetNetwork.id);
    expect(app.globalDb.networkMembers.isMember(targetNetwork.id, user!.id)).toBe(true);

    adminSocket.close();
    inviteSocket.close();
  });

  it('adds an existing registered user to the team from a join link and returns that team', async () => {
    const adminSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => adminSocket.on('connect', () => r()));
    const created = await new Promise<any>((resolve) => {
      adminSocket.emit('network:create', { name: 'Existing Invite Team', path: 'existing-invite' }, resolve);
    });
    expect(created.ok).toBe(true);
    const targetNetwork = created.network;
    const switched = await new Promise<any>((resolve) => {
      adminSocket.emit('network:switch', { networkId: targetNetwork.id }, resolve);
    });
    expect(switched.ok).toBe(true);
    const linkRes = await new Promise<any>((resolve) => {
      adminSocket.emit('join:create', { maxUses: 5 }, resolve);
    });
    expect(linkRes.ok).toBe(true);

    const registerSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { invite: true },
    });
    await new Promise<void>((r) => registerSocket.on('connect', () => r()));
    const registerRes = await new Promise<any>((resolve) => {
      registerSocket.emit('auth:register', {
        username: 'existing-joiner',
        password: 'secret123',
        email: 'existing-joiner@example.com',
      }, resolve);
    });
    expect(registerRes.ok).toBe(true);

    const loginSocket = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { invite: true },
    });
    await new Promise<void>((r) => loginSocket.on('connect', () => r()));
    const loginRes = await new Promise<any>((resolve) => {
      loginSocket.emit('auth:login', {
        username: 'existing-joiner',
        password: 'secret123',
        joinCode: linkRes.link.code,
      }, resolve);
    });

    expect(loginRes.ok).toBe(true);
    expect(loginRes.networkId).toBe(targetNetwork.id);
    expect(loginRes.networkPath).toBe(targetNetwork.path);
    const user = app.globalDb.users.getByName('existing-joiner');
    expect(user?.currentNetworkId).toBe(targetNetwork.id);
    expect(app.globalDb.networkMembers.isMember(targetNetwork.id, user!.id)).toBe(true);

    adminSocket.close();
    registerSocket.close();
    loginSocket.close();
  });

  it('returns and updates human member profile fields', async () => {
    const createdAt = Date.now() - 10_000;
    app.globalDb.users.create({
      id: 'human-profile-1',
      username: 'profile-user',
      email: 'profile@example.com',
      createdAt,
    });
    app.globalDb.networkMembers.add('default', 'human-profile-1', 'member');

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('human-profile-1', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));

    const listBefore = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    const humanBefore = listBefore.humans.find((human: any) => human.userId === 'human-profile-1');
    expect(humanBefore).toMatchObject({
      username: 'profile-user',
      email: 'profile@example.com',
      description: null,
      role: 'member',
    });
    expect(typeof humanBefore.joinedAt).toBe('number');
    expect(humanBefore.createdAt).toBe(createdAt);

    const update = await new Promise<any>((resolve) => {
      web.emit('member:update-human', { userId: 'human-profile-1', description: '负责内容运营' }, resolve);
    });
    expect(update.ok).toBe(true);
    expect(update.human).toMatchObject({
      userId: 'human-profile-1',
      description: '负责内容运营',
    });

    const listAfter = await new Promise<any>((resolve) => {
      web.emit('members:list', {}, resolve);
    });
    expect(listAfter.humans.find((human: any) => human.userId === 'human-profile-1').description).toBe('负责内容运营');
    web.close();
  });

  it('returns admin dashboard device and agent ownership fields', async () => {
    app.globalDb.devices.upsert({
      id: 'admin-dev-1',
      userId: 'admin',
      networkId: 'default',
      hostname: 'Mac Studio',
      lastSeenAt: Date.now(),
      systemInfo: { daemonVersion: '0.1.13', hostname: 'mac-studio.local' },
    });
    app.globalDb.agents.upsert({
      id: 'admin-agent-1',
      name: 'Drama',
      role: 'writer',
      adapterKind: 'codex',
      deviceId: 'admin-dev-1',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      ownerId: 'admin',
      command: 'codex',
      cwd: '/tmp/drama',
      description: '写作 Agent',
    });

    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const deviceRes = await new Promise<any>((resolve) => {
      web.emit('admin:list-devices', {}, resolve);
    });
    const agentRes = await new Promise<any>((resolve) => {
      web.emit('admin:list-agents', {}, resolve);
    });

    expect(deviceRes.ok).toBe(true);
    expect(deviceRes.devices[0]).toMatchObject({
      name: 'Mac Studio',
      userName: 'admin',
      networkName: 'Default Team',
      daemonUpdateAvailable: true,
      daemonVersionInfo: {
        current: '0.1.13',
        updateAvailable: true,
        status: 'update-available',
      },
    });
    expect(deviceRes.devices[0].publicAgents[0]).toMatchObject({
      name: 'Drama',
      deviceName: 'Mac Studio',
      userName: 'admin',
      networkName: 'Default Team',
    });
    expect(agentRes.ok).toBe(true);
    expect(agentRes.agents[0]).toMatchObject({
      name: 'Drama',
      deviceName: 'Mac Studio',
      userName: 'admin',
      networkName: 'Default Team',
    });
    web.close();
  });

  it('allows admins to transfer a device owner to another team member', async () => {
    const now = Date.now();
    app.globalDb.users.create({ id: 'old-device-owner', username: 'old-owner', passwordHash: null, createdAt: now });
    app.globalDb.users.create({ id: 'new-device-owner', username: 'test01', passwordHash: null, createdAt: now });
    app.globalDb.networkMembers.add('default', 'old-device-owner', 'member');
    app.globalDb.networkMembers.add('default', 'new-device-owner', 'member');
    app.globalDb.devices.upsert({
      id: 'device-transfer-admin',
      userId: 'old-device-owner',
      networkId: 'default',
      hostname: 'MyMBP',
      lastSeenAt: now,
      systemInfo: { hostname: 'shaw-mac.local' },
    });

    const member = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('old-device-owner', 'default') },
    });
    await new Promise<void>((r) => member.on('connect', () => r()));
    const forbidden = await new Promise<any>((resolve) => {
      member.emit('admin:transfer-device-owner', { deviceId: 'device-transfer-admin', userId: 'new-device-owner' }, resolve);
    });
    expect(forbidden).toEqual({ ok: false, error: 'FORBIDDEN' });
    member.close();

    const admin = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('admin', 'default') },
    });
    await new Promise<void>((r) => admin.on('connect', () => r()));
    const transferred = await new Promise<any>((resolve) => {
      admin.emit('admin:transfer-device-owner', { deviceId: 'device-transfer-admin', userId: 'new-device-owner' }, resolve);
    });
    expect(transferred.ok).toBe(true);
    expect(transferred.device).toMatchObject({
      id: 'device-transfer-admin',
      userId: 'new-device-owner',
      userName: 'test01',
    });
    expect(app.globalDb.devices.get('device-transfer-admin')).toMatchObject({ userId: 'new-device-owner' });

    const devices = await new Promise<any>((resolve) => {
      admin.emit('admin:list-devices', {}, resolve);
    });
    expect(devices.devices.find((device: any) => device.id === 'device-transfer-admin')).toMatchObject({
      userId: 'new-device-owner',
      userName: 'test01',
    });
    admin.close();
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
    const lbase = `http://127.0.0.1:${port}`;

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
      cwd: storageBaseDir,
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
    form.append('metaJson', JSON.stringify({
      kind: 'agent-workspace-file',
      teamId: 'default',
      agentId: 'custom-drama',
      runId: 'run-test',
      pathKind: 'output',
      relativePath: 'runs/run-test/outputs/drama.png',
      sha256: 'fake-sha',
    }));
    form.append('file', new Blob(['fake image']), 'drama.png');
    const uploadRes = await fetch(`${baseUrl}/api/networks/default/artifacts/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer default:default:user-token' },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = await uploadRes.json() as { id: string };
    uploadedArtifactId = uploaded.id;
    const previewRes = await fetch(`${baseUrl}/api/networks/default/artifacts/${uploadedArtifactId}/preview?token=${encodeURIComponent('default:default:user-token')}`);
    expect(previewRes.status).toBe(200);
    const workspaceRes = await fetch(`${baseUrl}/api/networks/default/agents/custom-drama/workspace?token=${encodeURIComponent('default:default:user-token')}`);
    expect(workspaceRes.status).toBe(200);
    const workspace = await workspaceRes.json() as any;
    expect(workspace.runs?.[0]).toMatchObject({
      runId: 'run-test',
      files: [{ id: uploadedArtifactId, relativePath: 'runs/run-test/outputs/drama.png' }],
    });

    const messages: any[] = [];
    const taskUpdates: any[] = [];
    web.emit('channel:join', { channelId: dmRes.dm.id });
    web.on('channel:message', (m: any) => messages.push(m));
    web.on('task:updated', (task: any) => taskUpdates.push(task));
    await new Promise((r) => setTimeout(r, 50));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: dmRes.dm.id, body: 'hello drama', clientMsgId: 'dm-1', artifactIds: [uploadedArtifactId] }, resolve);
    });
    expect(ack.ok).toBe(true);

    const req = await dispatchSeen;
    expect(req.agentId).toBe('custom-drama');
    expect(req.customAgent).toMatchObject({ id: 'custom-drama', name: 'drama', adapterKind: 'codex' });
    expect(req.attachments?.[0]).toMatchObject({
      id: uploadedArtifactId,
      filename: 'drama.png',
      downloadUrl: `/api/networks/default/artifacts/${uploadedArtifactId}/download`,
    });
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
    const human = messages.find((m) => m.senderKind === 'human' && m.body === 'hello drama');
    expect(human).toBeTruthy();
    expect(human?.artifacts?.[0]?.id).toBe(uploadedArtifactId);
    const humanMeta = JSON.parse(human!.metaJson);
    expect(humanMeta.taskId).toBeTruthy();
    expect(humanMeta.taskAssigneeName).toBe('drama');
    const taskList = await new Promise<any>((resolve) => {
      web.emit('task:list', { channelId: dmRes.dm.id }, resolve);
    });
    expect(taskList.ok).toBe(true);
    expect(taskList.tasks.find((task: any) => task.id === humanMeta.taskId)).toMatchObject({
      title: 'hello drama',
      assigneeId: 'custom-drama',
      channelId: dmRes.dm.id,
      status: 'done',
    });
    expect(taskUpdates.filter((task) => task.id === humanMeta.taskId).map((task) => task.status)).toEqual(expect.arrayContaining(['in_progress', 'done']));
    const messageCountBeforeTaskUpdate = messages.length;
    const taskUpdate = await new Promise<any>((resolve) => {
      web.emit('task:update', { id: humanMeta.taskId, status: 'closed' }, resolve);
    });
    expect(taskUpdate.ok).toBe(true);
    expect(taskUpdate.task).toMatchObject({ id: humanMeta.taskId, status: 'closed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toHaveLength(messageCountBeforeTaskUpdate);
    expect(taskUpdates.some((task) => task.id === humanMeta.taskId && task.status === 'closed')).toBe(true);
    const reply = messages.find((m) => m.senderKind === 'agent' && m.senderId === 'custom-drama' && m.body === 'custom dm ok');
    expect(reply).toBeTruthy();
    expect(JSON.parse(reply.metaJson).inReplyTo).toBe(human!.id);
    expect(reply.artifacts?.[0]).toMatchObject({
      id: uploadedArtifactId,
      filename: 'drama.png',
      previewUrl: `/api/networks/default/artifacts/${uploadedArtifactId}/preview`,
      downloadUrl: `/api/networks/default/artifacts/${uploadedArtifactId}/download`,
    });

    ag.close(); web.close();
  });

  it('restores custom agent status when daemon reply omits agentId', async () => {
    const now = Date.now();
    const owner = app.globalDb.users.listAll()[0]!;
    app.globalDb.devices.upsert({
      id: 'd-custom-legacy',
      userId: owner.id,
      networkId: 'default',
      hostname: 'legacy-device',
      lastSeenAt: now,
      systemInfo: null,
    });
    app.globalDb.agents.upsert({
      id: 'custom-legacy-drama',
      name: 'drama',
      role: 'executor-agent',
      adapterKind: 'codex',
      deviceId: 'd-custom-legacy',
      networkId: 'default',
      visibility: 'public',
      category: 'executor-hosted',
      source: 'custom',
      firstSeenAt: now,
      lastSeenAt: now,
      command: '/opt/homebrew/bin/codex',
      args: JSON.stringify([]),
      cwd: storageBaseDir,
      ownerId: null,
      description: 'Drama agent',
    });

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-custom-legacy',
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

    const dispatchSeen = new Promise<any>((resolve) => {
      ag.on('dispatch', (req: any) => resolve(req));
    });
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const statuses: any[] = [];
    web.on('agent:status', (status: any) => statuses.push(status));
    const dmRes = await new Promise<any>((resolve) => {
      web.emit('dm:start', { agentId: 'custom-legacy-drama' }, resolve);
    });
    expect(dmRes.ok).toBe(true);
    web.emit('channel:join', { channelId: dmRes.dm.id });
    await new Promise((r) => setTimeout(r, 50));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: dmRes.dm.id, body: 'legacy reply', clientMsgId: 'legacy-1' }, resolve);
    });
    expect(ack.ok).toBe(true);
    const req = await dispatchSeen;
    expect(statuses.some((s) => s.id === 'custom-legacy-drama' && s.status === 'busy')).toBe(true);

    ag.emit('reply', {
      channelId: req.channelId,
      body: 'legacy custom ok',
      requestId: req.requestId,
    });

    await waitFor(() => statuses.some((s) => s.id === 'custom-legacy-drama' && s.status === 'online'));
    expect(statuses.some((s) => s.id === 'custom-legacy-drama' && s.status === 'online')).toBe(true);

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
      cwd: storageBaseDir,
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

  it('does not duplicate the current thread message in dispatch history', async () => {
    const agentos = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-thread-hermes',
        networkId: 'default',
        agents: [{ id: 'hermes-thread', name: 'Hermes-Agent', role: 'r', adapterKind: 'hermes', category: 'agentos-hosted', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => agentos.on('connect', () => r()));
    agentos.emit('register');

    const requests: any[] = [];
    agentos.on('dispatch', (req: any) => {
      requests.push(req);
      const body = requests.length === 1 ? 'first reply' : 'thread reply';
      agentos.emit('reply', { agentId: 'hermes-thread', channelId: req.channelId, body, requestId: req.requestId });
    });

    const ch = app.channels.create('default', { name: `thread-${Date.now()}`, agentIds: ['hermes-thread'] });
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'], auth: { token: 'default:default:tok' } });
    await new Promise<void>((r) => web.on('connect', () => r()));
    web.emit('channel:join', { channelId: ch.id });
    await new Promise((r) => setTimeout(r, 50));

    const rootAck = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: ch.id, body: '@Hermes-Agent hello', clientMsgId: 'thread-root' }, resolve);
    });
    expect(rootAck.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests[0].prompt).toBe('@Hermes-Agent hello');
    expect(requests[0].history.some((turn: any) => turn.body === '@Hermes-Agent hello')).toBe(false);

    const replyAck = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: ch.id, body: '你装了哪些 Skills？', parentMessageId: rootAck.id, clientMsgId: 'thread-reply' }, resolve);
    });
    expect(replyAck.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    expect(requests[1].agentId).toBe('hermes-thread');
    expect(requests[1].prompt).toBe('你装了哪些 Skills？');
    expect(requests[1].history.some((turn: any) => turn.body === '你装了哪些 Skills？')).toBe(false);
    expect(requests[1].history.some((turn: any) => turn.body === '@Hermes-Agent hello')).toBe(true);
    expect(requests[1].history.some((turn: any) => turn.body === 'first reply')).toBe(true);

    agentos.close(); web.close();
  });

  it('sends display names and skips system events in agent dispatch history', async () => {
    app.globalDb.users.create({
      id: 'raw-user-id',
      username: 'shaw',
      passwordHash: null,
      createdAt: Date.now(),
    });
    app.globalDb.networkMembers.add('default', 'raw-user-id', 'member');

    const agentos = ioClient(`${baseUrl}/agent`, {
      auth: {
        token: 'default:default:tok',
        deviceId: 'd-history-hermes',
        networkId: 'default',
        agents: [{ id: 'hermes-history', name: 'Hermes-Agent', role: 'r', adapterKind: 'hermes', category: 'agentos-hosted', visibility: 'public' }],
      },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => agentos.on('connect', () => r()));
    agentos.emit('register');

    const requests: any[] = [];
    agentos.on('dispatch', (req: any) => {
      requests.push(req);
      agentos.emit('reply', { agentId: 'hermes-history', channelId: req.channelId, body: requests.length === 1 ? 'first reply' : 'second reply', requestId: req.requestId });
    });

    const ch = app.channels.create('default', { name: `history-${Date.now()}`, agentIds: ['hermes-history'] });
    const web = ioClient(`${baseUrl}/web`, {
      reconnection: false,
      transports: ['websocket'],
      auth: { token: generateToken('raw-user-id', 'default') },
    });
    await new Promise<void>((r) => web.on('connect', () => r()));
    web.emit('channel:join', { channelId: ch.id });
    await new Promise((r) => setTimeout(r, 50));

    const firstAck = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: ch.id, body: '@Hermes-Agent 第一条', asTask: true, clientMsgId: 'history-1' }, resolve);
    });
    expect(firstAck.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(requests[0].history.some((turn: any) => turn.role === 'system' || turn.body.includes('已创建任务'))).toBe(false);

    const secondAck = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: ch.id, body: '@Hermes-Agent 第二条', clientMsgId: 'history-2' }, resolve);
    });
    expect(secondAck.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const firstHumanTurn = requests[1].history.find((turn: any) => turn.body === '@Hermes-Agent 第一条');
    const firstAgentTurn = requests[1].history.find((turn: any) => turn.body === 'first reply');
    expect(firstHumanTurn).toMatchObject({ role: 'user', speaker: 'shaw' });
    expect(firstAgentTurn).toMatchObject({ role: 'assistant', speaker: 'Hermes-Agent' });
    expect(requests[1].history.some((turn: any) => turn.speaker === 'raw-user-id')).toBe(false);
    expect(requests[1].history.some((turn: any) => turn.role === 'system' || turn.body.includes('已创建任务'))).toBe(false);

    agentos.close(); web.close();
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
