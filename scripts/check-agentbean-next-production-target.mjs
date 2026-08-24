#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { validatePublicHttpTarget } from './observe-maintain-signal.mjs';

export async function checkProductionTarget({
  entryUrl,
  allowedOrigin = 'https://api.agentbean.dev',
  resolveHostImpl,
} = {}) {
  try {
    const parsed = new URL(entryUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        schemaVersion: 1, ok: false, authority: 'read_only_target_validation',
        origin: null, reason: 'entry_url_protocol_invalid', httpRequestCount: 0, mutationCount: 0,
      };
    }
    if (parsed.username || parsed.password) {
      return {
        schemaVersion: 1, ok: false, authority: 'read_only_target_validation',
        origin: null, reason: 'entry_url_credentials_forbidden', httpRequestCount: 0, mutationCount: 0,
      };
    }
    if (entryUrl !== parsed.origin) {
      return {
        schemaVersion: 1, ok: false, authority: 'read_only_target_validation',
        origin: null, reason: 'target_url_not_canonical', httpRequestCount: 0, mutationCount: 0,
      };
    }
  } catch {
    // The shared validator returns a stable, non-secret parse reason below.
  }
  const validation = await validatePublicHttpTarget({ entryUrl, allowedOrigin, resolveHostImpl });
  return {
    schemaVersion: 1,
    ok: validation.ok,
    authority: 'read_only_target_validation',
    origin: validation.ok ? validation.origin : null,
    reason: validation.reason,
    httpRequestCount: 0,
    mutationCount: 0,
  };
}

function parseArgs(argv) {
  const options = {
    entryUrl: process.env.AGENTBEAN_NEXT_ENTRY_URL ?? '',
    allowedOrigin: 'https://api.agentbean.dev',
    json: false,
  };
  const valueFor = (flag, index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${flag} 缺少参数值`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--url') {
      options.entryUrl = valueFor(flag, index);
      index += 1;
    } else if (flag === '--allowed-origin') {
      options.allowedOrigin = valueFor(flag, index);
      index += 1;
    } else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  return options;
}

function formatResult(result) {
  return result.ok
    ? `Production smoke target PASS：${result.origin}`
    : `Production smoke target BLOCKED：${result.reason}`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('用法：node scripts/check-agentbean-next-production-target.mjs [--url URL] [--allowed-origin ORIGIN] [--json]');
      return;
    }
    const result = await checkProductionTarget(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatResult(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`PRODUCTION_TARGET_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
