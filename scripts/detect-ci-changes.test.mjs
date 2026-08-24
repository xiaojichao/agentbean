import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedFiles, formatGithubOutput } from './detect-ci-changes.mjs';

test('docs-only changes skip all expensive surfaces', () => {
  const result = classifyChangedFiles([
    'docs/adr/0066-system-activity-uses-audience-scoped-projections.md',
    'CONTEXT.md',
    'CHANGELOG.md',
  ]);
  assert.deepEqual(result, {
    should_validate: false,
    should_browser_smoke: false,
    should_publish: false,
    should_deploy: false,
    should_agent_config_eval: false,
  });
});

test('daemon-only changes validate and publish but skip browser and deploy', () => {
  const result = classifyChangedFiles([
    'apps/daemon-next/src/executor.ts',
    'apps/daemon-next/package.json',
  ]);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, false);
  assert.equal(result.should_publish, true);
  assert.equal(result.should_deploy, false);
});

test('server-only changes validate, browser-smoke, and deploy without npm publish paths', () => {
  const result = classifyChangedFiles(['apps/server-next/src/application/usecases.ts']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, true);
  assert.equal(result.should_publish, false);
  assert.equal(result.should_deploy, true);
});

test('web-next changes require browser smoke and production deploy', () => {
  const result = classifyChangedFiles(['apps/web-next/app/page.tsx']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, true);
  assert.equal(result.should_deploy, true);
});

test('workflow changes force full validate publish and deploy surfaces', () => {
  const result = classifyChangedFiles(['.github/workflows/ci-cd.yml']);
  assert.deepEqual(result, {
    should_validate: true,
    should_browser_smoke: true,
    should_publish: true,
    should_deploy: true,
    should_agent_config_eval: true,
  });
});

test('force-all overrides empty file list', () => {
  assert.deepEqual(classifyChangedFiles([], { forceAll: true }), {
    should_validate: true,
    should_browser_smoke: true,
    should_publish: true,
    should_deploy: true,
    should_agent_config_eval: true,
  });
});

test('formats github actions output lines', () => {
  assert.equal(
    formatGithubOutput({
      should_validate: true,
      should_browser_smoke: false,
      should_publish: true,
      should_deploy: false,
      should_agent_config_eval: true,
    }),
    [
      'should_validate=true',
      'should_browser_smoke=false',
      'should_publish=true',
      'should_deploy=false',
      'should_agent_config_eval=true',
    ].join('\n'),
  );
});

test('detect-ci-changes script itself is a validate surface', () => {
  const result = classifyChangedFiles(['scripts/detect-ci-changes.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, false);
  assert.equal(result.should_agent_config_eval, true);
});

test('Agent contract changes run only the Agent configuration eval surface', () => {
  const result = classifyChangedFiles(['AGENTS.md', 'docs/agents/harness.md', '.codex/hooks.json', '.trellis/config.yaml']);
  assert.deepEqual(result, {
    should_validate: false,
    should_browser_smoke: false,
    should_publish: false,
    should_deploy: false,
    should_agent_config_eval: true,
  });
});

test('core delivery-gate changes run validate and Agent configuration eval', () => {
  const result = classifyChangedFiles(['scripts/check-pr-merge-readiness.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_agent_config_eval, true);
});

test('ordinary business code does not independently run Agent configuration eval', () => {
  const result = classifyChangedFiles(['apps/server-next/src/application/usecases.ts']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_agent_config_eval, false);
});

test('staging rollback rehearsal validates policy without opening production deploy', () => {
  const result = classifyChangedFiles(['scripts/rehearse-staging-rollback.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_agent_config_eval, true);
  assert.equal(result.should_deploy, false);
  assert.equal(result.should_publish, false);
});

test('rendered acceptance verifier validates and opens browser evidence without production delivery', () => {
  const result = classifyChangedFiles(['scripts/verify-agentbean-next-rendered.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, true);
  assert.equal(result.should_agent_config_eval, true);
  assert.equal(result.should_deploy, false);
  assert.equal(result.should_publish, false);
});

test('Maintain observer validates policy without opening browser or delivery writes', () => {
  const result = classifyChangedFiles(['scripts/observe-maintain-signal.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, false);
  assert.equal(result.should_agent_config_eval, true);
  assert.equal(result.should_deploy, false);
  assert.equal(result.should_publish, false);
});

test('production smoke target gate validates policy without triggering a deployment', () => {
  const result = classifyChangedFiles(['scripts/check-agentbean-next-production-target.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, false);
  assert.equal(result.should_agent_config_eval, true);
  assert.equal(result.should_deploy, false);
  assert.equal(result.should_publish, false);
});

test('SDLC observers, metrics and diagnosis implementation changes run validation and Agent config eval', () => {
  for (const file of [
    'scripts/report-sdlc-flow-metrics.mjs',
    'scripts/observe-pr-closeout.mjs',
    'scripts/diagnose-ci-failure.mjs',
    '.github/workflows/weekly-sdlc-flow-metrics.yml',
    '.github/workflows/ci-failure-diagnosis.yml',
  ]) {
    const result = classifyChangedFiles([file]);
    assert.equal(result.should_validate, true, file);
    assert.equal(result.should_agent_config_eval, true, file);
  }
});

test('SDLC flow metrics documentation runs Agent config eval without opening full validation', () => {
  const result = classifyChangedFiles(['docs/agents/sdlc-flow-metrics.md']);
  assert.equal(result.should_validate, false);
  assert.equal(result.should_agent_config_eval, true);
});

test('Trellis lineage implementation and tests run validation and Agent config eval', () => {
  for (const file of [
    '.trellis/scripts/task.py',
    '.trellis/scripts/common/task_context.py',
    '.trellis/scripts/common/task_store.py',
    '.trellis/scripts/common/task_lineage.py',
    '.trellis/tests/test_task_lineage.py',
  ]) {
    const result = classifyChangedFiles([file]);
    assert.equal(result.should_validate, true, file);
    assert.equal(result.should_agent_config_eval, true, file);
  }
});
