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
  const publishJobCondition =
    "if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && !inputs.skip_npm_publish && !inputs.run_railway_preflight && !inputs.sync_railway_next_runtime_env && !inputs.promote_agentbean_daemon_latest)";
  const cutoverRunbook = readFileSync(join(root, 'agentbean-next/docs/production-cutover-runbook.md'), 'utf8');
  const verificationMatrix = readFileSync(join(root, 'agentbean-next/docs/verification-matrix.md'), 'utf8');
  const parityBackfillAudit = readFileSync(join(root, 'agentbean-next/docs/parity-backfill-audit.md'), 'utf8');
  const settingsTeamsParityGreen = hasGreenSettingsTeamsParity(parityBackfillAudit);
  const knownGaps = readFileSync(join(root, 'agentbean-next/docs/known-gaps.md'), 'utf8');
  const socketProtocol = readFileSync(join(root, 'agentbean-next/docs/socket-protocol.md'), 'utf8');
  const contractsSocket = readFileSync(join(root, 'packages/contracts/src/socket.ts'), 'utf8');
  const serverNextUseCases = readFileSync(join(root, 'apps/server-next/src/application/usecases.ts'), 'utf8');
  const serverNextSocketHandlers = readFileSync(join(root, 'apps/server-next/src/transport/socket-handlers.ts'), 'utf8');
  const serverNextFirstSliceTests = readFileSync(join(root, 'apps/server-next/tests/first-slice.test.ts'), 'utf8');
  const serverNextSocketIntegrationTests = readFileSync(join(root, 'apps/server-next/tests/socket-integration.test.ts'), 'utf8');
  const daemonNextCli = readFileSync(join(root, 'apps/daemon-next/src/cli.ts'), 'utf8');
  const daemonNextProtocolClient = readFileSync(join(root, 'apps/daemon-next/src/index.ts'), 'utf8');
  const daemonNextAuthStore = readFileSync(join(root, 'apps/daemon-next/src/auth-store.ts'), 'utf8');
  const daemonNextCliTests = readFileSync(join(root, 'apps/daemon-next/tests/cli.test.ts'), 'utf8');
  const daemonNextAuthStoreTests = readFileSync(join(root, 'apps/daemon-next/tests/auth-store.test.ts'), 'utf8');
  const daemonNextProtocolClientTests = readFileSync(join(root, 'apps/daemon-next/tests/protocol-client.test.ts'), 'utf8');
  const webNextDashboardPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/dashboard/page.tsx'), 'utf8');
  const webNextChatPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/chat/page.tsx'), 'utf8');
  const webNextDevicesPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/devices/page.tsx'), 'utf8');
  const webNextAgentsPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/agents/page.tsx'), 'utf8');
  const webNextAgentDetailPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/agents/[agentId]/page.tsx'), 'utf8');
  const webNextTasksPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/tasks/page.tsx'), 'utf8');
  const webNextRunsPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/runs/page.tsx'), 'utf8');
  const webNextRunsPanel = readFileSync(join(root, 'apps/web-next/app/[teamPath]/settings/RunsPanel.tsx'), 'utf8');
  const webNextRunDetailPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/runs/[runId]/page.tsx'), 'utf8');
  const webNextSettingsPage = readFileSync(join(root, 'apps/web-next/app/[teamPath]/settings/page.tsx'), 'utf8');
  const browserSmokeScript = readFileSync(join(root, 'scripts/smoke-agentbean-next-browser.mjs'), 'utf8');
  const legacyAgentNamespace = readFileSync(join(root, 'apps/server/src/namespaces/agent.ts'), 'utf8');
  const legacyWebNamespaceTests = readFileSync(join(root, 'apps/server/tests/web-namespace.test.ts'), 'utf8');
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
      'ci-runs-on-main-push',
      workflow.includes('push:') &&
        workflow.includes('branches:') &&
        workflow.includes('- main') &&
        workflow.includes('pull_request:') &&
        cutoverRunbook.includes('推送 `main` 触发生产部署'),
      'CI/CD workflow must run automatically after changes land on main',
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
      'old-entry-smoke-script',
      packageJson.scripts?.['smoke:agentbean-old-entry'] ===
        'node scripts/smoke-agentbean-old-entry.mjs' &&
        workflow.includes('run_agentbean_old_production_smoke') &&
        workflow.includes('agentbean_old_entry_url') &&
        workflow.includes('Old AgentBean production smoke') &&
        workflow.includes('npm run smoke:agentbean-old-entry') &&
        cutoverRunbook.includes('npm run smoke:agentbean-old-entry') &&
        cutoverRunbook.includes('run_agentbean_old_production_smoke') &&
        cutoverRunbook.includes('旧生产 `/healthz`'),
      'root package.json, CI, and production runbook must expose an old AgentBean rollback entry smoke',
    ),
    check(
      'ci-runs-production-smoke-on-demand',
      workflow.includes('run_agentbean_next_production_smoke') &&
        workflow.includes('agentbean_next_entry_url') &&
        workflow.includes('AgentBean Next production smoke') &&
        workflow.includes("needs.validate-agentbean-next.result == 'success'") &&
        workflow.includes("needs.deploy.result == 'success' || needs.deploy.result == 'skipped'") &&
        workflow.includes("AGENTBEAN_NEXT_ENTRY_URL: ${{ github.event_name == 'workflow_dispatch' && inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}") &&
        workflow.includes('npm run smoke:agentbean-next-entry') &&
        workflow.includes('npm run smoke:agentbean-next-business') &&
        workflow.includes("github.event_name == 'workflow_dispatch' && inputs.run_agentbean_next_production_smoke") &&
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
      'ci-requires-repository-target-for-manual-next-deploy',
      workflow.includes('Require repository deploy target for manual AgentBean Next deploy') &&
        workflow.includes('repository variable AGENTBEAN_DEPLOY_TARGET=next') &&
        workflow.includes('The workflow input alone is not the final production flip') &&
        workflow.includes("inputs.run_production_deploy && env.AGENTBEAN_DEPLOY_TARGET == 'next' && vars.AGENTBEAN_DEPLOY_TARGET != 'next'") &&
        cutoverRunbook.includes('workflow input alone') &&
        cutoverRunbook.includes('repository variable，不是 workflow dispatch input'),
      'CI must block manual AgentBean Next deploys when only the workflow input is next but the repository variable is still old',
    ),
    check(
      'ci-requires-old-smoke-for-manual-rollback-deploy',
      workflow.includes('Require old production smoke for manual AgentBean rollback deploy') &&
        workflow.includes('Manual old AgentBean production deploy requires run_agentbean_old_production_smoke=true') &&
        workflow.includes("inputs.run_production_deploy && env.AGENTBEAN_DEPLOY_TARGET == 'old' && !inputs.run_agentbean_old_production_smoke") &&
        cutoverRunbook.includes('run_agentbean_old_production_smoke=true') &&
        cutoverRunbook.includes('反向只切不验'),
      'CI must block manual old AgentBean rollback deploys that do not also request old entry smoke',
    ),
    check(
      'ci-runs-ready-to-flip-before-production-smoke',
      workflow.includes('Run AgentBean Next ready-to-flip audit') &&
        workflow.includes("if: vars.AGENTBEAN_DEPLOY_TARGET != 'next'") &&
        workflow.includes('npm run audit:agentbean-next-ready-to-flip') &&
        workflow.indexOf('Run AgentBean Next ready-to-flip audit') <
          workflow.indexOf('Run AgentBean Next public entry smoke') &&
        cutoverRunbook.includes('ready-to-flip audit') &&
        cutoverRunbook.includes('production smoke'),
      'CI production smoke must first prove external state is ready except for the final deploy target',
    ),
    check(
      'ci-runs-strict-cutover-after-final-flip-before-production-smoke',
      workflow.includes('Run AgentBean Next strict cutover audit') &&
        workflow.includes("if: vars.AGENTBEAN_DEPLOY_TARGET == 'next'") &&
        workflow.includes('npm run audit:agentbean-next-cutover') &&
        workflow.indexOf('Run AgentBean Next strict cutover audit') <
          workflow.indexOf('Run AgentBean Next public entry smoke') &&
        cutoverRunbook.includes('strict cutover audit') &&
        cutoverRunbook.includes('final flip 后'),
      'CI production smoke must run strict cutover audit after the final deploy target is next',
    ),
    check(
      'ci-provides-production-env-for-production-smoke-audits',
      workflow.includes('GH_TOKEN: ${{ github.token }}') &&
        workflow.includes("AGENTBEAN_DEPLOY_TARGET: ${{ vars.AGENTBEAN_DEPLOY_TARGET || 'old' }}") &&
        workflow.includes('AGENTBEAN_NEXT_DATA_DIR: ${{ vars.AGENTBEAN_NEXT_DATA_DIR }}') &&
        workflow.includes('AGENTBEAN_NEXT_AUDIT_ENTRY_URL: ${{ vars.AGENTBEAN_NEXT_ENTRY_URL }}') &&
        workflow.includes("AGENTBEAN_NEXT_ENTRY_URL: ${{ github.event_name == 'workflow_dispatch' && inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}") &&
        workflow.includes('AGENTBEAN_NEXT_SESSION_SECRET: ${{ secrets.AGENTBEAN_NEXT_SESSION_SECRET }}') &&
        workflow.includes('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}') &&
        workflow.includes('RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}') &&
        workflow.indexOf('GH_TOKEN: ${{ github.token }}') <
          workflow.indexOf('Run AgentBean Next ready-to-flip audit') &&
        workflow.indexOf('GH_TOKEN: ${{ github.token }}') <
          workflow.indexOf('Run AgentBean Next strict cutover audit'),
      'CI production smoke audits must receive production variables and secrets before running cutover audits',
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
      'ci-deploys-production-on-main-push',
      workflow.includes("if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.run_production_deploy)") &&
        workflow.includes('Deploy Railway backend') &&
        workflow.includes('RAILWAY_TOKEN') &&
        cutoverRunbook.includes('推送 `main` 触发生产部署'),
      'CI deploy job must start automatically after a successful main push validation',
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
        Boolean(daemonNextPackageJson.dependencies?.['js-yaml']) &&
        Boolean(daemonNextPackageJson.dependencies?.['socket.io-client']),
      '@agentbean/daemon-next must depend on published contracts, js-yaml, and socket.io-client',
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
        workflow.includes(publishJobCondition) &&
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
    check(
      'ci-publishes-on-main-push',
      workflow.includes('skip_npm_publish') &&
        workflow.includes(publishJobCondition) &&
        workflow.includes('Publish agent to npm') &&
        workflow.includes('NPM_TOKEN') &&
        cutoverRunbook.includes('推送 `main` 触发生产部署'),
      'CI publish job must start automatically after a successful main push validation',
    ),
    check(
      'ci-runs-next-production-smoke-after-main-push',
      workflow.includes("github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.AGENTBEAN_DEPLOY_TARGET == 'next'") &&
        workflow.includes("AGENTBEAN_NEXT_ENTRY_URL: ${{ github.event_name == 'workflow_dispatch' && inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}") &&
        cutoverRunbook.includes('push run 的 deploy 成功后自动运行 `AgentBean Next production smoke`'),
      'CI must run AgentBean Next production smoke automatically after main-push deploys when the repository deploy target is next',
    ),
    check(
      'ci-promotes-canonical-daemon-latest-on-demand',
      workflow.includes('promote_agentbean_daemon_latest') &&
        workflow.includes('Promote canonical daemon npm latest') &&
        workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.promote_agentbean_daemon_latest") &&
        workflow.includes('Require NPM_TOKEN for latest promotion') &&
        workflow.includes('NPM_TOKEN is required when promote_agentbean_daemon_latest=true') &&
        workflow.includes('Ensure legacy daemon rollback tag before latest promotion') &&
        workflow.indexOf('Ensure legacy daemon rollback tag before latest promotion') <
          workflow.indexOf('Promote canonical daemon to npm latest') &&
        workflow.includes('npm dist-tag add') &&
        workflow.includes('Verify npm latest points to daemon-next'),
      'CI must expose an explicit, gated workflow_dispatch to promote canonical @agentbean/daemon npm latest to the daemon-next version, so the default npm install entry can be flipped to next on demand',
    ),
    check(
      'ci-legacy-daemon-does-not-reclaim-latest-when-next',
      workflow.includes('npm publish --access public --tag legacy') &&
        workflow.includes('AGENTBEAN_NPM_PUBLISH_TARGET" = "next"') &&
        workflow.includes('Ensure legacy daemon rollback dist-tag') &&
        workflow.includes('npm dist-tag add "@agentbean/daemon@$LEGACY_VERSION" legacy'),
      'When npm publish target is next, the legacy apps/daemon package must publish under a non-latest dist-tag so it cannot reclaim the canonical @agentbean/daemon npm latest entry',
    ),
    check(
      'cutover-audit-requires-canonical-daemon-latest',
      workflow.includes('Run AgentBean Next strict cutover audit') &&
        workflow.includes('npm run audit:agentbean-next-cutover') &&
        cutoverRunbook.includes('npm `@latest` dist-tag 已指向 daemon-next') &&
        readFileSync(join(root, 'scripts/audit-agentbean-next-cutover.mjs'), 'utf8').includes('npm-canonical-daemon-latest-dist-tag'),
      'Strict cutover audit must require npm @agentbean/daemon dist-tags.latest to point at the daemon-next canonical version before declaring final replacement readiness',
    ),
    check(
      'members-list-agent-parity-regression',
      socketProtocol.includes('Ack<{ humans: HumanMemberDto[]; agents: AgentDto[] }>') &&
        serverNextUseCases.includes('repositories.agents.listVisibleInTeam(listInput.teamId)') &&
        serverNextFirstSliceTests.includes('lists visible scanned and custom agents with team members') &&
        serverNextFirstSliceTests.includes("category: 'agentos-hosted'") &&
        serverNextFirstSliceTests.includes("source: 'custom'"),
      'members:list must keep the old member-page contract: human members plus visible scanned AgentOS and custom agents',
    ),
    check(
      'daemon-next-register-batch-legacy-compatibility',
      legacyAgentNamespace.includes("socket.on('agent:register-batch', handleDeviceRegisterAgents)") &&
        legacyAgentNamespace.includes("socket.on('device:register-agents', handleDeviceRegisterAgents)") &&
        legacyWebNamespaceTests.includes('shows daemon-next scanned and custom device agents in the members list'),
      'Old production server must continue accepting daemon-next agent:register-batch until the final migration has no old-server compatibility surface',
    ),
    check(
      'daemon-onboarding-profile-lifecycle',
      daemonNextCli.includes('listProfiles') &&
        daemonNextCli.includes('clearProfileId') &&
        daemonNextCli.includes('renameProfileFrom') &&
        daemonNextCli.includes('renameAuthProfileFn') &&
        daemonNextAuthStore.includes('renameAuthProfile') &&
        daemonNextCliTests.includes('list-profiles reports saved profiles without opening a socket') &&
        daemonNextCliTests.includes('clear-profile removes the selected profile without opening a socket') &&
        daemonNextCliTests.includes('rename-profile renames the selected profile without opening a socket') &&
        daemonNextAuthStoreTests.includes('does not overwrite an existing target profile when renaming') &&
        daemonNextProtocolClientTests.includes('reconnect uses the latest successful scan snapshot') &&
        verificationMatrix.includes('P3-11b') &&
        parityBackfillAudit.includes('profile list/clear/rename CLI'),
      'Daemon onboarding must keep profile list/clear/rename CLI management and reconnect snapshot evidence under readiness protection',
    ),
    check(
      'daemon-onboarding-token-refresh',
      daemonNextProtocolClient.includes('onCredentialsChanged') &&
        daemonNextProtocolClient.includes('readAckDeviceCredentials') &&
        daemonNextCli.includes('onCredentialsChanged') &&
        daemonNextCli.includes('saveAuthFn({') &&
        daemonNextCliTests.includes('refreshed hello credentials are persisted back to the same profile') &&
        daemonNextProtocolClientTests.includes('reports refreshed device credentials from initial hello and reconnect acknowledgements') &&
        serverNextFirstSliceTests.includes('returns custom agent env only to the bound device token') &&
        verificationMatrix.includes('P3-11c') &&
        parityBackfillAudit.includes('token refresh persistence'),
      'Daemon onboarding must persist refreshed device credentials from initial hello and reconnect acknowledgements so restarts do not reuse stale invite tokens',
    ),
    check(
      'daemon-onboarding-lifecycle-green',
      daemonNextProtocolClientTests.includes('keeps refreshed credentials and latest scan snapshot across the reconnect lifecycle') &&
        daemonNextProtocolClientTests.includes('re-announces device, runtimes, and agents after reconnect') &&
        daemonNextProtocolClientTests.includes('handles targeted scan requests by reporting fresh runtimes and agents') &&
        daemonNextCliTests.includes('saved path: refreshed hello credentials are persisted back to the same profile') &&
        daemonNextCliTests.includes('list-profiles reports saved profiles without opening a socket') &&
        serverNextFirstSliceTests.includes('device invite issues credentials to a waiting daemon and registers it without manual team config') &&
        serverNextFirstSliceTests.includes('returns custom agent env only to the bound device token') &&
        packageJson.scripts?.['smoke:agentbean-next-daemon-install'] ===
          'node scripts/smoke-agentbean-next-daemon-install.mjs' &&
        verificationMatrix.includes('P3-11d') &&
        verificationMatrix.includes('E2E-11f') &&
        parityBackfillAudit.includes('| `daemon onboarding` | Green |') &&
        parityBackfillAudit.includes('所有核心产品入口已经进入 Green') &&
        !knownGaps.includes('auth token 刷新/续期未实现') &&
        !knownGaps.includes('profile 删除/重命名 CLI 未提供'),
      'Daemon onboarding must have one product-entry lifecycle gate tying invite, saved profile, token refresh, reconnect, latest scan snapshot, targeted scan, npm install smoke, and Green parity docs together',
    ),
    check(
      'product-surface-parity-contracts',
      verificationMatrix.includes('P2-09b') &&
        verificationMatrix.includes('`members:list` 返回 team human members 与当前 team 可见 agents') &&
        verificationMatrix.includes('P2-09c') &&
        verificationMatrix.includes('`members:list`、`device:agents:list`、`agents:subscribe` 与 `channel:members`') &&
        verificationMatrix.includes('E2E-11') &&
        verificationMatrix.includes('已迁移产品入口不得只按模块完成验收') &&
        verificationMatrix.includes('`parity-backfill-audit.md`'),
      'Verification matrix must keep product-surface parity contracts for already migrated AgentBean Next areas',
    ),
    check(
      'parity-backfill-audit-status-table',
      parityBackfillAudit.includes('## 入口审计') &&
        parityBackfillAudit.includes('| `members` | Green |') &&
        parityBackfillAudit.includes('| `devices` | Green |') &&
        parityBackfillAudit.includes('| `agents` | Green |') &&
        parityBackfillAudit.includes('| `tasks` | Green |') &&
        parityBackfillAudit.includes('| `runs` / `运行记录` | Green |') &&
        settingsTeamsParityGreen &&
        parityBackfillAudit.includes('| `dashboard` / `admin` | Green |') &&
        parityBackfillAudit.includes('| `daemon onboarding` | Green |') &&
        parityBackfillAudit.includes('| `channels` / `channel members` | Green |') &&
        parityBackfillAudit.includes('## 下一条 backfill slice') &&
        parityBackfillAudit.includes('所有核心产品入口已经进入 Green'),
      'AgentBean Next parity backfill audit must keep a Red/Yellow/Green product-entry status table and the next recommended slice',
    ),
    check(
      'teams-parity-browser-smoke',
      browserSmokeScript.includes('webui-teams-business-flow') &&
        browserSmokeScript.includes('agentbean.teamPath') &&
        !browserSmokeScript.includes(['agentbean.', 'network', 'Path'].join('')) &&
        browserSmokeScript.includes('Release A team page redirect mismatch') &&
        browserSmokeScript.includes('redirectResponse.status !== 308') &&
        browserSmokeScript.includes("const compatibilityTeamsSegment = ['net', 'works'].join('');") &&
        browserSmokeScript.includes('const legacyTeamsUrl = new URL(`/${teamPath}/${compatibilityTeamsSegment}`, root);') &&
        browserSmokeScript.includes('const canonicalTeamsUrl = new URL(`/${teamPath}/teams`, root);') &&
        verificationMatrix.includes('webui-teams-business-flow') &&
        verificationMatrix.includes('settings / teams') &&
        verificationMatrix.includes('308 permanent redirect'),
      'Team management parity must keep canonical Team storage/routes, refresh persistence, and the temporary Release A permanent redirect under browser/readiness protection',
    ),
    check(
      'devices-parity-browser-smoke',
      browserSmokeScript.includes('webui-devices-business-flow') &&
        browserSmokeScript.includes('device-runtime-scan') &&
        browserSmokeScript.includes('device-runtime-item') &&
        browserSmokeScript.includes('device-agent-item') &&
        browserSmokeScript.includes('device:scan-requested') &&
        browserSmokeScript.includes('agent:register-batch') &&
        browserSmokeScript.includes('device-delete-confirm') &&
        webNextDevicesPage.includes('data-smoke="device-runtime-scan"') &&
        webNextDevicesPage.includes('data-smoke="device-runtime-item"') &&
        webNextDevicesPage.includes('data-smoke="device-agent-item"') &&
        webNextDevicesPage.includes('data-smoke="device-delete-confirm"') &&
        verificationMatrix.includes('webui-devices-business-flow') &&
        parityBackfillAudit.includes('| `devices` | Green |'),
      'Device parity must stay covered by an App Router browser smoke for detail runtime/custom-agent projection, targeted scan AgentOS projection, rename refresh restore, and delete redirect',
    ),
    check(
      'agents-parity-browser-smoke',
      browserSmokeScript.includes('webui-agents-business-flow') &&
        browserSmokeScript.includes('agent-config-open') &&
        browserSmokeScript.includes('agent-config-save') &&
        browserSmokeScript.includes('agent-delete-confirm') &&
        browserSmokeScript.includes('agent-list-page') &&
        browserSmokeScript.includes('agent-metrics-panel') &&
        webNextAgentsPage.includes('data-smoke="agent-list-page"') &&
        webNextAgentDetailPage.includes('data-smoke="agent-config-open"') &&
        webNextAgentDetailPage.includes('data-smoke="agent-config-save"') &&
        webNextAgentDetailPage.includes('data-smoke="agent-delete-confirm"') &&
        verificationMatrix.includes('webui-agents-business-flow') &&
        parityBackfillAudit.includes('| `agents` | Green |'),
      'Agent parity must stay covered by an App Router browser smoke for list/detail, config update, metrics, and delete/list disappearance',
    ),
    check(
      'tasks-parity-browser-smoke',
      browserSmokeScript.includes('webui-task-business-flow') &&
        browserSmokeScript.includes('task-reorder-top') &&
        browserSmokeScript.includes('task-delete') &&
        browserSmokeScript.includes('taskSortOrder') &&
        webNextTasksPage.includes('data-smoke="task-reorder-top"') &&
        webNextTasksPage.includes('data-smoke="task-delete"') &&
        webNextTasksPage.includes('data-task-sort-order') &&
        verificationMatrix.includes('webui-task-business-flow') &&
        parityBackfillAudit.includes('| `tasks` | Green |'),
      'Task parity must stay covered by an App Router browser smoke for create, status update, reorder, delete/list disappearance, and refresh restore',
    ),
    check(
      'runs-parity-browser-smoke',
      browserSmokeScript.includes('webui-runs-business-flow') &&
        browserSmokeScript.includes('workspace-runs-filter-status') &&
        browserSmokeScript.includes('workspace-runs-filter-agent') &&
        browserSmokeScript.includes('workspace-runs-filter-device') &&
        browserSmokeScript.includes('workspace-runs-filter-group') &&
        browserSmokeScript.includes('workspace-run-full-log-search') &&
        browserSmokeScript.includes('workspace-run-source-message-link') &&
        browserSmokeScript.includes('workspace-run-back-to-list') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-page"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-status"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-agent"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-device"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-filter-group"') &&
        webNextRunsPanel.includes('data-smoke="workspace-runs-load-more"') &&
        webNextRunsPanel.includes('data-smoke="workspace-run-card"') &&
        webNextRunDetailPage.includes('data-smoke="workspace-run-detail"') &&
        webNextRunDetailPage.includes('data-smoke="workspace-run-back-to-list"') &&
        webNextRunDetailPage.includes('data-smoke="workspace-run-command"') &&
        webNextRunDetailPage.includes('data-smoke="workspace-run-full-log"') &&
        webNextRunDetailPage.includes('data-smoke="workspace-run-artifact-tree"') &&
        verificationMatrix.includes('webui-runs-business-flow') &&
        verificationMatrix.includes('E2E-11g') &&
        parityBackfillAudit.includes('| `runs` / `运行记录` | Green |'),
      'Runs parity must stay covered by an App Router browser smoke for list filters, detail route, full log artifact, artifact tree, inline log search, source message jump, and refresh restore',
    ),
    check(
      'settings-parity-browser-smoke',
      browserSmokeScript.includes('webui-settings-business-flow') &&
        browserSmokeScript.includes('settings-account-panel') &&
        browserSmokeScript.includes('settings-browser-panel') &&
        browserSmokeScript.includes('agentbean.browserSettings.v1') &&
        browserSmokeScript.includes('settings-team-name-input') &&
        browserSmokeScript.includes('settings-join-revoke') &&
        webNextSettingsPage.includes('data-smoke="settings-account-panel"') &&
        webNextSettingsPage.includes('data-smoke="settings-account-logout"') &&
        webNextSettingsPage.includes('data-smoke="settings-browser-panel"') &&
        webNextSettingsPage.includes('data-smoke="settings-browser-reset"') &&
        webNextSettingsPage.includes('data-smoke="settings-browser-attachment-open-mode"') &&
        webNextSettingsPage.includes('data-smoke="settings-team-name-input"') &&
        webNextSettingsPage.includes('data-smoke="settings-join-revoke"') &&
        verificationMatrix.includes('webui-settings-business-flow') &&
        verificationMatrix.includes('settings / teams') &&
        settingsTeamsParityGreen,
      'Settings parity must stay covered by an App Router browser smoke for account identity, browser preference persistence/reset, team rename, join link revoke, and refresh restore',
    ),
    check(
      'channel-members-parity-browser-smoke',
      browserSmokeScript.includes('webui-channel-members-business-flow') &&
        browserSmokeScript.includes('channel-member-add-candidate') &&
        browserSmokeScript.includes('channel-member-remove') &&
        browserSmokeScript.includes('mention-candidate') &&
        browserSmokeScript.includes('assertWebUiChannelVisibleToMember') &&
        webNextChatPage.includes('data-smoke="channel-members-open"') &&
        webNextChatPage.includes('data-smoke="channel-member-item"') &&
        webNextChatPage.includes('data-smoke="mention-candidate"') &&
        verificationMatrix.includes('webui-channel-members-business-flow') &&
        parityBackfillAudit.includes('| `channels` / `channel members` | Green |'),
      'Channel member parity must stay covered by an App Router browser smoke for human/agent add-remove, private visibility reclaim, channel:members projection, and mention scope',
    ),
    check(
      'admin-dashboard-parity-regression',
      contractsSocket.includes("listTeams: 'admin:list-teams'") &&
        contractsSocket.includes("transferDeviceOwner: 'admin:transfer-device-owner'") &&
        serverNextSocketHandlers.includes('WEB_EVENTS.admin.listTeams') &&
        serverNextSocketHandlers.includes('WEB_EVENTS.admin.transferDeviceOwner') &&
        serverNextUseCases.includes('listAdminDevices') &&
        serverNextUseCases.includes('transferDeviceOwnerAsAdmin') &&
        serverNextSocketIntegrationTests.includes('serves admin dashboard lists and device owner transfer to global admins only') &&
        webNextDashboardPage.includes('admin:list-users') &&
        webNextDashboardPage.includes('admin:transfer-device-owner') &&
        verificationMatrix.includes('P2-21a') &&
        verificationMatrix.includes('admin dashboard lists'),
      'Admin dashboard migration must keep socket contract, server-next handlers, regression tests, and verification-matrix coverage together',
    ),
    check(
      'admin-dashboard-parity-browser-smoke',
      browserSmokeScript.includes('webui-admin-dashboard-business-flow') &&
        browserSmokeScript.includes('promoteSmokeUserToAdmin') &&
        browserSmokeScript.includes('admin-device-owner-select') &&
        browserSmokeScript.includes('admin-device-owner-save') &&
        browserSmokeScript.includes('admin-agent-row') &&
        webNextDashboardPage.includes('data-smoke="admin-dashboard-page"') &&
        webNextDashboardPage.includes("key: 'users'") &&
        webNextDashboardPage.includes("key: 'devices'") &&
        webNextDashboardPage.includes("key: 'agents'") &&
        webNextDashboardPage.includes('data-smoke={`admin-tab-${t.key}`}') &&
        webNextDashboardPage.includes('data-smoke="admin-device-owner-select"') &&
        webNextDashboardPage.includes('data-smoke="admin-device-owner-save"') &&
        webNextDashboardPage.includes('data-smoke="admin-agent-row"') &&
        verificationMatrix.includes('webui-admin-dashboard-business-flow') &&
        parityBackfillAudit.includes('| `dashboard` / `admin` | Green |'),
      'Admin dashboard parity must stay covered by an App Router browser smoke for admin tabs, list rows, device detail, owner transfer, and agent ownership projection',
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

export function hasGreenSettingsTeamsParity(parityBackfillAudit) {
  return parityBackfillAudit.includes('| `settings` / `teams` | Green |');
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
