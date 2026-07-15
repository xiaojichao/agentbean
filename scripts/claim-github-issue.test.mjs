import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeClaims,
  claimComment,
  evaluateIssueClaim,
  openClosingPullRequests,
  releaseComment,
  releaseEffects,
  releaseIntentComment,
  releaseOwnedClaim,
  releasedComment,
} from './claim-github-issue.mjs';

function comment(body, createdAt, url = null, author = 'xiaojichao', authorAssociation = 'OWNER') {
  return { body, createdAt, url, author: { login: author }, authorAssociation };
}

function fixture(overrides = {}) {
  return {
    number: 568,
    title: '防止任务串到其他 Session',
    url: 'https://github.com/xiaojichao/agentbean/issues/568',
    state: 'OPEN',
    viewerLogin: 'xiaojichao',
    repositoryNameWithOwner: 'xiaojichao/agentbean',
    defaultBranchName: 'main',
    labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'ready-for-agent' }] },
    assignees: { pageInfo: { hasNextPage: false }, nodes: [{ login: 'xiaojichao' }] },
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

test('release intent keeps the Session claim active until cleanup completes', () => {
  const comments = [
    comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
    comment(releaseIntentComment('session-a'), '2026-07-15T00:00:02Z'),
  ];
  assert.deepEqual(activeClaims(comments).map((claim) => claim.sessionId), ['session-a']);
  comments.push(comment(releaseComment('session-a', {
    removeAssignee: true,
    restoreReadyForAgent: false,
  }), '2026-07-15T00:00:03Z'));
  assert.equal(activeClaims(comments)[0].status, 'release_pending');
  comments.push(comment(releasedComment('session-a'), '2026-07-15T00:00:04Z'));
  assert.deepEqual(activeClaims(comments), []);
});

test('release cleanup remains retryable when the completion marker write fails', () => {
  const issue = fixture({
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment(claimComment('session-a', 'workflow', true), '2026-07-15T00:00:01Z')],
    },
  });
  const options = { issue: 568, sessionId: 'session-a' };
  const repo = { nameWithOwner: 'xiaojichao/agentbean' };
  const commands = [];
  let failCompletionMarker = true;
  let sequence = 1;
  const execute = (args) => {
    commands.push(args);
    const bodyIndex = args.indexOf('--body');
    const body = bodyIndex >= 0 ? args[bodyIndex + 1] : null;
    if (failCompletionMarker && body?.includes('action=released ')) {
      throw new Error('simulated GitHub failure');
    }
    if (body) {
      issue.comments.nodes.push(comment(body, `2026-07-15T00:00:0${++sequence}Z`));
    }
    if (args.includes('--remove-assignee')) issue.assignees.nodes = [];
    if (args.includes('--add-label')) issue.labels.nodes = [{ name: 'ready-for-agent' }];
  };
  const dependencies = { execute, reload: () => issue };

  assert.throws(
    () => releaseOwnedClaim(issue, options, repo, dependencies),
    /simulated GitHub failure/,
  );
  assert.match(commands[0].at(-1), /action=releasing/);
  assert.match(commands[1].at(-1), /action=release .*remove_assignee=1 restore_ready=1/);
  assert.deepEqual(commands[2].slice(0, 3), ['issue', 'edit', '568']);
  assert.match(commands[3].at(-1), /action=released /);
  assert.equal(activeClaims(issue.comments.nodes)[0].status, 'release_pending');

  failCompletionMarker = false;
  const retry = releaseOwnedClaim(issue, options, repo, dependencies);
  assert.equal(retry.released, true);
  assert.match(commands[4].at(-1), /action=released /);
  assert.deepEqual(activeClaims(issue.comments.nodes), []);
});

test('release refuses side effects when history is truncated', () => {
  const issue = fixture({
    comments: {
      pageInfo: { hasPreviousPage: true },
      nodes: [comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z')],
    },
  });
  let executed = false;
  assert.throws(() => releaseOwnedClaim(
    issue,
    { issue: 568, sessionId: 'session-a' },
    { nameWithOwner: 'xiaojichao/agentbean' },
    { execute: () => { executed = true; }, reload: () => issue },
  ), /历史查询被截断/);
  assert.equal(executed, false);
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
    nextWinner: { sessionId: 'session-a', authorLogin: 'xiaojichao' },
    issueState: 'OPEN',
  }), {
    removeAssignee: false,
    restoreReadyForAgent: false,
  });
});

test('releasing a claim from another account removes only that account assignee', () => {
  const [claim] = activeClaims([
    comment(claimComment('session-b', 'business', true), '2026-07-15T00:00:01Z', null, 'other-user'),
  ]);
  assert.deepEqual(releaseEffects(claim, {
    wasWinner: false,
    nextWinner: { sessionId: 'session-a', authorLogin: 'xiaojichao' },
    issueState: 'OPEN',
  }), {
    removeAssignee: true,
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
          baseRefName: 'main',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue).map((pr) => pr.number), [570]);
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'OPEN_CLOSING_PR');
});

test('recognizes a closing keyword followed by a colon', () => {
  const issue = fixture({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Closes: #568',
          baseRefName: 'main',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue).map((pr) => pr.number), [570]);
});

test('recognizes a closing keyword followed by a full GitHub Issue URL', () => {
  const issue = fixture({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Closes https://github.com/xiaojichao/agentbean/issues/568',
          baseRefName: 'main',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue).map((pr) => pr.number), [570]);
});

test('ignores a closing reference that targets the same issue number in another repository', () => {
  const issue = fixture({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Related to #568\n\nCloses other/repo#568',
          baseRefName: 'main',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue), []);
});

test('ignores a closing keyword on a PR targeting a non-default branch', () => {
  const issue = fixture({
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [{
        source: {
          __typename: 'PullRequest',
          number: 570,
          state: 'OPEN',
          url: 'https://github.com/xiaojichao/agentbean/pull/570',
          body: 'Closes #568',
          baseRefName: 'feature/stack-base',
        },
      }],
    },
  });
  assert.deepEqual(openClosingPullRequests(issue), []);
});

test('ignores forged claim and release markers from another GitHub author', () => {
  const issue = fixture({
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [
        comment(claimComment('session-forged', 'workflow'), '2026-07-15T00:00:00Z', null, 'someone-else', 'NONE'),
        comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
        comment(releaseComment('session-a'), '2026-07-15T00:00:02Z', null, 'someone-else', 'NONE'),
      ],
    },
  });
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, true);
  assert.equal(result.winner.sessionId, 'session-a');
});

test('ignores a release marker written by a different trusted assignee', () => {
  const comments = [
    comment(claimComment('session-a', 'workflow'), '2026-07-15T00:00:01Z'),
    comment(releaseComment('session-a'), '2026-07-15T00:00:02Z', null, 'other-user', 'COLLABORATOR'),
  ];
  assert.deepEqual(activeClaims(comments).map((claim) => claim.sessionId), ['session-a']);
});

test('blocks a valid claim from another assigned GitHub account', () => {
  const issue = fixture({
    assignees: {
      pageInfo: { hasNextPage: false },
      nodes: [{ login: 'xiaojichao' }, { login: 'other-user' }],
    },
    comments: {
      pageInfo: { hasPreviousPage: false },
      nodes: [comment(
        claimComment('session-other', 'workflow'),
        '2026-07-15T00:00:01Z',
        null,
        'other-user',
        'COLLABORATOR',
      )],
    },
  });
  const result = evaluateIssueClaim(issue, 'session-a');
  assert.equal(result.ready, false);
  assert.equal(result.winner.authorLogin, 'other-user');
  assert.equal(result.blockers[0].code, 'CLAIMED_BY_OTHER_SESSION');
});

test('refuses a new claim when the Issue is assigned to another account without a marker', () => {
  const issue = fixture({
    assignees: {
      pageInfo: { hasNextPage: false },
      nodes: [{ login: 'other-user' }],
    },
  });
  const result = evaluateIssueClaim(issue, 'session-a', {
    requireOwned: false,
    rejectForeignAssignees: true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.blockers[0].code, 'ASSIGNED_TO_OTHER_ACCOUNT');
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
          baseRefName: 'main',
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
