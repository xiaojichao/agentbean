import { describe, it, expect } from 'vitest';
import { DeviceRegistry } from '../src/device-registry.js';

describe('DeviceRegistry', () => {
  it('registers a device and lists its agents', () => {
    const reg = new DeviceRegistry();
    const mockSocket = { id: 's1', disconnect: () => {} } as any;
    reg.register({
      id: 'dev-1', userId: 'u1', networkId: 'n1', socket: mockSocket,
      agents: new Map([['a1', { id: 'a1', name: 'Codex', role: 'coder', adapterKind: 'codex' }]]),
      lastSeenAt: Date.now(), status: 'online',
    });
    expect(reg.allAgents('n1')).toHaveLength(1);
    expect(reg.allAgents('n2')).toHaveLength(0);
    expect(reg.getAgentDevice('a1')?.id).toBe('dev-1');
  });

  it('kicks old socket when same deviceId reconnects', () => {
    const reg = new DeviceRegistry();
    const kicks: string[] = [];
    reg.onKick((sid) => kicks.push(sid));

    const sock1 = { id: 's1' } as any;
    reg.register({ id: 'dev-1', userId: 'u1', networkId: 'n1', socket: sock1, agents: new Map(), lastSeenAt: 0, status: 'online' });

    const sock2 = { id: 's2' } as any;
    reg.register({ id: 'dev-1', userId: 'u1', networkId: 'n1', socket: sock2, agents: new Map(), lastSeenAt: 0, status: 'online' });

    expect(kicks).toContain('s1');
    expect(reg.get('dev-1')?.socket.id).toBe('s2');
  });

  it('finds device by socket id', () => {
    const reg = new DeviceRegistry();
    const sock = { id: 'sock-42' } as any;
    reg.register({ id: 'dev-x', userId: 'u1', networkId: 'n1', socket: sock, agents: new Map(), lastSeenAt: 0, status: 'online' });
    expect(reg.getBySocket('sock-42')?.id).toBe('dev-x');
  });
});
