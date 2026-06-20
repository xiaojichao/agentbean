#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

export async function collectAgentBeanNextEntrySmoke({
  baseUrl,
  fetcher = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return [
      check(
        'entry-url-present',
        false,
        'AgentBean Next entry smoke needs --url or AGENTBEAN_NEXT_ENTRY_URL',
      ),
    ];
  }

  const health = await readJson(fetcher, new URL('/healthz', normalizedBaseUrl));
  const html = await readText(fetcher, new URL('/', normalizedBaseUrl));
  const socketClient = await readText(fetcher, new URL('/socket.io/socket.io.js', normalizedBaseUrl));

  return [
    check('entry-url-present', true, 'AgentBean Next entry smoke target URL is configured'),
    check(
      'entry-healthz-ok',
      health.ok && health.value?.ok === true && health.value?.service === 'agentbean-next-server',
      health.ok
        ? 'AgentBean Next entry /healthz must return the server-next health payload'
        : `AgentBean Next entry /healthz could not be read: ${health.error}`,
    ),
    check(
      'entry-root-html-agentbean',
      html.ok && isAgentBeanNextProductEntryHtml(html.value),
      html.ok
        ? 'AgentBean Next entry root page must serve the landing-first product entry or the production Next App Router shell, not the old or harness entry'
        : `AgentBean Next entry root page could not be read: ${html.error}`,
    ),
    check(
      'entry-socket-client-served',
      socketClient.ok &&
        socketClient.value.includes('socket.io') &&
        socketClient.value.includes('io'),
      socketClient.ok
        ? 'AgentBean Next entry must serve Socket.IO client assets for realtime web sessions'
        : `AgentBean Next Socket.IO client could not be read: ${socketClient.error}`,
    ),
  ];
}

function isAgentBeanNextProductEntryHtml(value) {
  if (value.includes('AgentBean Next Preview') || value.includes('Next local')) {
    return false;
  }
  return isStaticPreviewProductEntry(value) || isNextAppRouterProductEntryShell(value);
}

function isStaticPreviewProductEntry(value) {
  return (
    value.includes('<title>AgentBean</title>') &&
    value.includes('class="landing"') &&
    value.includes('让人类、本机 Agent 和远程设备上的 Agent 无缝协作') &&
    value.includes('id="app-workspace"') &&
    value.includes('私有 Agent 团队') &&
    value.includes('team-switcher') &&
    value.includes('添加自定义 Agent')
  );
}

function isNextAppRouterProductEntryShell(value) {
  return (
    value.includes('<title>AgentBean</title>') &&
    value.includes('Your AI Agent Platform') &&
    value.includes('/_next/static/chunks/app/page-') &&
    value.includes('/_next/static/chunks/app/layout-') &&
    value.includes('SocketProvider') &&
    value.includes('AppShell')
  );
}

export function summarizeEntrySmoke(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

function normalizeBaseUrl(input) {
  if (!input) {
    return undefined;
  }
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function readJson(fetcher, url) {
  const result = await readText(fetcher, url);
  if (!result.ok) {
    return result;
  }
  try {
    return { ok: true, value: JSON.parse(result.value), error: undefined };
  } catch (error) {
    return {
      ok: false,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readText(fetcher, url) {
  try {
    const response = await fetcher(url);
    if (!response?.ok) {
      return {
        ok: false,
        value: '',
        error: `HTTP ${response?.status ?? 'unknown'}`,
      };
    }
    return { ok: true, value: await response.text(), error: undefined };
  } catch (error) {
    return {
      ok: false,
      value: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function check(id, ok, message) {
  return { id, ok, message };
}

function parseArgs(argv) {
  const urlIndex = argv.indexOf('--url');
  return {
    json: argv.includes('--json'),
    url: urlIndex >= 0 ? argv[urlIndex + 1] : undefined,
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next entry smoke passed (${summary.total}/${summary.total}).`
      : `AgentBean Next entry smoke failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.url ?? process.env.AGENTBEAN_NEXT_ENTRY_URL;
  const summary = summarizeEntrySmoke(await collectAgentBeanNextEntrySmoke({ baseUrl }));
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
