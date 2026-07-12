import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregatePiSeaVerdicts,
  createPendingPiSeaVerdict,
  validatePiSeaVerdict,
} from './check-pi-management-sea.mjs';

const compatibleLinux = {
  schemaVersion: 1,
  os: 'linux',
  arch: 'x64',
  nodeVersion: '26.5.0',
  piVersion: '0.80.6',
  status: 'compatible',
  checks: [
    'runner-platform',
    'node-version',
    'pi-version',
    'bundle',
    'executable-build',
    'platform-signature',
    'executable-run',
    'sea-smoke',
  ].map((id) => ({ id, ok: true })),
};
const checker = fileURLToPath(new URL('./check-pi-management-sea.mjs', import.meta.url));

test('accepts only the exact versioned per-platform verdict contract', () => {
  assert.deepEqual(validatePiSeaVerdict(compatibleLinux), { ok: true, verdict: compatibleLinux });
  for (const invalid of [
    { ...compatibleLinux, schemaVersion: 2 },
    { ...compatibleLinux, nodeVersion: '26.4.0' },
    { ...compatibleLinux, piVersion: '0.80.5' },
    { ...compatibleLinux, os: 'darwin' },
    { ...compatibleLinux, arch: 'armv7' },
    { ...compatibleLinux, status: 'unknown' },
    { ...compatibleLinux, checks: [] },
    { ...compatibleLinux, checks: [{ id: 'runtime-session', ok: false }] },
    { ...compatibleLinux, checks: [{ id: 'sea-smoke', ok: true }] },
    { ...compatibleLinux, checks: [...compatibleLinux.checks, compatibleLinux.checks[0]] },
    { ...compatibleLinux, extra: true },
  ]) {
    assert.equal(validatePiSeaVerdict(invalid).ok, false);
  }
});

test('pending verdict is fail-closed and contains no runtime data', () => {
  assert.deepEqual(createPendingPiSeaVerdict({ os: 'windows', arch: 'x64' }), {
    schemaVersion: 1,
    os: 'windows',
    arch: 'x64',
    nodeVersion: '26.5.0',
    piVersion: '0.80.6',
    status: 'blocked-for-phase5',
    checks: [{ id: 'sea-smoke', ok: false, diagnosticCode: 'SEA_VERDICT_NOT_FINALIZED' }],
  });
});

test('aggregator reports compatible only when every expected platform is uniquely Green', () => {
  const mac = { ...compatibleLinux, os: 'macos', arch: 'arm64' };
  const windows = { ...compatibleLinux, os: 'windows' };
  assert.deepEqual(
    aggregatePiSeaVerdicts([compatibleLinux, mac, windows]),
    {
      schemaVersion: 1,
      status: 'compatible',
      expectedPlatforms: ['linux:x64', 'macos:arm64', 'windows:x64'],
      verdicts: [compatibleLinux, mac, windows],
      diagnosticCodes: [],
    },
  );
});

test('aggregator writes a blocked verdict for missing, duplicate, invalid, or blocked platforms', () => {
  const blocked = { ...compatibleLinux, status: 'blocked-for-phase5', checks: [
    { id: 'sea-smoke', ok: false, diagnosticCode: 'SEA_EXECUTABLE_FAILED' },
  ] };
  const result = aggregatePiSeaVerdicts([blocked, compatibleLinux, { malformed: true }]);
  assert.equal(result.status, 'blocked-for-phase5');
  assert.deepEqual(result.expectedPlatforms, ['linux:x64', 'macos:arm64', 'windows:x64']);
  assert.equal(result.verdicts.length, 3);
  assert.deepEqual(result.diagnosticCodes, [
    'SEA_DUPLICATE_PLATFORM_VERDICT',
    'SEA_INVALID_PLATFORM_VERDICT',
    'SEA_MISSING_PLATFORM_VERDICT',
  ]);
});

test('aggregator blocks otherwise-valid verdicts for an unexpected platform', () => {
  const unexpected = { ...compatibleLinux, os: 'linux', arch: 'arm64' };
  const result = aggregatePiSeaVerdicts([
    compatibleLinux,
    { ...compatibleLinux, os: 'macos', arch: 'arm64' },
    { ...compatibleLinux, os: 'windows' },
    unexpected,
  ]);
  assert.equal(result.status, 'blocked-for-phase5');
  assert.deepEqual(result.diagnosticCodes, ['SEA_UNEXPECTED_PLATFORM_VERDICT']);
});

test('root compatibility consumer fails a valid blocked verdict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentbean-pi-sea-consumer-'));
  const verdictPath = join(directory, 'verdict.json');
  try {
    writeFileSync(verdictPath, JSON.stringify(compatibleLinux));
    assert.equal(spawnSync(process.execPath, [checker, 'validate', '--file', verdictPath]).status, 0);

    writeFileSync(verdictPath, JSON.stringify({
      ...compatibleLinux,
      status: 'blocked-for-phase5',
      checks: [{ id: 'sea-smoke', ok: false, diagnosticCode: 'SEA_RUNTIME_SMOKE_FAILED' }],
    }));
    assert.equal(spawnSync(process.execPath, [checker, 'validate', '--file', verdictPath]).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow runs native three-platform SEA jobs and always aggregates real verdict artifacts', () => {
  const workflow = readFileSync('.github/workflows/pi-sea-compatibility.yml', 'utf8');
  for (const required of [
    'node-version: 26.5.0',
    'runner: ubuntu-latest',
    'runner: macos-14',
    'runner: windows-latest',
    'verdict_os: linux',
    'verdict_os: macos',
    'verdict_os: windows',
    'fail-fast: false',
    'Initialize fail-closed platform verdict',
    'Build and execute PI management SEA',
    'Upload platform verdict',
    'Aggregate fail-closed verdict',
    'Upload aggregate verdict',
    'npm run check:pi-sea-compatibility -- --file artifacts/pi-sea-verdict/verdict.json',
    '- packages/contracts/**',
    '- packages/domain/**',
  ]) {
    assert.ok(workflow.includes(required), `missing workflow contract: ${required}`);
  }
  assert.equal(workflow.includes('continue-on-error'), false);
  assert.ok(workflow.match(/if: always\(\)/g)?.length >= 4);
  assert.doesNotMatch(workflow, /name: Build and execute PI management SEA\n\s+if: always\(\)/);
  assert.match(
    workflow,
    /name: Consume platform verdict through root gate\r?\n\s+if: always\(\)/,
  );
  assert.match(
    workflow.replaceAll('\n', '\r\n'),
    /name: Consume platform verdict through root gate\r?\n\s+if: always\(\)/,
  );
});
