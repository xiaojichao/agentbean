import { describe, it, expect, vi } from 'vitest';
import { runIntros, type DispatchFn } from '../src/intro.js';
import { AgentRegistry } from '../src/registry.js';

describe('runIntros', () => {
  it('dispatches one self-introduction per online member', async () => {
    const registry = new AgentRegistry();
    registry.register('s1', { id: 'a1', name: 'A1', role: 'social', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });
    registry.register('s2', { id: 'a2', name: 'A2', role: 'eng', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });

    const dispatched: any[] = [];
    const dispatch: DispatchFn = vi.fn(async (req) => {
      dispatched.push(req);
      return { ok: true, body: `intro from ${req.agentId}` };
    });
    const messages: any[] = [];

    await runIntros({
      channel: { id: 'c1', name: '频道 1' },
      members: [registry.snapshot('a1')!, registry.snapshot('a2')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });

    expect(dispatched.map((d) => d.agentId).sort()).toEqual(['a1', 'a2']);
    expect(dispatched[0].prompt).toContain('频道 1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ channelId: 'c1', senderKind: 'agent', body: expect.stringContaining('intro') });
    expect(JSON.parse(messages[0].metaJson)).toMatchObject({ senderName: 'A1' });
  });

  it('emits a system failure message when dispatch returns ok=false', async () => {
    const registry = new AgentRegistry();
    registry.register('s', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });
    const dispatch: DispatchFn = async () => ({ ok: false, error: 'CLI exited 1' });
    const messages: any[] = [];
    await runIntros({
      channel: { id: 'c1', name: 'cn' },
      members: [registry.snapshot('a1')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });
    expect(messages[0]).toMatchObject({
      senderKind: 'system',
      body: expect.stringContaining('A1'),
    });
  });

  it('skips members who are offline', async () => {
    const registry = new AgentRegistry();
    registry.register('s', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', category: 'coding' as any, networkId: 'default' });
    registry.markOffline('a1', 'test');
    const dispatch: DispatchFn = vi.fn();
    const messages: any[] = [];
    await runIntros({
      channel: { id: 'c1', name: 'cn' },
      members: [registry.snapshot('a1')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(messages[0]).toMatchObject({
      senderKind: 'system',
      body: expect.stringContaining('离线'),
    });
  });
});
