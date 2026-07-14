import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePullRequest, formatReadiness } from './check-pr-merge-readiness.mjs';

const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fixture(overrides = {}) {
  return {
    number: 566,
    title: '防止过早合并',
    url: 'https://github.com/xiaojichao/agentbean/pull/566',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    createdAt: '2026-07-15T00:00:00Z',
    headRefOid: head,
    commits: {
      nodes: [{
        commit: {
          oid: head,
          committedDate: '2026-07-15T00:05:00Z',
          statusCheckRollup: {
            state: 'SUCCESS',
            contexts: {
              nodes: [{ __typename: 'CheckRun', name: 'Validate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
            },
          },
        },
      }],
    },
    reviews: {
      nodes: [{
        state: 'COMMENTED',
        submittedAt: '2026-07-15T00:10:00Z',
        author: { login: 'chatgpt-codex-connector' },
        commit: { oid: head },
      }],
    },
    reviewThreads: { nodes: [] },
    reviewRequests: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

test('marks a clean PR ready only after Codex reviewed the head commit', () => {
  const result = evaluatePullRequest(fixture(), new Date('2026-07-15T00:15:00Z'));
  assert.equal(result.ready, true);
  assert.equal(result.timing.headToCodexReviewSeconds, 300);
  assert.match(formatReadiness(result), /READY/);
});

test('marks a clean draft ready for Review without requiring Codex Review', () => {
  const result = evaluatePullRequest(fixture({
    isDraft: true,
    reviews: { nodes: [] },
  }), new Date('2026-07-15T00:15:00Z'), { stage: 'review' });
  assert.equal(result.ready, true);
  assert.equal(result.stage, 'review');
  assert.equal(result.review.codexCurrent, false);
  assert.match(formatReadiness(result), /Review 前置门禁/);
  assert.match(formatReadiness(result), /此阶段不要求/);
});

test('accepts GitHub DRAFT merge state when all current checks pass', () => {
  const result = evaluatePullRequest(fixture({
    isDraft: true,
    mergeStateStatus: 'DRAFT',
    reviews: { nodes: [] },
  }), new Date(), { stage: 'review' });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test('blocks a draft from Review while its current checks are pending', () => {
  const pr = fixture({
    isDraft: true,
    mergeStateStatus: 'UNSTABLE',
    reviews: { nodes: [] },
  });
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [
    { __typename: 'CheckRun', name: 'Validate', status: 'IN_PROGRESS', conclusion: null },
  ];
  const result = evaluatePullRequest(pr, new Date(), { stage: 'review' });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), [
    'MERGE_STATE_NOT_REVIEWABLE',
    'CHECKS_PENDING',
  ]);
});

test('blocks the Review preflight after a PR has already left Draft', () => {
  const result = evaluatePullRequest(fixture({ reviews: { nodes: [] } }), new Date(), { stage: 'review' });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['PR_NOT_DRAFT']);
});

test('allows a fixed draft to request a new Review despite a stale change request', () => {
  const result = evaluatePullRequest(fixture({
    isDraft: true,
    reviewDecision: 'CHANGES_REQUESTED',
  }), new Date(), { stage: 'review' });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test('keeps the merge gate blocked when Codex Review is missing', () => {
  const result = evaluatePullRequest(fixture({ reviews: { nodes: [] } }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_MISSING']);
});

test('accepts a clean Codex comment that names the current short SHA', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaaaa`",
      }],
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.review.codexCurrent, true);
});

test('blocks when Codex Review only covers an older commit', () => {
  const result = evaluatePullRequest(fixture({
    reviews: {
      nodes: [{
        state: 'COMMENTED',
        submittedAt: '2026-07-15T00:04:00Z',
        author: { login: 'chatgpt-codex-connector' },
        commit: { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }],
    },
  }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_STALE']);
});

test('blocks pending and failed checks with their names', () => {
  const pr = fixture();
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [
    { __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'StatusContext', context: 'Vercel', state: 'FAILURE' },
  ];
  const result = evaluatePullRequest(pr);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CHECKS_PENDING', 'CHECKS_FAILED']);
  assert.deepEqual(result.checks.pending, ['CI']);
  assert.deepEqual(result.checks.failing, ['Vercel']);
});

test('fails closed when a paginated gate exceeds the first 100 results', () => {
  const pr = fixture();
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true };
  pr.reviewThreads.pageInfo = { hasNextPage: true };
  pr.reviewRequests.pageInfo = { hasNextPage: true };
  const result = evaluatePullRequest(pr);
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'RESULTS_TRUNCATED');
  assert.match(result.blockers[0].detail, /checks、review threads、review requests/);
});

test('blocks unresolved threads and pending requested reviewers', () => {
  const result = evaluatePullRequest(fixture({
    reviewThreads: { nodes: [{ id: 'thread-1', isResolved: false, isOutdated: true }] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'reviewer' } }] },
  }));
  assert.deepEqual(result.blockers.map((item) => item.code), ['REVIEWS_PENDING', 'THREADS_UNRESOLVED']);
});

test('blocks draft, change-requested, and conflicting PRs', () => {
  const result = evaluatePullRequest(fixture({
    isDraft: true,
    mergeable: 'CONFLICTING',
    reviewDecision: 'CHANGES_REQUESTED',
  }));
  assert.deepEqual(result.blockers.map((item) => item.code), [
    'PR_DRAFT',
    'PR_NOT_MERGEABLE',
    'CHANGES_REQUESTED',
  ]);
});

test('blocks when repository rules still require review', () => {
  const result = evaluatePullRequest(fixture({ reviewDecision: 'REVIEW_REQUIRED' }));
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'REVIEW_REQUIRED');
});

test('fails closed when GitHub has not produced check results', () => {
  const pr = fixture();
  pr.commits.nodes[0].commit.statusCheckRollup = null;
  const result = evaluatePullRequest(pr);
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'CHECKS_MISSING');
});

test('fails closed when the check rollup has no contexts', () => {
  const pr = fixture();
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [];
  const result = evaluatePullRequest(pr);
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'CHECKS_MISSING');
});

test('blocks a merge state that is not clean', () => {
  const result = evaluatePullRequest(fixture({ mergeStateStatus: 'BEHIND' }));
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'MERGE_STATE_NOT_CLEAN');
});

test('never reports an already merged PR as ready', () => {
  const result = evaluatePullRequest(fixture({ state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.slice(0, 3).map((item) => item.code), [
    'PR_NOT_OPEN',
    'PR_NOT_MERGEABLE',
    'MERGE_STATE_NOT_CLEAN',
  ]);
});
