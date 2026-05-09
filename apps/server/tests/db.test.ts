import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Db } from '../src/db.js';

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

  it('messages.append + listByChannel orders by created_at', () => {
    const c = db.channels.create({ name: 'c', createdAt: 0 });
    db.messages.append({ id: 'm2', channelId: c.id, senderKind: 'human', senderId: null, body: 'two', createdAt: 200, metaJson: null });
    db.messages.append({ id: 'm1', channelId: c.id, senderKind: 'system', senderId: null, body: 'one', createdAt: 100, metaJson: null });
    const list = db.messages.listByChannel(c.id, 10);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
