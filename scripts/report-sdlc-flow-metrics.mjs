import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const DEFAULT_DAYS = 28;
const MAX_REST_PAGES = 10;
const PAGE_SIZE = 100;
const CODEX_REVIEWER = 'chatgpt-codex-connector';
const WORKFLOW_FILE = 'ci-cd.yml';
const DEPLOY_JOB = 'Deploy production';
const PRODUCTION_SMOKE_JOB = 'AgentBean Next production smoke';
const HEALTH_STEP = 'Wait for production server healthcheck';
const JOB_FETCH_CONCURRENCY = 6;
const execFileAsync = promisify(execFile);

const pullRequestsQuery = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: 100
      after: $cursor
      states: [OPEN, CLOSED, MERGED]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        state
        isDraft
        createdAt
        updatedAt
        mergedAt
        headRefOid
        mergeCommit { oid }
        commits(first: 100) {
          pageInfo { hasNextPage }
          nodes { commit { oid } }
        }
        timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT]) {
          pageInfo { hasNextPage }
          nodes {
            ... on ReadyForReviewEvent { createdAt }
          }
        }
        reviews(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            state
            submittedAt
            author { login }
            commit { oid }
          }
        }
      }
    }
  }
}`;

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim().slice(0, 2000) || 'gh 执行失败');
  }
  return result.stdout.trim();
}

async function runGhAsync(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.stdout?.trim().slice(0, 2000) || error.message);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} 返回了无效 JSON`);
  }
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsBetween(start, end) {
  const startMs = timestamp(start);
  const endMs = timestamp(end);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

function inWindow(value, from, to) {
  const time = timestamp(value);
  return time != null && time >= timestamp(from) && time <= timestamp(to);
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

export function durationSummary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { sampleSize: 0, averageSeconds: null, p50Seconds: null, p90Seconds: null };
  }
  return {
    sampleSize: sorted.length,
    averageSeconds: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50Seconds: percentile(sorted, 0.5),
    p90Seconds: percentile(sorted, 0.9),
  };
}

function firstReadyAt(pr) {
  return (pr.timelineItems?.nodes ?? [])
    .map((event) => event.createdAt)
    .filter(Boolean)
    .sort((left, right) => timestamp(left) - timestamp(right))[0] ?? null;
}

function submittedReviews(pr) {
  return (pr.reviews?.nodes ?? [])
    .filter((review) => review.state !== 'PENDING' && review.submittedAt)
    .sort((left, right) => timestamp(left.submittedAt) - timestamp(right.submittedAt));
}

function matchesCommit(candidate, head) {
  if (!candidate || !head) return false;
  return candidate.startsWith(head) || head.startsWith(candidate);
}

export function computePullRequestMetrics(pullRequests, { from, to }) {
  const created = pullRequests.filter((pr) => inWindow(pr.createdAt, from, to));
  const merged = pullRequests.filter((pr) => inWindow(pr.mergedAt, from, to));
  const truncated = pullRequests.filter(
    (pr) => pr.timelineItems?.pageInfo?.hasNextPage || pr.reviews?.pageInfo?.hasNextPage,
  );
  const completeCreated = created.filter((pr) => !truncated.includes(pr));

  const draftToReadySeconds = [];
  const readyToFirstReviewSeconds = [];
  let readyEventMissing = 0;
  let firstReviewMissing = 0;
  for (const pr of completeCreated) {
    const readyAt = firstReadyAt(pr);
    if (!readyAt) {
      readyEventMissing += 1;
      continue;
    }
    const draftDuration = secondsBetween(pr.createdAt, readyAt);
    if (draftDuration != null) draftToReadySeconds.push(draftDuration);
    const firstReview = submittedReviews(pr).find(
      (review) => timestamp(review.submittedAt) >= timestamp(readyAt),
    );
    if (!firstReview) firstReviewMissing += 1;
    else {
      const reviewDuration = secondsBetween(readyAt, firstReview.submittedAt);
      if (reviewDuration != null) readyToFirstReviewSeconds.push(reviewDuration);
    }
  }

  const openReviewable = pullRequests.filter(
    (pr) => pr.state === 'OPEN' && !pr.isDraft && !truncated.includes(pr),
  );
  const staleCodexPrNumbers = openReviewable
    .filter((pr) => {
      const codexReviews = submittedReviews(pr).filter(
        (review) => review.author?.login === CODEX_REVIEWER,
      );
      return codexReviews.length > 0
        && !codexReviews.some((review) => matchesCommit(review.commit?.oid, pr.headRefOid));
    })
    .map((pr) => pr.number);

  return {
    observedPullRequests: pullRequests.length,
    createdInWindow: created.length,
    mergedInWindow: merged.length,
    prLeadTime: durationSummary(
      merged.map((pr) => secondsBetween(pr.createdAt, pr.mergedAt)).filter(Number.isFinite),
    ),
    draftToReady: {
      ...durationSummary(draftToReadySeconds),
      missingReadyEvent: readyEventMissing,
    },
    readyToFirstReview: {
      ...durationSummary(readyToFirstReviewSeconds),
      missingFirstReview: firstReviewMissing,
    },
    staleCodexReview: {
      eligibleOpenNonDraft: openReviewable.length,
      count: staleCodexPrNumbers.length,
      prNumbers: staleCodexPrNumbers,
    },
    truncatedPrNumbers: truncated.map((pr) => pr.number),
  };
}

function conclusionKey(run) {
  return run.conclusion ?? (run.status === 'completed' ? 'unknown' : `pending:${run.status ?? 'unknown'}`);
}

export function computeFirstPassCiMetrics(runs, pullRequests = [], window = null) {
  return summarizeFirstPassCiResolution(resolveFirstPassCiRuns(runs, pullRequests, window));
}

export function resolveFirstPassCiRuns(runs, pullRequests = [], window = null) {
  const prByCommit = new Map();
  const commitFallbackTruncatedPrNumbers = pullRequests
    .filter((pr) => pr.commits?.pageInfo?.hasNextPage)
    .map((pr) => pr.number);
  for (const pr of pullRequests) {
    for (const node of pr.commits?.nodes ?? []) {
      const oid = node.commit?.oid;
      if (!oid) continue;
      if (prByCommit.has(oid) && prByCommit.get(oid) !== pr.number) prByCommit.set(oid, null);
      else if (!prByCommit.has(oid)) prByCommit.set(oid, pr.number);
    }
  }
  const firstByPr = new Map();
  let runsWithUnresolvedPullRequestAssociation = 0;
  const eligibleRuns = window
    ? runs.filter((run) => inWindow(run.created_at, window.from, window.to))
    : runs;
  const ordered = [...eligibleRuns]
    .sort((left, right) => (
      timestamp(left.created_at) - timestamp(right.created_at)
      || Number(left.id ?? 0) - Number(right.id ?? 0)
    ));
  for (const run of ordered) {
    const directPullRequests = run.pull_requests ?? [];
    if (directPullRequests.length > 1) {
      runsWithUnresolvedPullRequestAssociation += 1;
      continue;
    }
    const association = directPullRequests.length === 1 ? 'direct' : 'commit_fallback';
    const number = association === 'direct'
      ? directPullRequests[0]?.number
      : prByCommit.get(run.head_sha);
    if (!number) {
      runsWithUnresolvedPullRequestAssociation += 1;
      continue;
    }
    const first = firstByPr.get(number);
    if (!first) {
      firstByPr.set(number, {
        prNumber: number,
        run,
        association,
        laterRunId: null,
        laterRunCreatedAt: null,
        laterRunHeadSha: null,
      });
    } else if (!first.laterRunId) {
      first.laterRunId = run.id;
      first.laterRunCreatedAt = run.created_at;
      first.laterRunHeadSha = run.head_sha ?? null;
    }
  }
  return {
    firstRuns: [...firstByPr.values()],
    commitFallbackEvidenceComplete: commitFallbackTruncatedPrNumbers.length === 0,
    runsWithUnresolvedPullRequestAssociation,
    runsWithoutPullRequest: commitFallbackTruncatedPrNumbers.length === 0
      ? runsWithUnresolvedPullRequestAssociation
      : null,
    commitFallbackTruncatedPrNumbers,
  };
}

function summarizeFirstPassCiResolution(resolution) {
  const byConclusion = {};
  for (const { run } of resolution.firstRuns) {
    const key = conclusionKey(run);
    byConclusion[key] = (byConclusion[key] ?? 0) + 1;
  }
  const completed = resolution.firstRuns.map((entry) => entry.run).filter((run) => Boolean(run.conclusion));
  const success = completed.filter((run) => run.conclusion === 'success').length;
  return {
    pullRequestsWithFirstRun: resolution.firstRuns.length,
    completedFirstRuns: completed.length,
    success,
    successRate: completed.length === 0 ? null : Number((success / completed.length).toFixed(4)),
    byConclusion,
    commitFallbackEvidenceComplete: resolution.commitFallbackEvidenceComplete,
    runsWithUnresolvedPullRequestAssociation: resolution.runsWithUnresolvedPullRequestAssociation,
    runsWithoutPullRequest: resolution.runsWithoutPullRequest,
    commitFallbackTruncatedPrNumbers: resolution.commitFallbackTruncatedPrNumbers,
  };
}

function classifyFailureStep(stepNames, failedJobNames) {
  const names = [...stepNames, ...failedJobNames].map((name) => name.toLowerCase());
  const includes = (fragment) => names.some((name) => name.includes(fragment));
  if (includes('package tests and retained phase boundaries')) return 'package_tests_or_boundaries';
  if (includes('build agentbean next packages')) return 'build';
  if (includes('browser smoke')) return 'browser_smoke';
  if (includes('preview smoke')) return 'preview_smoke';
  if (includes('daemon install smoke')) return 'daemon_install_smoke';
  if (includes('readiness')) return 'readiness';
  if (includes('team terminology')) return 'terminology';
  if (includes('agent configuration eval')) return 'agent_configuration_eval';
  if (includes('install') || includes('set up') || includes('checkout')) return 'setup_or_dependencies';
  if (failedJobNames.length > 0 && stepNames.length === 0) return 'job_failure_without_failed_step';
  return 'other';
}

function categoryPareto(items) {
  const counts = new Map();
  for (const item of items) {
    const current = counts.get(item.category) ?? { category: item.category, runIds: [], prNumbers: [] };
    current.runIds.push(item.runId);
    current.prNumbers.push(item.prNumber);
    counts.set(item.category, current);
  }
  return {
    sampleSize: items.length,
    categories: [...counts.values()]
      .map((item) => ({
        ...item,
        count: item.runIds.length,
        share: items.length === 0 ? null : Number((item.runIds.length / items.length).toFixed(4)),
      }))
      .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)),
  };
}

export function computeFirstPassCiDiagnostics(resolution, jobResults = []) {
  const jobsByRun = new Map(jobResults.map((result) => [result.runId, result]));
  const nonSuccessRuns = resolution.firstRuns
    .filter(({ run }) => run.conclusion && run.conclusion !== 'success')
    .map((entry) => {
      const result = jobsByRun.get(entry.run.id);
      const failedJobs = (result?.jobs ?? [])
        .filter((job) => job.conclusion === 'failure')
        .map((job) => job.name);
      const failedSteps = (result?.jobs ?? [])
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.conclusion === 'failure')
        .map((step) => step.name);
      let category = `conclusion:${entry.run.conclusion}`;
      if (entry.run.conclusion === 'failure') {
        category = result?.jobsCapped
          ? 'jobs_truncated'
          : classifyFailureStep(failedSteps, failedJobs);
      } else if (entry.run.conclusion === 'cancelled') {
        category = entry.laterRunId
          ? 'cancelled_followed_by_later_pr_run'
          : 'cancelled_without_later_pr_run';
      }
      return {
        prNumber: entry.prNumber,
        runId: entry.run.id,
        createdAt: entry.run.created_at,
        headSha: entry.run.head_sha,
        conclusion: entry.run.conclusion,
        association: entry.association,
        category,
        laterRunId: entry.laterRunId,
        laterRunCreatedAt: entry.laterRunCreatedAt,
        laterRunHeadSha: entry.laterRunHeadSha,
        failedJobs,
        failedSteps,
      };
    });
  const failures = nonSuccessRuns.filter((run) => run.conclusion === 'failure');
  const cancellations = nonSuccessRuns.filter((run) => run.conclusion === 'cancelled');
  const cancellationsWithLaterRunCount = cancellations.filter(
    (run) => run.category === 'cancelled_followed_by_later_pr_run',
  ).length;
  const completedFirstRunsExcludingCancellationsWithLaterRun = resolution.firstRuns.filter(({ run, laterRunId }) => (
    Boolean(run.conclusion) && !(run.conclusion === 'cancelled' && laterRunId)
  )).length;
  const successCount = resolution.firstRuns.filter(({ run }) => run.conclusion === 'success').length;
  return {
    nonSuccessRuns,
    failurePareto: categoryPareto(failures),
    cancellationPareto: categoryPareto(cancellations),
    cancellationsWithLaterRunCount,
    completedFirstRunsExcludingCancellationsWithLaterRun,
    successRateExcludingCancellationsWithLaterRun: completedFirstRunsExcludingCancellationsWithLaterRun === 0
      ? null
      : Number((successCount / completedFirstRunsExcludingCancellationsWithLaterRun).toFixed(4)),
    jobsTruncatedRunIds: jobResults.filter((result) => result.jobsCapped).map((result) => result.runId),
  };
}

function outcome(value) {
  return value ?? 'missing';
}

export function computeDeliveryMetrics(deliveries, mergedPullRequests) {
  const mergeByCommit = new Map(
    mergedPullRequests
      .filter((pr) => pr.mergeCommit?.oid)
      .map((pr) => [pr.mergeCommit.oid, pr]),
  );
  const mergeToSmokeSeconds = [];
  const deployToHealthSeconds = [];
  const deployOutcomes = {};
  const smokeOutcomes = {};
  let runsWithoutMergedPullRequest = 0;
  let healthStepMissing = 0;
  const truncatedJobRunIds = deliveries
    .filter((delivery) => delivery.jobsCapped)
    .map((delivery) => delivery.run.id);

  for (const { run, jobs } of deliveries.filter((delivery) => !delivery.jobsCapped)) {
    const deploy = jobs.find((job) => job.name === DEPLOY_JOB);
    const smoke = jobs.find((job) => job.name === PRODUCTION_SMOKE_JOB);
    deployOutcomes[outcome(deploy?.conclusion)] = (deployOutcomes[outcome(deploy?.conclusion)] ?? 0) + 1;
    smokeOutcomes[outcome(smoke?.conclusion)] = (smokeOutcomes[outcome(smoke?.conclusion)] ?? 0) + 1;

    const mergedPr = mergeByCommit.get(run.head_sha);
    if (!mergedPr) runsWithoutMergedPullRequest += 1;
    if (mergedPr && smoke?.conclusion === 'success') {
      const duration = secondsBetween(mergedPr.mergedAt, smoke.completed_at);
      if (duration != null) mergeToSmokeSeconds.push(duration);
    }

    const health = (smoke?.steps ?? []).find((step) => step.name === HEALTH_STEP);
    if (!health) healthStepMissing += 1;
    if (deploy?.conclusion === 'success' && health?.conclusion === 'success') {
      const duration = secondsBetween(deploy.completed_at, health.completed_at);
      if (duration != null) deployToHealthSeconds.push(duration);
    }
  }

  return {
    mainPushRuns: deliveries.length,
    analyzedRuns: deliveries.length - truncatedJobRunIds.length,
    mergeToProductionSmoke: durationSummary(mergeToSmokeSeconds),
    deployToFirstHealthy: durationSummary(deployToHealthSeconds),
    deployOutcomes,
    productionSmokeOutcomes: smokeOutcomes,
    runsWithoutMergedPullRequest,
    healthStepMissing,
    truncatedJobRunIds,
  };
}

function resolveRepository(repo, runCommand) {
  const nameWithOwner = repo
    || runCommand(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const [owner, name, ...rest] = nameWithOwner.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`无效仓库：${nameWithOwner}`);
  return { owner, name, nameWithOwner };
}

function fetchPullRequests({ owner, name, from }, runCommand) {
  const pullRequests = [];
  let cursor = null;
  let pageCount = 0;
  while (true) {
    const args = [
      'api', 'graphql',
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-f', `query=${pullRequestsQuery}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const payload = parseJson(runCommand(args), 'GitHub GraphQL API');
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join('; '));
    }
    const connection = payload.data?.repository?.pullRequests;
    if (!connection) throw new Error('GitHub GraphQL API 未返回 pullRequests');
    const nodes = connection.nodes ?? [];
    pullRequests.push(...nodes.filter((pr) => timestamp(pr.updatedAt) >= timestamp(from)));
    pageCount += 1;
    const reachedWindowStart = nodes.some((pr) => timestamp(pr.updatedAt) < timestamp(from));
    if (!connection.pageInfo?.hasNextPage || reachedWindowStart) break;
    cursor = connection.pageInfo.endCursor;
    if (!cursor) throw new Error('GitHub GraphQL 分页缺少 endCursor');
  }
  return { pullRequests, pageCount };
}

export function hydrateTruncatedPullRequestCommits({ owner, name, pullRequests }, runCommand) {
  const warnings = [];
  for (const pr of pullRequests.filter((candidate) => candidate.commits?.pageInfo?.hasNextPage)) {
    const nodes = [];
    let complete = false;
    try {
      for (let page = 1; page <= MAX_REST_PAGES; page += 1) {
        const path = restPath(`repos/${owner}/${name}/pulls/${pr.number}/commits`, {
          per_page: String(PAGE_SIZE),
          page: String(page),
        });
        const items = parseJson(runCommand([
          'api', path,
          '--jq', '[.[] | {commit:{oid:.sha}}]',
        ]), `PR #${pr.number} commits API`);
        if (!Array.isArray(items)) throw new Error('commits API 未返回数组');
        nodes.push(...items);
        if (items.length < PAGE_SIZE) {
          complete = true;
          break;
        }
      }
    } catch {
      warnings.push(`PR #${pr.number} 的 commit 列表补全失败，first-pass CI 关联保留为不完整证据`);
      continue;
    }
    pr.commits = {
      nodes,
      pageInfo: { hasNextPage: !complete },
    };
    if (!complete) {
      warnings.push(`PR #${pr.number} 的 commit 列表超过 ${MAX_REST_PAGES * PAGE_SIZE} 项，first-pass CI 关联保留为不完整证据`);
    }
  }
  return { pullRequests, warnings };
}

function restPath(path, params) {
  const query = new URLSearchParams(params);
  return `${path}?${query.toString()}`;
}

function fetchWorkflowRuns({ owner, name, from, event, branch }, runCommand) {
  const workflowRuns = [];
  let totalCount = null;
  let capped = false;
  let page = 1;
  for (; page <= MAX_REST_PAGES; page += 1) {
    const path = restPath(
      `repos/${owner}/${name}/actions/workflows/${WORKFLOW_FILE}/runs`,
      {
        event,
        ...(branch ? { branch } : {}),
        created: `>=${from}`,
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
    );
    const payload = parseJson(runCommand([
      'api', path,
      '--jq',
      '{total_count,workflow_runs:[.workflow_runs[]|{id,head_sha,created_at,status,conclusion,pull_requests}]}',
    ]), 'GitHub Actions workflow runs API');
    totalCount ??= payload.total_count ?? 0;
    const items = payload.workflow_runs ?? [];
    workflowRuns.push(...items);
    if (items.length < PAGE_SIZE || workflowRuns.length >= totalCount) break;
  }
  if (page > MAX_REST_PAGES && totalCount > workflowRuns.length) capped = true;
  return { workflowRuns, totalCount, capped };
}

async function fetchRunJobs({ owner, name, runId }, runCommand) {
  const jobs = [];
  let page = 1;
  let totalCount = null;
  let capped = false;
  for (; page <= MAX_REST_PAGES; page += 1) {
    const path = restPath(`repos/${owner}/${name}/actions/runs/${runId}/jobs`, {
      filter: 'latest',
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const payload = parseJson(await runCommand([
      'api', path,
      '--jq',
      '{total_count,jobs:[.jobs[]|{name,status,conclusion,started_at,completed_at,steps}]}',
    ]), 'GitHub Actions jobs API');
    totalCount ??= payload.total_count ?? 0;
    const items = payload.jobs ?? [];
    jobs.push(...items);
    if (items.length < PAGE_SIZE || jobs.length >= totalCount) break;
  }
  if (page > MAX_REST_PAGES && totalCount > jobs.length) capped = true;
  return { jobs, capped };
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  return results;
}

export async function collectSdlcFlowMetrics(
  { repo = null, days = DEFAULT_DAYS, now = new Date() },
  runCommand = runGh,
  runCommandAsync = runGhAsync,
) {
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const repository = resolveRepository(repo, runCommand);
  const prResult = fetchPullRequests({ ...repository, from }, runCommand);
  const commitHydration = hydrateTruncatedPullRequestCommits({
    ...repository,
    pullRequests: prResult.pullRequests,
  }, runCommand);
  const prMetrics = computePullRequestMetrics(prResult.pullRequests, { from, to });

  const pullRequestRuns = fetchWorkflowRuns(
    { ...repository, from, event: 'pull_request', branch: null },
    runCommand,
  );
  const mainPushRuns = fetchWorkflowRuns(
    { ...repository, from, event: 'push', branch: 'main' },
    runCommand,
  );
  const pullRequestWorkflowRuns = pullRequestRuns.workflowRuns
    .filter((run) => inWindow(run.created_at, from, to));
  const firstPassResolution = resolveFirstPassCiRuns(
    pullRequestWorkflowRuns,
    prResult.pullRequests,
    { from, to },
  );
  const failedFirstRuns = firstPassResolution.firstRuns
    .filter(({ run }) => run.conclusion === 'failure');
  const firstPassJobResults = await mapWithConcurrency(
    failedFirstRuns,
    JOB_FETCH_CONCURRENCY,
    async ({ run }) => {
      const result = await fetchRunJobs({ ...repository, runId: run.id }, runCommandAsync);
      return { runId: run.id, jobs: result.jobs, jobsCapped: result.capped };
    },
  );
  const firstPassDiagnostics = computeFirstPassCiDiagnostics(
    firstPassResolution,
    firstPassJobResults,
  );
  const mainPushWorkflowRuns = mainPushRuns.workflowRuns
    .filter((run) => inWindow(run.created_at, from, to));
  const mergedPullRequests = prResult.pullRequests.filter((pr) => inWindow(pr.mergedAt, from, to));
  const mergeCommits = new Set(
    mergedPullRequests.map((pr) => pr.mergeCommit?.oid).filter(Boolean),
  );
  const matchedMainPushRuns = mainPushWorkflowRuns.filter((run) => mergeCommits.has(run.head_sha));
  const deliveries = await mapWithConcurrency(matchedMainPushRuns, JOB_FETCH_CONCURRENCY, async (run) => {
    const result = await fetchRunJobs({ ...repository, runId: run.id }, runCommandAsync);
    return { run, jobs: result.jobs, jobsCapped: result.capped };
  });

  const warnings = [...commitHydration.warnings];
  if (prMetrics.truncatedPrNumbers.length > 0) {
    warnings.push(`PR #${prMetrics.truncatedPrNumbers.join(', #')} 的 ready/review 连接超过 100 项，已排除相关指标`);
  }
  if (pullRequestRuns.capped) warnings.push('pull_request workflow runs 命中 GitHub 1000 条查询上限');
  if (mainPushRuns.capped) warnings.push('main push workflow runs 命中 GitHub 1000 条查询上限');
  const commitTruncatedPrNumbers = prResult.pullRequests
    .filter((pr) => pr.commits?.pageInfo?.hasNextPage)
    .map((pr) => pr.number);
  if (commitTruncatedPrNumbers.length > 0) {
    warnings.push(`PR #${commitTruncatedPrNumbers.join(', #')} 超过 100 个 commits，first-pass CI 的 SHA 回退关联可能不完整`);
  }
  const cappedJobRuns = deliveries.filter((item) => item.jobsCapped).map((item) => item.run.id);
  if (cappedJobRuns.length > 0) warnings.push(`部分 workflow run 的 jobs 超过 1000 项：${cappedJobRuns.join(', ')}`);
  if (firstPassDiagnostics.jobsTruncatedRunIds.length > 0) {
    warnings.push(`部分 first-pass CI run 的 jobs 超过 1000 项：${firstPassDiagnostics.jobsTruncatedRunIds.join(', ')}`);
  }

  return {
    schemaVersion: 1,
    generatedAt: to,
    repository: repository.nameWithOwner,
    window: { days, from, to },
    definitions: {
      prLeadTime: '窗口内合并的 PR：createdAt → mergedAt',
      draftToReady: '窗口内创建且存在 ReadyForReviewEvent 的 PR：createdAt → 首次 ready',
      readyToFirstReview: '窗口内创建的 PR：首次 ready → 其后首次非 PENDING review',
      staleCodexReview: '观察窗口内有更新的 open、非 draft PR：有 Codex review，但没有 review 覆盖当前 head',
      firstPassCiSuccess: '窗口内 pull_request 事件中，每个 PR 最早一次 CI/CD run 的 conclusion',
      firstPassCiFailurePareto: '失败 first-run 按固定优先级归一失败 job/step；不读取完整日志',
      firstPassCiCancellationPareto: '取消 first-run 仅按是否存在同 PR 后续 run 分类；不把相关性直接断言为 concurrency supersede',
      mergeToProductionSmoke: 'merge commit 对应 main push run：mergedAt → production smoke job 完成',
      deployToFirstHealthy: '同一 main push run：deploy job 完成 → healthcheck step 完成',
    },
    pullRequests: prMetrics,
    firstPassCi: {
      ...summarizeFirstPassCiResolution(firstPassResolution),
      workflowRunsComplete: !pullRequestRuns.capped,
      diagnostics: firstPassDiagnostics,
    },
    delivery: {
      ...computeDeliveryMetrics(deliveries, mergedPullRequests),
      workflowRunsComplete: !mainPushRuns.capped,
      observedMainPushRuns: mainPushWorkflowRuns.length,
      matchedMergeRuns: matchedMainPushRuns.length,
    },
    dataQuality: {
      pullRequestPages: prResult.pageCount,
      pullRequestRunTotal: pullRequestRuns.totalCount,
      mainPushRunTotal: mainPushRuns.totalCount,
      warnings,
    },
  };
}

function formatPercent(value) {
  return value == null ? '未知' : `${(value * 100).toFixed(1)}%`;
}

function formatSeconds(value) {
  if (value == null) return '未知';
  if (value < 60) return `${value}秒`;
  if (value < 3600) return `${Math.round(value / 60)}分钟`;
  return `${(value / 3600).toFixed(1)}小时`;
}

function metricLine(label, metric) {
  return `${label}：样本 ${metric.sampleSize}，P50 ${formatSeconds(metric.p50Seconds)}，P90 ${formatSeconds(metric.p90Seconds)}`;
}

function paretoLine(label, pareto) {
  const categories = pareto.categories
    .slice(0, 3)
    .map((item) => `${item.category} ${item.count}/${pareto.sampleSize}`)
    .join('，');
  return `${label}：${categories || '无样本'}`;
}

export function formatSdlcFlowMetrics(result) {
  const lines = [
    `AgentBean SDLC 流程指标（${result.window.from.slice(0, 10)} 至 ${result.window.to.slice(0, 10)}）`,
    `仓库：${result.repository}`,
    `首次 CI 成功率：${formatPercent(result.firstPassCi.successRate)}（${result.firstPassCi.success}/${result.firstPassCi.completedFirstRuns}）`,
    `排除存在后续 run 的取消后：${formatPercent(result.firstPassCi.diagnostics.successRateExcludingCancellationsWithLaterRun)}（${result.firstPassCi.success}/${result.firstPassCi.diagnostics.completedFirstRunsExcludingCancellationsWithLaterRun}）`,
    paretoLine('首次 CI 失败 Pareto', result.firstPassCi.diagnostics.failurePareto),
    paretoLine('首次 CI 取消 Pareto', result.firstPassCi.diagnostics.cancellationPareto),
    metricLine('Draft → Ready', result.pullRequests.draftToReady),
    metricLine('Ready → 首次 Review', result.pullRequests.readyToFirstReview),
    `Codex stale review：${result.pullRequests.staleCodexReview.count}/${result.pullRequests.staleCodexReview.eligibleOpenNonDraft}`,
    metricLine('PR lead time', result.pullRequests.prLeadTime),
    metricLine('Merge → production smoke', result.delivery.mergeToProductionSmoke),
    metricLine('Deploy → first healthy', result.delivery.deployToFirstHealthy),
  ];
  if (result.dataQuality.warnings.length > 0) {
    lines.push('数据质量提示：', ...result.dataQuality.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    days: DEFAULT_DAYS,
    json: false,
    repo: process.env.GITHUB_REPOSITORY ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--repo') options.repo = argv[++index];
    else if (value === '--days') options.days = Number(argv[++index]);
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!Number.isInteger(options.days) || options.days <= 0 || options.days > 365) {
    throw new Error('--days 必须是 1 到 365 之间的整数');
  }
  return options;
}

function usage() {
  return '用法：npm run report:sdlc-flow-metrics -- [--days 28] [--json] [--repo owner/name]';
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await collectSdlcFlowMetrics(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSdlcFlowMetrics(result));
  } catch (error) {
    console.error(`SDLC_FLOW_METRICS_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
