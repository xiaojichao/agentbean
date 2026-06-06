#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const repo = 'xiaojichao/agentbean';

export function collectAgentBeanNextCutoverAudit({
  root = rootDir,
  runCommand = runCommandSync,
} = {}) {
  const contractsPackage = readJson(join(root, 'packages/contracts/package.json'));
  const daemonNextPackage = readJson(join(root, 'apps/daemon-next/package.json'));
  const canonicalDaemonVersion = daemonNextPackage.version;
  const variablesResult = readGitHubVariables(runCommand);
  const secretsResult = readGitHubSecrets(runCommand);
  const registry = {
    contracts: npmVersionExists(runCommand, '@agentbean/contracts', contractsPackage.version),
    daemonNext: npmVersionExists(runCommand, '@agentbean/daemon-next', daemonNextPackage.version),
    canonicalDaemon: npmVersionExists(runCommand, '@agentbean/daemon', canonicalDaemonVersion),
  };

  const variableMap = new Map(variablesResult.items.map((variable) => [variable.name, variable.value]));
  const secretNames = new Set(secretsResult.items.map((secret) => secret.name));

  return [
    check(
      'github-variables-readable',
      variablesResult.ok,
      variablesResult.ok
        ? 'GitHub repository variables must be readable'
        : `GitHub repository variables could not be read: ${variablesResult.error}`,
    ),
    check(
      'github-secrets-readable',
      secretsResult.ok,
      secretsResult.ok
        ? 'GitHub repository secrets must be readable'
        : `GitHub repository secrets could not be read: ${secretsResult.error}`,
    ),
    check(
      'github-variable-deploy-target-next',
      variableMap.get('AGENTBEAN_DEPLOY_TARGET') === 'next',
      'GitHub variable AGENTBEAN_DEPLOY_TARGET must be next for the final production flip',
    ),
    check(
      'github-variable-next-data-dir',
      Boolean(variableMap.get('AGENTBEAN_NEXT_DATA_DIR')) &&
        !String(variableMap.get('AGENTBEAN_NEXT_DATA_DIR')).includes('.agentbean-next'),
      'GitHub variable AGENTBEAN_NEXT_DATA_DIR must point at the production Railway volume path',
    ),
    check(
      'github-secret-railway-token',
      secretNames.has('RAILWAY_TOKEN'),
      'GitHub secret RAILWAY_TOKEN must exist for production deploy',
    ),
    check(
      'github-secret-npm-token',
      secretNames.has('NPM_TOKEN'),
      'GitHub secret NPM_TOKEN must exist for npm publish',
    ),
    check(
      'github-secret-next-session-secret',
      secretNames.has('AGENTBEAN_NEXT_SESSION_SECRET'),
      'GitHub secret AGENTBEAN_NEXT_SESSION_SECRET must exist before server-next production deploy',
    ),
    check(
      'npm-contracts-next-version',
      registry.contracts,
      `npm registry must contain @agentbean/contracts@${contractsPackage.version}`,
    ),
    check(
      'npm-daemon-next-version',
      registry.daemonNext,
      `npm registry must contain @agentbean/daemon-next@${daemonNextPackage.version}`,
    ),
    check(
      'npm-canonical-daemon-next-version',
      registry.canonicalDaemon,
      `npm registry must contain canonical @agentbean/daemon@${canonicalDaemonVersion}`,
    ),
  ];
}

export function summarizeCutoverAudit(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

function readGitHubVariables(runCommand) {
  try {
    const output = runCommand('gh', [
      'variable',
      'list',
      '--repo',
      repo,
      '--json',
      'name,value,updatedAt',
    ]);
    return { ok: true, items: JSON.parse(output), error: undefined };
  } catch (error) {
    return { ok: false, items: [], error: formatCommandError(error) };
  }
}

function readGitHubSecrets(runCommand) {
  try {
    const output = runCommand('gh', ['secret', 'list', '--repo', repo, '--json', 'name,updatedAt']);
    return { ok: true, items: JSON.parse(output), error: undefined };
  } catch (error) {
    return { ok: false, items: [], error: formatCommandError(error) };
  }
}

function npmVersionExists(runCommand, packageName, version) {
  try {
    return runCommand('npm', ['view', `${packageName}@${version}`, 'version']).trim() === version;
  } catch {
    return false;
  }
}

function runCommandSync(command, args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return execFileSync(command, args, {
        cwd: rootDir,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableCommandError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

function formatCommandError(error) {
  if (error && typeof error === 'object' && 'stderr' in error && error.stderr) {
    return String(error.stderr).trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isRetryableCommandError(error) {
  const text = formatCommandError(error);
  return /EOF|timeout|ETIMEDOUT|ECONNRESET|ENETUNREACH|TLS handshake/i.test(text);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function check(id, ok, message) {
  return { id, ok, message };
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next cutover audit passed (${summary.total}/${summary.total}).`
      : `AgentBean Next cutover audit failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = summarizeCutoverAudit(collectAgentBeanNextCutoverAudit());
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
