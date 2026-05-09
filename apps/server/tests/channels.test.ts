import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { StorageManager } from '../src/storage.js';
import { ChannelService } from '../src/channels.js';
import { AgentRegistry } from '../src/registry.js';

let storage: StorageManager;
let svc: ChannelService;
let registry: AgentRegistry;
let testDir: string;

beforeEach(() => {
  testDir = `./data/test-channels-${Date.now()}`;
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  storage = new StorageManager(testDir);
  storage.createSpace('test-net');
  registry = new AgentRegistry();
  svc = new ChannelService({ storageManager: storage, registry });
  registry.register('s1', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });
  registry.register('s2', { id: 'a2', name: 'A2', role: 'r', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });
});

afterEach(() => {
  storage.closeAll();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe('ChannelService', () => {
  it('create requires at least one agentId', () => {
    expect(() => svc.create('test-net', { name: '频道 1', agentIds: [] })).toThrow(/NO_AGENT/);
  });

  it('create persists channel and members', () => {
    const ch = svc.create('test-net', { name: '', agentIds: ['a1', 'a2'] });
    expect(ch.name).toBe('频道 1');
    const members = svc.memberIds('test-net', ch.id);
    expect(members.sort()).toEqual(['a1', 'a2']);
  });

  it('create autonumbers default channel name', () => {
    const c1 = svc.create('test-net', { name: '', agentIds: ['a1'] });
    const c2 = svc.create('test-net', { name: '', agentIds: ['a2'] });
    expect(c1.name).toBe('频道 1');
    expect(c2.name).toBe('频道 2');
  });

  it('list returns channels in created order', () => {
    const a = svc.create('test-net', { name: 'foo', agentIds: ['a1'] });
    const b = svc.create('test-net', { name: 'bar', agentIds: ['a1'] });
    expect(svc.list('test-net').map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('membersOf returns runtimes for online + offline agents', () => {
    const ch = svc.create('test-net', { name: 'x', agentIds: ['a1', 'a2'] });
    registry.markOffline('a2', 'test');
    const members = svc.membersOf('test-net', ch.id);
    const sorted = members.sort((m1, m2) => m1.id.localeCompare(m2.id));
    expect(sorted.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(sorted[0]!.status).toBe('online');
    expect(sorted[1]!.status).toBe('offline');
  });
});
