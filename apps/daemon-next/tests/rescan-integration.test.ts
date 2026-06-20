import { describe, expect, it, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient } from '../src/index';
import type { DaemonProtocolSocket } from '../src/index';

function fakeSocket(): DaemonProtocolSocket & { emits: Array<{ event: string; payload: unknown }> } {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const socket: DaemonProtocolSocket = {
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      if (event === AGENT_EVENTS.device.hello) return { device: { id: 'dev-1' } };
      return { ok: true };
    },
    on() {}, off() {},
  };
  return Object.assign(socket, { emits });
}

describe('createDaemonProtocolClient periodic rescan', () => {
  it('reports when scan changes via rescanNow', async () => {
    const socket = fakeSocket();
    const initial = { runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] };
    const scan = vi.fn();
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] }); // unchanged on first background tick
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }], agents: [] }); // changed on rescanNow

    const client = createDaemonProtocolClient({
      socket, device: { teamId: 't1', ownerId: 'o1' },
      runtimes: initial.runtimes, agents: initial.agents,
      executor: vi.fn(),
      serverUrl: 'http://localhost',
      scan: scan as any,
      rescanIntervalMs: 60000,
    });
    await client.start();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1)); // first background tick ran (unchanged)

    const runtimesBefore = socket.emits.filter((e) => e.event === AGENT_EVENTS.device.runtimes).length;
    await client.rescanNow!();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    const runtimesAfter = socket.emits.filter((e) => e.event === AGENT_EVENTS.device.runtimes).length;
    expect(runtimesAfter).toBeGreaterThan(runtimesBefore); // changed -> reported
    client.stop?.();
  });
});
