import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanOldEntrySmoke,
  summarizeOldEntrySmoke,
} from '../../../scripts/smoke-agentbean-old-entry.mjs';

describe('AgentBean old entry smoke', () => {
  test('passes when the public entry serves the old server health payload', async () => {
    const checks = await collectAgentBeanOldEntrySmoke({
      baseUrl: 'https://agentbean.example',
      fetcher: createFakeFetcher({
        '/healthz': json({ status: 'ok' }),
      }),
    });

    expect(summarizeOldEntrySmoke(checks)).toMatchObject({
      ok: true,
      failed: 0,
      total: 3,
    });
  });

  test('fails when the public entry still serves server-next health', async () => {
    const checks = await collectAgentBeanOldEntrySmoke({
      baseUrl: 'https://agentbean.example',
      fetcher: createFakeFetcher({
        '/healthz': json({ ok: true, service: 'agentbean-next-server' }),
      }),
    });

    expect(checks.find((check) => check.id === 'old-entry-healthz-ok')).toMatchObject({
      ok: false,
    });
    expect(checks.find((check) => check.id === 'old-entry-not-next-server')).toMatchObject({
      ok: false,
    });
    expect(summarizeOldEntrySmoke(checks)).toMatchObject({
      ok: false,
      failed: 2,
    });
  });

  test('reports a missing target URL without fetching', async () => {
    const checks = await collectAgentBeanOldEntrySmoke();

    expect(checks).toEqual([
      {
        id: 'old-entry-url-present',
        ok: false,
        message:
          'AgentBean old entry smoke needs --url, AGENTBEAN_OLD_ENTRY_URL, or AGENTBEAN_NEXT_ENTRY_URL',
      },
    ]);
  });
});

function createFakeFetcher(routes: Record<string, FakeResponse>) {
  return async (url: URL) => {
    const response = routes[url.pathname];
    return response ?? { ok: false, status: 404, text: async () => 'not found' };
  };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function json(value: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}
