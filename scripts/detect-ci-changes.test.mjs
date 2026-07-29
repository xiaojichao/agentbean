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

test('web-next changes require browser smoke', () => {
  const result = classifyChangedFiles(['apps/web-next/app/page.tsx']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, true);
  assert.equal(result.should_deploy, false);
});

test('workflow changes force full validate publish and deploy surfaces', () => {
  const result = classifyChangedFiles(['.github/workflows/ci-cd.yml']);
  assert.deepEqual(result, {
    should_validate: true,
    should_browser_smoke: true,
    should_publish: true,
    should_deploy: true,
  });
});

test('force-all overrides empty file list', () => {
  assert.deepEqual(classifyChangedFiles([], { forceAll: true }), {
    should_validate: true,
    should_browser_smoke: true,
    should_publish: true,
    should_deploy: true,
  });
});

test('formats github actions output lines', () => {
  assert.equal(
    formatGithubOutput({
      should_validate: true,
      should_browser_smoke: false,
      should_publish: true,
      should_deploy: false,
    }),
    [
      'should_validate=true',
      'should_browser_smoke=false',
      'should_publish=true',
      'should_deploy=false',
    ].join('\n'),
  );
});

test('detect-ci-changes script itself is a validate surface', () => {
  const result = classifyChangedFiles(['scripts/detect-ci-changes.mjs']);
  assert.equal(result.should_validate, true);
  assert.equal(result.should_browser_smoke, false);
});
