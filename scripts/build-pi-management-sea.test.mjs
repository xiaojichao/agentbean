import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertRunnerPlatform,
  bundleSeaEntry,
  createSeaConfig,
  diagnosticCodeForStage,
  normalizeSeaPlatform,
  resolvePiRuntimeVersion,
  SEA_VIRTUAL_ENTRY_URL,
} from './build-pi-management-sea.mjs';

test('uses an absolute virtual file URL on POSIX and Windows', () => {
  assert.equal(fileURLToPath(SEA_VIRTUAL_ENTRY_URL, { windows: false }), '/C:/agentbean-pi-sea/entry.cjs');
  assert.equal(fileURLToPath(SEA_VIRTUAL_ENTRY_URL, { windows: true }), 'C:\\agentbean-pi-sea\\entry.cjs');
});

test('bundles the real PI management smoke as a self-contained CommonJS entry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-pi-sea-bundle-'));
  const outfile = join(directory, 'entry.cjs');
  try {
    await bundleSeaEntry(outfile);
    const bundle = readFileSync(outfile, 'utf8');
    assert.match(bundle, /phase-0-sea-deterministic/);
    assert.doesNotMatch(bundle, /require\(["']@agentbean\/contracts["']\)/);
    assert.doesNotMatch(bundle, /require\(["']@mariozechner\/pi-agent-core["']\)/);
    const result = spawnSync(process.execPath, [outfile], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const smoke = JSON.parse(result.stdout.trim());
    assert.ok(smoke.checks.every((check) => check.ok));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes runner platforms to the verdict contract', () => {
  assert.equal(normalizeSeaPlatform('linux'), 'linux');
  assert.equal(normalizeSeaPlatform('darwin'), 'macos');
  assert.equal(normalizeSeaPlatform('win32'), 'windows');
  assert.throws(() => normalizeSeaPlatform('freebsd'), /SEA_PLATFORM_UNSUPPORTED/);
});

test('rejects a verdict platform that does not match the native runner', () => {
  assert.doesNotThrow(() => assertRunnerPlatform('macos', 'arm64', 'darwin', 'arm64'));
  assert.throws(
    () => assertRunnerPlatform('macos', 'arm64', 'darwin', 'x64'),
    /SEA_RUNNER_PLATFORM_MISMATCH/,
  );
  assert.throws(
    () => assertRunnerPlatform('linux', 'x64', 'win32', 'x64'),
    /SEA_RUNNER_PLATFORM_MISMATCH/,
  );
});

test('creates a deterministic SEA config without snapshot or code cache', () => {
  assert.deepEqual(createSeaConfig('/tmp/entry.cjs', '/tmp/agentbean-pi'), {
    main: '/tmp/entry.cjs',
    mainFormat: 'commonjs',
    output: '/tmp/agentbean-pi',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: [],
    execArgvExtension: 'none',
  });
});

test('maps every build stage to a stable diagnostic code', () => {
  assert.equal(diagnosticCodeForStage('platform'), 'SEA_RUNNER_PLATFORM_MISMATCH');
  assert.equal(diagnosticCodeForStage('node-version'), 'SEA_NODE_VERSION_MISMATCH');
  assert.equal(diagnosticCodeForStage('pi-version'), 'SEA_PI_VERSION_MISMATCH');
  assert.equal(diagnosticCodeForStage('bundle'), 'SEA_BUNDLE_FAILED');
  assert.equal(diagnosticCodeForStage('build'), 'SEA_EXECUTABLE_BUILD_FAILED');
  assert.equal(diagnosticCodeForStage('sign'), 'SEA_CODESIGN_FAILED');
  assert.equal(diagnosticCodeForStage('run'), 'SEA_EXECUTABLE_RUN_FAILED');
  assert.equal(diagnosticCodeForStage('smoke'), 'SEA_SMOKE_CONTRACT_FAILED');
  assert.equal(diagnosticCodeForStage('unknown'), 'SEA_UNKNOWN_FAILURE');
});

test('proves the bundled PI version from exact runtime and installed manifests', () => {
  const runtimeManifest = {
    dependencies: {
      '@earendil-works/pi-ai': '0.80.6',
      '@earendil-works/pi-coding-agent': '0.80.6',
    },
  };
  const installed = Array.from({ length: 4 }, () => ({ version: '0.80.6' }));
  assert.equal(resolvePiRuntimeVersion(runtimeManifest, installed), '0.80.6');
  assert.throws(
    () => resolvePiRuntimeVersion(runtimeManifest, [...installed.slice(0, 2), { version: '0.80.7' }]),
    /SEA_PI_VERSION_MISMATCH/,
  );
});
