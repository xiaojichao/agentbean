#!/usr/bin/env node

import { resolve } from 'node:path';
import { runAgentBeanChannelCollaborationRestartBrowserSmoke } from './smoke-agentbean-next-browser.mjs';

const options = parseArgs(process.argv.slice(2));
const summary = await runAgentBeanChannelCollaborationRestartBrowserSmoke(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  for (const item of summary.checks) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}: ${item.message}\n`);
  }
}
if (!summary.ok) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = { timeoutMs: 90_000, headed: false, skipBuild: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--chrome-bin') parsed.chromeBin = requiredValue(argv, ++index, argument);
    else if (argument === '--artifacts-dir') parsed.artifactsDir = resolve(requiredValue(argv, ++index, argument));
    else if (argument === '--timeout-ms') parsed.timeoutMs = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === '--headed') parsed.headed = true;
    else if (argument === '--skip-build') parsed.skipBuild = true;
    else if (argument === '--json') parsed.json = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} must be a positive integer`);
  return parsed;
}
