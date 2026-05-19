import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '../src/registry.js';
import { startHeartbeatScanner } from '../src/heartbeat-scanner.js';

describe('startHeartbeatScanner', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('marks agents offline after 30s without heartbeat', () => {
    const r = new AgentRegistry();
    r.register('s1', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    const events: string[] = [];
    const stop = startHeartbeatScanner({
      registry: r, timeoutMs: 30_000, intervalMs: 5_000,
      onTimeout: (id) => events.push(id),
    });
    vi.setSystemTime(20_000);
    vi.advanceTimersByTime(5_000);
    expect(r.snapshot('a1')?.status).toBe('online');
    vi.setSystemTime(31_000);
    vi.advanceTimersByTime(5_000);
    expect(r.snapshot('a1')?.status).toBe('offline');
    expect(events).toEqual(['a1']);
    stop();
  });

  it('does not double-fire after already offline', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    const events: string[] = [];
    const stop = startHeartbeatScanner({
      registry: r, timeoutMs: 30_000, intervalMs: 5_000,
      onTimeout: (id) => events.push(id),
    });
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);
    expect(events).toEqual(['a1']);
    stop();
  });

  it('does not mark virtual custom agents offline by heartbeat timeout', () => {
    const r = new AgentRegistry();
    r.registerVirtual({
      id: 'custom-drama',
      name: 'drama',
      role: 'executor-agent',
      adapterKind: 'codex',
      source: 'custom',
      deviceId: 'device-1',
    });
    r.setStatus('custom-drama', 'online');
    const events: string[] = [];
    const stop = startHeartbeatScanner({
      registry: r, timeoutMs: 30_000, intervalMs: 5_000,
      onTimeout: (id) => events.push(id),
    });
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(5_000);
    expect(r.snapshot('custom-drama')?.status).toBe('online');
    expect(events).toEqual([]);
    stop();
  });
});
