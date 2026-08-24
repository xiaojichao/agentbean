import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertAcceptanceSources,
  installReadOnlyNetworkGuard,
  isReadOnlyRequest,
  parseArgs,
  runRenderedAcceptanceVerifier,
  validateRenderedAcceptanceContract,
} from './verify-agentbean-next-rendered.mjs';

function contractFixture() {
  return {
    schemaVersion: 1,
    name: 'prepared delivery review',
    sources: [
      {
        id: 'acceptance',
        path: 'docs/acceptance.md',
        anchors: ['真实页面可见', '窄屏可达'],
      },
    ],
    viewports: [
      { id: 'narrow', width: 390, height: 844 },
      { id: 'wide', width: 1440, height: 1000 },
    ],
    ready: { selector: '[data-ready="true"]', timeoutMs: 5_000 },
    checks: [
      {
        id: 'workspace-visible',
        type: 'visible',
        selector: '[data-ready="true"]',
        contractRef: { sourceId: 'acceptance', anchor: '真实页面可见' },
      },
      {
        id: 'no-page-overflow',
        type: 'page-no-horizontal-overflow',
        viewports: ['narrow'],
        contractRef: { sourceId: 'acceptance', anchor: '窄屏可达' },
      },
    ],
  };
}

function createRepoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-rendered-verifier-test-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/acceptance.md'), '# 验收\n\n真实页面可见\n\n窄屏可达\n');
  return root;
}

function fakeBrowserDriver({ writeMethod } = {}) {
  let pageIndex = 0;
  const stats = { launches: 0, closes: 0, viewports: [] };
  return {
    stats,
    async launchChrome() {
      stats.launches += 1;
      return {
        debugUrl: 'http://127.0.0.1:9222',
        close: async () => { stats.closes += 1; },
      };
    },
    async openPage(_debugUrl, events) {
      pageIndex += 1;
      const listeners = new Map();
      return {
        on(method, listener) {
          listeners.set(method, listener);
          return () => listeners.delete(method);
        },
        async send(method, params) {
          events.push({ type: 'test', level: 'info', text: `${method}:${params?.requestId ?? ''}` });
        },
        async setViewport(viewport) { stats.viewports.push({ ...viewport }); },
        async addScriptOnNewDocument(source) {
          events.push({ type: 'session', level: 'debug', text: source });
        },
        async navigate(url) {
          const requestPaused = listeners.get('Fetch.requestPaused');
          await requestPaused?.({
            requestId: `get-${pageIndex}`,
            request: { method: 'GET', url },
          });
          if (writeMethod) {
            await requestPaused?.({
              requestId: `write-${pageIndex}`,
              request: { method: writeMethod, url: `${new URL(url).origin}/api/mutate?token=secret` },
            });
          }
        },
        async waitForFunction() {},
        async evaluateJson(expression) {
          const match = expression.match(/const checks = (\[[\s\S]*?\]);\n\s+const visible/);
          assert.ok(match?.[1]);
          return JSON.parse(match[1]).map((check) => ({ ...check, ok: true, actual: {} }));
        },
        async screenshot(path) { writeFileSync(path, 'png'); },
        async close() {},
      };
    },
  };
}

test('contract requires traceable sources and both 390px and 1440px viewports', () => {
  const validated = validateRenderedAcceptanceContract(contractFixture());
  assert.deepEqual(validated.viewports.map(({ width }) => width), [390, 1440]);
  assert.equal(validated.checks[0].contractRef.sourceId, 'acceptance');

  const missingWide = contractFixture();
  missingWide.viewports = [{ id: 'narrow', width: 390, height: 844 }];
  assert.throws(() => validateRenderedAcceptanceContract(missingWide), /至少包含 390px 与 1440px/);

  const staleRef = contractFixture();
  staleRef.checks[0].contractRef.anchor = '未声明锚点';
  assert.throws(() => validateRenderedAcceptanceContract(staleRef), /不在 source acceptance 的 anchors/);
});

test('acceptance source anchors fail closed when the source drifts', () => {
  const repoRoot = createRepoFixture();
  try {
    const contract = validateRenderedAcceptanceContract(contractFixture());
    assert.equal(assertAcceptanceSources(contract, { repoRoot })[0].ok, true);
    writeFileSync(join(repoRoot, 'docs/acceptance.md'), '# 验收\n\n真实页面可见\n\n真实页面可见\n\n窄屏可达\n');
    assert.throws(() => assertAcceptanceSources(contract, { repoRoot }), /锚点不唯一：真实页面可见/);
    writeFileSync(join(repoRoot, 'docs/acceptance.md'), '# 验收\n\n真实页面可见\n');
    assert.throws(() => assertAcceptanceSources(contract, { repoRoot }), /缺少锚点：窄屏可达/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('acceptance source symlinks cannot escape the repository root', () => {
  const repoRoot = createRepoFixture();
  const externalRoot = mkdtempSync(join(tmpdir(), 'agentbean-rendered-external-'));
  try {
    const external = join(externalRoot, 'escape.md');
    writeFileSync(external, '真实页面可见\n窄屏可达\n');
    symlinkSync(external, join(repoRoot, 'docs/escape.md'));
    const raw = contractFixture();
    raw.sources[0].path = 'docs/escape.md';
    const contract = validateRenderedAcceptanceContract(raw);
    assert.throws(() => assertAcceptanceSources(contract, { repoRoot }), /越出仓库/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('checked-in workbench example remains bound to current architecture and prototype anchors', () => {
  const example = JSON.parse(readFileSync('docs/agents/rendered-acceptance-contract.example.json', 'utf8'));
  const contract = validateRenderedAcceptanceContract(example);
  assert.equal(assertAcceptanceSources(contract).every((source) => source.ok), true);
});

test('HTTP guard allows reads and aborts writes without exposing query values', async () => {
  assert.equal(isReadOnlyRequest('get'), true);
  assert.equal(isReadOnlyRequest('POST'), false);
  const sent = [];
  let listener;
  const guard = await installReadOnlyNetworkGuard({
    on(_method, value) { listener = value; },
    async send(method, params) { sent.push({ method, params }); },
  }, { allowedOrigins: ['https://example.test', 'wss://example.test'] });
  await listener({ requestId: 'read', request: { method: 'GET', url: 'https://example.test/page?token=read-secret' } });
  await listener({ requestId: 'socket', request: { method: 'GET', url: 'wss://example.test/socket.io/' } });
  await listener({ requestId: 'write', request: { method: 'POST', url: 'https://example.test/api?token=write-secret' } });
  await listener({ requestId: 'external', request: { method: 'GET', url: 'https://third-party.test/pixel?token=external-secret' } });
  await guard.close();

  assert.deepEqual(guard.allowed, [
    { method: 'GET', url: 'https://example.test/page' },
    { method: 'GET', url: 'wss://example.test/socket.io/' },
  ]);
  assert.deepEqual(guard.blockedWriteRequests, [{ method: 'POST', url: 'https://example.test/api' }]);
  assert.deepEqual(guard.blockedExternalRequests, [{ method: 'GET', url: 'https://third-party.test/pixel' }]);
  assert.ok(sent.some(({ method, params }) => method === 'Fetch.continueRequest' && params.requestId === 'read'));
  assert.ok(sent.some(({ method, params }) => method === 'Fetch.failRequest' && params.requestId === 'write'));
  assert.ok(sent.some(({ method }) => method === 'Fetch.disable'));
});

test('remote targets and session files require explicit operator confirmations', async () => {
  const repoRoot = createRepoFixture();
  try {
    await assert.rejects(
      runRenderedAcceptanceVerifier({
        contract: contractFixture(),
        targetUrl: 'https://app.example.test/team/chat',
        repoRoot,
        browserDriver: fakeBrowserDriver(),
      }),
      /allowLiveTarget/,
    );
    await assert.rejects(
      runRenderedAcceptanceVerifier({
        contract: contractFixture(),
        targetUrl: 'https://app.example.test/team/chat',
        repoRoot,
        session: {
          schemaVersion: 1,
          origin: 'https://app.example.test',
          localStorage: { 'agentbean.token': 'read-only-token' },
        },
        allowLiveTarget: true,
        browserDriver: fakeBrowserDriver(),
      }),
      /preparedReadOnlySession/,
    );
    assert.throws(() => parseArgs(['--timeout-ms', 'nope']), /正整数/);
    assert.throws(() => parseArgs(['--timeout-ms', '0']), /正整数/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('verifier records two rendered screenshots and redacts session values', async () => {
  const repoRoot = createRepoFixture();
  const artifactsDir = join(repoRoot, 'artifacts');
  const secret = 'secret-session-token';
  try {
    const browserDriver = fakeBrowserDriver();
    const report = await runRenderedAcceptanceVerifier({
      contract: contractFixture(),
      targetUrl: 'https://app.example.test/team/chat?task=123#review',
      repoRoot,
      artifactsDir,
      session: {
        schemaVersion: 1,
        origin: 'https://app.example.test',
        localStorage: { 'agentbean.token': secret },
      },
      allowLiveTarget: true,
      preparedReadOnlySession: true,
      browserDriver,
    });

    assert.equal(report.ok, true);
    assert.equal(report.target, 'https://app.example.test/team/chat');
    assert.deepEqual(report.viewports.map(({ width }) => width), [390, 1440]);
    assert.equal(browserDriver.stats.launches, 2);
    assert.equal(browserDriver.stats.closes, 2);
    assert.deepEqual(browserDriver.stats.viewports.map(({ width }) => width), [390, 1440]);
    assert.ok(report.viewports.every(({ screenshot }) => readFileSync(screenshot, 'utf8') === 'png'));
    assert.ok(report.viewports.every(({ screenshotSha256 }) => /^[a-f0-9]{64}$/.test(screenshotSha256)));
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(readFileSync(report.artifacts.browserEvents, 'utf8').includes(secret), false);
    assert.ok(readFileSync(report.artifacts.browserEvents, 'utf8').includes('[REDACTED'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('a page-originated HTTP write makes the viewport fail even when DOM checks pass', async () => {
  const repoRoot = createRepoFixture();
  try {
    const report = await runRenderedAcceptanceVerifier({
      contract: contractFixture(),
      targetUrl: 'https://app.example.test/team/chat',
      repoRoot,
      artifactsDir: join(repoRoot, 'artifacts'),
      allowLiveTarget: true,
      browserDriver: fakeBrowserDriver({ writeMethod: 'POST' }),
    });
    assert.equal(report.ok, false);
    assert.ok(report.viewports.every((viewport) => viewport.network.blockedWriteRequests[0].method === 'POST'));
    assert.equal(JSON.stringify(report).includes('token=secret'), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
