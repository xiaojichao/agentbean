#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_STATUS = new Set(['success', 'failure', 'cancelled', 'skipped', 'pending', 'missing']);
const LIVE_HEALTH_STATUS = new Set(['healthy', 'unhealthy', 'unreachable', 'not_checked']);
const LIVE_HEALTH_REASONS = new Set([
  'entry_url_missing',
  'entry_url_protocol_invalid',
  'entry_url_credentials_forbidden',
  'entry_url_invalid',
  'live_target_not_authorized',
  'allowed_origin_missing',
  'target_origin_not_allowed',
  'target_address_not_public',
  'target_resolution_failed',
  'payload_too_large',
  'health_contract_failed',
  'request_failed',
  'explicitly_skipped',
]);
const ORDERED_STEPS = ['target', 'cutover', 'health', 'entry', 'business'];
const PROHIBITED_ACTIONS = [
  'create_issue',
  'create_pr',
  'rerun_ci',
  'cancel_ci',
  'dispatch_workflow',
  'modify_code',
  'deploy',
  'rollback',
  'publish',
];

function isLocalHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost');
}

function sanitizeEntryUrl(input) {
  if (!input) return { ok: false, reason: 'entry_url_missing', url: null, remote: false };
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'entry_url_protocol_invalid', url: null, remote: false };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'entry_url_credentials_forbidden', url: null, remote: false };
    }
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return {
      ok: true,
      reason: null,
      url: parsed.toString().replace(/\/$/, ''),
      remote: !isLocalHostname(parsed.hostname),
    };
  } catch {
    return { ok: false, reason: 'entry_url_invalid', url: null, remote: false };
  }
}

async function readLimitedBody(response, maxBytes = 65_536) {
  if (!response.body?.getReader) throw new Error('streaming response body required');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return { text: '', tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, tooLarge: false };
}

function normalizeAllowedOrigin(input) {
  if (!input) return null;
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username || parsed.password
      || (parsed.pathname && parsed.pathname !== '/')
      || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  );
}

function isPublicIpAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPublicIpv4(normalized.slice('::ffff:'.length));
  return !(
    normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
  );
}

async function targetUsesOnlyPublicAddresses(hostname, resolveHostImpl) {
  const unwrapped = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(unwrapped)
    ? [{ address: unwrapped }]
    : await resolveHostImpl(unwrapped, { all: true, verbatim: true });
  return addresses.length > 0 && addresses.every((candidate) => isPublicIpAddress(candidate.address));
}

export async function validatePublicHttpTarget({
  entryUrl,
  allowedOrigin,
  resolveHostImpl = lookup,
} = {}) {
  const target = sanitizeEntryUrl(entryUrl);
  if (!target.ok) return { ok: false, url: null, origin: null, reason: target.reason };
  if (!target.remote) return { ok: false, url: target.url, origin: new URL(target.url).origin, reason: 'target_address_not_public' };
  const normalizedAllowedOrigin = normalizeAllowedOrigin(allowedOrigin);
  if (!normalizedAllowedOrigin) {
    return { ok: false, url: target.url, origin: new URL(target.url).origin, reason: 'allowed_origin_missing' };
  }
  const origin = new URL(target.url).origin;
  if (origin !== normalizedAllowedOrigin) {
    return { ok: false, url: target.url, origin, reason: 'target_origin_not_allowed' };
  }
  try {
    if (!await targetUsesOnlyPublicAddresses(new URL(target.url).hostname, resolveHostImpl)) {
      return { ok: false, url: target.url, origin, reason: 'target_address_not_public' };
    }
  } catch {
    return { ok: false, url: target.url, origin, reason: 'target_resolution_failed' };
  }
  return { ok: true, url: target.url, origin, reason: null };
}

export async function observeLiveHealth({
  entryUrl,
  allowLiveTarget = false,
  allowedOrigin = null,
  fetchImpl = globalThis.fetch,
  resolveHostImpl = lookup,
  observedAt = new Date().toISOString(),
  timeoutMs = 10_000,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('timeoutMs 必须是 100—60000 的整数');
  }
  const target = sanitizeEntryUrl(entryUrl);
  if (!target.ok) {
    return {
      status: 'not_checked',
      url: null,
      httpStatus: null,
      payloadMatches: null,
      observedAt,
      reason: target.reason,
      requestMethod: null,
    };
  }
  const healthUrl = new URL('/healthz', `${target.url}/`).toString();
  if (target.remote && !allowLiveTarget) {
    return {
      status: 'not_checked',
      url: healthUrl,
      httpStatus: null,
      payloadMatches: null,
      observedAt,
      reason: 'live_target_not_authorized',
      requestMethod: null,
    };
  }
  if (target.remote) {
    const validation = await validatePublicHttpTarget({ entryUrl: target.url, allowedOrigin, resolveHostImpl });
    if (!validation.ok) {
      return {
        status: 'not_checked', url: healthUrl, httpStatus: null, payloadMatches: null,
        observedAt, reason: validation.reason, requestMethod: null,
      };
    }
  }

  try {
    const response = await fetchImpl(healthUrl, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyResult = await readLimitedBody(response);
    let payloadMatches = false;
    if (!bodyResult.tooLarge) {
      try {
        const payload = JSON.parse(bodyResult.text);
        payloadMatches = payload?.ok === true && payload?.service === 'agentbean-next-server';
      } catch {
        payloadMatches = false;
      }
    }
    const healthy = response.status === 200 && payloadMatches;
    return {
      status: healthy ? 'healthy' : 'unhealthy',
      url: healthUrl,
      httpStatus: response.status,
      payloadMatches,
      observedAt,
      reason: healthy ? null : bodyResult.tooLarge ? 'payload_too_large' : 'health_contract_failed',
      requestMethod: 'GET',
    };
  } catch {
    return {
      status: 'unreachable',
      url: healthUrl,
      httpStatus: null,
      payloadMatches: null,
      observedAt,
      reason: 'request_failed',
      requestMethod: 'GET',
    };
  }
}

function normalizeStatus(value, label) {
  const normalized = String(value || 'missing').toLowerCase();
  if (!WORKFLOW_STATUS.has(normalized)) {
    throw new Error(`${label} 状态无效：${value}`);
  }
  return normalized;
}

function validRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validHeadSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function validRunId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeLiveHealth(input, observedAt) {
  if (!LIVE_HEALTH_STATUS.has(input?.status)) throw new Error(`liveHealth.status 无效：${input?.status}`);
  const sanitizedTarget = input.url ? sanitizeEntryUrl(input.url) : null;
  const safeUrl = sanitizedTarget?.ok
    ? new URL('/healthz', `${sanitizedTarget.url}/`).toString()
    : null;
  const httpStatus = Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599
    ? input.httpStatus
    : null;
  const payloadMatches = typeof input.payloadMatches === 'boolean' ? input.payloadMatches : null;
  const requestMethod = input.requestMethod === 'GET' ? 'GET' : null;
  return {
    status: input.status,
    url: safeUrl,
    httpStatus,
    payloadMatches,
    observedAt: validTimestamp(input.observedAt) ? input.observedAt : observedAt,
    reason: LIVE_HEALTH_REASONS.has(input.reason) ? input.reason : input.reason == null ? null : 'unclassified',
    requestMethod,
  };
}

function liveHealthWarnings(liveHealth) {
  const warnings = [];
  if (liveHealth.status === 'not_checked') {
    warnings.push(`live health 未检查：${liveHealth.reason ?? 'unknown'}`);
    if (liveHealth.requestMethod !== null) warnings.push('live health 未检查却记录了请求方法');
    return warnings;
  }
  if (!liveHealth.url || liveHealth.requestMethod !== 'GET') {
    warnings.push(`live health 的 ${liveHealth.status} 状态缺少 URL/GET 证据`);
  }
  if (liveHealth.status === 'healthy'
    && (liveHealth.httpStatus !== 200 || liveHealth.payloadMatches !== true)) {
    warnings.push('live health 的 healthy 状态与 HTTP/payload 证据不一致');
  }
  if (liveHealth.status === 'healthy' && liveHealth.reason !== null) {
    warnings.push('live health 的 healthy 状态不应包含失败原因');
  }
  if (liveHealth.status === 'unhealthy'
    && liveHealth.httpStatus === null) {
    warnings.push('live health 的 unhealthy 状态缺少 HTTP status');
  }
  if (liveHealth.status === 'unhealthy'
    && liveHealth.httpStatus === 200 && liveHealth.payloadMatches === true) {
    warnings.push('live health 的 unhealthy 状态与成功 HTTP/payload 证据冲突');
  }
  if (liveHealth.status === 'unreachable'
    && liveHealth.httpStatus !== null) {
    warnings.push('live health 的 unreachable 状态不应包含 HTTP status');
  }
  if (liveHealth.status === 'unreachable'
    && (liveHealth.payloadMatches !== null || liveHealth.reason !== 'request_failed')) {
    warnings.push('live health 的 unreachable 状态与 request/payload 证据冲突');
  }
  return warnings;
}

function writeReport(output, report) {
  const artifactsRoot = resolve(process.cwd(), 'artifacts');
  const root = resolve(process.cwd(), 'artifacts/maintain');
  const outputPath = resolve(process.cwd(), output);
  if (outputPath !== root && !outputPath.startsWith(`${root}${sep}`)) {
    throw new Error('--output 必须位于当前目录的 artifacts/maintain 内');
  }
  if (dirname(outputPath) !== root) {
    throw new Error('--output 必须直接位于 artifacts/maintain 内，不能使用嵌套目录');
  }
  mkdirSync(artifactsRoot, { recursive: true });
  if (lstatSync(artifactsRoot).isSymbolicLink()) {
    throw new Error('artifacts 目录不能是符号链接');
  }
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error('artifacts/maintain 根目录不能是符号链接');
  }
  const temporary = join(root, `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function workflowWarnings(workflow, trigger) {
  const warnings = [];
  if (trigger === 'post_deploy' && ['pending', 'missing', 'skipped'].includes(workflow.deploy)) {
    warnings.push(`post-deploy 观察缺少确定性的 deploy 结论：${workflow.deploy}`);
  }
  let previousFailed = workflow.deploy === 'failure' || workflow.deploy === 'cancelled';
  for (const name of ORDERED_STEPS) {
    const status = workflow[name];
    if (status === 'pending' || status === 'missing') {
      warnings.push(`${name} step 状态不可判定：${status}`);
    }
    if (status === 'skipped' && !previousFailed) {
      warnings.push(`${name} step 在没有上游失败时被跳过`);
    }
    if (status === 'failure' || status === 'cancelled') previousFailed = true;
  }
  return warnings;
}

function derivePrimarySignal(workflow, liveHealth) {
  if (workflow.deploy === 'failure' || workflow.deploy === 'cancelled') return 'deployment_failed';
  if (workflow.target === 'failure' || workflow.target === 'cancelled') return 'smoke_target_invalid';
  if (workflow.cutover === 'failure' || workflow.cutover === 'cancelled') return 'cutover_audit_failed';
  if (workflow.health === 'failure' || workflow.health === 'cancelled') return 'workflow_health_failed';
  if (workflow.entry === 'failure' || workflow.entry === 'cancelled') return 'entry_smoke_failed';
  if (workflow.business === 'failure' || workflow.business === 'cancelled') return 'business_smoke_failed';
  if (liveHealth.status === 'unhealthy') return 'live_health_unhealthy';
  if (liveHealth.status === 'unreachable') return 'live_health_unreachable';
  return 'healthy';
}

function regressionTarget(signal) {
  const targets = {
    deployment_failed: 'check:agentbean-next-railway-preflight',
    smoke_target_invalid: 'smoke:agentbean-next-entry',
    cutover_audit_failed: 'audit:agentbean-next-cutover',
    workflow_health_failed: 'smoke:agentbean-next-entry',
    entry_smoke_failed: 'smoke:agentbean-next-entry',
    business_smoke_failed: 'smoke:agentbean-next-business',
    live_health_unhealthy: 'smoke:agentbean-next-entry',
    live_health_unreachable: 'smoke:agentbean-next-entry',
  };
  return targets[signal] ?? null;
}

function stableFingerprint(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function buildMaintainObservation({
  environment = 'production',
  trigger = 'post_deploy',
  repository,
  runId,
  headSha,
  workflow: workflowInput = {},
  liveHealth,
  observedAt = new Date().toISOString(),
} = {}) {
  if (!['production', 'staging'].includes(environment)) throw new Error(`environment 无效：${environment}`);
  if (!['post_deploy', 'manual_smoke'].includes(trigger)) throw new Error(`trigger 无效：${trigger}`);
  if (!validTimestamp(observedAt)) throw new Error(`observedAt 无效：${observedAt}`);
  if (!liveHealth || typeof liveHealth !== 'object') throw new Error('liveHealth 缺失');
  const safeLiveHealth = normalizeLiveHealth(liveHealth, observedAt);

  const workflow = {
    deploy: normalizeStatus(workflowInput.deploy, 'deploy'),
    target: normalizeStatus(workflowInput.target, 'target'),
    cutover: normalizeStatus(workflowInput.cutover, 'cutover'),
    health: normalizeStatus(workflowInput.health, 'health'),
    entry: normalizeStatus(workflowInput.entry, 'entry'),
    business: normalizeStatus(workflowInput.business, 'business'),
  };
  const warnings = [
    ...(!validRepository(repository) ? ['repository 缺失或格式无效'] : []),
    ...(!validRunId(runId) ? ['runId 缺失或格式无效'] : []),
    ...(!validHeadSha(headSha) ? ['headSha 缺失或不是完整 40 位 SHA'] : []),
    ...workflowWarnings(workflow, trigger),
    ...liveHealthWarnings(safeLiveHealth),
  ];
  const primarySignal = warnings.length > 0
    ? 'evidence_incomplete'
    : derivePrimarySignal(workflow, safeLiveHealth);
  const workflowHealthFailed = workflow.health === 'failure' || workflow.health === 'cancelled';
  const liveFailed = safeLiveHealth.status === 'unhealthy' || safeLiveHealth.status === 'unreachable';
  const level = warnings.length > 0
    ? 'blocked'
    : primarySignal === 'healthy'
      ? 'record'
      : liveFailed && workflowHealthFailed
        ? 'escalation_candidate'
        : 'diagnose';
  const fingerprint = stableFingerprint({
    schemaVersion: 1,
    environment,
    trigger,
    repository: repository ?? null,
    runId: runId ?? null,
    headSha: headSha ?? null,
    workflow,
    liveHealth: {
      status: safeLiveHealth.status,
      httpStatus: safeLiveHealth.httpStatus,
      payloadMatches: safeLiveHealth.payloadMatches,
      reason: safeLiveHealth.reason,
    },
    primarySignal,
  });
  const hasIncident = level === 'diagnose' || level === 'escalation_candidate';
  const target = regressionTarget(primarySignal);

  return {
    schemaVersion: 1,
    observedAt,
    environment,
    trigger,
    authority: 'read_only_observation',
    repository: validRepository(repository) ? repository : null,
    runId: validRunId(runId) ? runId : null,
    headSha: validHeadSha(headSha) ? headSha : null,
    classification: {
      level,
      primarySignal,
      fingerprint,
    },
    workflow,
    liveHealth: safeLiveHealth,
    dataQuality: {
      status: warnings.length === 0 ? 'complete' : 'blocked',
      warnings,
    },
    candidates: {
      incident: hasIncident ? {
        kind: 'incident_candidate',
        status: 'draft_only',
        title: `[${environment}] ${primarySignal}`,
        severity: level === 'escalation_candidate' ? 'high' : 'medium',
        fingerprint,
        createAuthorized: false,
      } : null,
      regression: hasIncident && target ? {
        kind: 'regression_candidate',
        status: 'draft_only',
        sourceFingerprint: fingerprint,
        suggestedExistingCheck: target,
        requiredBehavior: primarySignal,
        modifyAuthorized: false,
      } : null,
      agentEval: level === 'blocked' || hasIncident ? {
        kind: 'agent_eval_candidate',
        status: 'draft_only',
        sourceFingerprint: fingerprint,
        suggestedCaseId: 'post-merge-production-truth',
        requiredBehavior: level === 'blocked' ? 'fail_closed_on_incomplete_evidence' : 'diagnose_without_mutation',
        modifyAuthorized: false,
      } : null,
    },
    actions: {
      performed: safeLiveHealth.requestMethod === 'GET' ? ['live_health_get'] : [],
      recommendedReadOnly: level === 'blocked'
        ? ['collect_complete_evidence']
        : hasIncident
          ? ['diagnose_ci_failure', 'compare_same_head_evidence']
          : ['record_evidence'],
      prohibited: [...PROHIBITED_ACTIONS],
      mutationCount: 0,
    },
  };
}

export function parseArgs(argv) {
  const options = {
    environment: 'production',
    trigger: 'post_deploy',
    repository: process.env.GITHUB_REPOSITORY ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    headSha: process.env.GITHUB_SHA ?? '',
    entryUrl: process.env.AGENTBEAN_NEXT_ENTRY_URL ?? '',
    deployStatus: 'missing',
    targetStatus: 'missing',
    cutoverStatus: 'missing',
    healthStatus: 'missing',
    entryStatus: 'missing',
    businessStatus: 'missing',
    allowLiveTarget: false,
    allowedOrigin: '',
    skipLiveHealth: false,
    timeoutMs: 10_000,
    output: null,
    json: false,
  };
  const valueFor = (flag, index) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`${flag} 缺少参数值`);
    return argv[index + 1];
  };
  const valueFlags = new Map([
    ['--environment', 'environment'], ['--trigger', 'trigger'], ['--repository', 'repository'],
    ['--run-id', 'runId'], ['--head-sha', 'headSha'], ['--entry-url', 'entryUrl'],
    ['--deploy-status', 'deployStatus'], ['--target-status', 'targetStatus'],
    ['--cutover-status', 'cutoverStatus'], ['--health-status', 'healthStatus'],
    ['--entry-status', 'entryStatus'], ['--business-status', 'businessStatus'],
    ['--allowed-origin', 'allowedOrigin'], ['--output', 'output'], ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (valueFlags.has(flag)) {
      const value = valueFor(flag, index);
      options[valueFlags.get(flag)] = flag === '--timeout-ms' ? Number(value) : value;
      index += 1;
    } else if (flag === '--allow-live-target') options.allowLiveTarget = true;
    else if (flag === '--skip-live-health') options.skipLiveHealth = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000) {
    throw new Error('--timeout-ms 必须是 100—60000 的整数');
  }
  return options;
}

export function formatMaintainObservation(observation) {
  const lines = [
    `Maintain 信号：${observation.classification.level}`,
    `主信号：${observation.classification.primarySignal}`,
    `Run/Head：${observation.runId ?? 'unknown'} / ${observation.headSha?.slice(0, 10) ?? 'unknown'}`,
    `Deploy/Health/Smoke：${observation.workflow.deploy} / ${observation.workflow.health} / ${observation.workflow.business}`,
    `Live health：${observation.liveHealth.status}${observation.liveHealth.httpStatus ? ` (HTTP ${observation.liveHealth.httpStatus})` : ''}`,
    `指纹：${observation.classification.fingerprint}`,
    '写操作：0',
  ];
  if (observation.dataQuality.warnings.length > 0) {
    lines.push('数据质量：', ...observation.dataQuality.warnings.map((warning) => `- ${warning}`));
  }
  if (observation.candidates.incident) lines.push('已生成 incident/regression/eval 草案候选；未创建外部工件。');
  return lines.join('\n');
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`用法：node scripts/observe-maintain-signal.mjs [options]
  --repository owner/name --run-id ID --head-sha SHA
  --deploy-status STATUS --target-status STATUS --cutover-status STATUS
  --health-status STATUS --entry-status STATUS --business-status STATUS
  --entry-url URL --allow-live-target --allowed-origin ORIGIN [--output artifacts/maintain/report.json] [--json]

该命令只做 GET 和本地报告写入，不创建 Issue/PR、不 rerun、不 deploy、不 rollback。`);
      return;
    }
    const observedAt = new Date().toISOString();
    const liveHealth = options.skipLiveHealth
      ? {
        status: 'not_checked', url: null, httpStatus: null, payloadMatches: null,
        observedAt, reason: 'explicitly_skipped', requestMethod: null,
      }
      : await observeLiveHealth({
        entryUrl: options.entryUrl,
        allowLiveTarget: options.allowLiveTarget,
        allowedOrigin: options.allowedOrigin,
        observedAt,
        timeoutMs: options.timeoutMs,
      });
    const observation = buildMaintainObservation({
      environment: options.environment,
      trigger: options.trigger,
      repository: options.repository,
      runId: options.runId,
      headSha: options.headSha,
      workflow: {
        deploy: options.deployStatus,
        target: options.targetStatus,
        cutover: options.cutoverStatus,
        health: options.healthStatus,
        entry: options.entryStatus,
        business: options.businessStatus,
      },
      liveHealth,
      observedAt,
    });
    if (options.output) {
      writeReport(options.output, observation);
    }
    console.log(options.json ? JSON.stringify(observation, null, 2) : formatMaintainObservation(observation));
  } catch (error) {
    console.error(`MAINTAIN_SIGNAL_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
