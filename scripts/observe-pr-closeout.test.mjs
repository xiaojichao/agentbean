import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCloseoutObservation,
  collectCloseoutObservation,
  formatCloseoutObservation,
  observeCloseoutLiveHealth,
  parseArgs,
} from './observe-pr-closeout.mjs';

const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function pr(overrides = {}) {
  return {
    number: 123,
    title: '实现 closeout observer',
    url: 'https://github.com/xiaojichao/agentbean/pull/123',
    state: 'MERGED',
    isDraft: false,
    createdAt: '2026-08-24T00:00:00Z',
    mergedAt: '2026-08-24T01:00:00Z',
    headRefOid: head,
    mergeCommit: { oid: head },
    commits: {
      nodes: [{
        commit: {
          oid: head,
          committedDate: '2026-08-24T00:30:00Z',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [{
                __typename: 'CheckRun',
                name: 'Validate AgentBean Next',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              }],
            },
          },
        },
      }],
    },
    reviews: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        submittedAt: '2026-08-24T00:40:00Z',
        state: 'COMMENTED',
        author: { login: 'chatgpt-codex-connector' },
        commit: { oid: head },
      }],
    },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 456,
    html_url: 'https://github.com/xiaojichao/agentbean/actions/runs/456',
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-08-24T01:00:05Z',
    updated_at: '2026-08-24T01:20:00Z',
    ...overrides,
  };
}

function jobs() {
  return [
    {
      id: 1,
      name: 'Deploy production',
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-08-24T01:10:00Z',
    },
    {
      id: 2,
      name: 'AgentBean Next production smoke',
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-08-24T01:20:00Z',
      steps: [{
        name: 'Wait for production server healthcheck',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-08-24T01:15:00Z',
      }],
    },
  ];
}

const healthy = {
  status: 'healthy',
  url: 'https://api.agentbean.dev/healthz',
  httpStatus: 200,
  observedAt: '2026-08-24T02:00:00Z',
  error: null,
};

test('reports observed_complete only when every delivery observation succeeds', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run()],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.equal(result.authorization, 'read_only_observation');
  assert.equal(result.observedPhase, 'observed_complete');
  assert.equal(result.pullRequest.codexReview.status, 'covered');
  assert.equal(result.pullRequest.checks.status, 'success');
  assert.equal(result.deploy.status, 'success');
  assert.equal(result.productionSmoke.health.status, 'success');
});

test('keeps an open draft separate from production evidence', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr({ state: 'OPEN', isDraft: true, mergedAt: null, mergeCommit: null }),
    liveHealth: { ...healthy, status: 'not_checked' },
  });
  assert.equal(result.observedPhase, 'pr_draft');
  assert.equal(result.mainRun.association, 'missing');
});

test('does not guess when merge commit maps to multiple main runs', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run(), run({ id: 457 })],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.equal(result.observedPhase, 'main_run_ambiguous');
  assert.equal(result.mainRun.id, null);
  assert.deepEqual(result.mainRun.candidateIds, [456, 457]);
});

test('rejects a main run whose head SHA does not equal the merge commit', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run({ head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.equal(result.observedPhase, 'main_run_missing');
  assert.deepEqual(result.mainRun.mismatchedCandidateIds, [456]);
  assert.match(result.dataQuality.warnings.join('\n'), /不匹配/);
});

test('fails closed when jobs or review connections are truncated', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr({
      reviews: { pageInfo: { hasPreviousPage: true }, nodes: [] },
    }),
    mainRuns: [run()],
    jobs: jobs(),
    jobsTruncated: true,
    liveHealth: healthy,
  });
  assert.equal(result.pullRequest.codexReview.status, 'truncated');
  assert.equal(result.deploy.status, 'truncated');
  assert.equal(result.productionSmoke.health.status, 'truncated');
  assert.match(result.dataQuality.warnings.join('\n'), /不可判定/);
});

test('preserves pending, failed and missing states instead of treating them as success', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run({ status: 'in_progress', conclusion: null })],
    jobs: [],
    liveHealth: { ...healthy, status: 'unreachable', httpStatus: null },
  });
  assert.equal(result.observedPhase, 'main_run_pending');
  assert.equal(result.deploy.status, 'missing');
  assert.equal(result.liveHealth.status, 'unreachable');
});

test('phase points to a downstream smoke failure even when it fails the whole run', () => {
  const failedJobs = jobs();
  failedJobs[1].conclusion = 'failure';
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run({ conclusion: 'failure' })],
    jobs: failedJobs,
    liveHealth: healthy,
  });
  assert.equal(result.observedPhase, 'production_smoke_failure');
});

test('observed_complete requires latest-head review and clear threads', () => {
  const stale = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr({
      reviews: {
        pageInfo: { hasPreviousPage: false },
        nodes: [{
          submittedAt: '2026-08-24T00:40:00Z',
          state: 'COMMENTED',
          author: { login: 'chatgpt-codex-connector' },
          commit: { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        }],
      },
    }),
    mainRuns: [run()],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.equal(stale.observedPhase, 'codex_review_stale');

  const unresolved = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr({
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [{ id: 'thread-1', isResolved: false }],
      },
    }),
    mainRuns: [run()],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.equal(unresolved.observedPhase, 'review_threads_unresolved');
});

test('collector uses only read-only gh api calls and can skip live health', async () => {
  const calls = [];
  const runCommand = (args) => {
    calls.push(args);
    if (args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: pr({ state: 'OPEN', mergedAt: null, mergeCommit: null }) } } });
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  const result = await collectCloseoutObservation({
    number: 123,
    repo: 'xiaojichao/agentbean',
    healthUrl: null,
  }, runCommand, async () => {
    throw new Error('fetch should not run');
  });
  assert.equal(result.observedPhase, 'pr_open');
  assert.equal(result.liveHealth.status, 'not_checked');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql']);
});

test('live health allows the canonical contract and blocks unauthorized or private targets before fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ ok: true, service: 'agentbean-next-server' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const resolvePublic = async () => [{ address: '1.1.1.1', family: 4 }];

  const canonical = await observeCloseoutLiveHealth({
    url: 'https://api.agentbean.dev/healthz',
    fetchImpl,
    resolveHostImpl: resolvePublic,
  });
  assert.equal(canonical.status, 'healthy');
  assert.equal(fetchCalls, 1);

  const unauthorized = await observeCloseoutLiveHealth({
    url: 'https://example.com/healthz',
    fetchImpl,
    resolveHostImpl: resolvePublic,
  });
  assert.equal(unauthorized.status, 'not_checked');
  assert.equal(unauthorized.error, 'live_target_not_authorized');

  const privateTarget = await observeCloseoutLiveHealth({
    url: 'http://127.0.0.1/healthz',
    allowLiveTarget: true,
    allowedOrigin: 'http://127.0.0.1',
    fetchImpl,
  });
  assert.equal(privateTarget.status, 'not_checked');
  assert.equal(privateTarget.error, 'target_address_not_public');
  assert.equal(fetchCalls, 1);
});

test('formats a concise Chinese observation and validates CLI arguments', () => {
  const result = buildCloseoutObservation({
    repository: 'xiaojichao/agentbean',
    pr: pr(),
    mainRuns: [run()],
    jobs: jobs(),
    liveHealth: healthy,
  });
  assert.match(formatCloseoutObservation(result), /closeout 只读观察/);
  assert.match(formatCloseoutObservation(result), /Live health：健康/);
  assert.equal(parseArgs(['123', '--skip-live-health']).healthUrl, null);
  assert.equal(parseArgs(['123', '--health-url', 'https://api.agentbean.dev/healthz']).allowLiveTarget, false);
  assert.throws(() => parseArgs([]), /用法/);
  assert.throws(() => parseArgs(['123', '--health-url']), /缺少参数值/);
  assert.throws(() => parseArgs(['123', '--health-url', 'file:\/\/tmp\/health']), /无效 health URL/);
  assert.throws(() => parseArgs(['123', '--health-url', 'https://example.com/healthz']), /无效 health URL/);
  const custom = parseArgs([
    '123', '--health-url', 'https://example.com/healthz',
    '--allow-live-target', '--allowed-health-origin', 'https://example.com',
  ]);
  assert.equal(custom.allowedHealthOrigin, 'https://example.com');
});
