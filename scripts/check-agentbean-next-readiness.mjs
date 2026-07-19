#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  const piManagementRuntimePackageJson = readJson(join(root, 'packages/pi-management-runtime/package.json'));
  const daemonNextPackageJson = readJson(join(root, 'apps/daemon-next/package.json'));
  const railwayJson = readJson(join(root, 'railway.json'));
  const workflow = readFileSync(join(root, '.github/workflows/ci-cd.yml'), 'utf8');
  const seaWorkflow = readFileSync(join(root, '.github/workflows/pi-sea-compatibility.yml'), 'utf8');
  const dailyChangelogWorkflow = readFileSync(join(root, '.github/workflows/daily-changelog.yml'), 'utf8');
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8');
  const piSeaChecker = readFileSync(join(root, 'scripts/check-pi-management-sea.mjs'), 'utf8');
  const piSeaBuilder = readFileSync(join(root, 'scripts/build-pi-management-sea.mjs'), 'utf8');
  const publishJobCondition =
    "if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && !inputs.skip_npm_publish && !inputs.run_railway_preflight && !inputs.sync_railway_next_runtime_env && !inputs.promote_agentbean_daemon_latest)";
  const publishJob = workflow.slice(
    workflow.indexOf('\n  publish:'),
    workflow.indexOf('\n  promote-agentbean-daemon-latest:'),
  );
  const deployJob = workflow.slice(
    workflow.indexOf('\n  deploy:'),
    workflow.indexOf('\n  railway-next-preflight:'),
  );
  const cutoverRunbook = readFileSync(join(root, 'agentbean-next/docs/production-cutover-runbook.md'), 'utf8');
  const verificationMatrix = readFileSync(join(root, 'agentbean-next/docs/verification-matrix.md'), 'utf8');
  const parityBackfillAudit = readFileSync(join(root, 'agentbean-next/docs/parity-backfill-audit.md'), 'utf8');
  const settingsTeamsParityGreen = hasGreenSettingsTeamsParity(parityBackfillAudit);
  const knownGaps = readFileSync(join(root, 'agentbean-next/docs/known-gaps.md'), 'utf8');
  const socketProtocol = readFileSync(join(root, 'agentbean-next/docs/socket-protocol.md'), 'utf8');
  const contractsSocket = readFileSync(join(root, 'packages/contracts/src/socket.ts'), 'utf8');
  const contractsArtifact = readFileSync(join(root, 'packages/contracts/src/artifact.ts'), 'utf8');
  const serverNextUseCases = readFileSync(join(root, 'apps/server-next/src/application/usecases.ts'), 'utf8');
  const serverNextSocketHandlers = readFileSync(join(root, 'apps/server-next/src/transport/socket-handlers.ts'), 'utf8');
  const serverNextFirstSliceTests = readFileSync(join(root, 'apps/server-next/tests/first-slice.test.ts'), 'utf8');
  const serverNextSocketIntegrationTests = readFileSync(join(root, 'apps/server-next/tests/socket-integration.test.ts'), 'utf8');
  const phase0ManagementBoundaryTests = readFileSync(join(root, 'apps/server-next/tests/phase-0-management-boundary.test.ts'), 'utf8');
  const phase2CloseoutSmoke = readFileSync(join(root, 'apps/server-next/tests/phase-2-managed-team-smoke.test.ts'), 'utf8');
  const serverNextRepositories = readFileSync(join(root, 'apps/server-next/src/application/repositories.ts'), 'utf8');
  const serverNextSource = readTreeText(join(root, 'apps/server-next/src'));
  const serverNextMigrations = readTreeText(join(root, 'apps/server-next/src/infra/sqlite/migrations'));
  const serverNextDevServer = readFileSync(join(root, 'apps/server-next/src/dev-server.ts'), 'utf8');
  const serverNextFullPreview = readFileSync(join(root, 'apps/server-next/src/full-preview.ts'), 'utf8');
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
  const daemonInstallSmokeScript = readFileSync(
    join(root, 'scripts/smoke-agentbean-next-daemon-install.mjs'),
    'utf8',
  );
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
      'ci-runs-package-scoped-phase-tests',
      hasDeduplicatedPackageCi({ scripts: packageJson.scripts, workflow }),
      'AgentBean Next CI must run each package suite once, retain every Phase boundary, and build canonical packages once',
    ),
    check(
      'ci-detects-pr-merge-readiness-changes',
      workflow.includes('check-pr-merge-readiness(\\.test)?') &&
        workflow.includes('claim-github-issue(\\.test)?') &&
        packageJson.scripts?.['test:issue-claim'] === 'node --test scripts/claim-github-issue.test.mjs',
      'CI change detection must cover PR readiness and Session Claim guards and run their tests',
    ),
    check(
      'ci-builds-canonical-packages-before-browser-smoke',
      workflow.includes('run: npm run build:packages') &&
        workflow.indexOf('run: npm run build:packages') <
          workflow.indexOf('npm run smoke:agentbean-next-browser -- --skip-build'),
      'CI must create the production Web build through the canonical package build before the combined browser smoke starts',
    ),
    check(
      'ci-runs-production-readiness-before-deploy',
      workflow.includes('npm run check:agentbean-next-readiness -- --production') &&
        workflow.includes('AGENTBEAN_NEXT_SESSION_SECRET') &&
        workflow.includes('AGENTBEAN_NEXT_DATA_DIR'),
      'CI deploy job must run production readiness checks before server-next deploys',
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
      'legacy-source-retired',
      !existsSync(join(root, 'apps/server')) &&
        !existsSync(join(root, 'apps/web')) &&
        !existsSync(join(root, 'apps/daemon')) &&
        !existsSync(join(root, 'scripts/smoke-agentbean-old-entry.mjs')) &&
        !packageJson.scripts?.['smoke:agentbean-old-entry'] &&
        !workflow.includes('run_agentbean_old_production_smoke'),
      'Release B must remove legacy source trees, old entry smoke, and old-target CI controls',
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
      'ci-requires-production-smoke-for-manual-deploy',
      workflow.includes('Require production smoke for manual AgentBean Next deploy') &&
        workflow.includes('Manual AgentBean Next production deploy requires run_agentbean_next_production_smoke=true') &&
        workflow.includes('inputs.run_production_deploy && !inputs.run_agentbean_next_production_smoke') &&
        cutoverRunbook.includes('run_agentbean_next_production_smoke=true') &&
        cutoverRunbook.includes('只切不验'),
      'CI must block manual server-next production deploys that do not also request production smoke',
    ),
    check(
      'ci-forbids-deploy-when-npm-publish-is-skipped',
      workflow.includes('Reject production deploy when npm publish is skipped') &&
        workflow.includes('inputs.run_production_deploy && inputs.skip_npm_publish') &&
        workflow.includes('Manual production deploy cannot use skip_npm_publish=true; publish must complete before deploy.') &&
        cutoverRunbook.includes('`skip_npm_publish=true`'),
      'CI must fail before a manual production deploy can bypass npm publication',
    ),
    check(
      'ci-runs-strict-cutover-before-production-smoke',
      workflow.includes('Run AgentBean Next strict cutover audit') &&
        workflow.includes('npm run audit:agentbean-next-cutover') &&
        workflow.indexOf('Run AgentBean Next strict cutover audit') <
          workflow.indexOf('Run AgentBean Next public entry smoke') &&
        cutoverRunbook.includes('strict cutover audit') &&
        cutoverRunbook.includes('production smoke 先运行 strict cutover audit'),
      'CI production smoke must run strict cutover audit before public entry and business smoke',
    ),
    check(
      'ci-provides-production-env-for-production-smoke-audits',
      workflow.includes('GH_TOKEN: ${{ github.token }}') &&
        workflow.includes('AGENTBEAN_NEXT_DATA_DIR: ${{ vars.AGENTBEAN_NEXT_DATA_DIR }}') &&
        workflow.includes('AGENTBEAN_NEXT_AUDIT_ENTRY_URL: ${{ vars.AGENTBEAN_NEXT_ENTRY_URL }}') &&
        workflow.includes("AGENTBEAN_NEXT_ENTRY_URL: ${{ github.event_name == 'workflow_dispatch' && inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}") &&
        workflow.includes('AGENTBEAN_NEXT_SESSION_SECRET: ${{ secrets.AGENTBEAN_NEXT_SESSION_SECRET }}') &&
        workflow.includes('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}') &&
        workflow.includes('RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}') &&
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
      'ci-deploys-only-server-next',
      workflow.includes('timeout 8m railway up .') &&
        workflow.includes("needs.publish.result == 'success'") &&
        !workflow.includes('agentbean_deploy_target') &&
        !workflow.includes('deploy_path=') &&
        !workflow.includes('apps/server/package-lock.json'),
      'CI deploy job must deploy only the root server-next application',
    ),
    check(
      'daily-changelog-uses-single-main-push-deploy',
      dailyChangelogWorkflow.includes('git push origin HEAD:main') &&
        !dailyChangelogWorkflow.includes('gh workflow run ci-cd.yml'),
      'Daily changelog must rely on its main push and never dispatch a competing second production deploy',
    ),
    check(
      'ci-fails-closed-without-production-tokens',
      workflow.includes('Require RAILWAY_TOKEN for production deploy') &&
        workflow.includes('RAILWAY_TOKEN is required for production deploy; deploy cannot be skipped silently.') &&
        workflow.includes('Require NPM_TOKEN for npm publish') &&
        workflow.includes('NPM_TOKEN is required for npm publish; publish cannot be skipped silently.') &&
        !workflow.includes('- name: Skip Railway deploy') &&
        !workflow.includes('- name: Skip npm publish'),
      'Main release workflow must fail closed when Railway or npm credentials are missing',
    ),
    check(
      'ci-deploys-production-on-main-push',
      workflow.includes("github.event_name == 'push'") &&
        workflow.includes("github.event_name == 'workflow_dispatch' && inputs.run_production_deploy") &&
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
      'contracts-package-publishable',
      contractsPackageJson.private === false &&
        contractsPackageJson.version !== '0.0.0' &&
        Array.isArray(contractsPackageJson.files) &&
        contractsPackageJson.files.includes('dist/**/*') &&
        contractsPackageJson.scripts?.prepublishOnly === 'npm run build',
      '@agentbean/contracts must be publishable before daemon-next can be installed from npm',
    ),
    check(
      'pi-management-runtime-package-publishable',
      piManagementRuntimePackageJson.private === false &&
        piManagementRuntimePackageJson.version !== '0.0.0' &&
        Array.isArray(piManagementRuntimePackageJson.files) &&
        piManagementRuntimePackageJson.files.includes('dist/**/*.js') &&
        piManagementRuntimePackageJson.files.includes('dist/index.d.ts') &&
        piManagementRuntimePackageJson.files.includes('dist/types.d.ts') &&
        piManagementRuntimePackageJson.scripts?.prepublishOnly === 'npm run build' &&
        piManagementRuntimePackageJson.dependencies?.['@earendil-works/pi-ai'] === '0.80.6' &&
        piManagementRuntimePackageJson.dependencies?.['@earendil-works/pi-coding-agent'] === '0.80.6',
      '@agentbean/pi-management-runtime must be publishable with exact PI dependencies',
    ),
    check(
      'daemon-next-package-publishable',
      daemonNextPackageJson.private === false &&
        daemonNextPackageJson.version !== '0.0.0' &&
        Array.isArray(daemonNextPackageJson.files) &&
        daemonNextPackageJson.files.includes('dist/**/*') &&
        daemonNextPackageJson.bin?.agentbean === './dist/apps/daemon-next/src/bin.js' &&
        daemonNextPackageJson.bin?.['agentbean-next-daemon'] === './dist/apps/daemon-next/src/bin.js' &&
        daemonNextPackageJson.scripts?.prepublishOnly === 'npm run build',
      '@agentbean/daemon-next must expose a public npm package with a CLI bin',
    ),
    check(
      'daemon-next-runtime-dependencies',
      daemonNextPackageJson.dependencies?.['@agentbean/contracts'] === contractsPackageJson.version &&
        daemonNextPackageJson.dependencies?.['@agentbean/pi-management-runtime'] === piManagementRuntimePackageJson.version &&
        Boolean(daemonNextPackageJson.dependencies?.['js-yaml']) &&
        Boolean(daemonNextPackageJson.dependencies?.['socket.io-client']),
      '@agentbean/daemon-next must depend on exact published contracts and PI runtime plus its transport dependencies',
    ),
    check(
      'daemon-runtime-does-not-probe-retired-source',
      !daemonNextCli.includes('apps/server') &&
        !daemonNextCli.includes('server/package.json') &&
        !daemonNextCli.includes('npm ci in apps/server'),
      'daemon-next runtime dependency loading must be owned by daemon-next and never probe retired server source',
    ),
    check(
      'server-runtime-dependencies-owned-by-server-next',
      serverNextDevServer.includes("new URL('../package.json', import.meta.url)") &&
        serverNextDevServer.includes("new URL('../../../../package.json', import.meta.url)") &&
        serverNextDevServer.includes("join(process.cwd(), 'apps/server-next/package.json')") &&
        serverNextFullPreview.includes("new URL('../package.json', import.meta.url)") &&
        serverNextFullPreview.includes("new URL('../../../../package.json', import.meta.url)") &&
        serverNextFullPreview.includes("join(process.cwd(), 'apps/server-next/package.json')") &&
        !serverNextDevServer.includes("join(process.cwd(), 'package.json')") &&
        !serverNextFullPreview.includes("join(process.cwd(), 'package.json')"),
      'server-next runtime dependency loading must resolve from its owning workspace in source and compiled layouts',
    ),
    check(
      'daemon-next-version-replaces-old-daemon',
      compareSemver(daemonNextPackageJson.version, '0.1.35') > 0,
      '@agentbean/daemon-next version must be higher than the current @agentbean/daemon release before replacement',
    ),
    check(
      'ci-publishes-next-packages',
      workflow.includes('@agentbean/contracts@$CONTRACTS_VERSION') &&
        workflow.includes('@agentbean/pi-management-runtime@$PI_RUNTIME_VERSION') &&
        workflow.includes('@agentbean/daemon-next@$DAEMON_NEXT_VERSION') &&
        workflow.indexOf('Publish AgentBean Next contracts package') <
          workflow.indexOf('Publish AgentBean PI management runtime package') &&
        workflow.indexOf('Publish AgentBean PI management runtime package') <
          workflow.indexOf('Publish AgentBean Next daemon package') &&
        workflow.includes('prepare-agentbean-next-daemon-release.mjs') &&
        workflow.includes('@agentbean/daemon@$CANONICAL_DAEMON_VERSION') &&
        workflow.indexOf('Publish AgentBean Next daemon package') <
          workflow.indexOf('Publish AgentBean Next canonical daemon package'),
      'CI publish job must publish contracts, PI runtime, daemon-next, then canonical @agentbean/daemon',
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
      'ci-promotes-canonical-daemon-latest-before-production-deploy',
      publishJob.includes('canonical_daemon_version=$CANONICAL_DAEMON_VERSION') &&
        publishJob.includes('Promote canonical daemon latest before production deploy') &&
        publishJob.includes('Verify canonical daemon latest before production deploy') &&
        publishJob.includes('npm dist-tag add') &&
        publishJob.indexOf('Publish AgentBean Next canonical daemon package') <
          publishJob.indexOf('Promote canonical daemon latest before production deploy') &&
        publishJob.indexOf('Promote canonical daemon latest before production deploy') <
          publishJob.indexOf('Verify canonical daemon latest before production deploy') &&
        deployJob.includes('- publish'),
      'CI publish must promote and verify canonical @agentbean/daemon latest before the dependent production deploy can expose matching Web commands',
    ),
    check(
      'ci-runs-next-production-smoke-after-main-push',
      workflow.includes("github.event_name == 'push' && github.ref == 'refs/heads/main'") &&
        workflow.includes("AGENTBEAN_NEXT_ENTRY_URL: ${{ github.event_name == 'workflow_dispatch' && inputs.agentbean_next_entry_url || vars.AGENTBEAN_NEXT_ENTRY_URL }}") &&
        cutoverRunbook.includes('push run 的 deploy 成功后自动运行 `AgentBean Next production smoke`'),
      'CI must run AgentBean Next production smoke automatically after main-push deploys',
    ),
    check(
      'ci-promotes-canonical-daemon-latest-on-demand',
      workflow.includes('promote_agentbean_daemon_latest') &&
        workflow.includes('Promote canonical daemon npm latest') &&
        workflow.includes("if: github.event_name == 'workflow_dispatch' && inputs.promote_agentbean_daemon_latest") &&
        workflow.includes('Require NPM_TOKEN for latest promotion') &&
        workflow.includes('NPM_TOKEN is required when promote_agentbean_daemon_latest=true') &&
        workflow.includes('Verify legacy daemon historical archive before latest promotion') &&
        workflow.indexOf('Verify legacy daemon historical archive before latest promotion') <
          workflow.indexOf('Promote canonical daemon to npm latest') &&
        workflow.includes('npm dist-tag add') &&
        workflow.includes('Verify npm latest points to daemon-next'),
      'CI must expose an explicit, gated workflow_dispatch to promote canonical @agentbean/daemon npm latest to the daemon-next version, so the default npm install entry can be flipped to next on demand',
    ),
    check(
      'ci-verifies-published-legacy-daemon-artifact',
      workflow.includes('Verify legacy daemon historical archive dist-tag') &&
        workflow.includes('Verify legacy daemon historical archive before latest promotion') &&
        workflow.includes('npm view "@agentbean/daemon@$LEGACY_TAG" version') &&
        workflow.includes('LEGACY_TAG" != "0.1.35') &&
        !/^\s*working-directory:\s+apps\/daemon\s*$/m.test(workflow),
      'CI must verify the published npm legacy historical archive without presenting it as a server-next rollback',
    ),
    check(
      'cutover-audit-requires-canonical-daemon-dist-tags',
      workflow.includes('Run AgentBean Next strict cutover audit') &&
        workflow.includes('npm run audit:agentbean-next-cutover') &&
        cutoverRunbook.includes('npm `@latest` dist-tag 已指向 daemon-next') &&
        readFileSync(join(root, 'scripts/audit-agentbean-next-cutover.mjs'), 'utf8').includes('npm-canonical-daemon-latest-dist-tag') &&
        readFileSync(join(root, 'scripts/audit-agentbean-next-cutover.mjs'), 'utf8').includes('npm-canonical-daemon-legacy-dist-tag'),
      'Strict cutover audit must require npm latest to point at daemon-next and preserve legacy only as a historical archive',
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
        browserSmokeScript.includes('Release B removed Team page alias mismatch') &&
        browserSmokeScript.includes('removedAliasResponse.status !== 404') &&
        browserSmokeScript.includes("const compatibilityTeamsSegment = ['net', 'works'].join('');") &&
        browserSmokeScript.includes('const legacyTeamsUrl = new URL(`/${teamPath}/${compatibilityTeamsSegment}`, root);') &&
        browserSmokeScript.includes('const canonicalTeamsUrl = new URL(`/${teamPath}/teams`, root);') &&
        verificationMatrix.includes('webui-teams-business-flow') &&
        verificationMatrix.includes('settings / teams') &&
        verificationMatrix.includes('Release B 后旧页面 alias 返回 404'),
      'Team management parity must keep canonical Team storage/routes, refresh persistence, and removed alias 404 behavior under browser/readiness protection',
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
    check(
      'phase-0-management-boundary-regression',
      hasPhase0ManagementBoundary({
        boundaryTests: phase0ManagementBoundaryTests,
        contractsSocket,
        contractsArtifact,
        serverSource: serverNextSource,
        serverRepositories: serverNextRepositories,
        serverMigrations: serverNextMigrations,
        socketHandlers: serverNextSocketHandlers,
      }),
      'Phase 0 must lock existing direct Dispatch, Task review, Artifact/Workspace Run, Socket, repository, and migration boundaries without production management wiring',
    ),
    check(
      'phase-0-root-scripts',
      hasPhase0RootScripts(packageJson.scripts),
      'Phase 0 must expose deterministic root test, build, boundary, and SEA verdict consumer scripts',
    ),
    check(
      'phase-1-management-boundary-scaffold',
      packageJson.scripts?.['test:phase1-management-boundary'] ===
        'node --test scripts/check-phase-1-management-boundary.test.mjs' &&
        packageJson.scripts?.['check:phase1-management-boundary'] ===
          'node scripts/check-phase-1-management-boundary.mjs' &&
        workflow.includes('check-phase-1-management-boundary'),
      'Phase 1 must expose a fail-closed management boundary checker and include it in CI change detection',
    ),
    check(
      'phase-1-management-root-and-ci-gates',
      hasPhase1ManagementCiGate({ scripts: packageJson.scripts, workflow }),
      'Phase 1 management must expose and run complete root test/build gates while retaining Phase 0 and product gates',
    ),
    check(
      'phase-2-task-dag-boundary-and-ci-gates',
      hasPhase2TaskDagCiGate({ scripts: packageJson.scripts, workflow }),
      'Phase 2 must expose fail-closed boundary, test, build, and ordered CI gates while retaining Phase 1',
    ),
    check(
      'phase-2-real-two-agent-closeout-smoke',
      phase2CloseoutSmoke.includes('createTaskClaimProtocolClient') &&
        phase2CloseoutSmoke.includes("'agents.invoke'") &&
        phase2CloseoutSmoke.includes("'tasks.accept_subtask'") &&
        phase2CloseoutSmoke.includes('WEB_EVENTS.task.dag') &&
        phase2CloseoutSmoke.includes('AGENT_EVENTS.dispatch.result') &&
        browserSmokeScript.includes('webui-phase2-task-dag-business-flow') &&
        browserSmokeScript.includes('supportedPhases: [1, 2]') &&
        browserSmokeScript.includes('data-smoke="task-dag-panel"') &&
        daemonInstallSmokeScript.includes(
          'dist/apps/daemon-next/src/management-worker-protocol.js',
        ) &&
        daemonInstallSmokeScript.includes('PHASE_2_MANAGEMENT_TOOL_NAMES?.length !== 22') &&
        daemonInstallSmokeScript.includes("includes('agents.list_available')") &&
        daemonInstallSmokeScript.includes("includes('handoffs.request')") &&
        daemonInstallSmokeScript.includes("includes('handoffs.await_result')") &&
        daemonInstallSmokeScript.includes('createPiManagerWorkerHost'),
      'Phase 2 closeout must retain the real two-Agent claim/invocation/delivery/human-review smoke, browser Task DAG surface, and canonical published daemon Worker runtime',
    ),
    check(
      'node-24-toolchain-contract',
      hasNode24Toolchain({
        packageJson,
        nvmrc,
        workflows: [workflow, seaWorkflow, dailyChangelogWorkflow],
        piSeaChecker,
        piSeaBuilder,
      }),
      'AgentBean installs, tests, builds, deploys, and SEA compatibility checks must use Node 24.18.0',
    ),
    check(
      'ci-runs-phase-0-gates',
      ciRunsPhase0Gates(packageJson.scripts, workflow),
      'AgentBean Next CI must retain Phase 0 boundaries while running package tests and builds once',
    ),
    check(
      'ci-detects-phase-0-changes',
      ciDetectsPhase0Changes(workflow),
      'AgentBean Next CI change detection must cover Phase 0 scripts, lockfile, matrix, packages, and SEA workflow',
    ),
    check(
      'sea-workflow-consumes-root-verdict-check',
      seaWorkflowConsumesRootVerdictCheck(seaWorkflow),
      'SEA workflow must cover PI contracts and consume each generated verdict through the root compatibility checker',
    ),
  ];

  if (production) {
    checks.push(
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

export function hasPhase0ManagementBoundary(input) {
  const agentEventsContract = extractSourceSection(
    input.contractsSocket,
    'export const AGENT_EVENTS',
    'export interface ScanRequestCustomAgent',
  );
  const agentSocketHandlers = extractSourceSection(
    input.socketHandlers,
    'export function registerAgentSocketHandlers',
  );
  if (agentEventsContract === null || agentSocketHandlers === null) return false;
  const managementWorkerEvents = [
    'management-worker:register',
    'management-worker:lease-offer',
    'management-worker:lease-acquire',
    'management-worker:lease-renew',
    'management-worker:lease-release',
    'management-worker:abort',
    'management-worker:tool-request',
    'management-worker:checkpoint-fetch',
    'management-worker:outbox-replay',
    'management-worker:shadow-evaluate',
    'management-worker:shadow-result',
  ];
  const contractsWithoutWorkerEvents = input.contractsSocket.replace(
    /management-worker:[a-z-]+/g,
    '',
  ).replace(/management-policy:[a-z-]+/g, '')
    .replace(/task-claim:[a-z-]+/g, '')
    .replace(/server-worker:[a-z-]+/g, '')
    .replace(/from\s+['"]\.\/management-worker\.js['"]/g, '')
    // Phase 2 Task Claim 与 Phase 4 Server Worker 均为隔离 worker transport，
    // 不改变 Phase 0 direct Dispatch 边界（与 management-worker 同等豁免）。
    .replace(/export interface TaskClaimOfferV1[\s\S]*?(?=\/\*\*\s*\n \* `\/agent` management worker)/, '');

  return input.boundaryTests.includes('direct channel and DM messages create only canonical Dispatch records') &&
    input.boundaryTests.includes('message dispatch status is projected from the Dispatch repository at read time') &&
    input.boundaryTests.includes('only a human update completes it') &&
    input.boundaryTests.includes('existing Task create, update, and delete APIs') &&
    input.boundaryTests.includes('remain linked by dispatchId without invocationId') &&
    input.boundaryTests.includes('Worker transport stays isolated from existing Task and Dispatch APIs') &&
    managementWorkerEvents.every((eventName) => input.contractsSocket.includes(eventName)) &&
    !hasQuotedManagementExecutionName(contractsWithoutWorkerEvents) &&
    !/["']task:|:task:|\btask\s*:/.test(agentEventsContract) &&
    (!/AGENT_EVENTS\.managementWorker/.test(agentSocketHandlers) ||
      (/safeParseManagementWorkerPayload/.test(agentSocketHandlers) &&
        !/app,\s*'(?:registerManagementWorker|scheduleManagementRun)'/.test(agentSocketHandlers))) &&
    !/app,\s*'(?:createTask|updateTask|deleteTask|reorderTask)'/.test(agentSocketHandlers) &&
    !/pi-management-runtime|createManagementRuntimeFactory|ManagementRuntimeFactory|ManagementSession|PiManagerWorkerHost|ManagementWorkerHost|\bManagementOutbox\b/.test(input.serverSource) &&
    !/\b(?:invocationId|managementRunId)\b/.test(input.contractsArtifact) &&
    input.serverRepositories.includes('management: ManagementRepositories') &&
    input.serverRepositories.includes('managementUnitOfWork: ManagementUnitOfWork') &&
    /CREATE TABLE management_runs/i.test(input.serverMigrations) &&
    /CREATE TABLE management_events/i.test(input.serverMigrations) &&
    /CREATE TABLE agent_invocations/i.test(input.serverMigrations) &&
    /CREATE TABLE management_checkpoints/i.test(input.serverMigrations);
}

export function hasPhase0CiGate({ scripts, workflow, seaWorkflow }) {
  return hasPhase0RootScripts(scripts) &&
    ciRunsPhase0Gates(scripts, workflow) &&
    ciDetectsPhase0Changes(workflow) &&
    seaWorkflowConsumesRootVerdictCheck(seaWorkflow);
}

export function hasPhase1ManagementCiGate({ scripts, workflow }) {
  const expectedTest = 'npm run test:phase1-management-boundary && npm run check:phase1-management-boundary && npm run test:pi-management-runtime && npm run test:phase1';
  const expectedBuild = 'npm run build:packages';
  if (scripts?.['test:phase1-management'] !== expectedTest
    || scripts?.['build:phase1-management'] !== expectedBuild) {
    return false;
  }

  return hasDeduplicatedPackageCi({ scripts, workflow }) &&
    workflow.includes('check-phase-1-management-boundary');
}

export function hasPhase2TaskDagCiGate({ scripts, workflow }) {
  const expectedTest = 'npm run test:phase2-task-dag-boundary && npm run check:phase2-task-dag-boundary && npm run test:contracts -- --api.host 127.0.0.1 && npm run test:pi-management-runtime && npm run test:domain -- --api.host 127.0.0.1 && npm run test:server-next -- --api.host 127.0.0.1';
  const expectedBuild = 'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:daemon-next && npm run build:server-next';
  if (scripts?.['test:phase2-task-dag-boundary'] !== 'node --test scripts/check-phase-2-task-dag-boundary.test.mjs'
    || scripts?.['check:phase2-task-dag-boundary'] !== 'node scripts/check-phase-2-task-dag-boundary.mjs'
    || scripts?.['test:phase2-task-dag'] !== expectedTest
    || scripts?.['test:phase2-closeout'] !== 'cd apps/server-next && ../../node_modules/.bin/vitest run tests/phase-2-managed-team-smoke.test.ts --config vitest.config.ts --api.host 127.0.0.1'
    || scripts?.['build:phase2-task-dag'] !== expectedBuild) {
    return false;
  }
  return hasDeduplicatedPackageCi({ scripts, workflow }) &&
    !workflow.includes('run: npm run test:phase2-closeout') &&
    workflow.includes('check-phase-2-task-dag-boundary');
}

export function hasNode24Toolchain({ packageJson, nvmrc, workflows, piSeaChecker, piSeaBuilder }) {
  if (packageJson?.engines?.node !== '24.x' || nvmrc.trim() !== 'v24.18.0') return false;
  const setupNodeVersionIsPinned = workflows.every((workflow) => {
    const setupCount = workflow.match(/uses:\s*actions\/setup-node@/g)?.length ?? 0;
    const versions = [...workflow.matchAll(/node-version:\s*['"]?([^'"\s]+)/g)]
      .map((match) => match[1]);
    return setupCount === versions.length
      && versions.length > 0
      && versions.every((version) => version === '24.18.0');
  });
  return setupNodeVersionIsPinned
    && piSeaChecker.includes("PI_SEA_NODE_VERSION = '24.18.0'")
    && piSeaBuilder.includes("target: 'node24'")
    && piSeaBuilder.includes("'--experimental-sea-config'")
    && !piSeaBuilder.includes("target: 'node26'")
    && !piSeaBuilder.includes("'--build-sea'");
}

function hasPhase0RootScripts(scripts) {
  return scripts?.['test:phase0'] ===
      'npm run test:pi-management-runtime && npm run test:contracts -- --api.host 127.0.0.1 && npm run test:domain -- --api.host 127.0.0.1 && npm run test:phase0-boundary && npm run check:phase0-pi-boundary && cd apps/server-next && ../../node_modules/.bin/vitest run tests/phase-0-management-boundary.test.ts --config vitest.config.ts --api.host 127.0.0.1' &&
    scripts?.['build:phase0'] ===
      'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:server-next' &&
    scripts?.['check:pi-sea-compatibility'] === 'node scripts/check-pi-management-sea.mjs validate';
}

function ciRunsPhase0Gates(scripts, workflow) {
  return hasDeduplicatedPackageCi({ scripts, workflow });
}

function hasDeduplicatedPackageCi({ scripts, workflow }) {
  const expectedPackages = 'npm run test:contracts -- --api.host 127.0.0.1 && npm run test:pi-management-runtime && npm run test:domain -- --api.host 127.0.0.1 && npm run test:server-next-ci && npm run test:daemon-next -- --api.host 127.0.0.1 && npm run test:web-next -- --api.host 127.0.0.1';
  const expectedServerCi = 'cd apps/server-next && ../../node_modules/.bin/vitest run tests --config vitest.config.ts --api.host 127.0.0.1 --exclude tests/phase-2-managed-team-smoke.test.ts --exclude tests/phase-4-managed-server-worker-smoke.test.ts';
  const requiredBoundaries = [
    'npm run test:pr-merge-readiness',
    'npm run test:issue-claim',
    'npm run test:phase0-boundary',
    'npm run check:phase0-pi-boundary',
    'npm run test:phase1-management-boundary',
    'npm run check:phase1-management-boundary',
    'npm run test:phase2-task-dag-boundary',
    'npm run check:phase2-task-dag-boundary',
    'npm run test:phase2-closeout',
    'npm run test:phase3-memory-boundary',
    'npm run check:phase3-memory-boundary',
  ];
  const expectedBuild = 'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:server-next && npm run build:daemon-next && npm run build:web-next';
  const duplicateWorkflowScripts = [
    'test:phase1',
    'test:phase0',
    'test:phase1-management',
    'test:phase2-task-dag',
    'test:phase2-closeout',
    'build:phase0',
    'build:phase1-management',
    'build:phase2-task-dag',
  ];
  const packageTests = workflow.indexOf('run: npm run test:ci');
  const packageBuild = workflow.indexOf('run: npm run build:packages');
  const retainedBoundaries = scripts?.['test:retained-boundaries']?.split(/\s*&&\s*/u) ?? [];
  let boundaryCursor = -1;
  const retainsOrderedBoundaries = requiredBoundaries.every((command) => {
    boundaryCursor = retainedBoundaries.indexOf(command, boundaryCursor + 1);
    return boundaryCursor >= 0;
  });
  return scripts?.['test:packages'] === expectedPackages &&
    scripts?.['test:server-next-ci'] === expectedServerCi &&
    retainsOrderedBoundaries &&
    retainedBoundaries.length === new Set(retainedBoundaries).size &&
    scripts?.['test:ci'] === 'npm run test:packages && npm run test:retained-boundaries' &&
    scripts?.['build:packages'] === expectedBuild &&
    packageTests >= 0 &&
    packageTests < packageBuild &&
    workflow.match(/run: npm run test:ci/g)?.length === 1 &&
    workflow.match(/run: npm run build:packages/g)?.length === 1 &&
    duplicateWorkflowScripts.every((script) => !workflowRunsScript(workflow, script));
}

function workflowRunsScript(workflow, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:-\\s*)?(?:run:\\s*)?npm (?:run|run-script) ${escaped}(?:\\s|$)`, 'mu').test(workflow);
}

function ciDetectsPhase0Changes(workflow) {
  return [
    '^packages/',
    '^agentbean-next/',
    'check-phase-0-pi-boundary',
    'check-pi-management-sea',
    'build-pi-management-sea',
    '^\\.nvmrc$',
    'package(-lock)?\\.json',
    'pi-sea-compatibility',
  ].every((token) => workflow.includes(token));
}

function seaWorkflowConsumesRootVerdictCheck(seaWorkflow) {
  return seaWorkflow.includes('- packages/contracts/**') &&
    seaWorkflow.includes('- packages/domain/**') &&
    /name: Consume platform verdict through root gate\r?\n\s+if: always\(\)\r?\n\s+run: npm run check:pi-sea-compatibility -- --file artifacts\/pi-sea-verdict\/verdict\.json/u.test(seaWorkflow);
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

function readTreeText(root) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return `${entry.name}\n${entry.isDirectory() ? readTreeText(path) : readFileSync(path, 'utf8')}`;
    })
    .join('\n');
}

function extractSourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  if (endMarker === undefined) return source.slice(start);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? null : source.slice(start, end);
}

function hasQuotedManagementExecutionName(source) {
  return [...source.matchAll(/(['"])([^'"\n]*)\1/g)]
    .some((match) => /management|invocation|checkpoint/i.test(match[2]));
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
