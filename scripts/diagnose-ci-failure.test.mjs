import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeCiFailure,
  collectCiFailureDiagnosis,
  extractEvidence,
  formatCiFailureDiagnosis,
  parseArgs,
  redactSensitive,
} from './diagnose-ci-failure.mjs';

function run(overrides = {}) {
  return {
    id: 32565939196,
    name: 'CI/CD',
    path: '.github/workflows/ci-cd.yml',
    html_url: 'https://github.com/xiaojichao/agentbean/actions/runs/32565939196',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    head_branch: 'main',
    display_title: 'Example',
    run_attempt: 1,
    created_at: '2026-08-22T09:48:41Z',
    updated_at: '2026-08-22T09:59:58Z',
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 97015537679,
    name: 'AgentBean Next production smoke',
    html_url: 'https://github.com/xiaojichao/agentbean/actions/runs/32565939196/job/97015537679',
    status: 'completed',
    conclusion: 'failure',
    steps: [{
      name: 'Run AgentBean Next public entry smoke',
      number: 8,
      status: 'completed',
      conclusion: 'failure',
    }],
    ...overrides,
  };
}

test('classifies a production contract failure and provides a safe read-only reproduction', () => {
  const logs = new Map([[97015537679, {
    text: [
      'Server healthy after 1 attempt(s)',
      'AgentBean Next entry smoke failed (1/4).',
      'FAIL entry-root-html-agentbean: root page must serve the landing-first product entry',
    ].join('\n'),
    truncated: false,
    originalChars: 180,
  }]]);
  const result = analyzeCiFailure({
    repository: 'xiaojichao/agentbean',
    run: run(),
    jobs: [job()],
    logsByJobId: logs,
  });
  assert.equal(result.authorization, 'read_only_diagnosis');
  assert.equal(result.summary.primaryCategory, 'production_smoke');
  assert.equal(result.failures[0].flakyAssessment.status, 'unlikely');
  assert.equal(result.failures[0].reproduction.command, 'npm run smoke:agentbean-next-entry');
  assert.match(result.failures[0].mostLikelyCause, /FAIL entry-root/);
});

test('does not call a browser timeout flaky when the retry repeats the failure', () => {
  const browserJob = job({
    name: 'Validate AgentBean Next',
    steps: [{ name: 'Run AgentBean Next browser smoke', conclusion: 'failure', number: 12 }],
  });
  const logs = new Map([[browserJob.id, {
    text: [
      'FAIL webui-smoke-runtime-error: Timed out waiting for review card',
      'Browser smoke failed once; retrying once for transient WebUI races.',
      'FAIL webui-smoke-runtime-error: Timed out waiting for review card',
    ].join('\n'),
    truncated: false,
    originalChars: 220,
  }]]);
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run(), jobs: [browserJob], logsByJobId: logs });
  assert.equal(result.summary.primaryCategory, 'browser_smoke');
  assert.equal(result.failures[0].flakyAssessment.status, 'unlikely');
});

test('treats a failed explicit browser retry step as repeated evidence and keeps the local reproduction', () => {
  const browserJob = job({
    name: 'Validate AgentBean Next',
    steps: [{ name: 'Run AgentBean Next browser smoke retry', conclusion: 'failure', number: 13 }],
  });
  const logs = new Map([[browserJob.id, {
    text: 'FAIL webui-smoke-runtime-error: Timed out waiting for member detail',
    truncated: false,
    originalChars: 75,
  }]]);
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run(), jobs: [browserJob], logsByJobId: logs });
  assert.equal(result.summary.primaryCategory, 'browser_smoke');
  assert.equal(result.failures[0].flakyAssessment.status, 'unlikely');
  assert.equal(result.failures[0].reproduction.command, 'npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 60000');
});

test('marks strong runner or network signatures as possible flaky infrastructure', () => {
  const infraJob = job({ name: 'Validate AgentBean Next', steps: [{ name: 'Install AgentBean Next workspace dependencies', conclusion: 'failure' }] });
  const logs = new Map([[infraJob.id, {
    text: 'Error: lost communication with the server\nError: ECONNRESET',
    truncated: false,
    originalChars: 70,
  }]]);
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run(), jobs: [infraJob], logsByJobId: logs });
  assert.equal(result.summary.primaryCategory, 'infrastructure');
  assert.equal(result.failures[0].flakyAssessment.status, 'possible');
});

test('keeps cancelled jobs separate and does not invent a reproduction', () => {
  const cancelled = job({
    name: 'Validate AgentBean Next',
    conclusion: 'cancelled',
    steps: [{ name: 'Detect CI change surfaces', conclusion: 'cancelled' }],
  });
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run({ conclusion: 'cancelled' }), jobs: [cancelled] });
  assert.equal(result.summary.primaryCategory, 'cancelled');
  assert.equal(result.failures[0].flakyAssessment.status, 'insufficient_evidence');
  assert.equal(result.failures[0].reproduction.available, false);
});

test('collapses downstream jobs cancelled without an executed cancelled step', () => {
  const root = job({
    name: 'Validate AgentBean Next',
    conclusion: 'cancelled',
    steps: [{ name: 'Detect CI change surfaces', conclusion: 'cancelled' }],
  });
  const downstream = job({
    id: 2,
    name: 'Deploy production',
    conclusion: 'cancelled',
    steps: [],
  });
  const result = analyzeCiFailure({
    repository: 'xiaojichao/agentbean',
    run: run({ conclusion: 'cancelled' }),
    jobs: [root, downstream],
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.summary.downstreamCancelledCount, 1);
  assert.deepEqual(result.summary.downstreamCancelledJobs, ['Deploy production']);
});

test('never generates an automatic reproduction for production writes', () => {
  const deploy = job({
    name: 'Deploy production',
    steps: [{ name: 'Deploy Railway backend', conclusion: 'failure' }],
  });
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run(), jobs: [deploy] });
  assert.equal(result.failures[0].category, 'deployment');
  assert.equal(result.failures[0].reproduction.scope, 'external_write');
  assert.equal(result.failures[0].reproduction.command, null);
});

test('fails closed when jobs are truncated or logs are unavailable', () => {
  const result = analyzeCiFailure({
    repository: 'xiaojichao/agentbean',
    run: run(),
    jobs: [job()],
    jobsTruncated: true,
    logWarnings: ['job log unavailable'],
  });
  assert.equal(result.dataQuality.jobsTruncated, true);
  assert.match(result.dataQuality.warnings.join('\n'), /诊断不完整/);
  assert.equal(result.failures[0].log.available, false);
});

test('extracts compact evidence without repeating identical lines', () => {
  assert.deepEqual(extractEvidence('ok\nFAIL one\nFAIL one\nError: two'), ['FAIL one', 'Error: two']);
  assert.deepEqual(
    extractEvidence('job\tUNKNOWN STEP\t2026-08-22T09:00:00Z echo "::error::source only"\njob\tUNKNOWN STEP\t2026-08-22T09:00:01Z > node smoke.mjs --timeout-ms 1000\njob\tUNKNOWN STEP\t2026-08-22T09:00:02Z FAIL actual contract'),
    ['FAIL actual contract'],
  );
});

test('redacts common credentials before evidence can be emitted', () => {
  const raw = 'Error: Authorization: Bearer abc.def.ghi api_key=super-secret AKIA1234567890ABCDEF';
  const safe = redactSensitive(raw);
  assert.doesNotMatch(safe, /abc\.def\.ghi|super-secret|AKIA1234567890ABCDEF/);
  assert.match(safe, /REDACTED/);
});

test('collector keeps evidence from the full log and warns when the retained log is truncated', () => {
  const runCommand = (args) => {
    if (args[0] === 'api' && args[1].includes('/jobs')) {
      return JSON.stringify({ total_count: 1, jobs: [job({ id: 7 })] });
    }
    if (args[0] === 'api') return JSON.stringify(run({ id: 42 }));
    return `FAIL root cause at head\n${'x'.repeat(3000)}\nend`;
  };
  const result = collectCiFailureDiagnosis({
    runId: 42,
    repo: 'xiaojichao/agentbean',
    maxLogChars: 1000,
  }, runCommand);
  assert.match(result.failures[0].mostLikelyCause, /root cause at head/);
  assert.equal(result.failures[0].flakyAssessment.status, 'insufficient_evidence');
  assert.deepEqual(result.dataQuality.logsTruncatedJobIds, [7]);
  assert.match(result.dataQuality.warnings.join('\n'), /日志已截断/);
});

test('truncated logs never produce a strong flaky verdict even when full-log signals exist', () => {
  const logs = new Map([[97015537679, {
    text: 'FAIL retained',
    evidence: ['FAIL first', 'FAIL retry'],
    signals: {
      retryMarker: true,
      failureMarkers: 2,
      infrastructure: false,
      deterministic: true,
      timeout: true,
    },
    truncated: true,
    originalChars: 50_000,
  }]]);
  const result = analyzeCiFailure({
    repository: 'xiaojichao/agentbean',
    run: run(),
    jobs: [job()],
    logsByJobId: logs,
  });
  assert.equal(result.failures[0].flakyAssessment.status, 'insufficient_evidence');
  assert.match(result.failures[0].flakyAssessment.reasons.join('\n'), /retry 后重复失败/);
});

test('collector uses only read-only API and run-view commands', () => {
  const calls = [];
  const runCommand = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/actions/runs/42/jobs')) {
      return JSON.stringify({ total_count: 1, jobs: [job({ id: 7 })] });
    }
    if (args[0] === 'api') return JSON.stringify(run({ id: 42 }));
    if (args[0] === 'run' && args[1] === 'view') return 'FAIL deterministic contract failure';
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
  const result = collectCiFailureDiagnosis({
    runId: 42,
    repo: 'xiaojichao/agentbean',
    maxLogChars: 20_000,
  }, runCommand);
  assert.equal(result.summary.status, 'diagnosed');
  assert.ok(calls.every((args) => args[0] === 'api' || (args[0] === 'run' && args[1] === 'view')));
  assert.ok(calls.every((args) => !['rerun', 'cancel', 'delete', 'watch'].includes(args[1])));
});

test('collector rejects unsupported or non-failed runs before jobs and logs', () => {
  const invalidRuns = [
    [run({ id: 42, name: 'Other workflow' }), /不是受支持的 CI\/CD workflow/],
    [run({ id: 42, path: '.github/workflows/other.yml' }), /不是受支持的 CI\/CD workflow/],
    [run({ id: 42, conclusion: 'success' }), /不是可诊断的失败结论/],
    [run({ id: 42, status: 'in_progress', conclusion: null }), /尚未完成/],
  ];
  for (const [payload, expected] of invalidRuns) {
    const calls = [];
    const runCommand = (args) => {
      calls.push(args);
      return JSON.stringify(payload);
    };
    assert.throws(() => collectCiFailureDiagnosis({
      runId: 42,
      repo: 'xiaojichao/agentbean',
      maxLogChars: 20_000,
    }, runCommand), expected);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0][1], /\/jobs/);
  }
});

test('formats Chinese output and validates CLI bounds', () => {
  const result = analyzeCiFailure({ repository: 'xiaojichao/agentbean', run: run(), jobs: [job()] });
  assert.match(formatCiFailureDiagnosis(result), /只读诊断/);
  assert.match(formatCiFailureDiagnosis(result), /最小复现/);
  assert.equal(parseArgs(['42', '--json']).runId, 42);
  assert.throws(() => parseArgs(['--run']), /缺少参数值/);
  assert.throws(() => parseArgs(['--max-log-chars', '50']), /1000 到 200000/);
});

test('failure workflow diagnoses the exact failed run from trusted default-branch code', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-failure-diagnosis.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \['CI\/CD'\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /--run "\$TARGET_RUN_ID"/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /head_sha|pull_requests:\s*write|contents:\s*write|rerun|dispatch_workflow/);
});
