import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLAIM_MARKER_PREFIX = 'agentbean-codex-claim:v1';

const query = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    issue(number: $number) {
      number
      title
      url
      state
      labels(first: 100) {
        pageInfo { hasNextPage }
        nodes { name }
      }
      assignees(first: 100) {
        pageInfo { hasNextPage }
        nodes { login }
      }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          id
          url
          body
          createdAt
          author { login }
        }
      }
      timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                number
                state
                url
                body
                baseRefName
              }
            }
          }
        }
      }
    }
  }
}`;

function parseMarker(body) {
  const match = body?.match(/<!--\s*agentbean-codex-claim:v1\s+([^>]+?)\s*-->/);
  if (!match) return null;
  const attributes = Object.fromEntries(
    [...match[1].matchAll(/([a-z]+)=([^\s]+)/g)].map((item) => [item[1], item[2]]),
  );
  if (!['claim', 'releasing', 'release'].includes(attributes.action) || !attributes.session) return null;
  return {
    action: attributes.action,
    sessionId: attributes.session,
    scope: attributes.scope ?? 'unspecified',
    queue: attributes.queue === 'global' ? 'global' : 'session',
  };
}

export function activeClaims(comments = [], trustedAuthors = null) {
  const active = new Map();
  const trusted = trustedAuthors === null ? null : new Set(trustedAuthors);
  const ordered = comments
    .filter((comment) => !trusted || trusted.has(comment.author?.login))
    .map((comment, index) => ({ comment, index, marker: parseMarker(comment.body) }))
    .filter((item) => item.marker)
    .sort((left, right) => {
      const timeOrder = new Date(left.comment.createdAt) - new Date(right.comment.createdAt);
      return timeOrder || left.index - right.index;
    });

  for (const item of ordered) {
    const { marker, comment } = item;
    if (marker.action === 'release') {
      active.delete(marker.sessionId);
    } else if (!active.has(marker.sessionId)) {
      active.set(marker.sessionId, {
        sessionId: marker.sessionId,
        scope: marker.scope,
        queue: marker.queue,
        authorLogin: comment.author?.login ?? null,
        createdAt: comment.createdAt,
        url: comment.url ?? null,
      });
    }
  }
  return [...active.values()].sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

function closesIssue(body, issueNumber) {
  if (!body) return false;
  const keyword = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
  const shortReference = `(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#${issueNumber}\\b`;
  const urlReference = `https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/${issueNumber}\\b`;
  return new RegExp(`${keyword}\\s*:?\\s+(?:${shortReference}|${urlReference})`, 'i').test(body);
}

export function openClosingPullRequests(issue) {
  const byNumber = new Map();
  for (const event of issue.timelineItems?.nodes ?? []) {
    const source = event?.source;
    if (source?.__typename !== 'PullRequest' || source.state !== 'OPEN') continue;
    if (source.baseRefName !== issue.defaultBranchName) continue;
    if (!closesIssue(source.body, issue.number)) continue;
    byNumber.set(source.number, { number: source.number, url: source.url });
  }
  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

export function evaluateIssueClaim(issue, sessionId, { requireOwned = true } = {}) {
  const claims = activeClaims(issue.comments?.nodes, issue.trustedClaimAuthors);
  const winner = claims[0] ?? null;
  const linkedPullRequests = openClosingPullRequests(issue);
  const blockers = [];
  const truncated = [
    issue.labels?.pageInfo?.hasNextPage ? 'labels' : null,
    issue.assignees?.pageInfo?.hasNextPage ? 'assignees' : null,
    issue.comments?.pageInfo?.hasPreviousPage ? 'comments' : null,
    issue.timelineItems?.pageInfo?.hasPreviousPage ? 'timeline' : null,
  ].filter(Boolean);

  if (issue.state !== 'OPEN') blockers.push({ code: 'ISSUE_NOT_OPEN', detail: `Issue 状态为 ${issue.state}` });
  if (!issue.viewerLogin) blockers.push({
    code: 'VIEWER_UNKNOWN',
    detail: '无法确认当前 GitHub 登录账号',
  });
  if (!issue.defaultBranchName) blockers.push({
    code: 'DEFAULT_BRANCH_UNKNOWN',
    detail: '无法确认仓库默认分支，拒绝判断 closing PR',
  });
  if (truncated.length > 0) blockers.push({
    code: 'RESULTS_TRUNCATED',
    detail: `GitHub 查询被截断，无法证明认领唯一：${truncated.join('、')}`,
  });
  if (linkedPullRequests.length > 0) blockers.push({
    code: 'OPEN_CLOSING_PR',
    detail: `已有活动 PR 将关闭该 Issue：${linkedPullRequests.map((pr) => `#${pr.number}`).join('、')}`,
  });
  if (winner && winner.sessionId !== sessionId) blockers.push({
    code: 'CLAIMED_BY_OTHER_SESSION',
    detail: `最早有效 Claim 属于 Session ${winner.sessionId}`,
  });
  if (requireOwned && !winner) blockers.push({
    code: 'SESSION_CLAIM_MISSING',
    detail: '尚无 Session Claim，禁止创建 worktree 或 PR',
  });

  return {
    ready: blockers.length === 0,
    issue: { number: issue.number, title: issue.title, url: issue.url, state: issue.state },
    sessionId,
    winner,
    activeClaims: claims,
    openClosingPullRequests: linkedPullRequests,
    globallyQueued: (issue.labels?.nodes ?? []).some((label) => label.name === 'ready-for-agent'),
    blockers,
  };
}

export function claimComment(sessionId, scope, globallyQueued = false) {
  return [
    `<!-- ${CLAIM_MARKER_PREFIX} action=claim session=${sessionId} scope=${scope} queue=${globallyQueued ? 'global' : 'session'} -->`,
    `🔒 已由 Codex Session \`${sessionId}\` 认领（scope: \`${scope}\`）。其他 Session 在该 Claim 释放前不得创建 worktree 或 PR。`,
  ].join('\n');
}

export function releaseComment(sessionId) {
  return [
    `<!-- ${CLAIM_MARKER_PREFIX} action=release session=${sessionId} -->`,
    `🔓 Codex Session \`${sessionId}\` 已释放认领。`,
  ].join('\n');
}

export function releaseIntentComment(sessionId) {
  return [
    `<!-- ${CLAIM_MARKER_PREFIX} action=releasing session=${sessionId} -->`,
    `🔓 Codex Session \`${sessionId}\` 正在释放认领；清理完成前该 Claim 继续有效。`,
  ].join('\n');
}

export function releaseEffects(claim, { wasWinner, nextWinner, issueState }) {
  const clearsOwnership = Boolean(claim && wasWinner && !nextWinner);
  return {
    removeAssignee: Boolean(claim && (!nextWinner || nextWinner.authorLogin !== claim.authorLogin)),
    restoreReadyForAgent: clearsOwnership && issueState === 'OPEN' && claim.queue === 'global',
  };
}

function formatResult(result) {
  const lines = [
    `${result.ready ? 'READY ✅' : 'BLOCKED ⛔'} Issue #${result.issue.number} ${result.issue.title}`,
    `当前 Session：${result.sessionId}`,
    `有效 Claim：${result.winner?.sessionId ?? '无'}`,
    `全局队列：${result.globallyQueued ? '是' : '否'}`,
    `活动关闭型 PR：${result.openClosingPullRequests.map((pr) => `#${pr.number}`).join('、') || '无'}`,
  ];
  if (result.blockers.length > 0) {
    lines.push('阻塞项：', ...result.blockers.map((blocker) => `- [${blocker.code}] ${blocker.detail}`));
  }
  return lines.join('\n');
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh 执行失败');
  return result.stdout.trim();
}

function parseArgs(argv) {
  const options = {
    command: argv.shift(),
    issue: null,
    sessionId: process.env.CODEX_THREAD_ID ?? null,
    scope: 'session',
    repo: process.env.GITHUB_REPOSITORY ?? null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--issue') options.issue = Number(argv[++index]);
    else if (value === '--session') options.sessionId = argv[++index];
    else if (value === '--scope') options.scope = argv[++index];
    else if (value === '--repo') options.repo = argv[++index];
    else if (value === '--json') options.json = true;
    else if (/^\d+$/.test(value)) options.issue = Number(value);
    else throw new Error(`未知参数：${value}`);
  }
  if (!['claim', 'check', 'release'].includes(options.command)) {
    throw new Error('用法：npm run issue:claim -- <Issue号> --session <thread-id> [--scope business|workflow]');
  }
  if (!Number.isInteger(options.issue) || options.issue <= 0) throw new Error('必须提供有效 Issue 号');
  if (!options.sessionId || !/^[A-Za-z0-9._:-]+$/.test(options.sessionId)) throw new Error('必须提供有效 --session <thread-id>');
  if (!/^[A-Za-z0-9._:-]+$/.test(options.scope)) throw new Error('必须提供有效 --scope');
  return options;
}

function repository(options) {
  const nameWithOwner = options.repo || runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const [owner, name, ...rest] = nameWithOwner.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`无效仓库：${nameWithOwner}`);
  return { owner, name, nameWithOwner };
}

function fetchIssue(options, repo) {
  const raw = runGh([
    'api', 'graphql',
    '-F', `owner=${repo.owner}`,
    '-F', `name=${repo.name}`,
    '-F', `number=${options.issue}`,
    '-f', `query=${query}`,
  ]);
  const payload = JSON.parse(raw);
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
  const issue = payload.data?.repository?.issue;
  if (!issue) throw new Error(`找不到 Issue #${options.issue}`);
  return {
    ...issue,
    viewerLogin: payload.data?.viewer?.login ?? null,
    trustedClaimAuthors: (issue.assignees?.nodes ?? []).map((assignee) => assignee.login),
    defaultBranchName: payload.data?.repository?.defaultBranchRef?.name ?? null,
  };
}

function print(result, json) {
  console.log(json ? JSON.stringify(result, null, 2) : formatResult(result));
}

export function releaseOwnedClaim(issue, options, repo, dependencies = {}) {
  const execute = dependencies.execute ?? runGh;
  const reload = dependencies.reload ?? fetchIssue;
  const before = evaluateIssueClaim(issue, options.sessionId);
  const ownClaim = before.activeClaims.find((claim) => claim.sessionId === options.sessionId);
  if (!ownClaim) return { released: false, issue, result: before, effects: null };
  if (ownClaim.authorLogin !== issue.viewerLogin) {
    throw new Error(`Session Claim 属于 ${ownClaim.authorLogin}，当前账号 ${issue.viewerLogin} 无权释放`);
  }

  execute(['issue', 'comment', String(options.issue), '--repo', repo.nameWithOwner, '--body', releaseIntentComment(options.sessionId)]);
  const refreshedIssue = reload(options, repo);
  const releasing = evaluateIssueClaim(refreshedIssue, options.sessionId, { requireOwned: false });
  const releasingClaim = releasing.activeClaims.find((claim) => claim.sessionId === options.sessionId);
  if (!releasingClaim || releasingClaim.authorLogin !== refreshedIssue.viewerLogin) {
    throw new Error('释放意图写入后无法重新确认当前 Session Claim');
  }
  const nextWinner = releasing.activeClaims.find((claim) => claim.sessionId !== options.sessionId) ?? null;
  const effects = releaseEffects(releasingClaim, {
    wasWinner: releasing.winner?.sessionId === options.sessionId,
    nextWinner,
    issueState: refreshedIssue.state,
  });
  if (effects.removeAssignee) {
    const editArgs = ['issue', 'edit', String(options.issue), '--repo', repo.nameWithOwner, '--remove-assignee', '@me'];
    if (effects.restoreReadyForAgent) editArgs.push('--add-label', 'ready-for-agent');
    execute(editArgs);
  }
  execute(['issue', 'comment', String(options.issue), '--repo', repo.nameWithOwner, '--body', releaseComment(options.sessionId)]);
  return { released: true, issue: refreshedIssue, result: releasing, effects };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repo = repository(options);
    let issue = fetchIssue(options, repo);

    if (options.command === 'release') {
      const release = releaseOwnedClaim(issue, options, repo);
      if (!release.released) {
        print(release.result, options.json);
        process.exitCode = 2;
        return;
      }
      console.log(`RELEASED 🔓 Issue #${options.issue} / Session ${options.sessionId}`);
      return;
    }

    if (options.command === 'claim') {
      const before = evaluateIssueClaim(issue, options.sessionId, { requireOwned: false });
      if (!before.ready) {
        print(before, options.json);
        process.exitCode = 2;
        return;
      }
      const createdClaim = !before.winner;
      if (!before.winner) {
        runGh([
          'issue', 'comment', String(options.issue), '--repo', repo.nameWithOwner,
          '--body', claimComment(options.sessionId, options.scope, before.globallyQueued),
        ]);
      }
      const editArgs = ['issue', 'edit', String(options.issue), '--repo', repo.nameWithOwner, '--add-assignee', '@me'];
      if (before.globallyQueued) editArgs.push('--remove-label', 'ready-for-agent');
      runGh(editArgs);
      issue = fetchIssue(options, repo);
      const after = evaluateIssueClaim(issue, options.sessionId);
      if (createdClaim && after.winner?.sessionId !== options.sessionId) {
        const release = releaseOwnedClaim(issue, options, repo);
        if (!release.released) throw new Error('并发 Claim 失败后无法释放当前 Session');
        issue = fetchIssue(options, repo);
      }
    }

    const result = evaluateIssueClaim(issue, options.sessionId);
    print(result, options.json);
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.error(`ISSUE_CLAIM_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
