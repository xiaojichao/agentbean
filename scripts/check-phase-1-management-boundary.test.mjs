import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-phase-1-management-boundary.mjs', import.meta.url));

function write(root, path, source) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker, '--workspace-root', root], { encoding: 'utf8' });
}

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-phase-1-boundary-'));
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scaffoldRuntimeSlice(root, options = {}) {
  const runtimeVersion = options.runtimeVersion ?? '0.1.0';
  write(root, 'packages/pi-management-runtime/package.json', JSON.stringify({
    name: '@agentbean/pi-management-runtime',
    version: runtimeVersion,
    private: options.private ?? false,
    files: ['dist/**/*.js', 'dist/index.d.ts', 'dist/types.d.ts'],
    scripts: { prepublishOnly: 'npm run build' },
    dependencies: {
      '@earendil-works/pi-ai': '0.80.6',
      '@earendil-works/pi-coding-agent': '0.80.6',
    },
  }));
  write(root, 'apps/daemon-next/package.json', JSON.stringify({
    name: '@agentbean/daemon-next',
    version: '0.3.7',
    dependencies: {
      '@agentbean/pi-management-runtime': options.daemonRuntimeVersion ?? runtimeVersion,
    },
  }));
  write(root, 'packages/pi-management-runtime/src/types.ts', [
    'export const PHASE_1_MANAGEMENT_TOOL_NAMES = [];',
    'export interface ManagementSessionContextV1 {}',
  ].join('\n'));
}

function scaffoldFutureBoundaries(root) {
  for (const path of [
    'packages/contracts/src/management-worker.ts',
    'apps/server-next/src/infra/sqlite/migrations/team/0010_management_phase_1.sql',
    'apps/server-next/src/application/management/management-kernel.ts',
    'apps/daemon-next/src/pi-manager-worker-host.ts',
  ]) {
    write(root, path, '// scaffolded\n');
  }
}

test('reports the runtime/package slice as not ready before it is publishable', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root, { private: true });
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_RUNTIME_PACKAGE_INVALID/);
  });
});

test('reports future Phase 1 boundaries as explicitly not implemented after the runtime slice is ready', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_NOT_IMPLEMENTED:.*management-worker\.ts/);
    assert.match(result.stdout, /P1_RUNTIME_PACKAGE_READY/);
  });
});

test('passes when runtime/package and future management boundaries are present', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root);
    scaffoldFutureBoundaries(root);
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test('rejects imprecise daemon runtime dependencies', () => {
  withFixture((root) => {
    scaffoldRuntimeSlice(root, { daemonRuntimeVersion: '^0.1.0' });
    scaffoldFutureBoundaries(root);
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P1_DAEMON_RUNTIME_VERSION/);
  });
});
