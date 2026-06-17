import { describe, expect, test, vi } from 'vitest';
import { createHttpEnvResolver } from '../src/env-fetcher';

describe('daemon-next env fetcher', () => {
  test('fetches agent env with a bearer token and encoded path ids', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, env: { OPENAI_API_KEY: 'secret-value' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const resolver = createHttpEnvResolver({
      serverUrl: 'http://127.0.0.1:4100',
      token: 'device-token',
      fetch,
    });

    await expect(resolver({ teamId: 'team/1', agentId: 'agent 1' })).resolves.toEqual({
      OPENAI_API_KEY: 'secret-value',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/api/teams/team%2F1/agents/agent%201/env',
      { headers: { Authorization: 'Bearer device-token' } },
    );
  });

  test('throws when the server rejects the env request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 403 }));
    const resolver = createHttpEnvResolver({
      serverUrl: 'http://127.0.0.1:4100',
      token: 'device-token',
      fetch,
    });

    await expect(resolver({ teamId: 'team-1', agentId: 'agent-1' })).rejects.toThrow(
      'Agent env fetch failed: 403',
    );
  });
});
