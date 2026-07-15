import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeClaims,
  claimComment,
  evaluateIssueClaim,
  openClosingPullRequests,
  releaseComment,
  releaseEffects,
} from './claim-github-issue.mjs';

function comment(body, createdAt, url = null) {
  return { body, createdAt, url };
}

function fixture(overrides = {}) {
  return {
    number: 568,
    title: '防止任务串到其他 Session',
    url: 'https://github.com/xiaojichao/agentbean/issues/568',
    state: 'OPEN',
    labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'ready-for-agent' }] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    ...overrides,
  };
}

test('uses the earliest active Session claim as the only winner', () => {
  const comments = [
    comment(claimComment('session-b', 'business'), '2026-07-15T00:00:02Z'),
    comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
  ];
  assert.deepEqual(activeClaims(comments).map((claim) => claim.sessionId), ['session-a', 'session-b']);
});

test('release removes only the matching Session claim', () => {
  const comments = [
    comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
    comment(claimComment('session-b', 'business'), '2026-07-15T00:00:02Z'),
    comment(releaseComment('session-a'), '2026-07-15T00:00:03Z'),
  ];
  assert.deepEqual(activeClaims(comments).map((claim) => claim.sessionId), ['session-b']);
});

test('removing the final global winner clears assignee and restores the global queue', () => {
  const [claim] = activeClaims([
    comment(claimComment('session-a', 'business', true), '2026-07-15T00:00:01Z'),
  ]);
  assert.equal(claim.queue, 'global');
  assert.deepEqual(releaseEffects(claim, {
    wasWinner: true,
    nextWinner: null,
    issueState: 'OPEN',
  }), {
    removeAssignee: true,
    restoreReadyForAgent: true,
  });
});

test('releasing a non-winner never changes the shared GitHub assignee or queue', () => {
  const [claim] = activeClaims([
    comment(claimComment('session-b', 'business', true), '2026-07-15T00:00:01Z'),
  ]);
  assert.deepEqual(releaseEffects(claim, {
    wasWinner: false,
    nextWinner: { sessionId: 'session-a' },
    issueState: 'OPEN',
  }), {
    removeAssignee: false,
    restoreReadyForAgent: false,
  });
});

test('releasing a closed Issue clears assignee without restoring ready-for-agent', () => {
  const [claim] = activeClaims([
    comment(claimComment('session-a', 'business', true), '2026-07-15T00:00:01Z'),
  ]);
  assert.deepEqual(releaseEffects(claim, {
    wasWinner: true,
    nextWinner: null,
    issueState: 'CLOSED',
  }), {
    removeAssignee: true,
    restoreReadyForAgent: false,
  });
});

test('a losing concurrent Session can release its own non-winning claim', () => {
  const comments = [
    comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
    comment(claimComment('session-b', 'business'), '2026-07-15T00:00:02Z'),
    comment(releaseComment('session-b'), '2026-07-15T00:00:03Z'),
  ];
  assert.deepEqual(activeClaims(comments).map((claim) => claim.sessionId), ['session-a']);
});

test('allows the winning Session to create a worktree or PR', () => {
  const issue = fixture({
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z')],
    },
  });
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, true);
  assert.equal(result.winner.sessionId, 'session-a');
});

test('blocks a different Session even when both use the same GitHub account', () => {
  const issue = fixture({
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z')],
    },
  });
  const result = evaluateIssueClaim(issue, 'session-b');
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'CLAIMED_BY_OTHER_SESSION');
});

test('fails closed when no Session has claimed the Issue', () => {
  const result = evaluateIssueClaim(fixture(), 'session-a');
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'SESSION_CLAIM_MISSING');
});

test('blocks when an open PR already closes the Issue', () => {
  const issue = fixture({
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z')],
    },
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Closes #568',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue).map((pr) => pr.number), [570]);
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'OPEN_CLOSING_PR');
});

test('does not treat a plain cross-reference as a closing PR', () => {
  const issue = fixture({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Related to #568',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue), []);
});

test('fails closed when claim or cross-reference history is truncated', () => {
  const issue = fixture({
    comments: { pageInfo: { hasPreviousPage: true }, nodes: [] },
    timelineItems: { pageInfo: { hasPreviousPage: true }, nodes: [] },
  });
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'RESULTS_TRUNCATED');
  assert.match(result.blockers[0].detail, /comments、timeline/);
});

test('never allows work on a closed Issue', () => {
  const result = evaluateIssueClaim(fixture({ state: 'CLOSED' }), 'session-a', { requireOwned: false });
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'ISSUE_NOT_OPEN');
});
