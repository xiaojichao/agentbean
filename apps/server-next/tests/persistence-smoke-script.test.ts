import { describe, expect, test } from 'vitest';
import { runAgentBeanNextPersistenceSmoke } from '../../../scripts/smoke-agentbean-next-persistence.mjs';
import { startServerNextDevServer } from '../src/dev-server';

describe('AgentBean Next persistence smoke command', () => {
  test('runs SQLite restart persistence checks with an injected server factory', async () => {
    const summary = await runAgentBeanNextPersistenceSmoke({
      serverFactory: startServerNextDevServer,
      suffix: 'test',
      timeoutMs: 1_000,
    });

    expect(summary).toMatchObject({
      ok: true,
      failed: 0,
      total: 6,
    });
    expect(summary.checks.map((check) => check.id)).toEqual([
      'persistence-data-dir-ready',
      'persistence-first-session-created',
      'persistence-message-sent',
      'persistence-server-restarted',
      'persistence-session-restored',
      'persistence-channel-history-restored',
    ]);
  });
});
