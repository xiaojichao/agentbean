import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  checkState,
  collectReviewCandidates,
  matchesHead,
} from './check-pr-merge-readiness.mjs';
import {
  observeLiveHealth as observeHealthContract,
  validatePublicHttpTarget,
} from './observe-maintain-signal.mjs';

const DEFAULT_HEALTH_URL = 'https://api.agentbean.dev/healthz';
const DEFAULT_HEALTH_ORIGIN = 'https://api.agentbean.dev';
const WORKFLOW_FILE = 'ci-cd.yml';
const DEPLOY_JOB = 'Deploy production';
const PRODUCTION_SMOKE_JOB = 'AgentBean Next production smoke';
const HEALTH_STEP = 'Wait for production server healthcheck';
const PAGE_SIZE = 100;
const MAX_JOB_PAGES = 10;

const query = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      createdAt
      mergedAt
      headRefOid
      mergeCommit { oid }
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
                  ... on CheckRun { name status conclusion detailsUrl }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
      reviews(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          submittedAt
          state
          author { login }
          commit { oid }
        }
      }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          createdAt
          author { login }
          body
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { id isResolved }
      }
    }
  }
}`;

function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
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

function resolveRepository(repo, runCommand) {
  const nameWithOwner = repo
    || runCommand(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const [owner, name, ...rest] = nameWithOwner.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`无效仓库：${nameWithOwner}`);
  return { owner, name, nameWithOwner };
}

function fetchPullRequest({ owner, name, number }, runCommand) {
  const payload = parseJson(runCommand([
    'api', 'graphql',
    '-F', `owner=${owner}`,
    '-F', `name=${name}`,
    '-F', `number=${number}`,
    '-f', `query=${query}`,
  ]), 'GitHub GraphQL API');
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
  const pr = payload.data?.repository?.pullRequest;
  if (!pr) throw new Error(`找不到 PR #${number}`);
  return pr;
}

function restPath(path, params) {
  return `${path}?${new URLSearchParams(params).toString()}`;
}

function fetchMainRuns({ owner, name, mergeCommitOid }, runCommand) {
  const path = restPath(`repos/${owner}/${name}/actions/workflows/${WORKFLOW_FILE}/runs`, {
    event: 'push',
    branch: 'main',
    head_sha: mergeCommitOid,
    per_page: String(PAGE_SIZE),
  });
  const payload = parseJson(runCommand([
    'api', path,
    '--jq',
    '{total_count,workflow_runs:[.workflow_runs[]|{id,html_url,head_sha,run_attempt,created_at,updated_at,status,conclusion,event,head_branch}]}',
  ]), 'GitHub Actions workflow runs API');
  if (!Number.isInteger(payload.total_count) || !Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub Actions workflow runs API 响应缺少 total_count/workflow_runs');
  }
  return {
    runs: payload.workflow_runs,
    truncated: payload.total_count > PAGE_SIZE,
  };
}

function fetchRunJobs({ owner, name, runId }, runCommand) {
  const jobs = [];
  let totalCount = null;
  let page = 1;
  for (; page <= MAX_JOB_PAGES; page += 1) {
    const path = restPath(`repos/${owner}/${name}/actions/runs/${runId}/jobs`, {
      filter: 'latest',
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const payload = parseJson(runCommand([
      'api', path,
      '--jq',
      '{total_count,jobs:[.jobs[]|{id,name,html_url,status,conclusion,started_at,completed_at,steps}]}',
    ]), 'GitHub Actions jobs API');
    if (!Number.isInteger(payload.total_count) || !Array.isArray(payload.jobs)) {
      throw new Error('GitHub Actions jobs API 响应缺少 total_count/jobs');
    }
    totalCount ??= payload.total_count ?? 0;
    const items = payload.jobs ?? [];
    jobs.push(...items);
    if (items.length < PAGE_SIZE || jobs.length >= totalCount) break;
  }
  return { jobs, truncated: page > MAX_JOB_PAGES && totalCount > jobs.length };
}

function observationStatus(item) {
  if (!item) return 'missing';
  if (item.status !== 'completed') return 'pending';
  return item.conclusion ?? 'unknown';
}

function normalizeJob(job) {
  return {
    status: observationStatus(job),
    id: job?.id ?? null,
    name: job?.name ?? null,
    url: job?.html_url ?? null,
    startedAt: job?.started_at ?? null,
    completedAt: job?.completed_at ?? null,
    conclusion: job?.conclusion ?? null,
  };
}

function normalizeStep(step) {
  return {
    status: observationStatus(step),
    name: step?.name ?? null,
    startedAt: step?.started_at ?? null,
    completedAt: step?.completed_at ?? null,
    conclusion: step?.conclusion ?? null,
  };
}

function checkObservation(pr) {
  const commit = pr.commits?.nodes?.at(-1)?.commit;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const truncated = Boolean(commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage);
  const normalized = contexts.map((context) => ({
    name: context.name ?? context.context ?? context.__typename,
    status: checkState(context),
    url: context.detailsUrl ?? context.targetUrl ?? null,
  }));
  let status = 'success';
  if (!commit?.statusCheckRollup || normalized.length === 0) status = 'missing';
  else if (truncated) status = 'truncated';
  else if (normalized.some((item) => item.status === 'failing')) status = 'failure';
  else if (normalized.some((item) => item.status === 'pending')) status = 'pending';
  return { status, total: normalized.length, items: normalized, headSha: pr.headRefOid ?? commit?.oid ?? null };
}

function reviewObservation(pr) {
  const { candidates } = collectReviewCandidates(pr);
  const headSha = pr.headRefOid ?? null;
  const current = candidates
    .filter((candidate) => matchesHead(candidate.commit, headSha))
    .sort((left, right) => new Date(right.at) - new Date(left.at))[0] ?? null;
  const latest = [...candidates].sort((left, right) => new Date(right.at) - new Date(left.at))[0] ?? null;
  const truncated = Boolean(
    pr.reviews?.pageInfo?.hasPreviousPage || pr.comments?.pageInfo?.hasPreviousPage,
  );
  return {
    status: truncated ? 'truncated' : current ? 'covered' : latest ? 'stale' : 'missing',
    headSha,
    reviewedCommit: current?.commit ?? latest?.commit ?? null,
    reviewedAt: current?.at ?? latest?.at ?? null,
    provider: current?.provider ?? latest?.provider ?? null,
  };
}

function threadObservation(pr) {
  const nodes = pr.reviewThreads?.nodes ?? [];
  const unresolved = nodes.filter((thread) => !thread.isResolved);
  const truncated = Boolean(pr.reviewThreads?.pageInfo?.hasNextPage);
  return {
    status: truncated ? 'truncated' : unresolved.length > 0 ? 'unresolved' : 'clear',
    unresolvedCount: unresolved.length,
    unresolvedIds: unresolved.map((thread) => thread.id),
  };
}

function derivePhase(observation) {
  if (observation.pullRequest.state === 'OPEN') return observation.pullRequest.isDraft ? 'pr_draft' : 'pr_open';
  if (observation.pullRequest.state !== 'MERGED') return 'pr_closed_without_merge';
  if (observation.pullRequest.checks.status !== 'success') {
    return `pr_checks_${observation.pullRequest.checks.status}`;
  }
  if (observation.pullRequest.codexReview.status !== 'covered') {
    return `codex_review_${observation.pullRequest.codexReview.status}`;
  }
  if (observation.pullRequest.reviewThreads.status !== 'clear') {
    return `review_threads_${observation.pullRequest.reviewThreads.status}`;
  }
  if (observation.mainRun.association === 'missing') return 'main_run_missing';
  if (observation.mainRun.association === 'ambiguous') return 'main_run_ambiguous';
  if (observation.mainRun.status === 'pending') return 'main_run_pending';
  if (observation.deploy.status === 'missing' && observation.mainRun.status !== 'success') {
    return `main_run_${observation.mainRun.status}`;
  }
  if (observation.deploy.status !== 'success') return `deploy_${observation.deploy.status}`;
  if (observation.productionSmoke.status !== 'success') return `production_smoke_${observation.productionSmoke.status}`;
  if (observation.productionSmoke.health.status !== 'success') {
    return `workflow_health_${observation.productionSmoke.health.status}`;
  }
  if (observation.liveHealth.status === 'not_checked') return 'live_health_not_checked';
  if (observation.liveHealth.status !== 'healthy') return `live_health_${observation.liveHealth.status}`;
  if (observation.mainRun.status !== 'success') return `main_run_${observation.mainRun.status}`;
  return 'observed_complete';
}

export function buildCloseoutObservation({
  repository,
  pr,
  mainRuns = [],
  mainRunsTruncated = false,
  jobs = [],
  jobsTruncated = false,
  liveHealth,
  observedAt = new Date().toISOString(),
}) {
  const checks = checkObservation(pr);
  const codexReview = reviewObservation(pr);
  const reviewThreads = threadObservation(pr);
  const expectedMergeCommit = pr.mergeCommit?.oid ?? null;
  const matchingMainRuns = mainRuns.filter(
    (candidate) => expectedMergeCommit && candidate.head_sha === expectedMergeCommit,
  );
  const mismatchedMainRunIds = mainRuns
    .filter((candidate) => !expectedMergeCommit || candidate.head_sha !== expectedMergeCommit)
    .map((candidate) => candidate.id);
  const association = mainRunsTruncated ? 'truncated'
    : matchingMainRuns.length === 0 ? 'missing'
      : matchingMainRuns.length === 1 ? 'matched'
        : 'ambiguous';
  const run = association === 'matched' ? matchingMainRuns[0] : null;
  const deployJob = jobsTruncated ? null : jobs.find((job) => job.name === DEPLOY_JOB);
  const smokeJob = jobsTruncated ? null : jobs.find((job) => job.name === PRODUCTION_SMOKE_JOB);
  const healthStep = jobsTruncated
    ? null
    : (smokeJob?.steps ?? []).find((step) => step.name === HEALTH_STEP);
  const observation = {
    schemaVersion: 1,
    observedAt,
    repository,
    observedPhase: null,
    authorization: 'read_only_observation',
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt ?? null,
      headSha: pr.headRefOid ?? null,
      mergeCommitSha: pr.mergeCommit?.oid ?? null,
      checks,
      codexReview,
      reviewThreads,
    },
    mainRun: {
      association,
      candidateCount: matchingMainRuns.length,
      candidateIds: matchingMainRuns.map((candidate) => candidate.id),
      mismatchedCandidateIds: mismatchedMainRunIds,
      id: run?.id ?? null,
      url: run?.html_url ?? null,
      headSha: run?.head_sha ?? null,
      status: association === 'matched' ? observationStatus(run) : association,
      conclusion: run?.conclusion ?? null,
      createdAt: run?.created_at ?? null,
      updatedAt: run?.updated_at ?? null,
    },
    deploy: jobsTruncated ? { ...normalizeJob(null), status: 'truncated' } : normalizeJob(deployJob),
    productionSmoke: {
      ...(jobsTruncated ? { ...normalizeJob(null), status: 'truncated' } : normalizeJob(smokeJob)),
      health: jobsTruncated ? { ...normalizeStep(null), status: 'truncated' } : normalizeStep(healthStep),
    },
    liveHealth,
    dataQuality: {
      mainRunsTruncated,
      jobsTruncated,
      warnings: [
        ...(mainRunsTruncated ? ['main run 查询超过 100 条，无法唯一关联'] : []),
        ...(mismatchedMainRunIds.length > 0 ? [`main run 查询返回了 merge commit 不匹配的候选：${mismatchedMainRunIds.join(', ')}`] : []),
        ...(jobsTruncated ? ['job 查询超过 1000 条，deploy/smoke/health 状态不可判定'] : []),
        ...(codexReview.status === 'truncated' ? ['review/comment 查询超过 100 条，review coverage 不可判定'] : []),
        ...(checks.status === 'truncated' ? ['check 查询超过 100 条，check 状态不可判定'] : []),
        ...(reviewThreads.status === 'truncated' ? ['review thread 查询超过 100 条，thread 状态不可判定'] : []),
      ],
    },
  };
  observation.observedPhase = derivePhase(observation);
  return observation;
}

export async function observeCloseoutLiveHealth({
  url,
  allowLiveTarget = false,
  allowedOrigin = null,
  fetchImpl = fetch,
  resolveHostImpl,
} = {}) {
  if (!url) return { status: 'not_checked', url: null, httpStatus: null, observedAt: null, error: null };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 'not_checked', url: null, httpStatus: null, observedAt: null, error: 'entry_url_invalid' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password
    || parsed.pathname !== '/healthz'
    || parsed.search || parsed.hash) {
    return { status: 'not_checked', url, httpStatus: null, observedAt: null, error: 'health_url_contract_invalid' };
  }

  const canonicalTarget = parsed.toString() === DEFAULT_HEALTH_URL;
  const effectiveAllowedOrigin = canonicalTarget ? DEFAULT_HEALTH_ORIGIN : allowedOrigin;
  if (canonicalTarget || allowLiveTarget) {
    const validation = await validatePublicHttpTarget({
      entryUrl: parsed.origin,
      allowedOrigin: effectiveAllowedOrigin,
      ...(resolveHostImpl ? { resolveHostImpl } : {}),
    });
    if (!validation.ok) {
      return {
        status: 'not_checked',
        url: parsed.toString(),
        httpStatus: null,
        observedAt: null,
        error: validation.reason,
      };
    }
  }
  const result = await observeHealthContract({
    entryUrl: parsed.origin,
    allowLiveTarget: canonicalTarget || allowLiveTarget,
    allowedOrigin: effectiveAllowedOrigin,
    fetchImpl,
    ...(resolveHostImpl ? { resolveHostImpl } : {}),
  });
  return {
    status: result.status,
    url: result.url,
    httpStatus: result.httpStatus,
    observedAt: result.observedAt,
    error: result.reason,
  };
}

export async function collectCloseoutObservation(
  options,
  runCommand = runGh,
  fetchImpl = fetch,
) {
  const repository = resolveRepository(options.repo, runCommand);
  const pr = fetchPullRequest({ ...repository, number: options.number }, runCommand);
  let mainRunResult = { runs: [], truncated: false };
  let jobsResult = { jobs: [], truncated: false };
  if (pr.state === 'MERGED' && pr.mergeCommit?.oid) {
    mainRunResult = fetchMainRuns({ ...repository, mergeCommitOid: pr.mergeCommit.oid }, runCommand);
    if (!mainRunResult.truncated && mainRunResult.runs.length === 1) {
      jobsResult = fetchRunJobs({ ...repository, runId: mainRunResult.runs[0].id }, runCommand);
    }
  }
  const liveHealth = await observeCloseoutLiveHealth({
    url: options.healthUrl,
    allowLiveTarget: options.allowLiveTarget,
    allowedOrigin: options.allowedHealthOrigin,
    fetchImpl,
  });
  return buildCloseoutObservation({
    repository: repository.nameWithOwner,
    pr,
    mainRuns: mainRunResult.runs,
    mainRunsTruncated: mainRunResult.truncated,
    jobs: jobsResult.jobs,
    jobsTruncated: jobsResult.truncated,
    liveHealth,
  });
}

function statusLabel(value) {
  const labels = {
    success: '成功', pending: '进行中', failure: '失败', cancelled: '已取消', skipped: '已跳过',
    missing: '缺失', truncated: '查询不完整', covered: '覆盖当前 head', stale: '已过期', clear: '无未解决项',
    unresolved: '有未解决项', healthy: '健康', unhealthy: '不健康', unreachable: '不可达', not_checked: '未检查',
  };
  return labels[value] ?? value;
}

export function formatCloseoutObservation(observation) {
  const lines = [
    `PR #${observation.pullRequest.number} closeout 只读观察`,
    `阶段：${observation.observedPhase}`,
    `PR：${observation.pullRequest.state}${observation.pullRequest.isDraft ? ' / Draft' : ''}`,
    `Head：${observation.pullRequest.headSha?.slice(0, 10) ?? 'unknown'}`,
    `Checks：${statusLabel(observation.pullRequest.checks.status)}（${observation.pullRequest.checks.total}）`,
    `Codex Review：${statusLabel(observation.pullRequest.codexReview.status)}`,
    `Review threads：${statusLabel(observation.pullRequest.reviewThreads.status)}（${observation.pullRequest.reviewThreads.unresolvedCount}）`,
    `Main run：${statusLabel(observation.mainRun.status)}${observation.mainRun.id ? ` (#${observation.mainRun.id})` : ''}`,
    `Deploy：${statusLabel(observation.deploy.status)}`,
    `Production smoke：${statusLabel(observation.productionSmoke.status)}`,
    `Workflow health：${statusLabel(observation.productionSmoke.health.status)}`,
    `Live health：${statusLabel(observation.liveHealth.status)}${observation.liveHealth.httpStatus ? ` (HTTP ${observation.liveHealth.httpStatus})` : ''}`,
  ];
  if (observation.dataQuality.warnings.length > 0) {
    lines.push('数据质量提示：', ...observation.dataQuality.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    number: null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
    healthUrl: DEFAULT_HEALTH_URL,
    allowLiveTarget: false,
    allowedHealthOrigin: null,
    json: false,
  };
  const requireValue = (flag, index) => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--repo') {
      options.repo = requireValue(value, index);
      index += 1;
    } else if (value === '--health-url') {
      options.healthUrl = requireValue(value, index);
      index += 1;
    }
    else if (value === '--allow-live-target') options.allowLiveTarget = true;
    else if (value === '--allowed-health-origin') {
      options.allowedHealthOrigin = requireValue(value, index);
      index += 1;
    }
    else if (value === '--skip-live-health') options.healthUrl = null;
    else if (value === '--pr') {
      options.number = Number(requireValue(value, index));
      index += 1;
    }
    else if (/^\d+$/.test(value)) options.number = Number(value);
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (!options.help && (!Number.isInteger(options.number) || options.number <= 0)) {
    throw new Error('用法：npm run observe:pr-closeout -- <PR号> [--json] [--repo owner/name] [--health-url URL --allow-live-target --allowed-health-origin ORIGIN|--skip-live-health]');
  }
  if (options.repo != null && !/^[-\w.]+\/[-\w.]+$/.test(options.repo)) throw new Error(`无效仓库：${options.repo}`);
  if (options.healthUrl != null) {
    try {
      const parsed = new URL(options.healthUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password
        || parsed.pathname !== '/healthz'
        || parsed.search || parsed.hash) throw new Error();
      if (parsed.toString() !== DEFAULT_HEALTH_URL) {
        if (!options.allowLiveTarget || !options.allowedHealthOrigin) {
          throw new Error('custom_target_not_authorized');
        }
        const allowed = new URL(options.allowedHealthOrigin);
        if (!['http:', 'https:'].includes(allowed.protocol)
          || allowed.username || allowed.password
          || (allowed.pathname && allowed.pathname !== '/')
          || allowed.search || allowed.hash
          || allowed.origin !== parsed.origin) throw new Error('allowed_origin_invalid');
      }
    } catch {
      throw new Error(`无效 health URL：${options.healthUrl}`);
    }
  }
  return options;
}

function usage() {
  return '用法：npm run observe:pr-closeout -- <PR号> [--json] [--repo owner/name] [--health-url URL --allow-live-target --allowed-health-origin ORIGIN|--skip-live-health]';
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const observation = await collectCloseoutObservation(options);
    console.log(options.json ? JSON.stringify(observation, null, 2) : formatCloseoutObservation(observation));
  } catch (error) {
    console.error(`PR_CLOSEOUT_OBSERVER_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
