import { describe, expect, test } from 'vitest';
import { runAgentBeanNextBusinessSmoke } from '../../../scripts/smoke-agentbean-next-business.mjs';
import { startServerNextDevServer } from '../src/dev-server';

describe('AgentBean Next business smoke', () => {
  test('runs register -> daemon -> custom agent -> message -> reply against server-next', async () => {
    const server = await startServerNextDevServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir: '.agentbean-next-test',
        sessionSecret: 'business-smoke-test-secret',
      },
    });

    try {
      const summary = await runAgentBeanNextBusinessSmoke({
        baseUrl: server.baseUrl,
        suffix: 'test',
        timeoutMs: 2_000,
      });

      expect(summary).toMatchObject({
        ok: true,
        failed: 0,
        total: 8,
      });
      expect(summary.checks.map((check) => check.id)).toEqual([
        'business-url-present',
        'business-sockets-connected',
        'business-register-login',
        'business-daemon-hello',
        'business-runtime-report',
        'business-custom-agent-create',
        'business-message-dispatch',
        'business-agent-reply-visible',
      ]);
    } finally {
      await server.close();
    }
  });

  test('reports a missing target URL without connecting sockets', async () => {
    const summary = await runAgentBeanNextBusinessSmoke();

    expect(summary).toEqual({
      ok: false,
      total: 1,
      failed: 1,
      checks: [
        {
          id: 'business-url-present',
          ok: false,
          message: 'AgentBean Next business smoke needs --url or AGENTBEAN_NEXT_ENTRY_URL',
        },
      ],
    });
  });
});
