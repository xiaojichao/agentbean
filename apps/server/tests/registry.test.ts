import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRegistry } from '../src/registry.js';

describe('AgentRegistry', () => {
  const baseInfo = { name: 'A1', role: 'social', adapterKind: 'codex' as const };
  let now: number;
  beforeEach(() => { now = 1_000_000; vi.useFakeTimers(); vi.setSystemTime(now); });

  it('register transitions connecting → online', () => {
    const r = new AgentRegistry();
    const before = r.snapshot('a1');
    expect(before).toBeNull();
    r.register('socket-1', { id: 'a1', ...baseInfo });
    const snap = r.snapshot('a1');
    expect(snap?.status).toBe('online');
    expect(snap?.socketId).toBe('socket-1');
    expect(snap?.lastHeartbeatAt).toBe(now);
  });

  it('register on existing id with new socket kicks the old one', () => {
    const r = new AgentRegistry();
    r.register('socket-1', { id: 'a1', ...baseInfo });
    const kicked: string[] = [];
    r.onKick((sid) => kicked.push(sid));
    r.register('socket-2', { id: 'a1', ...baseInfo });
    expect(kicked).toEqual(['socket-1']);
    expect(r.snapshot('a1')?.socketId).toBe('socket-2');
  });

  it('heartbeat updates lastHeartbeatAt and clears error', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', ...baseInfo });
    r.markError('a1', 'boom');
    expect(r.snapshot('a1')?.status).toBe('error');
    vi.setSystemTime(now + 5_000);
    r.heartbeat('a1');
    expect(r.snapshot('a1')?.lastHeartbeatAt).toBe(now + 5_000);
    expect(r.snapshot('a1')?.status).toBe('online');
    expect(r.snapshot('a1')?.lastError).toBeUndefined();
  });

  it('markOffline keeps the runtime entry but flips status', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', ...baseInfo });
    r.markOffline('a1', 'heartbeat-timeout');
    const snap = r.snapshot('a1');
    expect(snap?.status).toBe('offline');
    expect(snap?.socketId).toBeNull();
  });

  it('all() returns sorted snapshots', () => {
    const r = new AgentRegistry();
    r.register('s1', { id: 'b1', name: 'B', role: 'r', adapterKind: 'codex' });
    r.register('s2', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    expect(r.all().map((a) => a.id)).toEqual(['a1', 'b1']);
  });
});
