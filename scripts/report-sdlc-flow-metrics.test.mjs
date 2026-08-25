import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  computeBrowserSmokeRetryDiagnostics,
  computeDeliveryMetrics,
  computeFirstPassCiDiagnostics,
  computeFirstPassCiMetrics,
  computePullRequestMetrics,
  durationSummary,
  formatSdlcFlowMetrics,
  hydrateTruncatedPullRequestCommits,
  mapWithConcurrency,
  parseArgs,
  resolveFirstPassCiRuns,
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

test('first-pass CI resolution preserves association evidence and the next run for cancellation diagnosis', () => {
  const resolution = resolveFirstPassCiRuns([
    { id: 1, head_sha: head, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 10 }] },
    { id: 2, head_sha: 'b'.repeat(40), created_at: '2026-08-01T02:00:00Z', conclusion: 'success', pull_requests: [{ number: 10 }] },
  ]);
  assert.deepEqual(resolution.firstRuns[0], {
    prNumber: 10,
    run: {
      id: 1,
      head_sha: head,
      created_at: '2026-08-01T01:00:00Z',
      conclusion: 'cancelled',
      pull_requests: [{ number: 10 }],
    },
    association: 'direct',
    laterRunId: 2,
    laterRunCreatedAt: '2026-08-01T02:00:00Z',
    laterRunHeadSha: 'b'.repeat(40),
  });
});

test('first-pass CI diagnostics classify failure evidence and keep cancellation inference neutral', () => {
  const resolution = resolveFirstPassCiRuns([
    { id: 1, created_at: '2026-08-01T01:00:00Z', conclusion: 'failure', pull_requests: [{ number: 10 }] },
    { id: 2, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 11 }] },
    { id: 3, created_at: '2026-08-01T02:00:00Z', conclusion: 'success', pull_requests: [{ number: 11 }] },
    { id: 4, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 12 }] },
    { id: 5, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 13 }] },
  ]);
  const result = computeFirstPassCiDiagnostics(resolution, [{
    runId: 1,
    jobsCapped: false,
    jobs: [{
      name: 'Validate AgentBean Next',
      conclusion: 'failure',
      steps: [{ name: 'Run package tests and retained phase boundaries once', conclusion: 'failure' }],
    }],
  }]);
  assert.equal(result.nonSuccessRuns.length, 3);
  assert.deepEqual(result.failurePareto.categories[0], {
    category: 'package_tests_or_boundaries',
    runIds: [1],
    prNumbers: [10],
    count: 1,
    share: 1,
  });
  assert.deepEqual(result.cancellationPareto.categories[0], {
    category: 'cancelled_followed_by_later_pr_run',
    runIds: [2],
    prNumbers: [11],
    count: 1,
    share: 0.5,
  });
  assert.equal(result.nonSuccessRuns[1].laterRunId, 3);
  assert.equal(result.cancellationsWithLaterRunCount, 1);
  assert.equal(result.completedFirstRunsExcludingCancellationsWithLaterRun, 3);
  assert.equal(result.successRateExcludingCancellationsWithLaterRun, 0.3333);
});

test('first-pass CI diagnostics use documented fixed category priority and expose truncated jobs', () => {
  const resolution = resolveFirstPassCiRuns([
    { id: 1, created_at: '2026-08-01T01:00:00Z', conclusion: 'failure', pull_requests: [{ number: 10 }] },
    { id: 2, created_at: '2026-08-01T01:00:00Z', conclusion: 'failure', pull_requests: [{ number: 11 }] },
  ]);
  const result = computeFirstPassCiDiagnostics(resolution, [
    {
      runId: 1,
      jobsCapped: false,
      jobs: [{
        name: 'Validate AgentBean Next',
        conclusion: 'failure',
        steps: [
          { name: 'Run browser smoke tests', conclusion: 'failure' },
          { name: 'Run package tests and retained phase boundaries once', conclusion: 'failure' },
        ],
      }],
    },
    { runId: 2, jobsCapped: true, jobs: [] },
  ]);
  assert.equal(result.nonSuccessRuns[0].category, 'package_tests_or_boundaries');
  assert.equal(result.nonSuccessRuns[1].category, 'jobs_truncated');
  assert.deepEqual(result.jobsTruncatedRunIds, [2]);
});

test('browser smoke retry diagnostics distinguish no retry, recovered retry, repeated failure, and historical unknown', () => {
  const resolution = resolveFirstPassCiRuns([
    { id: 1, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 10 }] },
    { id: 2, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 11 }] },
    { id: 3, created_at: '2026-08-01T01:00:00Z', conclusion: 'failure', pull_requests: [{ number: 12 }] },
    { id: 4, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 13 }] },
    { id: 5, created_at: '2026-08-01T01:00:00Z', conclusion: 'success', pull_requests: [{ number: 14 }] },
    { id: 6, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 15 }] },
    { id: 7, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 16 }] },
    { id: 8, created_at: '2026-08-01T01:00:00Z', conclusion: 'cancelled', pull_requests: [{ number: 17 }] },
  ]);
  const result = computeBrowserSmokeRetryDiagnostics(resolution, [
    { runId: 1, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'success' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'skipped' },
    ] }] },
    { runId: 2, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'success' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'success' },
    ] }] },
    { runId: 3, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'success' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'failure' },
    ] }] },
    { runId: 4, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'skipped' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'skipped' },
    ] }] },
    { runId: 5, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke', conclusion: 'success' },
    ] }] },
    { runId: 6, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'skipped' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'skipped' },
    ] }] },
    { runId: 8, jobsCapped: false, jobs: [{ steps: [
      { name: 'Run AgentBean Next browser smoke attempt 1', conclusion: 'failure' },
      { name: 'Run AgentBean Next browser smoke retry', conclusion: 'cancelled' },
    ] }] },
  ]);

  assert.deepEqual(result.counts, {
    noRetry: 1,
    retryRecovered: 1,
    retryFailed: 1,
    notApplicable: 2,
    unknown: 3,
  });
  assert.equal(result.applicableSampleSize, 3);
  assert.deepEqual(result.runs.map((run) => run.category), [
    'no_retry',
    'retry_recovered',
    'retry_failed',
    'not_applicable',
    'unknown',
    'not_applicable',
    'unknown',
    'unknown',
  ]);
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

test('first-pass CI refuses a run directly associated with multiple PRs', () => {
  const result = computeFirstPassCiMetrics([{
    id: 1,
    head_sha: head,
    created_at: '2026-08-01T01:00:00Z',
    conclusion: 'success',
    pull_requests: [{ number: 10 }, { number: 11 }],
  }], [{
    number: 10,
    commits: { nodes: [{ commit: { oid: head } }] },
  }]);
  assert.equal(result.pullRequestsWithFirstRun, 0);
  assert.equal(result.successRate, null);
  assert.deepEqual(result.byConclusion, {});
  assert.equal(result.runsWithUnresolvedPullRequestAssociation, 1);
  assert.equal(result.runsWithoutPullRequest, 1);
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
    firstPassCi: {
      successRate: 0.5,
      success: 1,
      completedFirstRuns: 2,
      diagnostics: {
        failurePareto: {
          sampleSize: 1,
          categories: [{ category: 'package_tests_or_boundaries', count: 1 }],
        },
        cancellationPareto: { sampleSize: 0, categories: [] },
        browserSmokeRetry: {
          counts: {
            noRetry: 1,
            retryRecovered: 1,
            retryFailed: 0,
            notApplicable: 0,
            unknown: 0,
          },
        },
        completedFirstRunsExcludingCancellationsWithLaterRun: 2,
        successRateExcludingCancellationsWithLaterRun: 0.5,
      },
    },
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
  assert.match(text, /排除存在后续 run 的取消后：50.0%/);
  assert.match(text, /首次 CI 失败 Pareto：package_tests_or_boundaries 1\/1/);
  assert.match(text, /Browser smoke retry：未重试 1，retry 恢复 1，retry 仍失败 0/);
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

test('CI workflow preserves browser attempts and exposes retry outcome without weakening the retry gate', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: browser_smoke_attempt_1[\s\S]*continue-on-error: true/);
  assert.match(workflow, /agentbean-next-browser-smoke\/attempt-1/);
  assert.match(workflow, /id: browser_smoke_attempt_2/);
  assert.match(workflow, /steps\.browser_smoke_attempt_1\.outcome == 'failure'/);
  assert.match(workflow, /agentbean-next-browser-smoke\/attempt-2/);
  assert.match(workflow, /retry-outcome\.json/);
  assert.match(workflow, /'retry-recovered'/);
  assert.match(workflow, /'retry-failed'/);
  assert.match(workflow, /classification === 'unknown'\) process\.exitCode = 1/);
  assert.match(workflow, /Upload AgentBean Next browser smoke artifacts[\s\S]*if: always\(\) && !cancelled\(\)/);
});
