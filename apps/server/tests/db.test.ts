import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initGlobalDb, openDb, type Db } from '../src/db.js';

let dbPath: string;
let db: Db;

beforeEach(() => {
  dbPath = join(tmpdir(), `agentbean-test-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
});

describe('openDb', () => {
  it('creates the four core tables', () => {
    const names = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['agents', 'channel_members', 'channels', 'messages']));
  });

  it('agents.upsert / getAll round-trips fields', () => {
    db.agents.upsert({
      id: 'a1', name: 'Shaw-A1', role: 'social', adapterKind: 'codex',
      visibility: 'public',
      deviceId: null, networkId: 'default', category: 'coding' as any,
      firstSeenAt: 100, lastSeenAt: 200, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    db.agents.upsert({
      id: 'a1', name: 'Shaw-A1', role: 'social', adapterKind: 'codex',
      visibility: 'public',
      deviceId: null, networkId: 'default', category: 'coding' as any,
      firstSeenAt: 100, lastSeenAt: 300, lastError: 'oops',
      ownerId: 'shaw', command: '/usr/bin/codex', args: '["--verbose"]', cwd: null,
    });
    const all = db.agents.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'a1', lastSeenAt: 300, lastError: 'oops', ownerId: 'shaw', command: '/usr/bin/codex' });
  });

  it('channels.create + channelMembers.add wires foreign keys', () => {
    const c = db.channels.create({ name: 'channel-1', createdAt: 10 });
    expect(c.id).toBeTruthy();
    db.agents.upsert({
      id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex',
      visibility: 'public',
      deviceId: null, networkId: 'default', category: 'coding' as any,
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    db.channelMembers.add({ channelId: c.id, agentId: 'a1', joinedAt: 11 });
    const members = db.channelMembers.list(c.id);
    expect(members).toEqual([{ channelId: c.id, agentId: 'a1', joinedAt: 11 }]);
  });

  it('agents table has source column with default self-register', () => {
    db.agents.upsert({
      id: 'a-src', name: 'Test', role: 'r', adapterKind: 'codex',
      visibility: 'public',
      deviceId: 'dev1', networkId: 'default', category: 'executor-hosted',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    const row = db.raw.prepare('SELECT source FROM agents WHERE id = ?').get('a-src') as any;
    expect(row.source).toBe('self-register');
  });

  it('agents.upsert persists explicit source', () => {
    db.agents.upsert({
      id: 'a-sc', name: 'Scanned', role: 'r', adapterKind: 'claude-code',
      visibility: 'public',
      deviceId: 'dev1', networkId: 'default', category: 'executor-hosted',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: '/usr/bin/claude', args: null, cwd: null,
    } as any);
    // Update with source
    db.raw.prepare('UPDATE agents SET source = ? WHERE id = ?').run('scanned', 'a-sc');
    const row = db.agents.get('a-sc');
    expect(row).toBeTruthy();
  });

  it('agents.listByDevice returns agents for a specific device', () => {
    db.agents.upsert({
      id: 'a-d1', name: 'A1', role: 'r', adapterKind: 'codex',
      visibility: 'public',
      deviceId: 'devX', networkId: 'default', category: 'executor-hosted',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    db.agents.upsert({
      id: 'a-d2', name: 'A2', role: 'r', adapterKind: 'hermes',
      visibility: 'public',
      deviceId: 'devY', networkId: 'default', category: 'agentos-hosted',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    db.agents.upsert({
      id: 'a-d3', name: 'A3', role: 'r', adapterKind: 'codex',
      visibility: 'public',
      deviceId: 'devX', networkId: 'default', category: 'executor-hosted',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
      ownerId: null, command: null, args: null, cwd: null,
    });
    const devXAgents = db.agents.listByDevice('devX');
    expect(devXAgents).toHaveLength(2);
    expect(devXAgents.map((a) => a.id).sort()).toEqual(['a-d1', 'a-d3']);
    const devYAgents = db.agents.listByDevice('devY');
    expect(devYAgents).toHaveLength(1);
    expect(devYAgents[0].id).toBe('a-d2');
  });

  it('devices.upsert moves a stable device id to the latest invite owner and team', () => {
    const globalPath = join(tmpdir(), `agentbean-global-test-${Date.now()}-${Math.random()}.db`);
    const global = initGlobalDb(globalPath);
    const now = Date.now();
    try {
      global.users.create({ id: 'u1', username: 'u1', createdAt: now });
      global.users.create({ id: 'u2', username: 'u2', createdAt: now });
      global.networks.create({ id: 'team-1', ownerId: 'u1', name: 'Team 1', path: 'team-1', visibility: 'public', createdAt: now });
      global.networks.create({ id: 'team-2', ownerId: 'u2', name: 'Team 2', path: 'team-2', visibility: 'public', createdAt: now });

      global.devices.upsert({
        id: 'stable-device',
        userId: 'u1',
        networkId: 'team-1',
        hostname: 'My-Mac',
        lastSeenAt: now,
        systemInfo: { daemonVersion: '0.1.24' },
      });
      global.devices.upsert({
        id: 'stable-device',
        userId: 'u2',
        networkId: 'team-2',
        hostname: 'My-Mac',
        lastSeenAt: now + 1,
        systemInfo: { daemonVersion: '0.1.25' },
      });

      expect(global.devices.listByNetwork('team-1')).toHaveLength(0);
      expect(global.devices.listByNetwork('team-2')).toHaveLength(1);
      expect(global.devices.get('stable-device')).toMatchObject({
        userId: 'u2',
        networkId: 'team-2',
        lastSeenAt: now + 1,
      });
    } finally {
      global.close();
      try { unlinkSync(globalPath); } catch {}
    }
  });

  it('messages.append + listByChannel orders by created_at', () => {
    const c = db.channels.create({ name: 'c', createdAt: 0 });
    db.messages.append({ id: 'm2', channelId: c.id, senderKind: 'human', senderId: null, body: 'two', createdAt: 200, metaJson: null });
    db.messages.append({ id: 'm1', channelId: c.id, senderKind: 'system', senderId: null, body: 'one', createdAt: 100, metaJson: null });
    const list = db.messages.listByChannel(c.id, 10);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
