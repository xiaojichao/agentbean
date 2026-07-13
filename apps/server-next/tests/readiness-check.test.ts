import { describe, expect, test } from 'vitest';
import {
  collectAgentBeanNextReadinessChecks,
  hasNode24Toolchain,
  hasPhase0CiGate,
  hasPhase0ManagementBoundary,
  hasPhase1ManagementCiGate,
  hasPhase2TaskDagCiGate,
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
      'pi-management-runtime-package-publishable',
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
      'phase-0-management-boundary-regression',
      'phase-0-root-scripts',
      'phase-1-management-boundary-scaffold',
      'phase-1-management-root-and-ci-gates',
      'phase-2-task-dag-boundary-and-ci-gates',
      'node-24-toolchain-contract',
      'ci-runs-phase-0-gates',
      'ci-detects-phase-0-changes',
      'sea-workflow-consumes-root-verdict-check',
    ]);
  });

  test('fails closed when the Phase 0 root or CI gate is incomplete', () => {
    const valid = {
      scripts: {
        'test:phase0': 'npm run test:pi-management-runtime && npm run test:contracts -- --api.host 127.0.0.1 && npm run test:domain -- --api.host 127.0.0.1 && npm run test:phase0-boundary && npm run check:phase0-pi-boundary && cd apps/server-next && ../../node_modules/.bin/vitest run tests/phase-0-management-boundary.test.ts --config vitest.config.ts --api.host 127.0.0.1',
        'build:phase0': 'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:server-next',
        'check:pi-sea-compatibility': 'node scripts/check-pi-management-sea.mjs validate',
      },
      workflow: [
        '^agentbean-next/',
        '^packages/',
        'check-phase-0-pi-boundary',
        'check-pi-management-sea',
        'build-pi-management-sea',
        '^\\.nvmrc$',
        'package(-lock)?\\.json',
        'pi-sea-compatibility',
        'run: npm run test:phase1',
        'run: npm run test:phase0',
        'run: npm run build:phase0',
      ].join('\n'),
      seaWorkflow: [
        '- packages/contracts/**',
        '- packages/domain/**',
        '      - name: Consume platform verdict through root gate',
        '        if: always()',
        '        run: npm run check:pi-sea-compatibility -- --file artifacts/pi-sea-verdict/verdict.json',
      ].join('\n'),
    };
    expect(hasPhase0CiGate(valid)).toBe(true);
    expect(hasPhase0CiGate({
      ...valid,
      seaWorkflow: valid.seaWorkflow.replaceAll('\n', '\r\n'),
    })).toBe(true);

    for (const bypass of [
      { scripts: { ...valid.scripts, 'test:phase0': 'npm run test:pi-management-runtime' } },
      { scripts: { ...valid.scripts, 'build:phase0': 'npm run build:pi-management-runtime' } },
      { scripts: { ...valid.scripts, 'check:pi-sea-compatibility': 'node scripts/build-pi-management-sea.mjs' } },
      { workflow: valid.workflow.replace('run: npm run test:phase0', '') },
      { workflow: valid.workflow.replace('^\\.nvmrc$', '') },
      { workflow: valid.workflow.replace('package(-lock)?\\.json', '') },
      { seaWorkflow: valid.seaWorkflow.replace('- packages/contracts/**', '') },
      { seaWorkflow: valid.seaWorkflow.replace('if: always()', '') },
      { seaWorkflow: valid.seaWorkflow.replace('npm run check:pi-sea-compatibility', 'node scripts/check-pi-management-sea.mjs') },
    ]) {
      expect(hasPhase0CiGate({ ...valid, ...bypass })).toBe(false);
    }
  });

  test('fails closed when a Phase 1 management root or CI gate is bypassed', () => {
    const valid = {
      scripts: {
        'test:phase1-management': 'npm run test:phase1-management-boundary && npm run check:phase1-management-boundary && npm run test:pi-management-runtime && npm run test:phase1',
        'build:phase1-management': 'npm run build:packages',
      },
      workflow: [
        'check-phase-1-management-boundary',
        'run: npm run test:phase1',
        'run: npm run test:phase0',
        'run: npm run test:phase1-management',
        'run: npm run build:phase0',
        'run: npm run build:phase1-management',
        'run: npm run build:packages',
      ].join('\n'),
    };
    expect(hasPhase1ManagementCiGate(valid)).toBe(true);

    for (const bypass of [
      { scripts: { ...valid.scripts, 'test:phase1-management': 'npm run test:phase1' } },
      { scripts: { ...valid.scripts, 'build:phase1-management': 'npm run build:server-next' } },
      { workflow: valid.workflow.replace('run: npm run test:phase1-management', '') },
      { workflow: valid.workflow.replace('run: npm run build:phase1-management', '') },
      { workflow: valid.workflow.replace('check-phase-1-management-boundary', '') },
      {
        workflow: valid.workflow.replace(
          'run: npm run test:phase0\nrun: npm run test:phase1-management',
          'run: npm run test:phase1-management\nrun: npm run test:phase0',
        ),
      },
    ]) {
      expect(hasPhase1ManagementCiGate({ ...valid, ...bypass })).toBe(false);
    }
  });

  test('fails closed when a Phase 2 boundary or ordered CI gate is bypassed', () => {
    const scripts = {
      'test:phase2-task-dag-boundary': 'node --test scripts/check-phase-2-task-dag-boundary.test.mjs',
      'check:phase2-task-dag-boundary': 'node scripts/check-phase-2-task-dag-boundary.mjs',
      'test:phase2-task-dag': 'npm run test:phase2-task-dag-boundary && npm run check:phase2-task-dag-boundary && npm run test:contracts -- --api.host 127.0.0.1 && npm run test:pi-management-runtime && npm run test:domain -- --api.host 127.0.0.1 && npm run test:server-next -- --api.host 127.0.0.1',
      'build:phase2-task-dag': 'npm run build:contracts && npm run build:domain && npm run build:pi-management-runtime && npm run build:daemon-next && npm run build:server-next',
    };
    const workflow = [
      'check-phase-2-task-dag-boundary',
      'run: npm run test:phase1-management',
      'run: npm run test:phase2-task-dag',
      'run: npm run build:phase1-management',
      'run: npm run build:phase2-task-dag',
    ].join('\n');
    expect(hasPhase2TaskDagCiGate({ scripts, workflow })).toBe(true);
    expect(hasPhase2TaskDagCiGate({ scripts, workflow: workflow.replace('run: npm run test:phase2-task-dag', '') })).toBe(false);
    expect(hasPhase2TaskDagCiGate({
      scripts: { ...scripts, 'test:phase2-task-dag': 'npm run test:pi-management-runtime' },
      workflow,
    })).toBe(false);
  });

  test('pins local, CI, deploy, and SEA execution to Node 24', () => {
    const workflow = [
      'uses: actions/setup-node@v6',
      'node-version: 24.18.0',
    ].join('\n');
    const valid = {
      packageJson: { engines: { node: '24.x' } },
      nvmrc: 'v24.18.0\n',
      workflows: [workflow, workflow.replaceAll('\n', '\r\n')],
      piSeaChecker: "export const PI_SEA_NODE_VERSION = '24.18.0';",
      piSeaBuilder: "target: 'node24'; run(process.execPath, ['--experimental-sea-config']);",
    };
    expect(hasNode24Toolchain(valid)).toBe(true);

    for (const bypass of [
      { packageJson: { engines: { node: '>=24' } } },
      { nvmrc: '26.5.0\n' },
      { workflows: [workflow, workflow.replace('24.18.0', '26.5.0')] },
      { workflows: [`${workflow}\nuses: actions/setup-node@v6`] },
      { piSeaChecker: "export const PI_SEA_NODE_VERSION = '26.5.0';" },
      { piSeaBuilder: "target: 'node26'; run(process.execPath, ['--build-sea']);" },
    ]) {
      expect(hasNode24Toolchain({ ...valid, ...bypass })).toBe(false);
    }
  });

  test('requires production environment for production smoke audits', () => {
    const summary = summarizeReadiness(collectAgentBeanNextReadinessChecks());

    expect(summary.checks.find((check) => check.id === 'ci-provides-production-env-for-production-smoke-audits')).toMatchObject({
      ok: true,
    });
  });

  test('fails closed when Phase 0 Server management boundaries are bypassed', () => {
    const boundaryTests = [
      'direct channel and DM messages create only canonical Dispatch records',
      'message dispatch status is projected from the Dispatch repository at read time',
      'only a human update completes it',
      'existing Task create, update, and delete APIs',
      'remain linked by dispatchId without invocationId',
      'Worker transport stays isolated from existing Task and Dispatch APIs',
    ].join('\n');
    const valid = {
      boundaryTests,
      contractsSocket: "export const AGENT_EVENTS = { dispatch: { result: 'dispatch:result' }, managementWorker: { register: 'management-worker:register', leaseOffer: 'management-worker:lease-offer', leaseAcquire: 'management-worker:lease-acquire', leaseRenew: 'management-worker:lease-renew', leaseRelease: 'management-worker:lease-release', abort: 'management-worker:abort', toolRequest: 'management-worker:tool-request', checkpointFetch: 'management-worker:checkpoint-fetch', outboxReplay: 'management-worker:outbox-replay', shadowEvaluate: 'management-worker:shadow-evaluate', shadowResult: 'management-worker:shadow-result' } }; export interface ScanRequestCustomAgent {}",
      contractsArtifact: 'interface ArtifactDto { dispatchId?: string }',
      serverSource: 'export function startServer() {}',
      serverRepositories: 'export interface Repositories { management: ManagementRepositories; managementUnitOfWork: ManagementUnitOfWork }',
      serverMigrations: 'CREATE TABLE management_runs (id TEXT); CREATE TABLE management_events (id TEXT); CREATE TABLE agent_invocations (id TEXT); CREATE TABLE management_checkpoints (id TEXT);',
      socketHandlers: "export function registerAgentSocketHandlers() { bind(socket, AGENT_EVENTS.dispatch.result, app, 'receiveDispatchResult'); }",
    };
    expect(hasPhase0ManagementBoundary(valid)).toBe(true);

    for (const bypass of [
      { contractsSocket: "export const AGENT_EVENTS = { task: { update: 'task:update' } }; export interface ScanRequestCustomAgent {}" },
      { contractsSocket: "export const AGENT_EVENTS = { run: 'management-run:start' }; export interface ScanRequestCustomAgent {}" },
      { contractsSocket: "export const AGENT_EVENTS = { invoke: 'agent-invocation:start' }; export interface ScanRequestCustomAgent {}" },
      { contractsSocket: "export const AGENT_EVENTS = { restore: 'checkpoint:restore' }; export interface ScanRequestCustomAgent {}" },
      { contractsSocket: "export const AGENT_EVENTS = {};" },
      { socketHandlers: "export function registerAgentSocketHandlers() { bind(socket, AGENT_EVENTS.managementWorker.register, app, 'registerManagementWorker'); }" },
      { socketHandlers: "export function registerAgentSocketHandlers() { bind(socket, AGENT_EVENTS.task.update, app, 'updateTask'); }" },
      { socketHandlers: 'export function registerWebSocketHandlers() {}' },
      { serverSource: "import { createManagementRuntimeFactory } from '@agentbean/pi-management-runtime';" },
      { serverSource: "import { createRuntime } from '../../../../packages/pi-management-runtime/src/index.js';" },
      { serverRepositories: 'export interface Repositories { managementUnitOfWork: ManagementUnitOfWork }' },
      { serverRepositories: 'export interface Repositories { management: ManagementRepositories }' },
      { contractsArtifact: 'interface ArtifactDto { invocationId?: string }' },
      { serverMigrations: 'CREATE TABLE management_runs (id TEXT); CREATE TABLE management_events (id TEXT); CREATE TABLE management_checkpoints (id TEXT);' },
      { serverMigrations: 'CREATE TABLE management_runs (id TEXT); CREATE TABLE agent_invocations (id TEXT); CREATE TABLE management_checkpoints (id TEXT);' },
    ]) {
      expect(hasPhase0ManagementBoundary({ ...valid, ...bypass })).toBe(false);
    }
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
