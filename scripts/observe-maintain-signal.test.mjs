import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  buildMaintainObservation,
  observeLiveHealth,
  parseArgs,
} from './observe-maintain-signal.mjs';

const base = {
  environment: 'production',
  trigger: 'post_deploy',
  repository: 'xiaojichao/agentbean',
  runId: '32565939196',
  headSha: 'a'.repeat(40),
  workflow: {
    deploy: 'success', target: 'success', cutover: 'success',
    health: 'success', entry: 'success', business: 'success',
  },
};

function health(overrides = {}) {
  return {
    status: 'healthy',
    url: 'https://api.agentbean.dev/healthz',
    httpStatus: 200,
    payloadMatches: true,
    observedAt: '2026-08-24T00:00:00.000Z',
    reason: null,
    requestMethod: 'GET',
    ...overrides,
  };
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const script = new URL('./observe-maintain-signal.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test('healthy post-deploy evidence is recorded without creating candidates', () => {
  const result = buildMaintainObservation({ ...base, liveHealth: health() });
  assert.equal(result.classification.level, 'record');
  assert.equal(result.classification.primarySignal, 'healthy');
  assert.deepEqual(result.candidates, { incident: null, regression: null, agentEval: null });
  assert.deepEqual(result.actions.performed, ['live_health_get']);
  assert.equal(result.actions.mutationCount, 0);
  assert.ok(result.actions.prohibited.includes('rollback'));
});

test('workflow and live health failure creates stable escalation candidates only', () => {
  const input = {
    ...base,
    workflow: { ...base.workflow, health: 'failure', entry: 'skipped', business: 'skipped' },
    liveHealth: health({ status: 'unhealthy', httpStatus: 503, payloadMatches: false, reason: 'health_contract_failed' }),
  };
  const first = buildMaintainObservation({ ...input, observedAt: '2026-08-24T01:00:00.000Z' });
  const second = buildMaintainObservation({ ...input, observedAt: '2026-08-24T02:00:00.000Z' });
  assert.equal(first.classification.level, 'escalation_candidate');
  assert.equal(first.classification.primarySignal, 'workflow_health_failed');
  assert.equal(first.classification.fingerprint, second.classification.fingerprint);
  assert.equal(first.candidates.incident.createAuthorized, false);
  assert.equal(first.candidates.regression.modifyAuthorized, false);
  assert.equal(first.candidates.agentEval.modifyAuthorized, false);
  assert.equal(first.actions.mutationCount, 0);
});

test('recovered live health keeps a workflow smoke failure in read-only diagnosis', () => {
  const result = buildMaintainObservation({
    ...base,
    workflow: { ...base.workflow, entry: 'failure', business: 'skipped' },
    liveHealth: health(),
  });
  assert.equal(result.classification.level, 'diagnose');
  assert.equal(result.classification.primarySignal, 'entry_smoke_failed');
  assert.equal(result.candidates.regression.suggestedExistingCheck, 'smoke:agentbean-next-entry');
  assert.deepEqual(result.actions.recommendedReadOnly, ['diagnose_ci_failure', 'compare_same_head_evidence']);
});

test('missing or ambiguous evidence fails closed without inventing an incident', () => {
  const result = buildMaintainObservation({
    ...base,
    repository: '',
    runId: '',
    headSha: 'short',
    workflow: { ...base.workflow, health: 'missing' },
    liveHealth: health({ status: 'not_checked', requestMethod: null, reason: 'entry_url_missing' }),
  });
  assert.equal(result.classification.level, 'blocked');
  assert.equal(result.classification.primarySignal, 'evidence_incomplete');
  assert.equal(result.candidates.incident, null);
  assert.equal(result.candidates.regression, null);
  assert.equal(result.candidates.agentEval.requiredBehavior, 'fail_closed_on_incomplete_evidence');
  assert.equal(result.actions.mutationCount, 0);
});

test('inconsistent library-provided health evidence is sanitized and blocked', () => {
  const result = buildMaintainObservation({
    ...base,
    liveHealth: health({
      url: 'https://api.agentbean.dev/healthz?token=secret',
      requestMethod: null,
      observedAt: 'not-a-time',
      reason: 'secret detail',
    }),
    observedAt: '2026-08-24T03:00:00.000Z',
  });
  assert.equal(result.classification.level, 'blocked');
  assert.equal(result.liveHealth.url, 'https://api.agentbean.dev/healthz');
  assert.equal(result.liveHealth.observedAt, '2026-08-24T03:00:00.000Z');
  assert.equal(result.liveHealth.reason, 'unclassified');
  assert.doesNotMatch(JSON.stringify(result), /token=secret|secret detail/);
});

test('contradictory health status and reason fail closed', () => {
  const unhealthy = buildMaintainObservation({
    ...base,
    liveHealth: health({ status: 'unhealthy', reason: 'health_contract_failed' }),
  });
  const healthyWithFailure = buildMaintainObservation({
    ...base,
    liveHealth: health({ reason: 'request_failed' }),
  });
  assert.equal(unhealthy.classification.level, 'blocked');
  assert.equal(healthyWithFailure.classification.level, 'blocked');
});

test('remote health requires explicit authorization and never calls fetch otherwise', async () => {
  let calls = 0;
  const result = await observeLiveHealth({
    entryUrl: 'https://api.agentbean.dev/?token=secret#fragment',
    fetchImpl: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'not_checked');
  assert.equal(result.reason, 'live_target_not_authorized');
  assert.equal(result.url, 'https://api.agentbean.dev/healthz');
  assert.doesNotMatch(JSON.stringify(result), /secret|fragment/);
});

test('authorized health observation performs one GET and stores no response body', async () => {
  const calls = [];
  const result = await observeLiveHealth({
    entryUrl: 'https://api.agentbean.dev/path?token=secret',
    allowLiveTarget: true,
    allowedOrigin: 'https://api.agentbean.dev',
    resolveHostImpl: async () => [{ address: '104.18.1.1', family: 4 }],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, service: 'agentbean-next-server', token: 'must-not-leak' }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.agentbean.dev/healthz');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(result.status, 'healthy');
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secret/);
});

test('health response body is capped before parsing', async () => {
  let cancelled = false;
  const response = {
    status: 200,
    body: {
      getReader() {
        let reads = 0;
        return {
          async read() {
            reads += 1;
            return reads === 1
              ? { done: false, value: new Uint8Array(65_537) }
              : { done: true, value: undefined };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
  };
  const result = await observeLiveHealth({
    entryUrl: 'https://api.agentbean.dev',
    allowLiveTarget: true,
    allowedOrigin: 'https://api.agentbean.dev',
    resolveHostImpl: async () => [{ address: '104.18.1.1', family: 4 }],
    fetchImpl: async () => response,
  });
  assert.equal(cancelled, true);
  assert.equal(result.status, 'unhealthy');
  assert.equal(result.reason, 'payload_too_large');
});

test('remote target must match the allowlisted origin and resolve only to public addresses', async () => {
  let fetchCalls = 0;
  const mismatch = await observeLiveHealth({
    entryUrl: 'https://example.com',
    allowLiveTarget: true,
    allowedOrigin: 'https://api.agentbean.dev',
    fetchImpl: async () => { fetchCalls += 1; },
  });
  const privateTarget = await observeLiveHealth({
    entryUrl: 'https://api.agentbean.dev',
    allowLiveTarget: true,
    allowedOrigin: 'https://api.agentbean.dev',
    resolveHostImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => { fetchCalls += 1; },
  });
  assert.equal(mismatch.reason, 'target_origin_not_allowed');
  assert.equal(privateTarget.reason, 'target_address_not_public');
  assert.equal(fetchCalls, 0);
});

test('URL credentials fail closed and unknown workflow status is rejected', async () => {
  const observed = await observeLiveHealth({ entryUrl: 'https://user:pass@example.com', allowLiveTarget: true });
  assert.equal(observed.status, 'not_checked');
  assert.equal(observed.reason, 'entry_url_credentials_forbidden');
  assert.throws(
    () => buildMaintainObservation({ ...base, workflow: { ...base.workflow, health: 'unknown' }, liveHealth: health() }),
    /health 状态无效/,
  );
});

test('CLI validates timeout and exposes explicit live authorization', () => {
  const parsed = parseArgs(['--allow-live-target', '--timeout-ms', '5000', '--health-status', 'success']);
  assert.equal(parsed.allowLiveTarget, true);
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.healthStatus, 'success');
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /100—60000/);
  assert.rejects(() => observeLiveHealth({ entryUrl: 'http://localhost', timeoutMs: 0 }), /100—60000/);
});

test('CLI observes a real local health endpoint and writes a read-only artifact', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/healthz');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'agentbean-next-server', secret: 'must-not-leak' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-maintain-'));
  const output = join(directory, 'artifacts/maintain/report.json');
  try {
    const args = [
      '--repository', 'xiaojichao/agentbean',
      '--run-id', '12345',
      '--head-sha', 'b'.repeat(40),
      '--deploy-status', 'success',
      '--target-status', 'success',
      '--cutover-status', 'success',
      '--health-status', 'success',
      '--entry-status', 'success',
      '--business-status', 'success',
      '--entry-url', `http://127.0.0.1:${address.port}?token=secret`,
      '--output', 'artifacts/maintain/report.json',
      '--json',
    ];
    const { exitCode, stdout, stderr } = await runCli(args, directory);
    assert.equal(exitCode, 0, stderr);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.classification.level, 'record');
    assert.equal(report.liveHealth.url, `http://127.0.0.1:${address.port}/healthz`);
    assert.equal(report.actions.mutationCount, 0);
    assert.deepEqual(JSON.parse(stdout), report);
    assert.doesNotMatch(JSON.stringify(report), /must-not-leak|token=secret/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI output cannot escape artifacts/maintain through a symlink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-maintain-output-'));
  const outside = join(directory, 'outside');
  const danglingTarget = join(outside, 'missing');
  const link = join(directory, 'artifacts/maintain/link');
  mkdirSync(outside, { recursive: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(danglingTarget, link, 'dir');
  try {
    const { exitCode, stderr } = await runCli([
      '--repository', 'xiaojichao/agentbean',
      '--run-id', '12345',
      '--head-sha', 'c'.repeat(40),
      '--deploy-status', 'success',
      '--target-status', 'success',
      '--cutover-status', 'success',
      '--health-status', 'success',
      '--entry-status', 'success',
      '--business-status', 'success',
      '--skip-live-health',
      '--output', 'artifacts/maintain/link/report.json',
    ], directory);
    assert.equal(exitCode, 1);
    assert.match(stderr, /不能使用嵌套目录/);
    assert.equal(existsSync(danglingTarget), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI output rejects artifacts/maintain when the root itself is a symlink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-maintain-root-output-'));
  const outside = join(directory, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  symlinkSync(outside, join(directory, 'artifacts/maintain'), 'dir');
  try {
    const { exitCode, stderr } = await runCli([
      '--repository', 'xiaojichao/agentbean', '--run-id', '12345', '--head-sha', 'd'.repeat(40),
      '--deploy-status', 'success', '--target-status', 'success', '--cutover-status', 'success',
      '--health-status', 'success', '--entry-status', 'success', '--business-status', 'success',
      '--skip-live-health', '--output', 'artifacts/maintain/report.json',
    ], directory);
    assert.equal(exitCode, 1);
    assert.match(stderr, /根目录不能是符号链接/);
    assert.equal(existsSync(join(outside, 'report.json')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI output rejects the artifacts ancestor when it is a symlink', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-artifacts-root-output-'));
  const outside = join(directory, 'outside');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(directory, 'artifacts'), 'dir');
  try {
    const { exitCode, stderr } = await runCli([
      '--repository', 'xiaojichao/agentbean', '--run-id', '12345', '--head-sha', 'e'.repeat(40),
      '--deploy-status', 'success', '--target-status', 'success', '--cutover-status', 'success',
      '--health-status', 'success', '--entry-status', 'success', '--business-status', 'success',
      '--skip-live-health', '--output', 'artifacts/maintain/report.json',
    ], directory);
    assert.equal(exitCode, 1);
    assert.match(stderr, /artifacts 目录不能是符号链接/);
    assert.equal(existsSync(join(outside, 'maintain/report.json')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI runs Maintain observation after smoke with non-blocking artifact upload', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Verify production smoke target URL[\s\S]*?npm run check:agentbean-next-production-target[\s\S]*?name: Wait for production server healthcheck/);
  assert.match(workflow, /name: Wait for production server healthcheck\n\s+id: production_health/);
  assert.match(workflow, /name: Observe post-deploy Maintain signal[\s\S]*?continue-on-error: true/);
  assert.match(workflow, /node scripts\/observe-maintain-signal\.mjs[\s\S]*?--allow-live-target[\s\S]*?--allowed-origin "https:\/\/api\.agentbean\.dev"/);
  assert.match(workflow, /name: Upload Maintain signal artifact[\s\S]*?actions\/upload-artifact@v7/);
});
