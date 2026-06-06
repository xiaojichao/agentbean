#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function collectAgentBeanNextReadinessChecks({
  root = rootDir,
  env = process.env,
  production = false,
} = {}) {
  const packageJson = readJson(join(root, 'package.json'));
  const contractsPackageJson = readJson(join(root, 'packages/contracts/package.json'));
  const daemonNextPackageJson = readJson(join(root, 'apps/daemon-next/package.json'));
  const railwayJson = readJson(join(root, 'railway.json'));
  const workflow = readFileSync(join(root, '.github/workflows/ci-cd.yml'), 'utf8');
  const checks = [
    check(
      'root-build-script',
      packageJson.scripts?.build === 'npm run build:packages',
      'root package.json build script must run AgentBean Next package builds',
    ),
    check(
      'root-start-script',
      packageJson.scripts?.start === 'npm run start:server-next' &&
        packageJson.scripts?.['start:server-next'] === 'node apps/server-next/dist/apps/server-next/src/bin.js',
      'root package.json start script must start server-next',
    ),
    check(
      'railway-build-command',
      railwayJson.build?.builder === 'RAILPACK' && railwayJson.build?.buildCommand === 'npm run build',
      'root railway.json must use RAILPACK and npm run build',
    ),
    check(
      'railway-start-healthcheck',
      railwayJson.deploy?.startCommand === 'npm start' && railwayJson.deploy?.healthcheckPath === '/healthz',
      'root railway.json must start with npm start and expose /healthz',
    ),
    check(
      'ci-validates-root-railway-config',
      workflow.includes('^railway\\.json$'),
      'AgentBean Next CI change detection must include root railway.json',
    ),
    check(
      'ci-runs-readiness-checker',
      workflow.includes('npm run check:agentbean-next-readiness'),
      'AgentBean Next CI must run the readiness checker before deploy/publish can continue',
    ),
    check(
      'ci-runs-production-readiness-before-next-deploy',
      workflow.includes("env.AGENTBEAN_DEPLOY_TARGET == 'next'") &&
        workflow.includes('npm run check:agentbean-next-readiness -- --production') &&
        workflow.includes('AGENTBEAN_NEXT_SESSION_SECRET') &&
        workflow.includes('AGENTBEAN_NEXT_DATA_DIR'),
      'CI deploy job must run production readiness checks before AGENTBEAN_DEPLOY_TARGET=next deploys',
    ),
    check(
      'deploy-target-gate',
      workflow.includes('AGENTBEAN_DEPLOY_TARGET') &&
        workflow.includes('deploy_path="apps/server"') &&
        workflow.includes('deploy_path="."'),
      'CI deploy job must keep old|next deployment target gate',
    ),
    check(
      'contracts-package-publishable',
      contractsPackageJson.private === false &&
        contractsPackageJson.version !== '0.0.0' &&
        Array.isArray(contractsPackageJson.files) &&
        contractsPackageJson.files.includes('dist/**/*') &&
        contractsPackageJson.scripts?.prepublishOnly === 'npm run build',
      '@agentbean/contracts must be publishable before daemon-next can be installed from npm',
    ),
    check(
      'daemon-next-package-publishable',
      daemonNextPackageJson.private === false &&
        daemonNextPackageJson.version !== '0.0.0' &&
        Array.isArray(daemonNextPackageJson.files) &&
        daemonNextPackageJson.files.includes('dist/**/*') &&
        daemonNextPackageJson.bin?.['agentbean-next-daemon'] === './dist/apps/daemon-next/src/bin.js' &&
        daemonNextPackageJson.scripts?.prepublishOnly === 'npm run build',
      '@agentbean/daemon-next must expose a public npm package with a CLI bin',
    ),
    check(
      'daemon-next-runtime-dependencies',
      daemonNextPackageJson.dependencies?.['@agentbean/contracts'] === contractsPackageJson.version &&
        Boolean(daemonNextPackageJson.dependencies?.['socket.io-client']),
      '@agentbean/daemon-next must depend on published contracts and socket.io-client',
    ),
    check(
      'ci-publishes-next-packages',
      workflow.includes("env.AGENTBEAN_DEPLOY_TARGET == 'next'") &&
        workflow.includes('@agentbean/contracts@$CONTRACTS_VERSION') &&
        workflow.includes('@agentbean/daemon-next@$DAEMON_NEXT_VERSION') &&
        workflow.indexOf('Publish AgentBean Next contracts package') <
          workflow.indexOf('Publish AgentBean Next daemon package'),
      'CI publish job must publish AgentBean Next contracts before daemon-next when target is next',
    ),
  ];

  if (production) {
    checks.push(
      check(
        'production-deploy-target-next',
        env.AGENTBEAN_DEPLOY_TARGET === 'next',
        'AGENTBEAN_DEPLOY_TARGET must be next before replacing old AgentBean',
      ),
      check('railway-token-present', Boolean(env.RAILWAY_TOKEN), 'RAILWAY_TOKEN must be configured for production deploy'),
      check(
        'production-session-secret-present',
        Boolean(env.AGENTBEAN_NEXT_SESSION_SECRET),
        'AGENTBEAN_NEXT_SESSION_SECRET must be configured for server-next production sessions',
      ),
      check(
        'production-data-dir-present',
        Boolean(env.AGENTBEAN_NEXT_DATA_DIR),
        'AGENTBEAN_NEXT_DATA_DIR must point at a persistent Railway volume path',
      ),
      check(
        'production-data-dir-not-default',
        Boolean(env.AGENTBEAN_NEXT_DATA_DIR) && !env.AGENTBEAN_NEXT_DATA_DIR.includes('.agentbean-next'),
        'AGENTBEAN_NEXT_DATA_DIR must not use the local development .agentbean-next fallback',
      ),
    );
  }

  return checks;
}

export function summarizeReadiness(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
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
    production: argv.includes('--production'),
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next readiness checks passed (${summary.total}/${summary.total}).`
      : `AgentBean Next readiness checks failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = summarizeReadiness(collectAgentBeanNextReadinessChecks({ production: args.production }));
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
