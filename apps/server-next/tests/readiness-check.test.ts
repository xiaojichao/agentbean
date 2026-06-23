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
      'ci-runs-production-readiness-before-next-deploy',
      'daemon-install-smoke-script',
      'entry-smoke-script',
      'business-smoke-script',
      'persistence-smoke-script',
      'old-entry-smoke-script',
      'ci-runs-production-smoke-on-demand',
      'ci-requires-production-smoke-for-next-deploy',
      'ci-requires-repository-target-for-manual-next-deploy',
      'ci-requires-old-smoke-for-manual-rollback-deploy',
      'ci-runs-ready-to-flip-before-production-smoke',
      'ci-runs-strict-cutover-after-final-flip-before-production-smoke',
      'ci-provides-production-env-for-production-smoke-audits',
      'ci-runs-daemon-install-smoke',
      'deploy-target-gate',
      'ci-deploys-production-on-main-push',
      'ci-bounds-railway-deploy-command',
      'ready-to-flip-audit-script',
      'contracts-package-publishable',
      'daemon-next-package-publishable',
      'daemon-next-runtime-dependencies',
      'daemon-next-version-replaces-old-daemon',
      'ci-publishes-next-packages',
      'ci-decouples-next-npm-publish-from-production-deploy',
      'ci-runs-railway-next-preflight-without-deploy',
      'ci-syncs-railway-next-env-without-deploy',
      'ci-publishes-on-main-push',
      'ci-runs-next-production-smoke-after-main-push',
      'ci-promotes-canonical-daemon-latest-on-demand',
      'ci-legacy-daemon-does-not-reclaim-latest-when-next',
      'cutover-audit-requires-canonical-daemon-latest',
      'members-list-agent-parity-regression',
      'daemon-next-register-batch-legacy-compatibility',
      'product-surface-parity-contracts',
      'parity-backfill-audit-status-table',
      'devices-parity-browser-smoke',
      'channel-members-parity-browser-smoke',
      'admin-dashboard-parity-regression',
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
      'production-deploy-target-next',
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
          AGENTBEAN_DEPLOY_TARGET: 'next',
          RAILWAY_TOKEN: 'token',
          AGENTBEAN_NEXT_SESSION_SECRET: 'session-secret',
          AGENTBEAN_NEXT_DATA_DIR: '/data/agentbean-next',
        },
      }),
    );

    expect(summary.ok).toBe(true);
  });
});
