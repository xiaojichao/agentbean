#!/usr/bin/env node
/**
 * Classify changed files into CI surfaces for AgentBean Next.
 *
 * Usage:
 *   git diff --name-only BASE...HEAD | node scripts/detect-ci-changes.mjs --stdin
 *   node scripts/detect-ci-changes.mjs --force-all
 *   node scripts/detect-ci-changes.mjs file1 file2 ...
 *
 * Prints GitHub Actions output lines:
 *   should_validate=true|false
 *   should_browser_smoke=true|false
 *   should_publish=true|false
 *   should_deploy=true|false
 *   should_agent_config_eval=true|false
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Paths that require the full AgentBean Next validate job (tests + build + smokes except browser gate). */
export const VALIDATE_PATH_RE =
  /^(?:agentbean-next\/|packages\/|apps\/(?:server-next|daemon-next|web-next)\/|scripts\/(?:check-agentbean-next-readiness|check-agentbean-next-railway-preflight|check-agentbean-next-production-target(?:\.test)?|check-pr-merge-readiness(?:\.test)?|claim-github-issue(?:\.test)?|check-team-terminology(?:\.test)?|check-phase-0-pi-boundary(?:\.test)?|check-phase-1-management-boundary(?:\.test)?|check-phase-2-task-dag-boundary(?:\.test)?|check-phase-3-memory-boundary(?:\.test)?|check-migration-registration(?:\.test)?|check-pi-management-sea(?:\.test)?|build-pi-management-sea(?:\.test)?|detect-ci-changes(?:\.test)?|run-changed-preflight(?:\.test)?|report-sdlc-flow-metrics(?:\.test)?|observe-pr-closeout(?:\.test)?|diagnose-ci-failure(?:\.test)?|rehearse-staging-rollback(?:\.test)?|verify-agentbean-next-rendered(?:\.test)?|observe-maintain-signal(?:\.test)?|audit-agentbean-next-cutover|prepare-agentbean-next-daemon-release|smoke-agentbean-next-.*)\.mjs$|\.trellis\/(?:scripts\/(?:task\.py|common\/task_(?:context|store|lineage)\.py)|tests\/)|docs\/superpowers\/(?:specs|plans)\/|README\.md$|\.nvmrc$|package(?:-lock)?\.json$|railway\.json$|\.github\/workflows\/(?:ci-cd|daily-changelog|pi-sea-compatibility|weekly-sdlc-flow-metrics|ci-failure-diagnosis)\.yml$)/;

/** Paths that require browser / WebUI smoke (expensive, flaky surface). */
export const BROWSER_SMOKE_PATH_RE =
  /^(?:apps\/(?:web-next|server-next)\/|scripts\/(?:smoke-agentbean-next-(?:browser|webui).*|verify-agentbean-next-rendered(?:\.test)?\.mjs$)|package(?:-lock)?\.json$|\.github\/workflows\/ci-cd\.yml$)/;

/** Paths that may produce a new npm package publish on main. */
export const PUBLISH_PATH_RE =
  /^(?:apps\/daemon-next\/|packages\/(?:contracts|pi-management-runtime)\/|scripts\/prepare-agentbean-next-daemon-release|package(?:-lock)?\.json$|\.github\/workflows\/ci-cd\.yml$)/;

/** Paths that require Railway production deploy on main.
 * Includes web-next: production server hosts the Web UI and railway build runs build:web-next.
 */
export const DEPLOY_PATH_RE =
  /^(?:apps\/(?:server-next|web-next)\/|packages\/(?:contracts|domain|pi-management-runtime)\/|scripts\/(?:check-agentbean-next-readiness|check-agentbean-next-railway-preflight|audit-agentbean-next-cutover|smoke-agentbean-next-.*)\.mjs$|railway\.json$|package(?:-lock)?\.json$|\.github\/workflows\/ci-cd\.yml$)/;

/** Agent contract, routing, hook, Trellis workflow, and core delivery-gate paths. */
export const AGENT_CONFIG_EVAL_PATH_RE =
  /^(?:AGENTS\.md$|CLAUDE\.md$|\.agents\/skills\/|\.(?:claude|codex|cursor)\/|\.trellis\/(?:workflow\.md$|config\.yaml$|scripts\/(?:get_context\.py$|task\.py$|common\/task_(?:context|store|lineage)\.py$)|tests\/)|docs\/agents\/(?:harness|skill-routing-eval|agent-config-eval|channel-task-review-workbench-acceptance|issue-tracker|pr-merge-gate|pr-closeout-observer|ci-failure-diagnosis|sdlc-flow-metrics|staging-rollback-rehearsal|rendered-acceptance-verifier|maintain-signal-observer)(?:-cases\.json|\.md)$|docs\/agents\/rendered-acceptance-contract\.example\.json$|agentbean-next\/docs\/production-cutover-runbook\.md$|scripts\/(?:check-agent-config-eval|check-agentbean-next-production-target|check-pr-merge-readiness|claim-github-issue|observe-pr-closeout|diagnose-ci-failure|report-sdlc-flow-metrics|rehearse-staging-rollback|verify-agentbean-next-rendered|observe-maintain-signal|detect-ci-changes|run-changed-preflight)(?:\.test)?\.mjs$|package\.json$|\.github\/workflows\/(?:ci-cd|weekly-sdlc-flow-metrics|ci-failure-diagnosis)\.yml$)/;

export function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function classifyChangedFiles(files, { forceAll = false } = {}) {
  if (forceAll) {
    return {
      should_validate: true,
      should_browser_smoke: true,
      should_publish: true,
      should_deploy: true,
      should_agent_config_eval: true,
    };
  }

  const normalized = [...new Set((files || []).map(normalizePath).filter(Boolean))];
  const should_validate = normalized.some((file) => VALIDATE_PATH_RE.test(file));
  const should_browser_smoke = should_validate && normalized.some((file) => BROWSER_SMOKE_PATH_RE.test(file));
  const should_publish = should_validate && normalized.some((file) => PUBLISH_PATH_RE.test(file));
  const should_deploy = should_validate && normalized.some((file) => DEPLOY_PATH_RE.test(file));
  const should_agent_config_eval = normalized.some((file) => AGENT_CONFIG_EVAL_PATH_RE.test(file));

  return {
    should_validate,
    should_browser_smoke,
    should_publish,
    should_deploy,
    should_agent_config_eval,
  };
}

export function formatGithubOutput(classification) {
  return [
    `should_validate=${classification.should_validate}`,
    `should_browser_smoke=${classification.should_browser_smoke}`,
    `should_publish=${classification.should_publish}`,
    `should_deploy=${classification.should_deploy}`,
    `should_agent_config_eval=${classification.should_agent_config_eval}`,
  ].join('\n');
}

function parseArgs(argv) {
  const options = { forceAll: false, stdin: false, files: [] };
  for (const value of argv) {
    if (value === '--force-all') options.forceAll = true;
    else if (value === '--stdin') options.stdin = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value.startsWith('-')) throw new Error(`未知参数：${value}`);
    else options.files.push(value);
  }
  return options;
}

function readStdinFiles() {
  const text = readFileSync(0, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`用法：
  git diff --name-only BASE...HEAD | node scripts/detect-ci-changes.mjs --stdin
  node scripts/detect-ci-changes.mjs --force-all
  node scripts/detect-ci-changes.mjs path/a path/b`);
      return;
    }
    const files = options.stdin ? readStdinFiles() : options.files;
    const classification = classifyChangedFiles(files, { forceAll: options.forceAll });
    console.log(formatGithubOutput(classification));
  } catch (error) {
    console.error(`DETECT_CI_CHANGES_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
