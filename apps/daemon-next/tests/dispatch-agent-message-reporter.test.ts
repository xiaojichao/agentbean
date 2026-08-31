import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import { createDispatchAgentMessageReporter } from '../src/dispatch-agent-message-reporter';

describe('dispatch Agent message reporter', () => {
  test('builds a stable first-update envelope from the dispatch lineage', async () => {
    const emitWithAck = vi.fn(async () => ({ ok: true }));
    const report = createDispatchAgentMessageReporter({
      socket: { connected: true, emitWithAck },
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      now: () => 123,
    });

    await report({ sequence: 1, kind: 'plan', body: '先检查请求，再整理结果。' });

    expect(emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.dispatch.message, {
      schemaVersion: 1,
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      updateId: 'dispatch-1:agent-message:1',
      sequence: 1,
      kind: 'plan',
      body: '先检查请求，再整理结果。',
      sentAt: 123,
    });
  });

  test('does not let a missing ack block the terminal result path', async () => {
    const report = createDispatchAgentMessageReporter({
      socket: { connected: true, emitWithAck: () => new Promise(() => {}) },
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      ackTimeoutMs: 5,
    });

    await expect(report({ sequence: 1, kind: 'plan', body: '先检查请求。' })).resolves.toBeUndefined();
  });

  test('keeps the structured status fallback when disconnected', async () => {
    const emitWithAck = vi.fn(async () => ({ ok: true }));
    const report = createDispatchAgentMessageReporter({
      socket: { connected: false, emitWithAck },
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    });

    await report({ sequence: 1, kind: 'plan', body: '先检查请求。' });
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});
