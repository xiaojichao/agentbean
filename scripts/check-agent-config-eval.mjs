#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CASES_FILE = 'docs/agents/agent-config-eval-cases.json';
const OBSERVATION_FIELDS = [
  ['capabilities', 'requiredCapabilities', 'forbiddenCapabilities'],
  ['actions', 'requiredActions', 'forbiddenActions'],
  ['evidence', 'requiredEvidence', 'forbiddenEvidence'],
];

function isUniqueStringArray(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function addArraySchemaFailure(failures, value, label) {
  if (!isUniqueStringArray(value)) failures.push(`${label} 必须是无重复的非空字符串数组`);
}

export function parseRoutingMatrixCaseIds(markdown) {
  return [...markdown.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((match) => Number(match[1]));
}

export function validateEvalSchema(config) {
  const failures = [];
  if (config?.schemaVersion !== 1) failures.push('schemaVersion 必须为 1');
  if (!config?.routingMatrix || typeof config.routingMatrix.file !== 'string') {
    failures.push('routingMatrix.file 缺失');
  }
  addArraySchemaFailure(failures, config?.routingMatrix?.expectedCaseIds?.map(String), 'routingMatrix.expectedCaseIds');
  addArraySchemaFailure(failures, config?.routingMatrix?.highSignalCaseIds?.map(String), 'routingMatrix.highSignalCaseIds');
  if (!Array.isArray(config?.cases)) {
    failures.push('cases 必须是数组');
    return failures;
  }
  if (config.cases.length !== 10) {
    failures.push('cases 必须恰好包含 10 个高风险场景');
  }

  const ids = config.cases.map((item) => item?.id);
  addArraySchemaFailure(failures, ids, 'cases[].id');
  for (const item of config.cases) {
    const label = `场景 ${item?.id ?? '<missing>'}`;
    if (typeof item?.title !== 'string' || !item.title) failures.push(`${label} 缺少 title`);
    if (typeof item?.prompt !== 'string' || !item.prompt) failures.push(`${label} 缺少 prompt`);
    if (typeof item?.expectation?.route !== 'string' || !item.expectation.route) failures.push(`${label} 缺少 expectation.route`);
    for (const [, requiredKey, forbiddenKey] of OBSERVATION_FIELDS) {
      addArraySchemaFailure(failures, item?.expectation?.[requiredKey] ?? [], `${label} ${requiredKey}`);
      addArraySchemaFailure(failures, item?.expectation?.[forbiddenKey] ?? [], `${label} ${forbiddenKey}`);
    }
    if (!Array.isArray(item?.policyAnchors) || item.policyAnchors.length === 0) {
      failures.push(`${label} 至少需要一个 policyAnchor`);
    } else {
      for (const anchor of item.policyAnchors) {
        if (typeof anchor?.file !== 'string' || !anchor.file) failures.push(`${label} policyAnchor.file 缺失`);
        addArraySchemaFailure(failures, anchor?.allOf, `${label} ${anchor?.file ?? '<missing>'}.allOf`);
      }
    }
    addArraySchemaFailure(failures, item?.regressionScripts, `${label} regressionScripts`);
  }
  return failures;
}

function sameNumberSet(left, right) {
  return left.length === right.length
    && left.every((value) => right.includes(value))
    && new Set(left).size === left.length;
}

export function validateStaticEval(config, {
  readText = (relativePath) => readFileSync(resolve(ROOT, relativePath), 'utf8'),
} = {}) {
  const failures = validateEvalSchema(config);
  if (failures.length > 0) return { ok: false, failures, summary: null };

  const routingMarkdown = readText(config.routingMatrix.file);
  const routingIds = parseRoutingMatrixCaseIds(routingMarkdown);
  if (!sameNumberSet(routingIds, config.routingMatrix.expectedCaseIds)) {
    failures.push(`路由矩阵编号漂移：expected=${config.routingMatrix.expectedCaseIds.join(',')} actual=${routingIds.join(',')}`);
  }
  for (const id of config.routingMatrix.highSignalCaseIds) {
    if (!routingIds.includes(id)) failures.push(`高信号路由用例 #${id} 缺失`);
  }

  const packageJson = JSON.parse(readText('package.json'));
  let anchorCount = 0;
  const regressionScripts = new Set();
  for (const item of config.cases) {
    for (const anchor of item.policyAnchors) {
      anchorCount += 1;
      let content;
      try {
        content = readText(anchor.file);
      } catch (error) {
        failures.push(`场景 ${item.id} 无法读取策略锚点 ${anchor.file}: ${error.message}`);
        continue;
      }
      for (const fragment of anchor.allOf) {
        if (!content.includes(fragment)) {
          failures.push(`场景 ${item.id} 的策略锚点漂移：${anchor.file} 缺少「${fragment}」`);
        }
      }
    }
    for (const script of item.regressionScripts) {
      regressionScripts.add(script);
      if (typeof packageJson.scripts?.[script] !== 'string') {
        failures.push(`场景 ${item.id} 引用的回归脚本不存在：${script}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: {
      routingCases: routingIds.length,
      highSignalRoutingCases: config.routingMatrix.highSignalCaseIds.length,
      policyCases: config.cases.length,
      policyAnchors: anchorCount,
      regressionScripts: regressionScripts.size,
    },
  };
}

function missingValues(actual, expected) {
  const actualSet = new Set(actual ?? []);
  return (expected ?? []).filter((value) => !actualSet.has(value));
}

function presentValues(actual, forbidden) {
  const actualSet = new Set(actual ?? []);
  return (forbidden ?? []).filter((value) => actualSet.has(value));
}

export function evaluateObservations(config, observationSet) {
  const failures = [];
  if (observationSet?.schemaVersion !== 1) failures.push('observation schemaVersion 必须为 1');
  if (typeof observationSet?.platform !== 'string' || !observationSet.platform) failures.push('observation platform 缺失');
  if (!Array.isArray(observationSet?.observations)) {
    return { ok: false, failures: [...failures, 'observations 必须是数组'], passed: 0, total: config.cases.length };
  }

  const expectedById = new Map(config.cases.map((item) => [item.id, item]));
  const seen = new Set();
  let passed = 0;
  for (const observation of observationSet.observations) {
    const id = observation?.id;
    if (typeof id !== 'string' || !id) {
      failures.push('observation.id 缺失');
      continue;
    }
    if (seen.has(id)) {
      failures.push(`观察结果重复：${id}`);
      continue;
    }
    seen.add(id);
    const expected = expectedById.get(id);
    if (!expected) {
      failures.push(`未知观察场景：${id}`);
      continue;
    }

    const caseFailures = [];
    if (observation.route !== expected.expectation.route) {
      caseFailures.push(`route expected=${expected.expectation.route} actual=${observation.route ?? '<missing>'}`);
    }
    for (const [actualKey, requiredKey, forbiddenKey] of OBSERVATION_FIELDS) {
      const actual = observation[actualKey];
      if (!isUniqueStringArray(actual)) {
        caseFailures.push(`${actualKey} 必须是无重复的非空字符串数组`);
        continue;
      }
      const missing = missingValues(actual, expected.expectation[requiredKey]);
      const forbidden = presentValues(actual, expected.expectation[forbiddenKey]);
      if (missing.length > 0) caseFailures.push(`${actualKey} 缺少 ${missing.join(',')}`);
      if (forbidden.length > 0) caseFailures.push(`${actualKey} 包含禁止项 ${forbidden.join(',')}`);
    }
    if (caseFailures.length > 0) failures.push(`场景 ${id}: ${caseFailures.join('; ')}`);
    else passed += 1;
  }

  for (const item of config.cases) {
    if (!seen.has(item.id)) failures.push(`缺少观察场景：${item.id}`);
  }
  return { ok: failures.length === 0, failures, passed, total: config.cases.length };
}

export function loadEvalConfig(root = ROOT, casesFile = DEFAULT_CASES_FILE) {
  return JSON.parse(readFileSync(resolve(root, casesFile), 'utf8'));
}

function parseArgs(argv) {
  const options = { json: false, observations: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') options.json = true;
    else if (value === '--observations') options.observations = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  if (argv.includes('--observations') && !options.observations) throw new Error('--observations 需要 JSON 文件路径');
  return options;
}

function formatHuman(result, observationResult) {
  const lines = [];
  if (result.summary) {
    lines.push(`Agent 配置静态评测：${result.ok ? 'PASS' : 'FAIL'}`);
    lines.push(`路由矩阵 ${result.summary.routingCases} 条（高信号 ${result.summary.highSignalRoutingCases} 条）`);
    lines.push(`高风险策略 ${result.summary.policyCases} 条 / 锚点 ${result.summary.policyAnchors} 个 / 回归脚本 ${result.summary.regressionScripts} 个`);
  }
  if (observationResult) {
    lines.push(`平台观察：${observationResult.ok ? 'PASS' : 'FAIL'}（${observationResult.passed}/${observationResult.total}）`);
  }
  const failures = [...result.failures, ...(observationResult?.failures ?? [])];
  for (const failure of failures) lines.push(`- ${failure}`);
  return lines.join('\n');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log('用法：node scripts/check-agent-config-eval.mjs [--json] [--observations path/to/results.json]');
      return;
    }
    const config = loadEvalConfig();
    const staticResult = validateStaticEval(config);
    const observationResult = options.observations
      ? evaluateObservations(config, JSON.parse(readFileSync(resolve(process.cwd(), options.observations), 'utf8')))
      : null;
    const result = { static: staticResult, observations: observationResult };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatHuman(staticResult, observationResult));
    if (!staticResult.ok || (observationResult && !observationResult.ok)) process.exitCode = 1;
  } catch (error) {
    console.error(`AGENT_CONFIG_EVAL_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
