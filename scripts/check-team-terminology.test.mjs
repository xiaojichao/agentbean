import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-team-terminology.mjs', import.meta.url));
const forbiddenCases = [
  ['product-network-id.ts', 'const payload = { networkId: "x" };', 'product identifier'],
  ['product-network-ids.ts', 'const payload = { networkIds: ["x"] };', 'product identifier'],
  ['product-network-name.ts', 'const payload = { networkName: "x" };', 'product identifier'],
  ['product-network-path.ts', 'const payload = { networkPath: "x" };', 'product identifier'],
  ['visibility-published.ts', 'const payload = { publishedNetworkIds: ["x"] };', 'visibility identifier'],
  ['visibility-unpublished.ts', 'const payload = { unpublishedNetworkIds: ["x"] };', 'visibility identifier'],
  ['admin-list-singular.ts', 'const operation = "listNetwork";', 'admin identifier'],
  ['admin-list-plural.ts', 'const operation = "listNetworks";', 'admin identifier'],
  ['admin-delete-singular.ts', 'const operation = "deleteNetwork";', 'admin identifier'],
  ['admin-delete-plural.ts', 'const operation = "deleteNetworks";', 'admin identifier'],
  ['pascal-network.ts', 'const resource = "Network";', 'Pascal/camel identifier'],
  ['pascal-dialog.ts', 'const dialog = "NetworkDialog";', 'Pascal/camel identifier'],
  ['socket-event.ts', 'const event = "network:list";', 'socket event'],
  ['admin-event-list-singular.ts', 'const event = "admin:list-network";', 'admin event'],
  ['admin-event-list-plural.ts', 'const event = "admin:list-networks";', 'admin event'],
  ['admin-event-delete-singular.ts', 'const event = "admin:delete-network";', 'admin event'],
  ['admin-event-delete-plural.ts', 'const event = "admin:delete-networks";', 'admin event'],
  ['http-route.ts', 'const path = "/api/networks/x";', 'HTTP route'],
  ['browser-key.ts', 'localStorage.setItem("agentbean.networkPath", "x");', 'browser key'],
  ['resource-table.sql', 'CREATE TABLE networks (id TEXT);', 'resource/table'],
  ['schema-network-id.sql', 'CREATE TABLE teams (network_id TEXT);', 'schema column'],
  ['schema-current-network-id.sql', 'CREATE TABLE users (current_network_id TEXT);', 'schema column'],
  ['schema-primary-network-id.sql', 'CREATE TABLE agents (primary_network_id TEXT);', 'schema column'],
  ['schema-members.sql', 'CREATE TABLE network_members (id TEXT);', 'schema table'],
  ['dependency.md', 'Tailscale is the collaboration boundary.', 'removed product dependency'],
];

function runChecker(...paths) {
  return spawnSync(process.execPath, [checker, ...paths], { encoding: 'utf8' });
}

test('rejects every forbidden product-space token family', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    for (const [name, source, expectedRule] of forbiddenCases) {
      const file = join(dir, name);
      writeFileSync(file, source);
      const result = runChecker(file);
      assert.equal(result.status, 1, `${name} should fail: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${name}:1:${expectedRule}:`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts canonical Team tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    const file = join(dir, 'team.ts');
    writeFileSync(file, 'const team = { teamId: "t", teamPath: "ops", currentTeamId: "t" };');
    const result = runChecker(file);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recursively scans directories and reports file, line, and rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    const file = join(dir, 'nested', 'payload.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'const ok = true;\nconst payload = { networkName: "old" };\n');
    const result = runChecker(dir);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /payload\.ts:2:product identifier:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not apply the default Release A allowlist to explicitly requested roots', () => {
  const allowlistedFile = join(
    dirname(checker),
    '..',
    'apps',
    'web-next',
    'lib',
    'team-path.ts',
  );
  const result = runChecker(allowlistedFile);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /team-path\.ts:\d+:(?:product identifier|browser key):/);
});

test('ignores generated TypeScript build metadata during recursive scans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{"diagnostic":"networkId"}');
    const result = runChecker(dir);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI change detection covers the default scan roots and checker files', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8');
  const regexSource = workflow.match(/next_changed_files=.*grep -E '([^']+)' \|\| true\)"/)?.[1];
  assert.ok(regexSource, 'AgentBean Next changed-files regex should be extractable');

  for (const path of [
    'packages/contracts/src/index.ts',
    'packages/contracts/tests/contracts.test.ts',
    'apps/server-next/src/index.ts',
    'apps/server-next/tests/readiness-check.test.ts',
    'apps/web-next/lib/socket.ts',
    'apps/daemon-next/src/index.ts',
    'apps/daemon-next/tests/protocol-client.test.ts',
    'scripts/check-agentbean-next-readiness.mjs',
    'scripts/smoke-agentbean-next-browser.mjs',
    'scripts/audit-agentbean-next-cutover.mjs',
    'scripts/check-agentbean-next-railway-preflight.mjs',
    'scripts/prepare-agentbean-next-daemon-release.mjs',
    'scripts/check-team-terminology.mjs',
    'scripts/check-team-terminology.test.mjs',
    '.github/workflows/ci-cd.yml',
    'package.json',
    'railway.json',
    'README.md',
    'agentbean-next/docs/verification-matrix.md',
    'docs/superpowers/specs/current.md',
  ]) {
    const result = spawnSync('grep', ['-E', regexSource, '-'], { input: `${path}\n`, encoding: 'utf8' });
    assert.equal(result.status, 0, `${path} must trigger AgentBean Next validation: ${result.stderr}`);
  }
});
