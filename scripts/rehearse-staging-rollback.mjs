#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectAgentBeanNextEntrySmoke,
  summarizeEntrySmoke,
} from './smoke-agentbean-next-entry.mjs';

export const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
export const STAGING_TOKEN_ENV = 'AGENTBEAN_STAGING_RAILWAY_TOKEN';
export const STAGING_ENTRY_HOST_ENV = 'AGENTBEAN_STAGING_ENTRY_HOST';
export const PRODUCTION_RAILWAY_ENVIRONMENT_IDS = new Set([
  'e9c1a221-28b1-49c0-b279-be249a428737',
]);
export const PRODUCTION_ENTRY_HOSTS = new Set([
  'agentbean.dev',
  'www.agentbean.dev',
  'api.agentbean.dev',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLLBACKABLE_HISTORY_STATUSES = new Set(['SUCCESS', 'REMOVED']);
const ROLLBACK_EXECUTION_FAILURE_STATUSES = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);
const CONFIG_KEYS = [
  'schemaVersion',
  'provider',
  'environmentName',
  'projectId',
  'serviceId',
  'environmentId',
  'baseUrl',
  'tokenEnv',
];
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'projectId',
  'serviceId',
  'environmentId',
  'historyTruncated',
  'deployments',
];
const DEPLOYMENT_KEYS = ['id', 'status', 'createdAt', 'canRollback', 'meta'];

const ROLLBACK_CONTEXT_QUERY = `query StagingRollbackContext($input: DeploymentListInput!, $environmentId: String!, $first: Int) {
  projectToken { projectId environmentId }
  environment(id: $environmentId) { id name }
  deployments(input: $input, first: $first) {
    edges {
      node { id status createdAt canRollback meta }
    }
    pageInfo { hasNextPage }
  }
}`;

const DEPLOYMENT_QUERY = `query StagingRollbackDeployment($id: String!) {
  deployment(id: $id) { id status createdAt canRollback meta }
}`;

const ROLLBACK_MUTATION = `mutation StagingRollback($id: String!) {
  deploymentRollback(id: $id) { id status }
}`;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

function assertExactKeys(value, allowed, label) {
  assertObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段：${unknown.join(', ')}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`${label} 缺少字段：${missing.join(', ')}`);
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`${label} 必须是 UUID`);
}

function normalizeStagingBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('baseUrl 必须是合法 URL');
  }
  if (url.protocol !== 'https:') throw new Error('baseUrl 必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('baseUrl 不得包含凭据、query 或 fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('baseUrl 必须指向 staging origin 根路径');
  if (url.port) throw new Error('baseUrl 不得使用非默认端口');
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('baseUrl 不得指向 IP、localhost 或本地域名');
  }
  if (PRODUCTION_ENTRY_HOSTS.has(hostname)) throw new Error('禁止把 production URL 用作 staging rollback target');
  return url.origin;
}

export function validateStagingRollbackConfig(config) {
  assertExactKeys(config, CONFIG_KEYS, 'staging rollback config');
  if (config.schemaVersion !== 1) throw new Error('config.schemaVersion 必须为 1');
  if (config.provider !== 'railway') throw new Error('config.provider 必须为 railway');
  if (config.environmentName !== 'staging') throw new Error('只允许 environmentName=staging');
  assertUuid(config.projectId, 'config.projectId');
  assertUuid(config.serviceId, 'config.serviceId');
  assertUuid(config.environmentId, 'config.environmentId');
  if (PRODUCTION_RAILWAY_ENVIRONMENT_IDS.has(config.environmentId)) {
    throw new Error('禁止使用 production Railway environment ID');
  }
  if (config.tokenEnv !== STAGING_TOKEN_ENV) {
    throw new Error(`config.tokenEnv 必须为 ${STAGING_TOKEN_ENV}`);
  }
  return { ...config, baseUrl: normalizeStagingBaseUrl(config.baseUrl) };
}

function validateDeployment(deployment, index) {
  const label = `snapshot.deployments[${index}]`;
  assertExactKeys(deployment, DEPLOYMENT_KEYS, label);
  assertUuid(deployment.id, `${label}.id`);
  if (typeof deployment.status !== 'string' || !deployment.status) throw new Error(`${label}.status 缺失`);
  if (!Number.isFinite(Date.parse(deployment.createdAt))) throw new Error(`${label}.createdAt 必须是 ISO 时间`);
  if (typeof deployment.canRollback !== 'boolean') throw new Error(`${label}.canRollback 必须是 boolean`);
  assertObject(deployment.meta, `${label}.meta`);
  return {
    id: deployment.id,
    status: deployment.status.toUpperCase(),
    createdAt: new Date(deployment.createdAt).toISOString(),
    canRollback: deployment.canRollback,
    meta: deployment.meta,
  };
}

export function validateRollbackSnapshot(snapshot, config) {
  assertExactKeys(snapshot, SNAPSHOT_KEYS, 'rollback snapshot');
  if (snapshot.schemaVersion !== 1) throw new Error('snapshot.schemaVersion 必须为 1');
  for (const key of ['projectId', 'serviceId', 'environmentId']) {
    if (snapshot[key] !== config[key]) throw new Error(`snapshot.${key} 与 staging config 不一致`);
  }
  if (snapshot.historyTruncated !== false) throw new Error('deployment history 查询不完整，保持 fail closed');
  if (!Array.isArray(snapshot.deployments) || snapshot.deployments.length < 2) {
    throw new Error('rollback snapshot 至少需要两个 deployment');
  }
  const deployments = snapshot.deployments.map(validateDeployment);
  if (new Set(deployments.map((item) => item.id)).size !== deployments.length) {
    throw new Error('rollback snapshot 包含重复 deployment ID');
  }
  return { ...snapshot, deployments };
}

function sourceVersion(deployment) {
  for (const key of ['commitHash', 'commitSha', 'sourceVersion', 'imageDigest', 'repoCommit']) {
    const value = deployment.meta?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return `deployment:${deployment.id}`;
}

function summarizeDeployment(deployment) {
  return {
    id: deployment.id,
    status: deployment.status,
    createdAt: deployment.createdAt,
    sourceVersion: sourceVersion(deployment),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashRollbackPlan(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function buildStagingRollbackPlan(rawConfig, rawSnapshot, { targetDeploymentId } = {}) {
  const config = validateStagingRollbackConfig(rawConfig);
  const snapshot = validateRollbackSnapshot(rawSnapshot, config);
  const deployments = [...snapshot.deployments].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const current = deployments[0];
  if (current.status !== 'SUCCESS') {
    throw new Error(`最新 staging deployment 状态为 ${current.status}；必须先冻结部署并等待稳定 SUCCESS`);
  }
  const candidates = deployments.filter((item) => (
    item.id !== current.id
    && Date.parse(item.createdAt) < Date.parse(current.createdAt)
    && item.canRollback
    && ROLLBACKABLE_HISTORY_STATUSES.has(item.status)
  ));
  const target = targetDeploymentId
    ? candidates.find((item) => item.id === targetDeploymentId)
    : candidates[0];
  if (!target) {
    throw new Error(targetDeploymentId
      ? `指定 deployment ${targetDeploymentId} 不是可回滚的历史 staging 版本`
      : '找不到 canRollback=true 的上一成功 staging deployment');
  }

  const plan = {
    schemaVersion: 1,
    kind: 'staging_rollback_rehearsal',
    authorization: {
      mode: 'explicit_staging_plan_hash',
      required: true,
      tokenEnv: STAGING_TOKEN_ENV,
    },
    environment: {
      provider: 'railway',
      name: 'staging',
      projectId: config.projectId,
      serviceId: config.serviceId,
      environmentId: config.environmentId,
      baseUrl: config.baseUrl,
    },
    current: summarizeDeployment(current),
    target: summarizeDeployment(target),
    actions: expectedPlanActions(target.id),
  };
  return { ...plan, planHash: hashRollbackPlan(plan) };
}

function expectedPlanActions(targetDeploymentId) {
  return [
    {
      id: 'assert_staging_deploys_frozen',
      operation: 'operator_ack',
      write: false,
      authorization: '--ack-staging-frozen',
    },
    {
      id: 'rollback_selected_deployment',
      operation: 'deploymentRollback',
      deploymentId: targetDeploymentId,
      write: true,
      authorization: 'human_plan_hash_required',
    },
    {
      id: 'wait_for_rollback_success',
      operation: 'deployment',
      write: false,
    },
    {
      id: 'verify_read_only_entry_smoke',
      operation: 'GET /healthz, /, /socket.io/socket.io.js',
      write: false,
    },
  ];
}

function assertPlanBoundToConfig(plan, config) {
  assertExactKeys(plan, ['schemaVersion', 'kind', 'authorization', 'environment', 'current', 'target', 'actions', 'planHash'], 'rollback plan');
  if (plan.schemaVersion !== 1 || plan.kind !== 'staging_rollback_rehearsal') throw new Error('rollback plan schema/kind 无效');
  assertExactKeys(plan.authorization, ['mode', 'required', 'tokenEnv'], 'rollback plan.authorization');
  if (
    plan.authorization.mode !== 'explicit_staging_plan_hash'
    || plan.authorization.required !== true
    || plan.authorization.tokenEnv !== STAGING_TOKEN_ENV
  ) throw new Error('rollback plan authorization contract 无效');
  assertExactKeys(plan.environment, ['provider', 'name', 'projectId', 'serviceId', 'environmentId', 'baseUrl'], 'rollback plan.environment');
  const expectedEnvironment = {
    provider: 'railway',
    name: 'staging',
    projectId: config.projectId,
    serviceId: config.serviceId,
    environmentId: config.environmentId,
    baseUrl: config.baseUrl,
  };
  if (canonicalJson(plan.environment) !== canonicalJson(expectedEnvironment)) {
    throw new Error('rollback plan environment 与 staging config 不一致');
  }
  for (const key of ['current', 'target']) {
    assertExactKeys(plan[key], ['id', 'status', 'createdAt', 'sourceVersion'], `rollback plan.${key}`);
    assertUuid(plan[key].id, `rollback plan.${key}.id`);
    if (!Number.isFinite(Date.parse(plan[key].createdAt))) throw new Error(`rollback plan.${key}.createdAt 无效`);
    if (typeof plan[key].sourceVersion !== 'string' || !plan[key].sourceVersion) throw new Error(`rollback plan.${key}.sourceVersion 缺失`);
  }
  if (plan.current.status !== 'SUCCESS') throw new Error('rollback plan.current 必须是 SUCCESS');
  if (!ROLLBACKABLE_HISTORY_STATUSES.has(plan.target.status)) throw new Error('rollback plan.target 状态不可用于历史 rollback');
  if (plan.current.id === plan.target.id || Date.parse(plan.target.createdAt) >= Date.parse(plan.current.createdAt)) {
    throw new Error('rollback plan target 必须早于 current');
  }
  if (canonicalJson(plan.actions) !== canonicalJson(expectedPlanActions(plan.target.id))) {
    throw new Error('rollback plan actions 与固定 rehearsal contract 不一致');
  }
  if (!/^[0-9a-f]{64}$/.test(plan.planHash)) throw new Error('rollback planHash 无效');
}

function assertExpectedStagingHost(config, expectedStagingHost) {
  const actual = new URL(config.baseUrl).hostname.toLowerCase();
  const expected = String(expectedStagingHost ?? '').trim().toLowerCase();
  if (!expected) throw new Error(`${STAGING_ENTRY_HOST_ENV} 缺失`);
  if (expected !== actual) throw new Error(`${STAGING_ENTRY_HOST_ENV} 与 config.baseUrl hostname 不一致`);
}

async function railwayGraphql({ token, query, variables, fetcher = globalThis.fetch }) {
  if (typeof token !== 'string' || !token) throw new Error(`${STAGING_TOKEN_ENV} 缺失`);
  const response = await fetcher(RAILWAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Project-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response?.ok) throw new Error(`Railway GraphQL HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`Railway GraphQL: ${payload.errors.map((item) => item.message).join('; ')}`);
  }
  if (!payload.data) throw new Error('Railway GraphQL 缺少 data');
  return payload.data;
}

function assertStagingScope(projectToken, environment, config) {
  if (!projectToken || projectToken.projectId !== config.projectId || projectToken.environmentId !== config.environmentId) {
    throw new Error('staging project token scope 与 config project/environment 不一致');
  }
  if (!environment || environment.id !== config.environmentId || environment.name !== 'staging') {
    throw new Error('Railway environment identity 必须精确为 staging');
  }
}

export async function collectLiveRollbackSnapshot(rawConfig, {
  token,
  fetcher = globalThis.fetch,
} = {}) {
  const config = validateStagingRollbackConfig(rawConfig);
  const data = await railwayGraphql({
    token,
    query: ROLLBACK_CONTEXT_QUERY,
    variables: {
      input: {
        projectId: config.projectId,
        serviceId: config.serviceId,
        environmentId: config.environmentId,
      },
      environmentId: config.environmentId,
      first: 50,
    },
    fetcher,
  });
  assertStagingScope(data.projectToken, data.environment, config);
  return validateRollbackSnapshot({
    schemaVersion: 1,
    projectId: config.projectId,
    serviceId: config.serviceId,
    environmentId: config.environmentId,
    historyTruncated: data.deployments?.pageInfo?.hasNextPage === true,
    deployments: (data.deployments?.edges ?? []).map((edge) => edge.node),
  }, config);
}

async function waitForRollbackDeployment(id, {
  token,
  fetcher,
  sleep,
  pollAttempts,
  pollDelayMs,
}) {
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const data = await railwayGraphql({ token, query: DEPLOYMENT_QUERY, variables: { id }, fetcher });
    const deployment = data.deployment;
    if (!deployment) throw new Error(`Railway deployment ${id} 不存在`);
    const status = String(deployment.status ?? '').toUpperCase();
    if (status === 'SUCCESS') return deployment;
    if (ROLLBACK_EXECUTION_FAILURE_STATUSES.has(status)) throw new Error(`rollback deployment ${id} 终止于 ${status}`);
    if (attempt < pollAttempts) await sleep(pollDelayMs);
  }
  throw new Error(`rollback deployment ${id} 在 ${pollAttempts} 次检查后仍未成功`);
}

export async function executeStagingRollback({
  rawConfig,
  plan,
  confirmation,
  token,
  expectedStagingHost,
  stagingFrozen,
}, {
  graphqlFetcher = globalThis.fetch,
  entryFetcher = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  pollAttempts = 30,
  pollDelayMs = 5_000,
} = {}) {
  const config = validateStagingRollbackConfig(rawConfig);
  if (!plan || plan.planHash !== confirmation) throw new Error('执行需要与当前 planHash 完全一致的 --confirm');
  assertPlanBoundToConfig(plan, config);
  if (hashRollbackPlan(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash'))) !== plan.planHash) {
    throw new Error('rollback plan 内容与 planHash 不一致');
  }
  assertExpectedStagingHost(config, expectedStagingHost);
  if (stagingFrozen !== true) throw new Error('执行前必须显式确认 --ack-staging-frozen');
  const freshSnapshot = await collectLiveRollbackSnapshot(config, { token, fetcher: graphqlFetcher });
  const freshPlan = buildStagingRollbackPlan(config, freshSnapshot, { targetDeploymentId: plan.target.id });
  if (freshPlan.planHash !== plan.planHash) {
    throw new Error('staging deployment truth 已变化；旧 planHash 失效，禁止执行 mutation');
  }
  const targetData = await railwayGraphql({ token, query: DEPLOYMENT_QUERY, variables: { id: plan.target.id }, fetcher: graphqlFetcher });
  if (!targetData.deployment?.canRollback) throw new Error('目标 deployment 当前已不可 rollback');
  const rollbackData = await railwayGraphql({ token, query: ROLLBACK_MUTATION, variables: { id: plan.target.id }, fetcher: graphqlFetcher });
  const started = rollbackData.deploymentRollback;
  if (!started?.id) throw new Error('Railway rollback mutation 未返回 deployment ID');
  const completed = await waitForRollbackDeployment(started.id, {
    token,
    fetcher: graphqlFetcher,
    sleep,
    pollAttempts,
    pollDelayMs,
  });
  const entrySmoke = summarizeEntrySmoke(await collectAgentBeanNextEntrySmoke({
    baseUrl: config.baseUrl,
    fetcher: entryFetcher,
  }));
  return {
    schemaVersion: 1,
    kind: 'staging_rollback_rehearsal_result',
    ok: entrySmoke.ok,
    authorization: 'explicit_staging_plan_hash',
    planHash: plan.planHash,
    currentDeploymentId: plan.current.id,
    targetDeploymentId: plan.target.id,
    rollbackDeployment: {
      id: completed.id,
      status: completed.status,
    },
    verification: {
      entrySmoke,
    },
    nextAction: entrySmoke.ok
      ? 'record_evidence_and_request_operator_signoff'
      : 'freeze_staging_and_escalate_without_automatic_followup_write',
  };
}

function parseArgs(argv) {
  const options = { execute: false, json: false, stagingFrozen: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') options.config = argv[++index];
    else if (value === '--snapshot') options.snapshot = argv[++index];
    else if (value === '--target-deployment') options.targetDeploymentId = argv[++index];
    else if (value === '--confirm') options.confirmation = argv[++index];
    else if (value === '--execute') options.execute = true;
    else if (value === '--ack-staging-frozen') options.stagingFrozen = true;
    else if (value === '--json') options.json = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.help && !options.config) throw new Error('--config 必填');
  if (options.execute && options.snapshot) throw new Error('--execute 禁止使用离线 snapshot，必须重新读取 staging truth');
  if (options.execute && !options.confirmation) throw new Error('--execute 必须同时提供 --confirm <planHash>');
  if (options.execute && !options.stagingFrozen) throw new Error('--execute 必须同时提供 --ack-staging-frozen');
  return options;
}

function formatPlan(plan) {
  return [
    'Staging rollback rehearsal plan（未执行写操作）',
    `current: ${plan.current.sourceVersion} (${plan.current.id})`,
    `target:  ${plan.target.sourceVersion} (${plan.target.id})`,
    `planHash: ${plan.planHash}`,
    `执行需显式追加：--execute --confirm ${plan.planHash} --ack-staging-frozen`,
  ].join('\n');
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`用法：
  npm run rehearse:staging-rollback -- --config path/to/staging.json [--snapshot path/to/history.json] [--target-deployment id] [--json]
  npm run rehearse:staging-rollback -- --config path/to/staging.json --execute --confirm <planHash> --ack-staging-frozen [--json]`);
      return;
    }
    const rawConfig = JSON.parse(readFileSync(resolve(process.cwd(), options.config), 'utf8'));
    const config = validateStagingRollbackConfig(rawConfig);
    const token = process.env[STAGING_TOKEN_ENV];
    const snapshot = options.snapshot
      ? JSON.parse(readFileSync(resolve(process.cwd(), options.snapshot), 'utf8'))
      : await collectLiveRollbackSnapshot(config, { token });
    const plan = buildStagingRollbackPlan(config, snapshot, { targetDeploymentId: options.targetDeploymentId });
    if (!options.execute) {
      console.log(options.json ? JSON.stringify(plan, null, 2) : formatPlan(plan));
      return;
    }
    const result = await executeStagingRollback({
      rawConfig: config,
      plan,
      confirmation: options.confirmation,
      token,
      expectedStagingHost: process.env[STAGING_ENTRY_HOST_ENV],
      stagingFrozen: options.stagingFrozen,
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`STAGING_ROLLBACK_REHEARSAL_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
