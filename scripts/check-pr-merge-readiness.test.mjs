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

function summaryFixture() {
  return fixture({
    reviews: { nodes: [] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        author: { login: 'chatgpt-codex-connector', __typename: 'Bot' },
        createdAt: '2026-07-15T00:06:00Z',
        updatedAt: '2026-07-15T00:10:00Z',
        body: '<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\n'
          + '| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n'
          + '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-07-15T00:10:00.123Z">2026-07-15T00:10:00.123Z</relative-time> | `aaaaaaa` | Draft marked ready |\n',
      }],
    },
    reactions: {
      pageInfo: { hasNextPage: false },
      nodes: [{ user: { login: 'chatgpt-codex-connector[bot]' }, content: 'THUMBS_UP', createdAt: '2026-07-15T00:10:00Z' }],
    },
  });
}

test('accepts the current Codex summary plus a fresh bot reaction, using completion time', () => {
  const result = evaluatePullRequest(summaryFixture());
  assert.equal(result.ready, true);
  assert.equal(result.review.codexCurrent, true);
  assert.equal(result.review.codexReviewedAt, '2026-07-15T00:10:00.123Z');
});

for (const [name, mutate] of [
  ['human summary', (pr) => { pr.comments.nodes[0].author = { login: 'xiaojichao', __typename: 'User' }; }],
  ['spoofed bot identity', (pr) => { pr.comments.nodes[0].author.__typename = 'User'; }],
  ['missing marker', (pr) => { pr.comments.nodes[0].body = pr.comments.nodes[0].body.replace('<!-- codex-pull-request-review-summary -->', ''); }],
  ['running review', (pr) => { pr.comments.nodes[0].body = pr.comments.nodes[0].body.replace('✅ **Completed**', '🔄 **Running** since'); }],
  ['failed review', (pr) => { pr.comments.nodes[0].body = pr.comments.nodes[0].body.replace('✅ **Completed**', '❌ **Failed**'); }],
  ['older commit', (pr) => { pr.comments.nodes[0].body = pr.comments.nodes[0].body.replace('`aaaaaaa`', '`bbbbbbb`'); }],
  ['missing timestamp', (pr) => { pr.comments.nodes[0].body = pr.comments.nodes[0].body.replace(/<relative-time[^>]*>[^<]*<\/relative-time>/, ''); }],
  ['missing reaction', (pr) => { pr.reactions.nodes = []; }],
  ['human thumbs up', (pr) => { pr.reactions.nodes[0].user.login = 'xiaojichao'; }],
  ['stale thumbs up', (pr) => { pr.reactions.nodes[0].createdAt = '2026-07-15T00:09:59Z'; }],
  ['bot still reviewing', (pr) => { pr.reactions.nodes.push({ user: { login: 'chatgpt-codex-connector[bot]' }, content: 'EYES' }); }],
  ['truncated comments', (pr) => { pr.comments.pageInfo.hasPreviousPage = true; }],
  ['truncated reactions', (pr) => { pr.reactions.pageInfo.hasNextPage = true; }],
  ['missing pagination evidence', (pr) => { delete pr.reactions.pageInfo; }],
  ['unknown review row', (pr) => { pr.comments.nodes[0].body += '| Security Review | Running | `aaaaaaa` | Manual |\n'; }],
  ['unresolved finding', (pr) => { pr.reviewThreads.nodes = [{ id: 'finding', isResolved: false }]; }],
  ['requested changes', (pr) => { pr.reviewDecision = 'CHANGES_REQUESTED'; }],
]) {
  test(`does not accept a summary with ${name}`, () => {
    const pr = summaryFixture();
    mutate(pr);
    assert.equal(evaluatePullRequest(pr).ready, false);
  });
}

test('a newer pending summary cannot fall back to an older completion or formal review', () => {
  const pr = summaryFixture();
  pr.reviews = fixture().reviews;
  const newer = structuredClone(pr.comments.nodes[0]);
  newer.updatedAt = '2026-07-15T00:11:00Z';
  newer.body = newer.body.replace('✅ **Completed**', '🔄 **Running** since');
  pr.comments.nodes.push(newer);
  assert.ok(evaluatePullRequest(pr).blockers.some((item) => item.code === 'CODEX_SUMMARY_UNCONFIRMED'));
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

test('waives a missing Codex Review when the whole PR is documentation-only', () => {
  const result = evaluatePullRequest(
    fixture({ reviews: { nodes: [] } }),
    new Date(),
    {
      changedFiles: [
        'docs/adr/0066-system-activity-uses-audience-scoped-projections.md',
        'CONTEXT.md',
        'CHANGELOG.md',
      ],
    },
  );
  assert.equal(result.ready, true);
  assert.equal(result.review.codexWaived, 'docs_only_pr');
  assert.equal(result.review.codexSatisfied, true);
  assert.match(formatReadiness(result), /已豁免（PR 仅为文档路径）/);
});

test('waives a stale Codex Review when only documentation paths changed after it', () => {
  const result = evaluatePullRequest(
    fixture({
      reviews: {
        nodes: [{
          state: 'COMMENTED',
          submittedAt: '2026-07-15T00:04:00Z',
          author: { login: 'chatgpt-codex-connector' },
          commit: { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        }],
      },
    }),
    new Date(),
    {
      filesSinceCodexReview: ['CHANGELOG.md', 'docs/adr/0001-example.md'],
    },
  );
  assert.equal(result.ready, true);
  assert.equal(result.review.codexWaived, 'docs_only_delta');
  assert.equal(result.review.codexCurrent, false);
  assert.equal(result.review.codexSatisfied, true);
  assert.match(formatReadiness(result), /已豁免（相对上次 Review 仅为文档路径）/);
});

test('does not waive a stale Codex Review when non-doc files changed after it', () => {
  const result = evaluatePullRequest(
    fixture({
      reviews: {
        nodes: [{
          state: 'COMMENTED',
          submittedAt: '2026-07-15T00:04:00Z',
          author: { login: 'chatgpt-codex-connector' },
          commit: { oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        }],
      },
    }),
    new Date(),
    {
      filesSinceCodexReview: ['CHANGELOG.md', 'apps/server-next/src/bin.ts'],
    },
  );
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_STALE']);
  assert.equal(result.review.codexWaived, null);
});

test('fails closed on docs waiver when the changed-file list is truncated', () => {
  const result = evaluatePullRequest(
    fixture({ reviews: { nodes: [] } }),
    new Date(),
    {
      changedFiles: ['docs/adr/0066.md'],
      filesTruncated: true,
    },
  );
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_MISSING']);
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

test('accepts an alternative review comment with provider, commit, and conclusion', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'xiaojichao' },
        body: '## 替代 Codex Review\nreview-provider: local-codex\nReviewed commit: `aaaaaaaaaa`\n结论：APPROVED',
      }],
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.review.codexCurrent, true);
  assert.match(formatReadiness(result), /已覆盖最新提交/);
});

test('rejects an alternative comment missing the review-provider field', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'xiaojichao' },
        body: 'Reviewed commit: `aaaaaaaaaa`\n结论：APPROVED',
      }],
    },
  }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_MISSING']);
});

test('rejects an alternative comment missing the conclusion field', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'xiaojichao' },
        body: 'review-provider: local-codex\nReviewed commit: `aaaaaaaaaa`',
      }],
    },
  }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_MISSING']);
});

test('blocks an alternative review comment that only covers an older commit', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'xiaojichao' },
        body: 'review-provider: local-codex\nReviewed commit: `bbbbbbbbbb`\n结论：APPROVED',
      }],
    },
  }));
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_STALE']);
});

test('detects Codex review usage limit and guides to the fallback channel', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [{
        createdAt: '2026-07-15T00:10:00Z',
        author: { login: 'chatgpt-codex-connector' },
        body: 'You have reached your Codex usage limits for code reviews. See the usage dashboard.',
      }],
    },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.review.codexReviewLimit, true);
  assert.deepEqual(result.blockers.map((item) => item.code), ['CODEX_REVIEW_MISSING']);
  assert.match(result.blockers[0].detail, /替代通道/);
  assert.match(formatReadiness(result), /额度不足/);
});

test('accepts an alternative review when the Codex bot hit its usage limit', () => {
  const result = evaluatePullRequest(fixture({
    reviews: { nodes: [] },
    comments: {
      nodes: [
        {
          createdAt: '2026-07-15T00:10:00Z',
          author: { login: 'chatgpt-codex-connector' },
          body: 'You have reached your Codex usage limits for code reviews.',
        },
        {
          createdAt: '2026-07-15T00:11:00Z',
          author: { login: 'xiaojichao' },
          body: 'review-provider: local-codex\nReviewed commit: `aaaaaaaaaa`\n结论：APPROVED',
        },
      ],
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.review.codexReviewLimit, true);
  assert.equal(result.review.codexCurrent, true);
});
