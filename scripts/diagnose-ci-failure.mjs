import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_FILE = 'ci-cd.yml';
const PAGE_SIZE = 100;
const MAX_JOB_PAGES = 10;
const DEFAULT_MAX_LOG_CHARS = 20_000;
const FAILURE_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'action_required', 'startup_failure', 'cancelled',
]);

const REPRODUCTIONS = new Map([
  ['Run AgentBean Next readiness checks', {
    command: 'npm run check:agentbean-next-readiness',
    scope: 'local',
  }],
  ['Enforce Team terminology', {
    command: 'npm run test:team-terminology && npm run check:team-terminology',
    scope: 'local',
  }],
  ['Run package tests and retained phase boundaries once', {
    command: 'npm run test:ci',
    scope: 'local',
  }],
  ['Build AgentBean Next packages once', {
    command: 'npm run build:packages',
    scope: 'local',
  }],
  ['Verify changelog generated file is fresh', {
    command: 'node_modules/.bin/tsx apps/web-next/scripts/gen-changelog.ts && git diff --exit-code apps/web-next/lib/releases.generated.ts',
    scope: 'local',
  }],
  ['Run AgentBean Next daemon install smoke', {
    command: 'npm run smoke:agentbean-next-daemon-install -- --skip-build',
    scope: 'local',
  }],
  ['Run AgentBean Next preview smoke', {
    command: 'npm run preview:agentbean-next',
    scope: 'local',
  }],
  ['Run AgentBean Next browser smoke', {
    command: 'npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 60000',
    scope: 'local_with_browser',
    note: '需要 Chrome；CI 使用 CHROME_BIN=/usr/bin/google-chrome，并会重试一次。',
  }],
  ['Run AgentBean Next production readiness checks', {
    command: 'npm run check:agentbean-next-readiness -- --production',
    scope: 'local_with_production_env',
    note: '只验证 readiness；不能证明 Railway 部署成功。',
  }],
  ['Run Railway AgentBean Next preflight', {
    command: 'npm run check:agentbean-next-railway-preflight',
    scope: 'read_only_external',
    note: '需要 Railway 凭据和远端读取权限。',
  }],
  ['Verify Railway AgentBean Next preflight', {
    command: 'npm run check:agentbean-next-railway-preflight',
    scope: 'read_only_external',
    note: '需要 Railway 凭据和远端读取权限。',
  }],
  ['Run AgentBean Next strict cutover audit', {
    command: 'npm run audit:agentbean-next-cutover',
    scope: 'read_only_external',
    note: '需要生产 URL 和相关远端读取权限。',
  }],
  ['Wait for production server healthcheck', {
    command: 'curl -fsS "$AGENTBEAN_NEXT_ENTRY_URL/healthz"',
    scope: 'read_only_external',
    note: '必须指向被诊断的真实环境，不能用 localhost 结果替代生产证据。',
  }],
  ['Run AgentBean Next public entry smoke', {
    command: 'npm run smoke:agentbean-next-entry',
    scope: 'read_only_external',
    note: '需要设置真实 AGENTBEAN_NEXT_ENTRY_URL。',
  }],
  ['Run AgentBean Next business smoke', {
    command: 'npm run smoke:agentbean-next-business',
    scope: 'read_only_external',
    note: '需要真实 URL、会话和 PI secret；不会自动填充 secrets。',
  }],
]);

const NON_REPRODUCIBLE_STEPS = new Map([
  ['Deploy Railway backend', '这是生产部署写操作；只读取失败日志，不生成自动复现命令。'],
  ['Sync Railway AgentBean Next runtime env', '这是 Railway 环境变量写操作；禁止由诊断器复现。'],
  ['Publish packages', '这是 npm 发布写操作；禁止由诊断器复现。'],
  ['Promote canonical daemon npm latest', '这是 npm dist-tag 写操作；禁止由诊断器复现。'],
]);

const STRONG_INFRASTRUCTURE_RE = /(?:no space left on device|runner has received a shutdown signal|lost communication with the server|socket hang up|ECONNRESET|ECONNREFUSED|HTTP 5\d\d|service unavailable)/i;
const DETERMINISTIC_FAILURE_RE = /(?:\bFAIL\b|AssertionError|expected .+ (?:to|but)|TypeError|SyntaxError|TS\d{4}|not assignable|contract failure)/i;
const EVIDENCE_RE = /(?:\bFAIL\b|\bfailed\b|\bERROR\b|Error:|AssertionError|TypeError|SyntaxError|fatal:|npm ERR!|Timed out|timeout|not found|denied|unauthorized|ECONN|ENOSPC|ENOMEM|exit code|exited with code|::error::)/i;

function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
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

function fetchRecentFailedRun({ owner, name }, runCommand) {
  const path = `repos/${owner}/${name}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&per_page=${PAGE_SIZE}`;
  const payload = parseJson(runCommand([
    'api', path,
    '--jq',
    '{workflow_runs:[.workflow_runs[]|{id,conclusion,created_at}]}',
  ]), 'GitHub Actions workflow runs API');
  if (!Array.isArray(payload.workflow_runs)) throw new Error('workflow runs 响应缺少 workflow_runs');
  const run = payload.workflow_runs.find(
    (candidate) => FAILURE_CONCLUSIONS.has(candidate.conclusion) && candidate.conclusion !== 'cancelled',
  ) ?? payload.workflow_runs.find((candidate) => candidate.conclusion === 'cancelled');
  if (!run) throw new Error('最近 100 个已完成 CI/CD run 中没有失败、超时或取消的 run');
  return run.id;
}

function fetchRun({ owner, name, runId }, runCommand) {
  const payload = parseJson(runCommand([
    'api', `repos/${owner}/${name}/actions/runs/${runId}`,
    '--jq',
    '{id,name,path,html_url,event,status,conclusion,head_sha,head_branch,display_title,created_at,updated_at,run_attempt}',
  ]), 'GitHub Actions workflow run API');
  if (!Number.isInteger(payload.id) || !payload.status) throw new Error(`run #${runId} 响应缺少 id/status`);
  return payload;
}

function fetchJobs({ owner, name, runId }, runCommand) {
  const jobs = [];
  let totalCount = null;
  let page = 1;
  for (; page <= MAX_JOB_PAGES; page += 1) {
    const path = `repos/${owner}/${name}/actions/runs/${runId}/jobs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = parseJson(runCommand([
      'api', path,
      '--jq',
      '{total_count,jobs:[.jobs[]|{id,name,html_url,status,conclusion,started_at,completed_at,steps}]}',
    ]), 'GitHub Actions jobs API');
    if (!Number.isInteger(payload.total_count) || !Array.isArray(payload.jobs)) {
      throw new Error('jobs 响应缺少 total_count/jobs');
    }
    totalCount ??= payload.total_count;
    jobs.push(...payload.jobs);
    if (payload.jobs.length < PAGE_SIZE || jobs.length >= totalCount) break;
  }
  return { jobs, truncated: page > MAX_JOB_PAGES && totalCount > jobs.length };
}

export function redactSensitive(text) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:ghp|github_pat|npm)_[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|password|api[_-]?key|access[_-]?token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:token|secret|password|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[=:]\s*)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
}

function normalizeLog(raw, maxChars) {
  const withoutAnsi = raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\^\[\[[0-9;]*m/g, '');
  const redacted = redactSensitive(withoutAnsi);
  const evidence = extractEvidence(redacted);
  const signals = collectFlakySignals(redacted);
  if (redacted.length <= maxChars) {
    return { text: redacted, evidence, signals, truncated: false, originalChars: redacted.length };
  }
  const headChars = Math.floor(maxChars / 2);
  const tailChars = maxChars - headChars;
  return {
    text: `${redacted.slice(0, headChars)}\n...[LOG_TRUNCATED]...\n${redacted.slice(-tailChars)}`,
    evidence,
    signals,
    truncated: true,
    originalChars: redacted.length,
  };
}

export function extractEvidence(log, limit = 4) {
  const safeLog = redactSensitive(log);
  const seen = new Set();
  const candidates = [];
  for (const [index, rawLine] of safeLog.split(/\r?\n/).entries()) {
    const parts = rawLine.split('\t');
    const payload = parts.length >= 3 ? parts.slice(2).join('\t') : rawLine;
    const line = payload
      .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s+/, '')
      .trim()
      .slice(0, 600);
    if (!line || !EVIDENCE_RE.test(line) || seen.has(line)) continue;
    if (/^>\s/.test(line)) continue;
    if (/^(?:echo|printf)\b.*(?:::error::|error|fail)/i.test(line)) continue;
    seen.add(line);
    let score = 0;
    if (/^FAIL\b/i.test(line)) score = 100;
    else if (/AssertionError|TypeError|SyntaxError|TS\d{4}|not assignable/i.test(line)) score = 90;
    else if (/retrying once|retry attempt/i.test(line)) score = 85;
    else if (/^##\[error\]|^::error::/i.test(line)) score = 80;
    else if (/\bfailed\b/i.test(line)) score = 70;
    else if (/Error:|fatal:|npm ERR!/i.test(line)) score = 60;
    else if (/timed out|timeout/i.test(line)) score = 50;
    candidates.push({ line, score, index });
  }
  return candidates
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((candidate) => candidate.line);
}

function failedSteps(job) {
  return (job.steps ?? []).filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion));
}

function collectFlakySignals(log) {
  return {
    retryMarker: /retrying once|retry attempt|attempt \d+\/\d+/i.test(log),
    failureMarkers: (log.match(/\bFAIL\b|AssertionError|::error::/gi) ?? []).length,
    infrastructure: STRONG_INFRASTRUCTURE_RE.test(log),
    deterministic: DETERMINISTIC_FAILURE_RE.test(log),
    timeout: /timed out|timeout/i.test(log),
  };
}

function classifyFailure(job, steps, log) {
  const stepNames = steps.map((step) => step.name).join(' ');
  const joined = `${job.name} ${stepNames} ${log}`;
  if (job.conclusion === 'cancelled') return { category: 'cancelled', confidence: 'high' };
  if (/AgentBean Next production smoke/.test(job.name)) {
    if (/healthcheck/.test(stepNames)) return { category: 'production_health', confidence: 'high' };
    return { category: 'production_smoke', confidence: 'high' };
  }
  if (/browser smoke/i.test(joined)) return { category: 'browser_smoke', confidence: 'high' };
  if (/Deploy production/.test(job.name)) return { category: 'deployment', confidence: 'high' };
  if (/Publish|npm latest|dist-tag/i.test(joined)) return { category: 'publishing', confidence: 'high' };
  if (/Railway Next|readiness|changelog|target URL|environment|config/i.test(joined)) {
    return { category: 'configuration', confidence: 'medium' };
  }
  if (/Build AgentBean Next|\btsc\b|TS\d{4}|not assignable/i.test(joined)) {
    return { category: 'build', confidence: 'high' };
  }
  if (/test|preview smoke|daemon install smoke|vitest|AssertionError|\bFAIL\b/i.test(joined)) {
    return { category: 'test', confidence: 'medium' };
  }
  if (STRONG_INFRASTRUCTURE_RE.test(log)) return { category: 'infrastructure', confidence: 'medium' };
  if (job.conclusion === 'timed_out' || /timed out|timeout/i.test(log)) {
    return { category: 'timeout', confidence: 'medium' };
  }
  return { category: 'unknown', confidence: 'low' };
}

function assessFlaky(job, log, { truncated = false, signals = null } = {}) {
  if (job.conclusion === 'cancelled') {
    return { status: 'insufficient_evidence', reasons: ['run/job 被取消，没有稳定性证据'] };
  }
  const observed = signals ?? collectFlakySignals(log);
  if (truncated) {
    const observedReasons = [
      ...(observed.retryMarker && observed.failureMarkers >= 2
        ? ['完整脱敏日志观察到 retry 后重复失败'] : []),
      ...(observed.infrastructure ? ['完整脱敏日志观察到 infrastructure 瞬态特征'] : []),
    ];
    return {
      status: 'insufficient_evidence',
      reasons: [
        '日志已截断，不能排除缺失的稳定性证据',
        ...observedReasons,
      ],
    };
  }
  if (observed.retryMarker && observed.failureMarkers >= 2) {
    return { status: 'unlikely', reasons: ['完整脱敏日志显示同一次 run 内重试后仍出现失败证据'] };
  }
  if (observed.infrastructure) {
    return { status: 'possible', reasons: ['日志包含 runner、网络或外部服务瞬态特征；需要跨 run 复核'] };
  }
  if (observed.deterministic) {
    return { status: 'unlikely', reasons: ['日志包含确定性断言、类型或契约失败'] };
  }
  if (observed.timeout) {
    return { status: 'possible', reasons: ['仅有 timeout 信号；需要同 head 重跑或历史 run 才能确认'] };
  }
  return { status: 'insufficient_evidence', reasons: ['单个 run 不足以判断 flaky'] };
}

function reproductionFor(steps) {
  for (const step of steps) {
    const safe = REPRODUCTIONS.get(step.name);
    if (safe) return { available: true, step: step.name, ...safe };
    const reason = NON_REPRODUCIBLE_STEPS.get(step.name);
    if (reason) return { available: false, step: step.name, command: null, scope: 'external_write', note: reason };
  }
  return {
    available: false,
    step: steps[0]?.name ?? null,
    command: null,
    scope: 'unknown',
    note: '没有经过仓库验证的安全最小复现命令。',
  };
}

function likelyCause(category, evidence, steps) {
  const first = evidence[0];
  if (first) return first;
  if (category === 'cancelled') return `run 在 ${steps[0]?.name ?? '未知步骤'} 被取消`;
  return `失败位于 ${steps[0]?.name ?? '未知步骤'}；日志证据不足，不能继续推断`;
}

export function analyzeCiFailure({ repository, run, jobs, jobsTruncated = false, logsByJobId = new Map(), logWarnings = [] }) {
  const failedOrTimedOut = jobs.filter(
    (job) => FAILURE_CONCLUSIONS.has(job.conclusion) && job.conclusion !== 'cancelled',
  );
  const cancelledWithStep = jobs.filter(
    (job) => job.conclusion === 'cancelled' && failedSteps(job).length > 0,
  );
  const passiveCancelled = jobs.filter(
    (job) => job.conclusion === 'cancelled' && failedSteps(job).length === 0,
  );
  const candidates = [...failedOrTimedOut, ...cancelledWithStep];
  if (candidates.length === 0 && run.conclusion === 'cancelled' && passiveCancelled.length > 0) {
    candidates.push(passiveCancelled[0]);
  }
  const failures = candidates.map((job) => {
    const steps = failedSteps(job);
    const logEntry = logsByJobId.get(job.id) ?? { text: '', truncated: false, originalChars: 0, unavailable: true };
    const evidence = logEntry.evidence ?? extractEvidence(logEntry.text);
    const classification = classifyFailure(job, steps, logEntry.text);
    return {
      job: {
        id: job.id,
        name: job.name,
        url: job.html_url ?? null,
        conclusion: job.conclusion,
        startedAt: job.started_at ?? null,
        completedAt: job.completed_at ?? null,
      },
      failedSteps: steps.map((step) => ({
        name: step.name,
        number: step.number ?? null,
        conclusion: step.conclusion,
      })),
      ...classification,
      mostLikelyCause: likelyCause(classification.category, evidence, steps),
      evidence,
      reproduction: reproductionFor(steps),
      flakyAssessment: assessFlaky(job, logEntry.text, {
        truncated: Boolean(logEntry.truncated),
        signals: logEntry.signals ?? null,
      }),
      log: {
        available: !logEntry.unavailable,
        truncated: Boolean(logEntry.truncated),
        originalChars: logEntry.originalChars ?? 0,
      },
    };
  });
  const categories = [...new Set(failures.map((failure) => failure.category))];
  const logsTruncatedJobIds = candidates
    .filter((job) => logsByJobId.get(job.id)?.truncated)
    .map((job) => job.id);
  const warnings = [
    ...logWarnings,
    ...(jobsTruncated ? ['job 查询超过 1000 条，诊断不完整'] : []),
    ...logsTruncatedJobIds.map((jobId) => `job #${jobId} 日志已截断；证据和稳定性信号从完整脱敏日志提取，分类文本仅保留首尾片段`),
    ...(run.conclusion && !['success', 'skipped', 'neutral'].includes(run.conclusion) && failures.length === 0
      ? ['run 非成功，但未观察到失败/取消 job'] : []),
  ];
  return {
    schemaVersion: 1,
    diagnosedAt: new Date().toISOString(),
    repository,
    authorization: 'read_only_diagnosis',
    run: {
      id: run.id,
      name: run.name,
      path: run.path ?? null,
      url: run.html_url,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      title: run.display_title,
      attempt: run.run_attempt,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    },
    summary: {
      status: run.status !== 'completed' ? 'run_not_completed'
        : failures.length === 0 ? 'no_failed_job_observed'
          : 'diagnosed',
      failureCount: failures.length,
      downstreamCancelledCount: Math.max(0, passiveCancelled.length - (candidates.includes(passiveCancelled[0]) ? 1 : 0)),
      downstreamCancelledJobs: passiveCancelled
        .filter((job) => !candidates.includes(job))
        .map((job) => job.name),
      primaryCategory: categories.length === 1 ? categories[0] : categories.length > 1 ? 'multiple' : null,
      mostLikelyCause: failures[0]?.mostLikelyCause ?? null,
    },
    failures,
    dataQuality: {
      jobsTruncated,
      logsTruncatedJobIds,
      warnings,
    },
  };
}

export function collectCiFailureDiagnosis(options, runCommand = runGh) {
  const repository = resolveRepository(options.repo, runCommand);
  const runId = options.runId ?? fetchRecentFailedRun(repository, runCommand);
  const run = fetchRun({ ...repository, runId }, runCommand);
  const jobsResult = fetchJobs({ ...repository, runId }, runCommand);
  const logsByJobId = new Map();
  const logWarnings = [];
  if (!jobsResult.truncated) {
    for (const job of jobsResult.jobs.filter((candidate) => FAILURE_CONCLUSIONS.has(candidate.conclusion))) {
      if (job.conclusion === 'cancelled') continue;
      try {
        const raw = runCommand([
          'run', 'view', String(runId),
          '--repo', repository.nameWithOwner,
          '--job', String(job.id),
          '--log',
        ]);
        logsByJobId.set(job.id, normalizeLog(raw, options.maxLogChars));
      } catch (error) {
        logsByJobId.set(job.id, { text: '', truncated: false, originalChars: 0, unavailable: true });
        logWarnings.push(`job #${job.id} 日志不可用：${error.message}`);
      }
    }
  }
  return analyzeCiFailure({
    repository: repository.nameWithOwner,
    run,
    jobs: jobsResult.jobs,
    jobsTruncated: jobsResult.truncated,
    logsByJobId,
    logWarnings,
  });
}

function formatReproduction(reproduction) {
  if (!reproduction.available) return reproduction.note;
  return `${reproduction.command}${reproduction.note ? `（${reproduction.note}）` : ''}`;
}

export function formatCiFailureDiagnosis(result) {
  const lines = [
    `CI run #${result.run.id} 只读诊断`,
    `结论：${result.run.conclusion ?? result.run.status}`,
    `分类：${result.summary.primaryCategory ?? '无'}`,
    `失败 job：${result.summary.failureCount}`,
  ];
  if (result.summary.downstreamCancelledCount > 0) {
    lines.push(`下游连带取消 job：${result.summary.downstreamCancelledCount}`);
  }
  for (const failure of result.failures) {
    lines.push(
      `\n[${failure.category}/${failure.confidence}] ${failure.job.name}`,
      `失败 step：${failure.failedSteps.map((step) => step.name).join('、') || '未知'}`,
      `最可能原因：${failure.mostLikelyCause}`,
      `Flaky：${failure.flakyAssessment.status}（${failure.flakyAssessment.reasons.join('；')}）`,
      `最小复现：${formatReproduction(failure.reproduction)}`,
    );
    if (failure.evidence.length > 0) lines.push('证据：', ...failure.evidence.map((line) => `- ${line}`));
  }
  if (result.dataQuality.warnings.length > 0) {
    lines.push('\n数据质量提示：', ...result.dataQuality.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    runId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    repo: process.env.GITHUB_REPOSITORY ?? null,
    maxLogChars: DEFAULT_MAX_LOG_CHARS,
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
    } else if (value === '--run') {
      options.runId = Number(requireValue(value, index));
      index += 1;
    } else if (value === '--max-log-chars') {
      options.maxLogChars = Number(requireValue(value, index));
      index += 1;
    } else if (/^\d+$/.test(value)) options.runId = Number(value);
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (options.runId != null && (!Number.isSafeInteger(options.runId) || options.runId <= 0)) {
    throw new Error('--run 必须是正整数');
  }
  if (!Number.isInteger(options.maxLogChars) || options.maxLogChars < 1000 || options.maxLogChars > 200_000) {
    throw new Error('--max-log-chars 必须是 1000 到 200000 之间的整数');
  }
  if (options.repo != null && !/^[-\w.]+\/[-\w.]+$/.test(options.repo)) throw new Error(`无效仓库：${options.repo}`);
  return options;
}

function usage() {
  return '用法：npm run diagnose:ci-failure -- [run-id|--run ID] [--json] [--repo owner/name] [--max-log-chars 20000]';
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = collectCiFailureDiagnosis(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatCiFailureDiagnosis(result));
  } catch (error) {
    console.error(`CI_FAILURE_DIAGNOSIS_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
