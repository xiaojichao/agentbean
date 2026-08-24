import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateObservations,
  loadEvalConfig,
  parseRoutingMatrixCaseIds,
  validateEvalSchema,
  validateStaticEval,
} from './check-agent-config-eval.mjs';

const config = loadEvalConfig();

function passingObservationSet() {
  return {
    schemaVersion: 1,
    platform: 'fixture',
    observations: config.cases.map((item) => ({
      id: item.id,
      route: item.expectation.route,
      capabilities: [...item.expectation.requiredCapabilities],
      actions: [...item.expectation.requiredActions],
      evidence: [...item.expectation.requiredEvidence],
    })),
  };
}

test('current repository passes the static Agent configuration eval', () => {
  const result = validateStaticEval(config);
  assert.equal(result.ok, true, result.failures.join('\n'));
  assert.deepEqual(result.summary, {
    routingCases: 20,
    highSignalRoutingCases: 6,
    policyCases: 10,
    policyAnchors: 14,
    regressionScripts: 12,
  });
});

test('routing matrix parser reads the 20 numbered markdown rows', () => {
  const markdown = '| # | prompt |\n|---|---|\n| 1 | a |\n| 20 | b |\n';
  assert.deepEqual(parseRoutingMatrixCaseIds(markdown), [1, 20]);
});

test('schema requires exactly ten unique policy cases', () => {
  const invalid = structuredClone(config);
  invalid.cases = invalid.cases.slice(0, 9);
  invalid.cases[1].id = invalid.cases[0].id;
  const failures = validateEvalSchema(invalid);
  assert.match(failures.join('\n'), /恰好包含 10 个/);
  assert.match(failures.join('\n'), /cases\[\]\.id/);
});

test('static eval reports a precise policy anchor drift', () => {
  const result = validateStaticEval(config, {
    readText(relativePath) {
      if (relativePath === 'docs/agents/channel-task-review-workbench-acceptance.md') return 'channelTaskHasProjectFacts';
      if (relativePath === 'package.json') return JSON.stringify({ scripts: Object.fromEntries(config.cases.flatMap((item) => item.regressionScripts).map((name) => [name, 'ok'])) });
      if (relativePath === config.routingMatrix.file) return config.routingMatrix.expectedCaseIds.map((id) => `| ${id} | case |`).join('\n');
      return config.cases.flatMap((item) => item.policyAnchors.filter((anchor) => anchor.file === relativePath).flatMap((anchor) => anchor.allOf)).join('\n');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /server-authority-projection.*只消费 Server 投影/);
});

test('complete platform observations pass exact scoring', () => {
  const result = evaluateObservations(config, passingObservationSet());
  assert.deepEqual(result, { ok: true, failures: [], passed: 10, total: 10 });
});

test('observation scoring catches wrong route, missing evidence, and forbidden action', () => {
  const input = passingObservationSet();
  const target = input.observations.find((item) => item.id === 'latest-head-review');
  target.route = 'direct';
  target.evidence = [];
  target.actions.push('merge_with_stale_review');
  const result = evaluateObservations(config, input);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /route expected=pr_merge_gate actual=direct/);
  assert.match(result.failures.join('\n'), /evidence 缺少 reviewed_head_sha/);
  assert.match(result.failures.join('\n'), /actions 包含禁止项 merge_with_stale_review/);
});

test('observation scoring fails closed on missing and unknown cases', () => {
  const input = passingObservationSet();
  input.observations.pop();
  input.observations.push({ id: 'unknown', route: 'direct', capabilities: [], actions: [], evidence: [] });
  const result = evaluateObservations(config, input);
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /未知观察场景：unknown/);
  assert.match(result.failures.join('\n'), /缺少观察场景：agent-handoff-evidence-reuse/);
});
