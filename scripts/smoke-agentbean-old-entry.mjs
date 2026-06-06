#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

export async function collectAgentBeanOldEntrySmoke({
  baseUrl,
  fetcher = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return [
      check(
        'old-entry-url-present',
        false,
        'AgentBean old entry smoke needs --url, AGENTBEAN_OLD_ENTRY_URL, or AGENTBEAN_NEXT_ENTRY_URL',
      ),
    ];
  }

  const health = await readJson(fetcher, new URL('/healthz', normalizedBaseUrl));

  return [
    check('old-entry-url-present', true, 'AgentBean old entry smoke target URL is configured'),
    check(
      'old-entry-healthz-ok',
      health.ok && health.value?.status === 'ok',
      health.ok
        ? 'Old AgentBean entry /healthz must return the old server health payload'
        : `Old AgentBean entry /healthz could not be read: ${health.error}`,
    ),
    check(
      'old-entry-not-next-server',
      health.ok && !(health.value?.ok === true && health.value?.service === 'agentbean-next-server'),
      health.ok
        ? 'Old AgentBean entry /healthz must not return the AgentBean Next server health payload'
        : `Old AgentBean entry /healthz could not be read: ${health.error}`,
    ),
  ];
}

export function summarizeOldEntrySmoke(checks) {
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
  try {
    const response = await fetcher(url);
    if (!response?.ok) {
      return {
        ok: false,
        value: undefined,
        error: `HTTP ${response?.status ?? 'unknown'}`,
      };
    }
    return { ok: true, value: JSON.parse(await response.text()), error: undefined };
  } catch (error) {
    return {
      ok: false,
      value: undefined,
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
      ? `AgentBean old entry smoke passed (${summary.total}/${summary.total}).`
      : `AgentBean old entry smoke failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl =
    args.url ?? process.env.AGENTBEAN_OLD_ENTRY_URL ?? process.env.AGENTBEAN_NEXT_ENTRY_URL;
  const summary = summarizeOldEntrySmoke(await collectAgentBeanOldEntrySmoke({ baseUrl }));
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
