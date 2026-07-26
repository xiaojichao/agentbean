#!/usr/bin/env node

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_SEA_NODE_VERSION = '24.18.0';
export const PI_SEA_VERSION = '0.80.6';
export const PI_SEA_EXPECTED_PLATFORMS = ['linux:x64', 'macos:arm64', 'windows:x64'];
export const PI_SEA_REQUIRED_COMPATIBLE_CHECKS = [
  'runner-platform',
  'node-version',
  'pi-version',
  'bundle',
  'executable-build',
  'platform-signature',
  'executable-run',
  'sea-smoke',
];

const VERDICT_KEYS = ['arch', 'checks', 'nodeVersion', 'os', 'piVersion', 'schemaVersion', 'status'];
const CHECK_KEYS = ['diagnosticCode', 'id', 'ok'];

export function createPendingPiSeaVerdict({ os, arch }) {
  return {
    schemaVersion: 1,
    os,
    arch,
    nodeVersion: PI_SEA_NODE_VERSION,
    piVersion: PI_SEA_VERSION,
    status: 'blocked-for-phase5',
    checks: [{ id: 'sea-smoke', ok: false, diagnosticCode: 'SEA_VERDICT_NOT_FINALIZED' }],
  };
}

export function validatePiSeaVerdict(candidate) {
  if (!isRecord(candidate) || !hasExactKeys(candidate, VERDICT_KEYS)) {
    return invalid('SEA_VERDICT_SCHEMA_INVALID');
  }
  if (candidate.schemaVersion !== 1
    || !['linux', 'macos', 'windows'].includes(candidate.os)
    || !['x64', 'arm64'].includes(candidate.arch)
    || candidate.nodeVersion !== PI_SEA_NODE_VERSION
    || candidate.piVersion !== PI_SEA_VERSION
    || !['compatible', 'blocked-for-phase5'].includes(candidate.status)
    || !Array.isArray(candidate.checks)
    || candidate.checks.length === 0) {
    return invalid('SEA_VERDICT_SCHEMA_INVALID');
  }
  for (const check of candidate.checks) {
    if (!isRecord(check)
      || !hasAllowedKeys(check, CHECK_KEYS)
      || typeof check.id !== 'string'
      || check.id.length === 0
      || typeof check.ok !== 'boolean'
      || (check.ok ? check.diagnosticCode !== undefined : typeof check.diagnosticCode !== 'string')) {
      return invalid('SEA_VERDICT_CHECK_INVALID');
    }
  }
  const allGreen = candidate.checks.every((check) => check.ok);
  if ((candidate.status === 'compatible') !== allGreen) {
    return invalid('SEA_VERDICT_STATUS_INCONSISTENT');
  }
  const checkIds = candidate.checks.map((check) => check.id);
  if (candidate.status === 'compatible'
    && (new Set(checkIds).size !== checkIds.length
      || !PI_SEA_REQUIRED_COMPATIBLE_CHECKS.every((id) => checkIds.includes(id)))) {
    return invalid('SEA_VERDICT_REQUIRED_CHECKS_MISSING');
  }
  return { ok: true, verdict: candidate };
}

export function aggregatePiSeaVerdicts(candidates) {
  const verdicts = [];
  const diagnostics = new Set();
  const byPlatform = new Map();

  for (const candidate of candidates) {
    const validation = validatePiSeaVerdict(candidate);
    if (!validation.ok) {
      diagnostics.add('SEA_INVALID_PLATFORM_VERDICT');
      continue;
    }
    const key = `${validation.verdict.os}:${validation.verdict.arch}`;
    if (!PI_SEA_EXPECTED_PLATFORMS.includes(key)) {
      diagnostics.add('SEA_UNEXPECTED_PLATFORM_VERDICT');
      continue;
    }
    if (byPlatform.has(key)) {
      diagnostics.add('SEA_DUPLICATE_PLATFORM_VERDICT');
      continue;
    }
    byPlatform.set(key, validation.verdict);
  }

  for (const key of PI_SEA_EXPECTED_PLATFORMS) {
    const verdict = byPlatform.get(key);
    if (!verdict) {
      diagnostics.add('SEA_MISSING_PLATFORM_VERDICT');
      const [os, arch] = key.split(':');
      verdicts.push(createPendingPiSeaVerdict({ os, arch }));
      continue;
    }
    verdicts.push(verdict);
  }

  const compatible = diagnostics.size === 0
    && verdicts.length === PI_SEA_EXPECTED_PLATFORMS.length
    && verdicts.every((verdict) => verdict.status === 'compatible');
  return {
    schemaVersion: 1,
    status: compatible ? 'compatible' : 'blocked-for-phase5',
    expectedPlatforms: [...PI_SEA_EXPECTED_PLATFORMS],
    verdicts,
    diagnosticCodes: [...diagnostics].sort(),
  };
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonFiles(root) {
  if (!root) return [];
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return readJsonFiles(path);
      if (!entry.name.endsWith('.json')) return [];
      try {
        return [JSON.parse(readFileSync(path, 'utf8'))];
      } catch {
        return [{ malformedVerdictFile: entry.name }];
      }
    });
  } catch {
    return [];
  }
}

function invalid(diagnosticCode) {
  return { ok: false, diagnosticCode };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function hasAllowedKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('SEA_ARGUMENTS_INVALID');
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function runCli(argv) {
  const { command, values } = parseArgs(argv);
  if (command === 'init') {
    if (!values.out || !values.os || !values.arch) throw new Error('SEA_ARGUMENTS_INVALID');
    writeJson(resolve(values.out), createPendingPiSeaVerdict({ os: values.os, arch: values.arch }));
    return 0;
  }
  if (command === 'aggregate') {
    if (!values.dir || !values.out) throw new Error('SEA_ARGUMENTS_INVALID');
    const aggregate = aggregatePiSeaVerdicts(readJsonFiles(resolve(values.dir)));
    writeJson(resolve(values.out), aggregate);
    return aggregate.status === 'compatible' ? 0 : 1;
  }
  if (command === 'validate') {
    if (!values.file) throw new Error('SEA_ARGUMENTS_INVALID');
    const validation = validatePiSeaVerdict(JSON.parse(readFileSync(resolve(values.file), 'utf8')));
    return validation.ok && validation.verdict.status === 'compatible' ? 0 : 1;
  }
  throw new Error('SEA_COMMAND_INVALID');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SEA_CHECK_FAILED');
    process.exitCode = 1;
  }
}
