import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  computeDeliveryMetrics,
  computeFirstPassCiMetrics,
  computePullRequestMetrics,
  durationSummary,
  formatSdlcFlowMetrics,
  hydrateTruncatedPullRequestCommits,
  mapWithConcurrency,
  parseArgs,
} from './report-sdlc-flow-metrics.mjs';

const from = '2026-08-01T00:00:00.000Z';
const to = '2026-08-29T00:00:00.000Z';
const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function pr(overrides = {}) {
  return {
    number: 10,
    state: 'MERGED',
    isDraft: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    mergedAt: '2026-08-03T00:00:00Z',
    headRefOid: head,
    mergeCommit: { oid: head },
    timelineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [{ createdAt: '2026-08-01T01:00:00Z' }],
    },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        state: 'COMMENTED',
        submittedAt: '2026-08-01T03:00:00Z',
        author: { login: 'reviewer' },
        commit: { oid: head },
      }],
    },
    ...overrides,
  };
}

test('durationSummary reports nearest-rank percentiles', () => {
  assert.deepEqual(durationSummary([10, 20, 30, 40, 50]), {
    sampleSize: 5,
    averageSeconds: 30,
    p50Seconds: 30,
    p90Seconds: 50,
  });
});

test('computes PR cohorts and excludes incomplete nested connections', () => {
  const result = computePullRequestMetrics([
    pr(),
    pr({
      number: 11,
      state: 'OPEN',
      mergedAt: null,
      headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reviews: {
        pageInfo: { hasNextPage: false },
        nodes: [{
          state: 'COMMENTED',
          submittedAt: '2026-08-02T00:00:00Z',
          author: { login: 'chatgpt-codex-connector' },
          commit: { oid: 'cccccccccccccccccccccccccccccccccccccccc' },
        }],
      },
    }),
    pr({
      number: 12,
      reviews: { pageInfo: { hasNextPage: true }, nodes: [] },
    }),
  ], { from, to });

  assert.equal(result.createdInWindow, 3);
  assert.equal(result.mergedInWindow, 2);
  assert.equal(result.prLeadTime.sampleSize, 2);
  assert.equal(result.draftToReady.sampleSize, 2);
  assert.equal(result.readyToFirstReview.sampleSize, 2);
  assert.deepEqual(result.staleCodexReview.prNumbers, [11]);
  assert.deepEqual(result.truncatedPrNumbers, [12]);
});

test('does not invent ready or review timestamps when events are missing', () => {
  const result = computePullRequestMetrics([
    pr({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } }),
    pr({
      number: 11,
      reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    }),
  ], { from, to });
  assert.equal(result.draftToReady.missingReadyEvent, 1);
  assert.equal(result.readyToFirstReview.missingFirstReview, 1);
});

test('first-pass CI uses the earliest run per PR and separates unlinked runs', () => {
  const result = computeFirstPassCiMetrics([
    { id: 2, created_at: '2026-08-01T02:00:00Z', conclusion: 'success', pull_requests: [{ number: 10 }] },
    { id: 1, created_at: '2026-08-01T01:00:00Z', conclusion: 'failure', pull_requests: [{ number: 10 }] },
    { id: 3, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 11 }] },
    { id: 4, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [] },
  ]);
  assert.equal(result.pullRequestsWithFirstRun, 2);
  assert.equal(result.success, 1);
  assert.equal(result.successRate, 0.5);
  assert.deepEqual(result.byConclusion, { failure: 1, success: 1 });
  assert.equal(result.runsWithoutPullRequest, 1);
  assert.equal(result.runsWithUnresolvedPullRequestAssociation, 1);
});

test('first-pass CI falls back to PR commit SHA when Actions omits pull_requests', () => {
  const result = computeFirstPassCiMetrics([{
    id: 1,
    head_sha: head,
    created_at: '2026-08-01T01:00:00Z',
    conclusion: 'success',
    pull_requests: [],
  }], [{
    number: 10,
    commits: { nodes: [{ commit: { oid: head } }] },
  }]);
  assert.equal(result.pullRequestsWithFirstRun, 1);
  assert.equal(result.successRate, 1);
  assert.equal(result.runsWithoutPullRequest, 0);
});

test('first-pass CI excludes runs outside the explicit window', () => {
  const result = computeFirstPassCiMetrics([
    { created_at: '2026-08-02T00:00:00Z', conclusion: 'success', pull_requests: [{ number: 10 }] },
    { created_at: '2026-08-30T00:00:00Z', conclusion: 'failure', pull_requests: [{ number: 11 }] },
  ], [], { from, to });
  assert.equal(result.pullRequestsWithFirstRun, 1);
  assert.equal(result.successRate, 1);
});

test('first-pass CI refuses an ambiguous commit-to-PR fallback', () => {
  const result = computeFirstPassCiMetrics([{
    head_sha: head,
    created_at: '2026-08-02T00:00:00Z',
    conclusion: 'success',
    pull_requests: [],
  }], [
    { number: 10, commits: { nodes: [{ commit: { oid: head } }] } },
    { number: 11, commits: { nodes: [{ commit: { oid: head } }] } },
  ]);
  assert.equal(result.pullRequestsWithFirstRun, 0);
  assert.equal(result.runsWithoutPullRequest, 1);
});

test('first-pass CI reports dataset-level incompleteness without assigning unknown runs to a truncated PR', () => {
  const result = computeFirstPassCiMetrics([{
    head_sha: 'c'.repeat(40),
    created_at: '2026-08-02T00:00:00Z',
    conclusion: 'success',
    pull_requests: [],
  }], [{
    number: 10,
    commits: {
      pageInfo: { hasNextPage: true },
      nodes: [{ commit: { oid: head } }],
    },
  }]);
  assert.equal(result.pullRequestsWithFirstRun, 0);
  assert.equal(result.commitFallbackEvidenceComplete, false);
  assert.equal(result.runsWithoutPullRequest, null);
  assert.equal(result.runsWithUnresolvedPullRequestAssociation, 1);
  assert.deepEqual(result.commitFallbackTruncatedPrNumbers, [10]);
});

test('first-pass CI still uses visible commit evidence from a truncated PR', () => {
  const result = computeFirstPassCiMetrics([{
    head_sha: head,
    created_at: '2026-08-02T00:00:00Z',
    conclusion: 'success',
    pull_requests: [],
  }], [{
    number: 10,
    commits: {
      pageInfo: { hasNextPage: true },
      nodes: [{ commit: { oid: head } }],
    },
  }]);
  assert.equal(result.pullRequestsWithFirstRun, 1);
  assert.equal(result.successRate, 1);
  assert.equal(result.runsWithUnresolvedPullRequestAssociation, 0);
});

test('hydrates a truncated PR commit connection before first-pass CI association', () => {
  const hiddenHead = 'b'.repeat(40);
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    commit: { oid: String(index).padStart(40, '0') },
  }));
  const pullRequests = [{
    number: 10,
    commits: { pageInfo: { hasNextPage: true }, nodes: firstPage },
  }];
  const calls = [];
  const result = hydrateTruncatedPullRequestCommits({
    owner: 'xiaojichao',
    name: 'agentbean',
    pullRequests,
  }, (args) => {
    calls.push(args);
    return JSON.stringify(calls.length === 1 ? firstPage : [{ commit: { oid: hiddenHead } }]);
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.length, 2);
  assert.equal(pullRequests[0].commits.pageInfo.hasNextPage, false);
  assert.equal(pullRequests[0].commits.nodes.at(-1).commit.oid, hiddenHead);
  const metrics = computeFirstPassCiMetrics([{
    head_sha: hiddenHead,
    created_at: '2026-08-02T00:00:00Z',
    conclusion: 'success',
    pull_requests: [],
  }], pullRequests);
  assert.equal(metrics.pullRequestsWithFirstRun, 1);
  assert.equal(metrics.commitFallbackEvidenceComplete, true);
  assert.equal(metrics.runsWithUnresolvedPullRequestAssociation, 0);
});

test('delivery metrics align merge commit, deploy, smoke and health timestamps', () => {
  const result = computeDeliveryMetrics([{
    run: { id: 1, head_sha: head },
    jobs: [
      { name: 'Deploy production', conclusion: 'success', completed_at: '2026-08-03T00:10:00Z' },
      {
        name: 'AgentBean Next production smoke',
        conclusion: 'success',
        completed_at: '2026-08-03T00:20:00Z',
        steps: [{
          name: 'Wait for production server healthcheck',
          conclusion: 'success',
          completed_at: '2026-08-03T00:15:00Z',
        }],
      },
    ],
  }], [pr()]);
  assert.equal(result.mergeToProductionSmoke.p50Seconds, 1200);
  assert.equal(result.deployToFirstHealthy.p50Seconds, 300);
  assert.deepEqual(result.deployOutcomes, { success: 1 });
});

test('delivery metrics exclude runs whose job list was truncated', () => {
  const result = computeDeliveryMetrics([{
    run: { id: 99, head_sha: head },
    jobsCapped: true,
    jobs: [],
  }], [pr()]);
  assert.equal(result.mainPushRuns, 1);
  assert.equal(result.analyzedRuns, 0);
  assert.deepEqual(result.truncatedJobRunIds, [99]);
  assert.deepEqual(result.deployOutcomes, {});
});

test('CLI parsing is strict and defaults to a four-week window', () => {
  assert.deepEqual(parseArgs(['--repo', 'xiaojichao/agentbean', '--json']), {
    days: 28,
    json: true,
    repo: 'xiaojichao/agentbean',
  });
  assert.throws(() => parseArgs(['--days', '0']), /1 到 365/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
});

test('human report surfaces core metrics and data-quality warnings', () => {
  const text = formatSdlcFlowMetrics({
    repository: 'xiaojichao/agentbean',
    window: { from, to },
    firstPassCi: { successRate: 0.5, success: 1, completedFirstRuns: 2 },
    pullRequests: {
      draftToReady: durationSummary([60]),
      readyToFirstReview: durationSummary([120]),
      staleCodexReview: { count: 1, eligibleOpenNonDraft: 3 },
      prLeadTime: durationSummary([3600]),
    },
    delivery: {
      mergeToProductionSmoke: durationSummary([600]),
      deployToFirstHealthy: durationSummary([30]),
    },
    dataQuality: { warnings: ['示例提示'] },
  });
  assert.match(text, /首次 CI 成功率：50.0%/);
  assert.match(text, /Codex stale review：1\/3/);
  assert.match(text, /示例提示/);
});

test('bounded concurrency preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [6, 2, 4]);
  assert.equal(peak, 2);
});

test('weekly workflow generates a read-only JSON artifact from the trusted default branch', () => {
  const workflow = readFileSync(new URL('../.github/workflows/weekly-sdlc-flow-metrics.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /node scripts\/report-sdlc-flow-metrics\.mjs/);
  assert.match(workflow, /--json > artifacts\/sdlc-flow-metrics\/report\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /issues:\s*write|pull-requests:\s*write|contents:\s*write/);
});
