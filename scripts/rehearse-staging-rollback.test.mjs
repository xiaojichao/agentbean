import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  PRODUCTION_RAILWAY_ENVIRONMENT_IDS,
  buildStagingRollbackPlan,
  collectLiveRollbackSnapshot,
  executeStagingRollback,
  validateStagingRollbackConfig,
} from './rehearse-staging-rollback.mjs';

const ids = {
  project: '11111111-1111-4111-8111-111111111111',
  service: '22222222-2222-4222-8222-222222222222',
  staging: '33333333-3333-4333-8333-333333333333',
  current: '44444444-4444-4444-8444-444444444444',
  previous: '55555555-5555-4555-8555-555555555555',
  older: '66666666-6666-4666-8666-666666666666',
  rollback: '77777777-7777-4777-8777-777777777777',
  newCurrent: '88888888-8888-4888-8888-888888888888',
};

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'railway',
    environmentName: 'staging',
    projectId: ids.project,
    serviceId: ids.service,
    environmentId: ids.staging,
    baseUrl: 'https://staging.example.test',
    tokenEnv: 'AGENTBEAN_STAGING_RAILWAY_TOKEN',
    ...overrides,
  };
}

function deployment(id, createdAt, overrides = {}) {
  return {
    id,
    status: 'SUCCESS',
    createdAt,
    canRollback: id !== ids.current,
    meta: { commitHash: id.slice(0, 8) },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: ids.project,
    serviceId: ids.service,
    environmentId: ids.staging,
    historyTruncated: false,
    deployments: [
      deployment(ids.current, '2026-08-24T10:00:00Z'),
      deployment(ids.previous, '2026-08-23T10:00:00Z', { status: 'REMOVED' }),
      deployment(ids.older, '2026-08-22T10:00:00Z', { status: 'REMOVED' }),
    ],
    ...overrides,
  };
}

function graphqlResponse(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

test('builds a deterministic dry-run plan from current and previous staging deployments', () => {
  const first = buildStagingRollbackPlan(config(), snapshot());
  const second = buildStagingRollbackPlan(config(), snapshot());
  assert.deepEqual(first, second);
  assert.equal(first.current.id, ids.current);
  assert.equal(first.target.id, ids.previous);
  assert.equal(first.target.sourceVersion, ids.previous.slice(0, 8));
  assert.match(first.planHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.actions.map((item) => item.write), [false, true, false, false]);
});

test('allows an explicit older target only when it remains rollbackable', () => {
  const plan = buildStagingRollbackPlan(config(), snapshot(), { targetDeploymentId: ids.older });
  assert.equal(plan.target.id, ids.older);
  assert.throws(
    () => buildStagingRollbackPlan(config(), snapshot(), { targetDeploymentId: ids.current }),
    /不是可回滚的历史 staging 版本/,
  );
});

test('fails closed when history is truncated or no prior deployment can rollback', () => {
  assert.throws(() => buildStagingRollbackPlan(config(), snapshot({ historyTruncated: true })), /查询不完整/);
  const noTarget = snapshot({
    deployments: [
      deployment(ids.current, '2026-08-24T10:00:00Z'),
      deployment(ids.previous, '2026-08-23T10:00:00Z', { canRollback: false }),
    ],
  });
  assert.throws(() => buildStagingRollbackPlan(config(), noTarget), /找不到 canRollback=true/);
});

test('refuses to plan while a newer staging deployment is still in progress', () => {
  const busy = snapshot({
    deployments: [
      deployment(ids.newCurrent, '2026-08-25T10:00:00Z', { status: 'DEPLOYING', canRollback: false }),
      ...snapshot().deployments,
    ],
  });
  assert.throws(() => buildStagingRollbackPlan(config(), busy), /必须先冻结部署并等待稳定 SUCCESS/);
});

test('hard rejects production environment, production URL, wrong token name, and unknown config keys', () => {
  const [productionEnvironmentId] = PRODUCTION_RAILWAY_ENVIRONMENT_IDS;
  assert.throws(() => validateStagingRollbackConfig(config({ environmentName: 'production' })), /只允许/);
  assert.throws(() => validateStagingRollbackConfig(config({ environmentId: productionEnvironmentId })), /production Railway/);
  assert.throws(() => validateStagingRollbackConfig(config({ baseUrl: 'https://api.agentbean.dev' })), /production URL/);
  assert.throws(() => validateStagingRollbackConfig(config({ baseUrl: 'https://127.0.0.1' })), /IP、localhost/);
  assert.throws(() => validateStagingRollbackConfig(config({ baseUrl: 'https://staging.example.test:8443' })), /非默认端口/);
  assert.throws(() => validateStagingRollbackConfig(config({ tokenEnv: 'RAILWAY_TOKEN' })), /AGENTBEAN_STAGING_RAILWAY_TOKEN/);
  assert.throws(() => validateStagingRollbackConfig(config({ extra: true })), /未知字段/);
});

test('production environment guard stays synchronized with the active workflow', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8');
  for (const environmentId of PRODUCTION_RAILWAY_ENVIRONMENT_IDS) assert.match(workflow, new RegExp(environmentId));
});

test('live snapshot verifies the project-token scope and performs no mutation', async () => {
  const queries = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    queries.push(body.query);
    return graphqlResponse({
      projectToken: { projectId: ids.project, environmentId: ids.staging },
      environment: { id: ids.staging, name: 'staging' },
      deployments: {
        edges: snapshot().deployments.map((node) => ({ node })),
        pageInfo: { hasNextPage: false },
      },
    });
  };
  const result = await collectLiveRollbackSnapshot(config(), { token: 'staging-token', fetcher });
  assert.equal(result.deployments.length, 3);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^query StagingRollbackContext/);
  assert.doesNotMatch(queries[0], /mutation/);
});

test('live snapshot rejects a project token scoped to another environment', async () => {
  const fetcher = async () => graphqlResponse({
    projectToken: { projectId: ids.project, environmentId: ids.current },
    environment: { id: ids.current, name: 'production' },
    deployments: { edges: [], pageInfo: { hasNextPage: false } },
  });
  await assert.rejects(
    collectLiveRollbackSnapshot(config(), { token: 'wrong-scope', fetcher }),
    /token scope/,
  );
});

test('live snapshot rejects a Railway environment whose real name is not staging', async () => {
  const fetcher = async () => graphqlResponse({
    projectToken: { projectId: ids.project, environmentId: ids.staging },
    environment: { id: ids.staging, name: 'production' },
    deployments: { edges: snapshot().deployments.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
  });
  await assert.rejects(
    collectLiveRollbackSnapshot(config(), { token: 'wrong-environment', fetcher }),
    /identity 必须精确为 staging/,
  );
});

test('execute requires the exact plan hash before any external request', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let called = false;
  await assert.rejects(
    executeStagingRollback({ rawConfig: config(), plan, confirmation: 'wrong', token: 'secret' }, {
      graphqlFetcher: async () => { called = true; throw new Error('should not run'); },
    }),
    /planHash/,
  );
  assert.equal(called, false);
});

test('execute rejects a plan bound to another staging config before any external request', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let called = false;
  await assert.rejects(
    executeStagingRollback({
      rawConfig: config({ environmentId: '99999999-9999-4999-8999-999999999999' }),
      plan,
      confirmation: plan.planHash,
      token: 'secret',
      expectedStagingHost: 'staging.example.test',
      stagingFrozen: true,
    }, {
      graphqlFetcher: async () => { called = true; throw new Error('should not run'); },
    }),
    /plan environment 与 staging config 不一致/,
  );
  assert.equal(called, false);
});

test('execute rejects an entry host that is not independently bound by the operator', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let called = false;
  await assert.rejects(
    executeStagingRollback({
      rawConfig: config(), plan, confirmation: plan.planHash, token: 'secret', expectedStagingHost: 'other.example.test',
    }, {
      graphqlFetcher: async () => { called = true; throw new Error('should not run'); },
    }),
    /AGENTBEAN_STAGING_ENTRY_HOST.*不一致/,
  );
  assert.equal(called, false);
});

test('execute requires an explicit staging freeze acknowledgement before external requests', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let called = false;
  await assert.rejects(
    executeStagingRollback({
      rawConfig: config(), plan, confirmation: plan.planHash, token: 'secret', expectedStagingHost: 'staging.example.test',
    }, {
      graphqlFetcher: async () => { called = true; throw new Error('should not run'); },
    }),
    /--ack-staging-frozen/,
  );
  assert.equal(called, false);
});

test('execute re-reads live history and rejects a stale current deployment before mutation', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let mutations = 0;
  const staleHistory = [
    deployment(ids.newCurrent, '2026-08-25T10:00:00Z'),
    deployment(ids.current, '2026-08-24T10:00:00Z', { status: 'REMOVED', canRollback: true }),
    deployment(ids.previous, '2026-08-23T10:00:00Z', { status: 'REMOVED' }),
  ];
  const graphqlFetcher = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes('deploymentRollback')) mutations += 1;
    return graphqlResponse({
      projectToken: { projectId: ids.project, environmentId: ids.staging },
      environment: { id: ids.staging, name: 'staging' },
      deployments: { edges: staleHistory.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
    });
  };
  await assert.rejects(
    executeStagingRollback({
      rawConfig: config(),
      plan,
      confirmation: plan.planHash,
      token: 'secret',
      expectedStagingHost: 'staging.example.test',
      stagingFrozen: true,
    }, { graphqlFetcher }),
    /truth 已变化/,
  );
  assert.equal(mutations, 0);
});

test('executes one staging rollback mutation, waits for success, then runs read-only entry smoke', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  const operations = [];
  const graphqlFetcher = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    operations.push(query.split(/\s+/).slice(0, 2).join(' '));
    if (query.includes('StagingRollbackContext')) {
      return graphqlResponse({
        projectToken: { projectId: ids.project, environmentId: ids.staging },
        environment: { id: ids.staging, name: 'staging' },
        deployments: { edges: snapshot().deployments.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
      });
    }
    if (query.includes('deploymentRollback')) {
      assert.equal(variables.id, ids.previous);
      return graphqlResponse({ deploymentRollback: { id: ids.rollback, status: 'DEPLOYING' } });
    }
    if (variables.id === ids.previous) {
      return graphqlResponse({ deployment: deployment(ids.previous, '2026-08-23T10:00:00Z') });
    }
    return graphqlResponse({ deployment: deployment(ids.rollback, '2026-08-24T10:05:00Z') });
  };
  const entryFetcher = async (url) => {
    if (url.pathname === '/healthz') return { ok: true, text: async () => JSON.stringify({ ok: true, service: 'agentbean-next-server' }) };
    if (url.pathname === '/') return { ok: true, text: async () => '<title>AgentBean：和你的 AI 同事，在一个团队里干活</title>三步，把 AI 请进团队 /_next/static/chunks/app/page-a /_next/static/chunks/app/layout-b SocketProvider AppShell' };
    return { ok: true, text: async () => 'socket.io io' };
  };
  const result = await executeStagingRollback({
    rawConfig: config(),
    plan,
    confirmation: plan.planHash,
    token: 'staging-secret',
    expectedStagingHost: 'staging.example.test',
    stagingFrozen: true,
  }, {
    graphqlFetcher,
    entryFetcher,
    sleep: async () => {},
    pollAttempts: 1,
    pollDelayMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rollbackDeployment.id, ids.rollback);
  assert.equal(result.nextAction, 'record_evidence_and_request_operator_signoff');
  assert.equal(operations.filter((item) => item.startsWith('mutation')).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /staging-secret/);
});

test('failed post-rollback smoke freezes staging without an automatic follow-up write', async () => {
  const plan = buildStagingRollbackPlan(config(), snapshot());
  let mutations = 0;
  const graphqlFetcher = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('StagingRollbackContext')) return graphqlResponse({
      projectToken: { projectId: ids.project, environmentId: ids.staging },
      environment: { id: ids.staging, name: 'staging' },
      deployments: { edges: snapshot().deployments.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
    });
    if (query.includes('deploymentRollback')) {
      mutations += 1;
      return graphqlResponse({ deploymentRollback: { id: ids.rollback, status: 'DEPLOYING' } });
    }
    if (variables.id === ids.previous) return graphqlResponse({ deployment: deployment(ids.previous, '2026-08-23T10:00:00Z') });
    return graphqlResponse({ deployment: deployment(ids.rollback, '2026-08-24T10:05:00Z') });
  };
  const result = await executeStagingRollback({
    rawConfig: config(), plan, confirmation: plan.planHash, token: 'secret', expectedStagingHost: 'staging.example.test', stagingFrozen: true,
  }, {
    graphqlFetcher,
    entryFetcher: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
    sleep: async () => {},
    pollAttempts: 1,
    pollDelayMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(mutations, 1);
  assert.equal(result.nextAction, 'freeze_staging_and_escalate_without_automatic_followup_write');
});
