import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertNode24,
  collectChangedFiles,
  executePreflight,
  planChangedPreflight,
} from './run-changed-preflight.mjs';

const scriptPath = fileURLToPath(new URL('./run-changed-preflight.mjs', import.meta.url));

test('plans matching tests and builds for one package surface', () => {
  const plan = planChangedPreflight([
    'apps/server-next/src/application/usecases.ts',
    'docs/notes.md',
  ]);
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.targets, ['server-next']);
  assert.deepEqual(plan.commands.map((command) => command.display), [
    'npm run test:server-next-ci',
    'npm run build:server-next',
  ]);
});

test('deduplicates commands while preserving canonical package order', () => {
  const plan = planChangedPreflight([
    'apps/web-next/app/page.tsx',
    'apps/daemon-next/src/executor.ts',
    'apps/web-next/tests/page.test.tsx',
  ]);
  assert.equal(plan.mode, 'targeted');
  assert.deepEqual(plan.targets, ['daemon-next', 'web-next']);
  assert.deepEqual(plan.commands.map((command) => command.id), [
    'test:daemon-next',
    'build:daemon-next',
    'test:web-next',
    'build:web-next',
  ]);
});

test('docs-only changes are an explicit package preflight no-op', () => {
  const plan = planChangedPreflight(['CHANGELOG.md', 'docs/agents/example.md']);
  assert.equal(plan.mode, 'none');
  assert.equal(plan.commands.length, 0);
  assert.match(plan.reason, /不涉及 package/);
});

test('shared packages, CI validate surfaces and unknown paths fail safe to full checks', () => {
  for (const file of [
    'packages/contracts/src/index.ts',
    'package.json',
    'README.md',
    'docs/superpowers/specs/example.md',
    'scripts/example.mjs',
    'tests/root-contract.test.ts',
  ]) {
    const plan = planChangedPreflight([file]);
    assert.equal(plan.mode, 'full');
    assert.deepEqual(plan.commands.map((command) => command.id), ['test:ci', 'build:packages']);
    assert.deepEqual(plan.fallbackFiles, [file]);
  }
});

test('collects committed, staged, unstaged, untracked, deleted, renamed and type changes from git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-changed-preflight-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'preflight@example.com');
    git('config', 'user.name', 'Preflight Test');
    mkdirSync(join(directory, 'apps/server-next/src'), { recursive: true });
    mkdirSync(join(directory, 'docs'), { recursive: true });
    writeFileSync(join(directory, 'apps/server-next/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(directory, 'apps/server-next/src/renamed.ts'), 'export const renamed = true;\n');
    writeFileSync(join(directory, 'apps/server-next/src/type-change.ts'), 'export const regular = true;\n');
    writeFileSync(join(directory, 'docs/base.md'), 'base\n');
    writeFileSync(join(directory, 'docs/delete.md'), 'delete me\n');
    git('add', '--', 'apps/server-next/src/a.ts', 'apps/server-next/src/renamed.ts', 'apps/server-next/src/type-change.ts', 'docs/base.md', 'docs/delete.md');
    git('commit', '--quiet', '-m', 'base');
    git('tag', 'preflight-base');

    writeFileSync(join(directory, 'apps/server-next/src/a.ts'), 'export const a = 2;\n');
    git('add', '--', 'apps/server-next/src/a.ts');
    git('commit', '--quiet', '-m', 'branch change');
    writeFileSync(join(directory, 'apps/server-next/src/a.ts'), 'export const a = 3;\n');
    writeFileSync(join(directory, 'docs/base.md'), 'staged\n');
    rmSync(join(directory, 'docs/delete.md'));
    git('mv', 'apps/server-next/src/renamed.ts', 'docs/renamed.ts');
    const symlinkBlob = git('hash-object', '-w', 'apps/server-next/src/a.ts').trim();
    git('update-index', '--cacheinfo', `120000,${symlinkBlob},apps/server-next/src/type-change.ts`);
    git('add', '--', 'docs/base.md');
    git('add', '--update', '--', 'docs/delete.md');
    mkdirSync(join(directory, 'packages/domain/src'), { recursive: true });
    writeFileSync(join(directory, 'packages/domain/src/new.ts'), 'export const value = 1;\n');

    assert.deepEqual(collectChangedFiles({ base: 'preflight-base', cwd: directory }), [
      'apps/server-next/src/a.ts',
      'apps/server-next/src/renamed.ts',
      'apps/server-next/src/type-change.ts',
      'docs/base.md',
      'docs/delete.md',
      'docs/renamed.ts',
      'packages/domain/src/new.ts',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI plan mode prints commands without executing them', () => {
  const output = execFileSync(process.execPath, [
    scriptPath,
    '--plan',
    'apps/server-next/src/example.ts',
  ], { encoding: 'utf8' });
  assert.match(output, /AgentBean changed preflight：targeted/);
  assert.match(output, /npm run test:server-next-ci/);
});

test('CLI rejects unknown arguments and a missing base ref', () => {
  for (const args of [['--wat'], ['--base']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHANGED_PREFLIGHT_ERROR:/);
  }
});

test('Node 24 guard rejects a different major version', () => {
  assert.doesNotThrow(() => assertNode24('24.18.0'));
  assert.throws(() => assertNode24('26.0.0'), /需要 Node 24/);
});

test('execution stops at the first failed command', () => {
  const plan = planChangedPreflight(['apps/server-next/src/a.ts']);
  const executed = [];
  const status = executePreflight(plan, {
    run(command) {
      executed.push(command.id);
      return { status: command.id === 'test:server-next-ci' ? 7 : 0 };
    },
  });
  assert.equal(status, 7);
  assert.deepEqual(executed, ['test:server-next-ci']);
});
