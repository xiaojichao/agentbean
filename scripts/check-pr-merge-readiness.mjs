import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CODEX_REVIEWER = 'chatgpt-codex-connector';
const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const query = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      mergeable
      mergeStateStatus
      reviewDecision
      createdAt
      mergedAt
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            committedDate
            statusCheckRollup {
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                  }
                  ... on StatusContext {
                    context
                    state
                  }
                }
              }
            }
          }
        }
      }
      reviews(last: 100) {
        nodes {
          submittedAt
          author { login }
          commit { oid }
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
        }
      }
      reviewRequests(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug }
          }
        }
      }
      comments(last: 100) {
        nodes {
          createdAt
          author { login }
          body
        }
      }
    }
  }
}`;

function checkState(context) {
  if (context.__typename === 'CheckRun') {
    if (context.status !== 'COMPLETED') return 'pending';
    return PASSING_CHECK_CONCLUSIONS.has(context.conclusion) ? 'passing' : 'failing';
  }
  if (context.__typename === 'StatusContext') {
    if (context.state === 'PENDING' || context.state === 'EXPECTED') return 'pending';
    return context.state === 'SUCCESS' ? 'passing' : 'failing';
  }
  return 'failing';
}

function reviewedCommitFromComment(comment) {
  if (comment.author?.login !== CODEX_REVIEWER) return null;
  return comment.body?.match(/Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i)?.[1] ?? null;
}

function matchesHead(candidate, headOid) {
  return Boolean(candidate && headOid && (headOid.startsWith(candidate) || candidate.startsWith(headOid)));
}

function secondsBetween(start, end) {
  if (!start || !end) return null;
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
}

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return '未知';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

export function evaluatePullRequest(pr, now = new Date(), { stage = 'merge' } = {}) {
  if (stage !== 'review' && stage !== 'merge') throw new Error(`未知门禁阶段：${stage}`);
  const commit = pr.commits?.nodes?.at(-1)?.commit;
  const headOid = pr.headRefOid ?? commit?.oid ?? null;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = contexts.map((context) => ({
    name: context.name ?? context.context ?? context.__typename,
    state: checkState(context),
  }));
  const pendingChecks = checks.filter((item) => item.state === 'pending');
  const failingChecks = checks.filter((item) => item.state === 'failing');
  const unresolvedThreads = (pr.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved);
  const pendingReviewers = (pr.reviewRequests?.nodes ?? []).map((request) =>
    request.requestedReviewer?.login ?? request.requestedReviewer?.slug ?? 'unknown',
  );

  const codexReviewCandidates = [
    ...(pr.reviews?.nodes ?? [])
      .filter((review) => review.author?.login === CODEX_REVIEWER)
      .map((review) => ({ commit: review.commit?.oid, at: review.submittedAt })),
    ...(pr.comments?.nodes ?? [])
      .map((comment) => ({ commit: reviewedCommitFromComment(comment), at: comment.createdAt }))
      .filter((item) => item.commit),
  ];
  const currentCodexReview = codexReviewCandidates
    .filter((item) => matchesHead(item.commit, headOid))
    .sort((left, right) => new Date(right.at) - new Date(left.at))[0] ?? null;

  const blockers = [];
  const truncatedConnections = [
    commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage ? 'checks' : null,
    pr.reviewThreads?.pageInfo?.hasNextPage ? 'review threads' : null,
    pr.reviewRequests?.pageInfo?.hasNextPage ? 'review requests' : null,
  ].filter(Boolean);
  if (pr.state !== 'OPEN') blockers.push({ code: 'PR_NOT_OPEN', detail: `PR 状态为 ${pr.state}` });
  if (stage === 'review' && !pr.isDraft) {
    blockers.push({ code: 'PR_NOT_DRAFT', detail: 'Review 前置门禁仅适用于 Draft PR' });
  }
  if (stage === 'merge' && pr.isDraft) blockers.push({ code: 'PR_DRAFT', detail: 'PR 仍是 Draft' });
  if (pr.mergeable !== 'MERGEABLE') blockers.push({ code: 'PR_NOT_MERGEABLE', detail: `mergeable=${pr.mergeable}` });
  if (pr.mergeStateStatus !== 'CLEAN') {
    blockers.push({
      code: 'MERGE_STATE_NOT_CLEAN',
      detail: `mergeStateStatus=${pr.mergeStateStatus}，预期 CLEAN`,
    });
  }
  if (!commit?.statusCheckRollup || contexts.length === 0) {
    blockers.push({ code: 'CHECKS_MISSING', detail: '最新提交尚无 CI/check 结果' });
  }
  if (truncatedConnections.length > 0) blockers.push({
    code: 'RESULTS_TRUNCATED',
    detail: `GitHub 查询超过 100 项，无法证明门禁完整：${truncatedConnections.join('、')}`,
  });
  if (pendingChecks.length > 0) blockers.push({
    code: 'CHECKS_PENDING',
    detail: `仍有 ${pendingChecks.length} 个检查运行中：${pendingChecks.map((item) => item.name).join('、')}`,
  });
  if (failingChecks.length > 0) blockers.push({
    code: 'CHECKS_FAILED',
    detail: `有 ${failingChecks.length} 个检查失败：${failingChecks.map((item) => item.name).join('、')}`,
  });
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    blockers.push({ code: 'CHANGES_REQUESTED', detail: '存在 blocking change request' });
  }
  if (stage === 'merge' && pr.reviewDecision === 'REVIEW_REQUIRED') {
    blockers.push({ code: 'REVIEW_REQUIRED', detail: '仓库规则仍要求 Review' });
  }
  if (pendingReviewers.length > 0) blockers.push({
    code: 'REVIEWS_PENDING',
    detail: `仍在等待 Review：${pendingReviewers.join('、')}`,
  });
  if (unresolvedThreads.length > 0) blockers.push({
    code: 'THREADS_UNRESOLVED',
    detail: `仍有 ${unresolvedThreads.length} 个未解决 Review thread`,
  });
  if (stage === 'merge' && !currentCodexReview) blockers.push({
    code: codexReviewCandidates.length > 0 ? 'CODEX_REVIEW_STALE' : 'CODEX_REVIEW_MISSING',
    detail: codexReviewCandidates.length > 0
      ? 'Codex Review 尚未覆盖最新提交'
      : '尚未收到 Codex Review',
  });

  return {
    ready: blockers.length === 0,
    stage,
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      mergedAt: pr.mergedAt ?? null,
    },
    head: {
      oid: headOid,
      committedAt: commit?.committedDate ?? null,
    },
    checks: {
      total: checks.length,
      passing: checks.filter((item) => item.state === 'passing').length,
      pending: pendingChecks.map((item) => item.name),
      failing: failingChecks.map((item) => item.name),
    },
    review: {
      codexCurrent: Boolean(currentCodexReview),
      codexReviewedAt: currentCodexReview?.at ?? null,
      unresolvedThreads: unresolvedThreads.length,
      pendingReviewers,
    },
    timing: {
      prAgeSeconds: secondsBetween(pr.createdAt, now),
      headToCodexReviewSeconds: secondsBetween(commit?.committedDate, currentCodexReview?.at),
      codexReviewAfterMerge: Boolean(pr.mergedAt && currentCodexReview?.at && new Date(currentCodexReview.at) > new Date(pr.mergedAt)),
    },
    blockers,
  };
}

export function formatReadiness(result) {
  const stageLabel = result.stage === 'review' ? 'Review 前置门禁' : '合并门禁';
  const lines = [
    `${result.ready ? 'READY ✅' : 'BLOCKED ⏳'} [${stageLabel}] PR #${result.pullRequest.number} ${result.pullRequest.title}`,
    `最新提交：${result.head.oid?.slice(0, 10) ?? 'unknown'}`,
    `检查：${result.checks.passing}/${result.checks.total} 通过`,
    `Codex Review：${result.stage === 'review' ? '此阶段不要求' : result.review.codexCurrent ? '已覆盖最新提交' : '未覆盖最新提交'}`,
    `未解决线程：${result.review.unresolvedThreads}`,
    `PR 已持续：${formatDuration(result.timing.prAgeSeconds)}`,
    `最新提交到 Codex Review：${formatDuration(result.timing.headToCodexReviewSeconds)}`,
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
    json: false,
    number: null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
    stage: 'merge',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--pr') options.number = Number(argv[++index]);
    else if (value === '--repo') options.repo = argv[++index];
    else if (value === '--stage') options.stage = argv[++index];
    else if (/^\d+$/.test(value)) options.number = Number(value);
    else throw new Error(`未知参数：${value}`);
  }
  if (!Number.isInteger(options.number) || options.number <= 0) {
    throw new Error('用法：npm run check:pr-merge-readiness -- <PR号> [--stage review|merge] [--json] [--repo owner/name]');
  }
  if (options.stage !== 'review' && options.stage !== 'merge') throw new Error(`未知门禁阶段：${options.stage}`);
  return options;
}

function fetchPullRequest({ number, repo }) {
  const nameWithOwner = repo || runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const [owner, name, ...rest] = nameWithOwner.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`无效仓库：${nameWithOwner}`);
  const raw = runGh([
    'api', 'graphql',
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${number}`,
    '-f', `query=${query}`,
  ]);
  const payload = JSON.parse(raw);
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) throw new Error(`找不到 PR #${number}`);
  return pr;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = evaluatePullRequest(fetchPullRequest(options), new Date(), { stage: options.stage });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatReadiness(result));
    process.exitCode = result.ready ? 0 : 2;
  } catch (error) {
    console.error(`PR_READINESS_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
