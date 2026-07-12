import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanNextReadinessChecks,
  summarizeReadiness,
} from '../../../scripts/check-agentbean-next-readiness.mjs';

describe('AgentBean Next readiness checker', () => {
  test('passes static repository deployment checks', () => {
    const summary = summarizeReadiness(collectAgentBeanNextReadinessChecks());

    expect(summary.ok).toBe(true);
    expect(summary.checks.map((check) => check.id)).toEqual([
      'root-build-script',
      'root-start-script',
      'railway-build-command',
      'railway-start-healthcheck',
      'ci-validates-root-railway-config',
      'ci-runs-on-main-push',
      'ci-runs-readiness-checker',
      'ci-runs-package-scoped-phase-tests',
      'ci-builds-canonical-packages-before-browser-smoke',
      'ci-runs-production-readiness-before-deploy',
      'daemon-install-smoke-script',
      'entry-smoke-script',
      'business-smoke-script',
      'persistence-smoke-script',
      'legacy-source-retired',
      'ci-runs-production-smoke-on-demand',
      'ci-requires-production-smoke-for-manual-deploy',
      'ci-forbids-deploy-when-npm-publish-is-skipped',
      'ci-runs-strict-cutover-before-production-smoke',
      'ci-provides-production-env-for-production-smoke-audits',
      'ci-runs-daemon-install-smoke',
      'ci-deploys-only-server-next',
      'daily-changelog-uses-single-main-push-deploy',
      'ci-fails-closed-without-production-tokens',
      'ci-deploys-production-on-main-push',
      'ci-bounds-railway-deploy-command',
      'contracts-package-publishable',
      'daemon-next-package-publishable',
      'daemon-next-runtime-dependencies',
      'daemon-runtime-does-not-probe-retired-source',
      'server-runtime-dependencies-owned-by-server-next',
      'daemon-next-version-replaces-old-daemon',
      'ci-publishes-next-packages',
      'ci-runs-railway-next-preflight-without-deploy',
      'ci-syncs-railway-next-env-without-deploy',
      'ci-publishes-on-main-push',
      'ci-runs-next-production-smoke-after-main-push',
      'ci-promotes-canonical-daemon-latest-on-demand',
      'ci-verifies-published-legacy-daemon-artifact',
      'cutover-audit-requires-canonical-daemon-dist-tags',
      'members-list-agent-parity-regression',
      'daemon-onboarding-profile-lifecycle',
      'daemon-onboarding-token-refresh',
      'daemon-onboarding-lifecycle-green',
      'product-surface-parity-contracts',
      'parity-backfill-audit-status-table',
      'teams-parity-browser-smoke',
      'devices-parity-browser-smoke',
      'agents-parity-browser-smoke',
      'tasks-parity-browser-smoke',
      'runs-parity-browser-smoke',
      'settings-parity-browser-smoke',
      'channel-members-parity-browser-smoke',
      'admin-dashboard-parity-regression',
      'admin-dashboard-parity-browser-smoke',
    ]);
  });

  test('requires production environment for production smoke audits', () => {
    const summary = summarizeReadiness(collectAgentBeanNextReadinessChecks());

    expect(summary.checks.find((check) => check.id === 'ci-provides-production-env-for-production-smoke-audits')).toMatchObject({
      ok: true,
    });
  });

  test('fails production readiness when required flip configuration is absent', () => {
    const summary = summarizeReadiness(
      collectAgentBeanNextReadinessChecks({
        production: true,
        env: {},
      }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual([
      'railway-token-present',
      'production-session-secret-present',
      'production-data-dir-present',
      'production-data-dir-not-default',
    ]);
  });

  test('passes production readiness when deployment target and production env are explicit', () => {
    const summary = summarizeReadiness(
      collectAgentBeanNextReadinessChecks({
        production: true,
        env: {
          RAILWAY_TOKEN: 'token',
          AGENTBEAN_NEXT_SESSION_SECRET: 'session-secret',
          AGENTBEAN_NEXT_DATA_DIR: '/data/agentbean-next',
        },
      }),
    );

    expect(summary.ok).toBe(true);
  });
});
