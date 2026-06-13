import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanNextEntrySmoke,
  summarizeEntrySmoke,
} from '../../../scripts/smoke-agentbean-next-entry.mjs';

describe('AgentBean Next entry smoke', () => {
  test('passes when the public entry serves server-next health, preview shell, and Socket.IO client', async () => {
    const checks = await collectAgentBeanNextEntrySmoke({
      baseUrl: 'https://agentbean.example',
      fetcher: createFakeFetcher({
        '/healthz': json({ ok: true, service: 'agentbean-next-server' }),
        '/': html(`
          <title>AgentBean</title>
          <section class="landing">
            <h1>让人类、本机 Agent 和远程设备上的 Agent 无缝协作</h1>
          </section>
          <main id="app-workspace">
          <p>私有 Agent 团队</p>
          <button class="team-switcher">AgentBean</button>
          <h2>添加自定义 Agent</h2>
          </main>
        `),
        '/socket.io/socket.io.js': text('/* socket.io */ var io = {};'),
      }),
    });

    expect(summarizeEntrySmoke(checks)).toMatchObject({
      ok: true,
      failed: 0,
      total: 4,
    });
  });

  test('fails when the root page is still the harness or old entry', async () => {
    const checks = await collectAgentBeanNextEntrySmoke({
      baseUrl: 'https://agentbean.example',
      fetcher: createFakeFetcher({
        '/healthz': json({ ok: true, service: 'agentbean-next-server' }),
        '/': html('<title>AgentBean Next Preview</title><p>Next local</p>'),
        '/socket.io/socket.io.js': text('/* socket.io */ var io = {};'),
      }),
    });

    expect(checks.find((check) => check.id === 'entry-root-html-agentbean')).toMatchObject({
      ok: false,
    });
    expect(summarizeEntrySmoke(checks)).toMatchObject({
      ok: false,
      failed: 1,
    });
  });

  test('reports a missing target URL without fetching', async () => {
    const checks = await collectAgentBeanNextEntrySmoke();

    expect(checks).toEqual([
      {
        id: 'entry-url-present',
        ok: false,
        message: 'AgentBean Next entry smoke needs --url or AGENTBEAN_NEXT_ENTRY_URL',
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
  return text(JSON.stringify(value));
}

function html(value: string): FakeResponse {
  return text(value);
}

function text(value: string): FakeResponse {
  return {
    ok: true,
    status: 200,
    text: async () => value,
  };
}
