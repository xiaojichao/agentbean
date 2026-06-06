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
  const cutoverRunbook = readFileSync(join(root, 'agentbean-next/docs/production-cutover-runbook.md'), 'utf8');
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
      'daemon-install-smoke-script',
      packageJson.scripts?.['smoke:agentbean-next-daemon-install'] ===
        'node scripts/smoke-agentbean-next-daemon-install.mjs',
      'root package.json must expose the AgentBean Next daemon install smoke',
    ),
    check(
      'entry-smoke-script',
      packageJson.scripts?.['smoke:agentbean-next-entry'] ===
        'node scripts/smoke-agentbean-next-entry.mjs' &&
        cutoverRunbook.includes('npm run smoke:agentbean-next-entry') &&
        cutoverRunbook.includes('AGENTBEAN_NEXT_ENTRY_URL'),
      'root package.json and production runbook must expose the AgentBean Next public entry smoke',
    ),
    check(
      'business-smoke-script',
      packageJson.scripts?.['smoke:agentbean-next-business'] ===
        'node scripts/smoke-agentbean-next-business.mjs' &&
        cutoverRunbook.includes('npm run smoke:agentbean-next-business') &&
        cutoverRunbook.includes('custom agent') &&
        cutoverRunbook.includes('agent reply'),
      'root package.json and production runbook must expose the AgentBean Next business smoke',
    ),
    check(
      'persistence-smoke-script',
      packageJson.scripts?.['smoke:agentbean-next-persistence'] ===
        'npm run build:server-next && node scripts/smoke-agentbean-next-persistence.mjs' &&
        cutoverRunbook.includes('npm run smoke:agentbean-next-persistence') &&
        cutoverRunbook.includes('SQLite volume') &&
        cutoverRunbook.includes('channel/message'),
      'root package.json and production runbook must expose the AgentBean Next SQLite restart persistence smoke',
    ),
    check(
      'ci-runs-production-smoke-on-demand',
      workflow.includes('run_agentbean_next_production_smoke') &&
        workflow.includes('agentbean_next_entry_url') &&
        workflow.includes('AgentBean Next production smoke') &&
        workflow.includes("needs.validate-agentbean-next.result == 'success'") &&
        workflow.includes("needs.deploy.result == 'success' || needs.deploy.result == 'skipped'") &&
        workflow.includes('AGENTBEAN_NEXT_ENTRY_URL: ${{ inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}') &&
        workflow.includes('npm run smoke:agentbean-next-entry') &&
        workflow.includes('npm run smoke:agentbean-next-business') &&
        workflow.includes("github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.AGENTBEAN_DEPLOY_TARGET == 'next'") &&
        cutoverRunbook.includes('run_agentbean_next_production_smoke') &&
        cutoverRunbook.includes('agentbean_next_entry_url'),
      'CI must expose an explicit workflow_dispatch AgentBean Next production smoke gate',
    ),
    check(
      'ci-requires-production-smoke-for-next-deploy',
      workflow.includes('Require production smoke for manual AgentBean Next deploy') &&
        workflow.includes('Manual AgentBean Next production deploy requires run_agentbean_next_production_smoke=true') &&
        workflow.includes("inputs.run_production_deploy && env.AGENTBEAN_DEPLOY_TARGET == 'next' && !inputs.run_agentbean_next_production_smoke") &&
        cutoverRunbook.includes('run_agentbean_next_production_smoke=true') &&
        cutoverRunbook.includes('只切不验'),
      'CI must block manual AgentBean Next production deploys that do not also request production smoke',
    ),
    check(
      'ci-runs-ready-to-flip-before-production-smoke',
      workflow.includes('Run AgentBean Next ready-to-flip audit') &&
        workflow.includes('npm run audit:agentbean-next-ready-to-flip') &&
        workflow.indexOf('Run AgentBean Next ready-to-flip audit') <
          workflow.indexOf('Run AgentBean Next public entry smoke') &&
        cutoverRunbook.includes('ready-to-flip audit') &&
        cutoverRunbook.includes('production smoke'),
      'CI production smoke must first prove external state is ready except for the final deploy target',
    ),
    check(
      'ci-runs-daemon-install-smoke',
      workflow.includes('Run AgentBean Next daemon install smoke') &&
        workflow.includes('npm run smoke:agentbean-next-daemon-install -- --skip-build'),
      'AgentBean Next CI must verify the canonical daemon package can be installed through the old npm entry',
    ),
    check(
      'deploy-target-gate',
      workflow.includes('AGENTBEAN_DEPLOY_TARGET') &&
        workflow.includes('deploy_path="apps/server"') &&
        workflow.includes('deploy_path="."'),
      'CI deploy job must keep old|next deployment target gate',
    ),
    check(
      'ci-bounds-railway-deploy-command',
      workflow.includes('timeout 8m railway up') &&
        workflow.includes('Railway deploy attempt ${attempt}/3') &&
        workflow.includes('timeout-minutes: 30'),
      'CI deploy job must bound each Railway CLI deploy attempt so production deploy cannot hang indefinitely',
    ),
    check(
      'ready-to-flip-audit-script',
      packageJson.scripts?.['audit:agentbean-next-ready-to-flip'] ===
        'node scripts/audit-agentbean-next-cutover.mjs --allow-pending-final-flip' &&
        cutoverRunbook.includes('npm run audit:agentbean-next-ready-to-flip') &&
        cutoverRunbook.includes('AGENTBEAN_DEPLOY_TARGET=next') &&
        cutoverRunbook.includes('最终开关'),
      'root package.json and production runbook must expose a pre-final-flip audit that allows only the final deploy target to remain pending',
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
      'daemon-next-version-replaces-old-daemon',
      compareSemver(daemonNextPackageJson.version, '0.1.35') > 0,
      '@agentbean/daemon-next version must be higher than the current @agentbean/daemon release before replacement',
    ),
    check(
      'ci-publishes-next-packages',
      workflow.includes('AGENTBEAN_NPM_PUBLISH_TARGET') &&
        workflow.includes("env.AGENTBEAN_NPM_PUBLISH_TARGET == 'next'") &&
        workflow.includes('@agentbean/contracts@$CONTRACTS_VERSION') &&
        workflow.includes('@agentbean/daemon-next@$DAEMON_NEXT_VERSION') &&
        workflow.indexOf('Publish AgentBean Next contracts package') <
          workflow.indexOf('Publish AgentBean Next daemon package') &&
        workflow.includes('prepare-agentbean-next-daemon-release.mjs') &&
        workflow.includes('@agentbean/daemon@$CANONICAL_DAEMON_VERSION') &&
        workflow.indexOf('Publish AgentBean Next daemon package') <
          workflow.indexOf('Publish AgentBean Next canonical daemon package'),
      'CI publish job must publish contracts, daemon-next, then canonical @agentbean/daemon when npm publish target is next',
    ),
    check(
      'ci-decouples-next-npm-publish-from-production-deploy',
        workflow.includes('agentbean_npm_publish_target') &&
        workflow.includes('agentbean_deploy_target') &&
        workflow.includes('run_production_deploy') &&
        workflow.includes('inputs.agentbean_npm_publish_target') &&
        workflow.includes('inputs.agentbean_deploy_target') &&
        workflow.includes('inputs.run_production_deploy') &&
        workflow.includes('AGENTBEAN_NPM_PUBLISH_TARGET') &&
        workflow.includes('AGENTBEAN_DEPLOY_TARGET') &&
        workflow.includes("env.AGENTBEAN_NPM_PUBLISH_TARGET == 'next'") &&
        workflow.includes("env.AGENTBEAN_DEPLOY_TARGET == 'next'"),
      'CI must allow publishing AgentBean Next npm packages without flipping the Railway production deploy target',
    ),
    check(
      'ci-runs-railway-next-preflight-without-deploy',
      packageJson.scripts?.['check:agentbean-next-railway-preflight'] ===
        'node scripts/check-agentbean-next-railway-preflight.mjs' &&
        workflow.includes('run_railway_preflight') &&
        workflow.includes('Railway Next preflight') &&
        workflow.includes('npm run check:agentbean-next-railway-preflight') &&
        workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.run_railway_preflight") &&
        workflow.includes("github.event_name == 'workflow_dispatch' && !inputs.run_railway_preflight") &&
        workflow.includes('run: npm run check:agentbean-next-readiness -- --production'),
      'CI must allow read-only Railway Next preflight without running production deploy',
    ),
    check(
      'ci-syncs-railway-next-env-without-deploy',
      workflow.includes('sync_railway_next_runtime_env') &&
        workflow.includes('Railway Next env sync') &&
        workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.sync_railway_next_runtime_env") &&
        workflow.includes('railway variable set "AGENTBEAN_NEXT_DATA_DIR=${AGENTBEAN_NEXT_DATA_DIR}"') &&
        workflow.includes('railway variable set AGENTBEAN_NEXT_SESSION_SECRET') &&
        workflow.includes('--stdin') &&
        workflow.includes('--skip-deploys') &&
        workflow.includes('Verify Railway AgentBean Next preflight') &&
        workflow.includes("!inputs.run_railway_preflight && !inputs.sync_railway_next_runtime_env"),
      'CI must allow explicitly syncing Railway Next runtime env without deploy or npm publish',
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

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!match) {
    return [0, 0, 0];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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
