#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function collectAgentBeanNextRailwayPreflightChecks({
  env = process.env,
  runCommand = runCommandSync,
} = {}) {
  const variablesResult = readRailwayVariables({ env, runCommand });
  const volumesResult = readRailwayVolumes({ env, runCommand });
  const variables = normalizeVariables(variablesResult.items);
  const volumes = normalizeVolumes(volumesResult.items);
  const dataDir = normalizePath(env.AGENTBEAN_NEXT_DATA_DIR);
  const dataDirVariable = variables.get('AGENTBEAN_NEXT_DATA_DIR');
  const sessionSecretVariable = variables.get('AGENTBEAN_NEXT_SESSION_SECRET');
  const coveringVolumes = dataDir ? volumes.filter((volume) => volumeCoversPath(volume.mountPath, dataDir)) : [];

  return [
    check('railway-token-present', Boolean(env.RAILWAY_TOKEN), 'RAILWAY_TOKEN must be available to query Railway'),
    check(
      'railway-project-id-present',
      Boolean(env.RAILWAY_PROJECT_ID),
      'RAILWAY_PROJECT_ID must identify the production project',
    ),
    check(
      'railway-service-id-present',
      Boolean(env.RAILWAY_SERVICE_ID),
      'RAILWAY_SERVICE_ID must identify the production backend service',
    ),
    check(
      'railway-environment-id-present',
      Boolean(env.RAILWAY_ENVIRONMENT),
      'RAILWAY_ENVIRONMENT must identify the production environment',
    ),
    check(
      'next-data-dir-present',
      Boolean(dataDir),
      'AGENTBEAN_NEXT_DATA_DIR must be provided by GitHub Actions before Railway preflight',
    ),
    check(
      'railway-variables-readable',
      variablesResult.ok,
      variablesResult.ok
        ? 'Railway service variables must be readable'
        : `Railway service variables could not be read: ${variablesResult.error}`,
    ),
    check(
      'railway-variable-next-data-dir',
      Boolean(dataDirVariable) && (!dataDirVariable.valueVisible || normalizePath(dataDirVariable.value) === dataDir),
      'Railway runtime env must include AGENTBEAN_NEXT_DATA_DIR matching the GitHub Actions value',
    ),
    check(
      'railway-variable-session-secret',
      Boolean(sessionSecretVariable),
      'Railway runtime env must include AGENTBEAN_NEXT_SESSION_SECRET',
    ),
    check(
      'railway-volumes-readable',
      volumesResult.ok,
      volumesResult.ok
        ? 'Railway service volumes must be readable'
        : `Railway service volumes could not be read: ${volumesResult.error}`,
    ),
    check('railway-volume-present', volumes.length > 0, 'Railway production service must have a persistent volume'),
    check(
      'railway-volume-covers-data-dir',
      coveringVolumes.length > 0,
      'At least one Railway production volume mount path must contain AGENTBEAN_NEXT_DATA_DIR',
    ),
  ];
}

export function summarizeRailwayPreflight(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

export function normalizeVariables(input) {
  const records = unwrapList(input);
  const variables = new Map();

  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const name = stringField(record, ['name', 'key', 'variable', 'id']);
    if (!name) {
      continue;
    }
    const value = valueField(record, ['value', 'currentValue', 'rawValue']);
    variables.set(name, {
      name,
      value,
      valueVisible: value !== undefined && value !== null && !isRedactedValue(value),
    });
  }

  if (records.length === 0 && input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string' || value === null) {
        variables.set(name, {
          name,
          value,
          valueVisible: value !== null && !isRedactedValue(value),
        });
      }
    }
  }

  return variables;
}

export function normalizeVolumes(input) {
  return unwrapList(input)
    .filter((record) => record && typeof record === 'object')
    .map((record) => ({
      id: stringField(record, ['id', 'volumeId']),
      name: stringField(record, ['name']),
      mountPath: normalizePath(stringField(record, ['mountPath', 'mount_path', 'mount', 'path'])),
      serviceId: stringField(record, ['serviceId', 'service_id']),
      environmentId: stringField(record, ['environmentId', 'environment_id']),
    }))
    .filter((record) => Boolean(record.mountPath));
}

export function volumeCoversPath(mountPath, targetPath) {
  const normalizedMountPath = normalizePath(mountPath);
  const normalizedTargetPath = normalizePath(targetPath);
  if (!normalizedMountPath || !normalizedTargetPath || normalizedMountPath === '/') {
    return false;
  }
  return (
    normalizedTargetPath === normalizedMountPath ||
    normalizedTargetPath.startsWith(`${normalizedMountPath}/`)
  );
}

function readRailwayVariables({ env, runCommand }) {
  if (!env.RAILWAY_TOKEN || !env.RAILWAY_SERVICE_ID || !env.RAILWAY_ENVIRONMENT) {
    return { ok: false, items: [], error: 'missing Railway token, service id, or environment id' };
  }
  try {
    const output = runCommand('railway', [
      'variable',
      'list',
      '--service',
      env.RAILWAY_SERVICE_ID,
      '--environment',
      env.RAILWAY_ENVIRONMENT,
      '--json',
    ]);
    return { ok: true, items: parseJson(output), error: undefined };
  } catch (error) {
    return { ok: false, items: [], error: formatCommandError(error) };
  }
}

function readRailwayVolumes({ env, runCommand }) {
  if (!env.RAILWAY_TOKEN || !env.RAILWAY_PROJECT_ID || !env.RAILWAY_SERVICE_ID || !env.RAILWAY_ENVIRONMENT) {
    return { ok: false, items: [], error: 'missing Railway token, project id, service id, or environment id' };
  }
  try {
    const output = runCommand('railway', [
      'volume',
      'list',
      '--service',
      env.RAILWAY_SERVICE_ID,
      '--environment',
      env.RAILWAY_ENVIRONMENT,
      '--json',
    ]);
    return { ok: true, items: parseJson(output), error: undefined };
  } catch (error) {
    return { ok: false, items: [], error: formatCommandError(error) };
  }
}

function runCommandSync(command, args) {
  return execFileSync(command, args, {
    cwd: rootDir,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function unwrapList(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (!input || typeof input !== 'object') {
    return [];
  }
  for (const key of ['items', 'data', 'variables', 'volumes', 'volumeInstances']) {
    if (Array.isArray(input[key])) {
      return input[key];
    }
  }
  return [];
}

function stringField(record, names) {
  for (const name of names) {
    if (typeof record[name] === 'string' && record[name].trim()) {
      return record[name].trim();
    }
  }
  return undefined;
}

function valueField(record, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return record[name];
    }
  }
  return undefined;
}

function normalizePath(path) {
  if (typeof path !== 'string') {
    return undefined;
  }
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, '') || '/';
}

function isRedactedValue(value) {
  return /^\*+$/.test(String(value)) || /^<redacted>$/i.test(String(value));
}

function parseJson(output) {
  return JSON.parse(String(output || 'null'));
}

function check(id, ok, message) {
  return { id, ok, message };
}

function formatCommandError(error) {
  if (error && typeof error === 'object' && 'stderr' in error && error.stderr) {
    return String(error.stderr).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next Railway preflight passed (${summary.total}/${summary.total}).`
      : `AgentBean Next Railway preflight failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = summarizeRailwayPreflight(collectAgentBeanNextRailwayPreflightChecks());
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
