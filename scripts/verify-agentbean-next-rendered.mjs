#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome, openPage } from './smoke-agentbean-next-browser.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CHECK_TYPES = new Set([
  'visible',
  'hidden',
  'text',
  'attribute',
  'page-no-horizontal-overflow',
  'horizontal-overflow-contained',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} 包含未知字段：${unknown.join(', ')}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return value;
}

function validateContractRef(value, label, sourceById) {
  const ref = assertObject(value, label);
  assertExactKeys(ref, ['sourceId', 'anchor'], label);
  assertNonEmptyString(ref.sourceId, `${label}.sourceId`);
  assertNonEmptyString(ref.anchor, `${label}.anchor`);
  const source = sourceById.get(ref.sourceId);
  if (!source) {
    throw new Error(`${label}.sourceId 未声明：${ref.sourceId}`);
  }
  if (!source.anchors.includes(ref.anchor)) {
    throw new Error(`${label}.anchor 不在 source ${ref.sourceId} 的 anchors 中`);
  }
  return { sourceId: ref.sourceId, anchor: ref.anchor };
}

export function validateRenderedAcceptanceContract(rawContract) {
  const contract = assertObject(rawContract, 'contract');
  assertExactKeys(contract, ['schemaVersion', 'name', 'sources', 'allowedOrigins', 'viewports', 'ready', 'checks'], 'contract');
  if (contract.schemaVersion !== 1) {
    throw new Error('contract.schemaVersion 必须为 1');
  }
  assertNonEmptyString(contract.name, 'contract.name');

  if (!Array.isArray(contract.sources) || contract.sources.length === 0) {
    throw new Error('contract.sources 必须是非空数组');
  }
  const sourceIds = new Set();
  const sources = contract.sources.map((rawSource, index) => {
    const label = `contract.sources[${index}]`;
    const source = assertObject(rawSource, label);
    assertExactKeys(source, ['id', 'path', 'anchors'], label);
    const id = assertNonEmptyString(source.id, `${label}.id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || sourceIds.has(id)) {
      throw new Error(`${label}.id 必须唯一且仅包含字母、数字、下划线或连字符`);
    }
    sourceIds.add(id);
    const path = assertNonEmptyString(source.path, `${label}.path`);
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`${label}.path 必须是仓库内相对路径`);
    }
    if (!Array.isArray(source.anchors) || source.anchors.length === 0) {
      throw new Error(`${label}.anchors 必须是非空数组`);
    }
    const anchors = source.anchors.map((anchor, anchorIndex) =>
      assertNonEmptyString(anchor, `${label}.anchors[${anchorIndex}]`));
    if (new Set(anchors).size !== anchors.length) {
      throw new Error(`${label}.anchors 不得重复`);
    }
    return { id, path, anchors };
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  if (contract.allowedOrigins !== undefined && !Array.isArray(contract.allowedOrigins)) {
    throw new Error('contract.allowedOrigins 必须是数组');
  }
  const allowedOrigins = (contract.allowedOrigins ?? []).map((value, index) => {
    const url = new URL(assertNonEmptyString(value, `contract.allowedOrigins[${index}]`));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== url.href.replace(/\/$/, '')) {
      throw new Error(`contract.allowedOrigins[${index}] 必须是不含 credentials/path 的 http/https origin`);
    }
    return url.origin;
  });
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new Error('contract.allowedOrigins 不得重复');
  }

  if (!Array.isArray(contract.viewports) || contract.viewports.length < 2) {
    throw new Error('contract.viewports 至少包含 390px 与 1440px 两个视口');
  }
  const viewportIds = new Set();
  const viewports = contract.viewports.map((rawViewport, index) => {
    const label = `contract.viewports[${index}]`;
    const viewport = assertObject(rawViewport, label);
    assertExactKeys(viewport, ['id', 'width', 'height'], label);
    const id = assertNonEmptyString(viewport.id, `${label}.id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || viewportIds.has(id)) {
      throw new Error(`${label}.id 必须唯一且可安全用于证据文件名`);
    }
    viewportIds.add(id);
    return {
      id,
      width: assertPositiveInteger(viewport.width, `${label}.width`),
      height: assertPositiveInteger(viewport.height, `${label}.height`),
    };
  });
  for (const requiredWidth of [390, 1440]) {
    if (!viewports.some((viewport) => viewport.width === requiredWidth)) {
      throw new Error(`contract.viewports 缺少 ${requiredWidth}px 视口`);
    }
  }

  const ready = assertObject(contract.ready, 'contract.ready');
  assertExactKeys(ready, ['selector', 'timeoutMs'], 'contract.ready');
  const validatedReady = {
    selector: assertNonEmptyString(ready.selector, 'contract.ready.selector'),
    timeoutMs: ready.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : assertPositiveInteger(ready.timeoutMs, 'contract.ready.timeoutMs'),
  };

  if (!Array.isArray(contract.checks) || contract.checks.length === 0) {
    throw new Error('contract.checks 必须是非空数组');
  }
  const checkIds = new Set();
  const checks = contract.checks.map((rawCheck, index) => {
    const label = `contract.checks[${index}]`;
    const check = assertObject(rawCheck, label);
    assertExactKeys(check, ['id', 'type', 'selector', 'expected', 'attribute', 'viewports', 'contractRef'], label);
    const id = assertNonEmptyString(check.id, `${label}.id`);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || checkIds.has(id)) {
      throw new Error(`${label}.id 必须唯一且仅包含字母、数字、下划线或连字符`);
    }
    checkIds.add(id);
    if (!CHECK_TYPES.has(check.type)) {
      throw new Error(`${label}.type 不受支持：${check.type}`);
    }
    if (check.type !== 'page-no-horizontal-overflow') {
      assertNonEmptyString(check.selector, `${label}.selector`);
    } else if (check.selector !== undefined) {
      throw new Error(`${label}.selector 不适用于 page-no-horizontal-overflow`);
    }
    if (check.type === 'text') {
      assertNonEmptyString(check.expected, `${label}.expected`);
    } else if (check.type === 'attribute') {
      assertNonEmptyString(check.attribute, `${label}.attribute`);
      assertNonEmptyString(check.expected, `${label}.expected`);
    } else if (check.expected !== undefined || check.attribute !== undefined) {
      throw new Error(`${label}.expected/attribute 只适用于 text 或 attribute`);
    }
    if (check.viewports !== undefined && !Array.isArray(check.viewports)) {
      throw new Error(`${label}.viewports 必须是数组`);
    }
    const scopedViewports = check.viewports === undefined
      ? viewports.map((viewport) => viewport.id)
      : check.viewports.map((viewportId, viewportIndex) => {
        const value = assertNonEmptyString(viewportId, `${label}.viewports[${viewportIndex}]`);
        if (!viewportIds.has(value)) {
          throw new Error(`${label}.viewports 引用了未知视口：${value}`);
        }
        return value;
      });
    if (scopedViewports.length === 0 || new Set(scopedViewports).size !== scopedViewports.length) {
      throw new Error(`${label}.viewports 必须非空且不得重复`);
    }
    return {
      id,
      type: check.type,
      ...(check.selector === undefined ? {} : { selector: check.selector }),
      ...(check.expected === undefined ? {} : { expected: check.expected }),
      ...(check.attribute === undefined ? {} : { attribute: check.attribute }),
      viewports: scopedViewports,
      contractRef: validateContractRef(check.contractRef, `${label}.contractRef`, sourceById),
    };
  });

  return {
    schemaVersion: 1,
    name: contract.name,
    sources,
    allowedOrigins,
    viewports,
    ready: validatedReady,
    checks,
  };
}

export function assertAcceptanceSources(contract, { repoRoot = process.cwd() } = {}) {
  const root = resolve(repoRoot);
  const realRoot = realpathSync(root);
  return contract.sources.map((source) => {
    const sourcePath = resolve(root, source.path);
    if (!existsSync(sourcePath)) {
      throw new Error(`验收来源不存在或越出仓库：${source.path}`);
    }
    const realSourcePath = realpathSync(sourcePath);
    const pathFromRoot = relative(realRoot, realSourcePath);
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      throw new Error(`验收来源不存在或越出仓库：${source.path}`);
    }
    const content = readFileSync(sourcePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const anchors = source.anchors.map((anchor) => {
      const matches = [];
      for (let index = content.indexOf(anchor); index !== -1; index = content.indexOf(anchor, index + anchor.length)) {
        matches.push(index);
      }
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `验收来源 ${source.path} 缺少锚点：${anchor}`
            : `验收来源 ${source.path} 的锚点不唯一：${anchor}`,
        );
      }
      const line = content.slice(0, matches[0]).split(/\r?\n/).length;
      const context = lines.slice(Math.max(0, line - 2), Math.min(lines.length, line + 1)).join('\n');
      return {
        text: anchor,
        line,
        contextSha256: createHash('sha256').update(context).digest('hex'),
      };
    });
    return { id: source.id, path: source.path, anchors, ok: true };
  });
}

export function validateRenderedSession(rawSession, targetUrl) {
  if (rawSession === undefined) return undefined;
  const session = assertObject(rawSession, 'session');
  assertExactKeys(session, ['schemaVersion', 'origin', 'localStorage'], 'session');
  if (session.schemaVersion !== 1) throw new Error('session.schemaVersion 必须为 1');
  const origin = new URL(assertNonEmptyString(session.origin, 'session.origin'));
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== origin.href.replace(/\/$/, '')) {
    throw new Error('session.origin 必须是 http/https origin，不得包含路径');
  }
  if (origin.origin !== targetUrl.origin) {
    throw new Error('session.origin 必须与目标页面同源');
  }
  const localStorage = assertObject(session.localStorage, 'session.localStorage');
  const entries = Object.entries(localStorage);
  if (entries.length === 0) throw new Error('session.localStorage 不得为空');
  for (const [key, value] of entries) {
    assertNonEmptyString(key, 'session.localStorage key');
    if (typeof value !== 'string') throw new Error(`session.localStorage.${key} 必须是字符串`);
  }
  return { schemaVersion: 1, origin: origin.origin, localStorage: Object.fromEntries(entries) };
}

export function normalizeRenderedTarget(input) {
  const url = new URL(assertNonEmptyString(input, 'targetUrl'));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('targetUrl 必须使用 http 或 https');
  }
  if (url.username || url.password) {
    throw new Error('targetUrl 不得包含 URL credentials');
  }
  return url;
}

export function isReadOnlyRequest(method) {
  return READ_ONLY_METHODS.has(String(method || '').toUpperCase());
}

function requestOrigin(input) {
  try {
    return new URL(input).origin;
  } catch {
    return '<invalid-origin>';
  }
}

function isLoopbackTarget(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function targetWebSocketOrigin(httpOrigin) {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

function evidenceUrl(input) {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export async function installReadOnlyNetworkGuard(page, { allowedOrigins = [] } = {}) {
  const allowedOriginSet = new Set(allowedOrigins);
  const allowed = [];
  const blockedWriteRequests = [];
  const blockedExternalRequests = [];
  const pending = new Set();
  const errors = [];
  const unsubscribe = page.on('Fetch.requestPaused', (params) => {
    const task = (async () => {
      const method = String(params.request?.method || '').toUpperCase();
      const record = { method, url: evidenceUrl(params.request?.url) };
      if (!allowedOriginSet.has(requestOrigin(params.request?.url))) {
        blockedExternalRequests.push(record);
        await page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' });
        return;
      }
      if (isReadOnlyRequest(method)) {
        allowed.push(record);
        await page.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      blockedWriteRequests.push(record);
      await page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' });
    })();
    pending.add(task);
    void task.catch((error) => errors.push(error)).finally(() => pending.delete(task));
    return task;
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return {
    allowed,
    blockedWriteRequests,
    blockedExternalRequests,
    async drain() {
      await Promise.allSettled([...pending]);
      if (errors.length > 0) {
        throw new AggregateError(errors, '只读网络拦截器处理请求失败');
      }
    },
    async close() {
      const failures = [];
      try {
        try { await this.drain(); } catch (error) { failures.push(error); }
        try { await page.send('Fetch.disable'); } catch (error) { failures.push(error); }
      } finally {
        unsubscribe?.();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, '关闭只读网络拦截器失败');
      }
    },
  };
}

function buildSessionSeedScript(session) {
  if (!session) return undefined;
  return `
    (() => {
      if (location.origin !== ${JSON.stringify(session.origin)}) return;
      const values = ${JSON.stringify(session.localStorage)};
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    })()
  `;
}

export function buildRenderedCheckExpression(checks) {
  return `
    (() => {
      const checks = ${JSON.stringify(checks)};
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      return checks.map((check) => {
        try {
          if (check.type === 'page-no-horizontal-overflow') {
            const root = document.documentElement;
            const body = document.body;
            const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
            const scrollWidth = Math.max(root.scrollWidth, body?.scrollWidth ?? 0);
            const actual = { scrollWidth, viewportWidth };
            return { ...check, ok: actual.scrollWidth <= actual.viewportWidth + 1, actual };
          }
          const element = document.querySelector(check.selector);
          const isVisible = visible(element);
          if (check.type === 'horizontal-overflow-contained') {
            const style = element ? getComputedStyle(element) : null;
            const hasOverflow = Boolean(element && element.scrollWidth > element.clientWidth + 1);
            const overflowMode = style?.overflowX ?? null;
            const contained = !hasOverflow || overflowMode === 'auto' || overflowMode === 'scroll';
            return { ...check, ok: isVisible && contained, actual: { visible: isVisible, hasOverflow, overflowMode } };
          }
          if (check.type === 'visible') return { ...check, ok: isVisible, actual: { exists: Boolean(element), visible: isVisible } };
          if (check.type === 'hidden') return { ...check, ok: !isVisible, actual: { exists: Boolean(element), visible: isVisible } };
          if (check.type === 'text') {
            const text = element?.textContent?.trim() ?? '';
            const matchesExpected = text.includes(check.expected);
            return { ...check, ok: isVisible && matchesExpected, actual: { visible: isVisible, matchesExpected, textLength: text.length } };
          }
          if (check.type === 'attribute') {
            const value = element?.getAttribute(check.attribute) ?? null;
            const matchesExpected = value === check.expected;
            return { ...check, ok: isVisible && matchesExpected, actual: { visible: isVisible, matchesExpected } };
          }
          return { ...check, ok: false, error: 'unsupported check type' };
        } catch (error) {
          return { ...check, ok: false, error: String(error?.message ?? error) };
        }
      });
    })()
  `;
}

function redactBrowserEvents(events, session) {
  const secrets = Object.values(session?.localStorage ?? {}).filter(Boolean);
  return events.map((event) => {
    let text = String(event.text ?? '');
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED_SESSION_VALUE]');
    text = text
      .replace(/(authorization|token|secret|password)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[REDACTED]')
      .slice(0, 2_000);
    return {
      type: event.type,
      level: event.level,
      text,
      ...(event.url ? { url: evidenceUrl(event.url) } : {}),
    };
  });
}

function ensureArtifactDirectory(artifactsDir) {
  const resolved = artifactsDir
    ? resolve(artifactsDir)
    : mkdtempSync(join(tmpdir(), 'agentbean-rendered-acceptance-'));
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export async function runRenderedAcceptanceVerifier({
  contract: rawContract,
  targetUrl: rawTargetUrl,
  repoRoot = process.cwd(),
  artifactsDir,
  session: rawSession,
  chromeBin,
  headed = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowLiveTarget = false,
  preparedReadOnlySession = false,
  browserDriver = { launchChrome, openPage },
} = {}) {
  const contract = validateRenderedAcceptanceContract(rawContract);
  const sources = assertAcceptanceSources(contract, { repoRoot });
  const targetUrl = normalizeRenderedTarget(rawTargetUrl);
  const session = validateRenderedSession(rawSession, targetUrl);
  if (!isLoopbackTarget(targetUrl) && !allowLiveTarget) {
    throw new Error('远端真实页面需要显式 allowLiveTarget 授权');
  }
  if (session && !preparedReadOnlySession) {
    throw new Error('session 文件需要显式 preparedReadOnlySession 确认其只读权限与预置状态');
  }
  const allowedOrigins = [...new Set([
    targetUrl.origin,
    targetWebSocketOrigin(targetUrl.origin),
    ...contract.allowedOrigins,
  ])];
  const evidenceDir = ensureArtifactDirectory(artifactsDir);
  const browserEvents = [];
  const viewportResults = [];

  for (const viewport of contract.viewports) {
    const screenshot = join(evidenceDir, `${viewport.id}-${viewport.width}x${viewport.height}.png`);
    const browserArtifactsDir = join(evidenceDir, 'browser', viewport.id);
    mkdirSync(browserArtifactsDir, { recursive: true });
    const applicableChecks = contract.checks.filter((check) => check.viewports.includes(viewport.id));
    let chrome;
    let page;
    let guard;
    try {
      chrome = await browserDriver.launchChrome({ chromeBin, artifactsDir: browserArtifactsDir, headed, timeoutMs });
      page = await browserDriver.openPage(chrome.debugUrl, browserEvents, timeoutMs);
      guard = await installReadOnlyNetworkGuard(page, {
        allowedOrigins,
      });
      await page.setViewport(viewport);
      const sessionScript = buildSessionSeedScript(session);
      if (sessionScript) await page.addScriptOnNewDocument(sessionScript);
      await page.navigate(targetUrl.href);
      await page.waitForFunction(
        `(() => { const element = document.querySelector(${JSON.stringify(contract.ready.selector)}); if (!element) return false; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0; })()`,
        `ready selector ${contract.ready.selector}`,
        Math.min(contract.ready.timeoutMs, timeoutMs),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const checks = await page.evaluateJson(buildRenderedCheckExpression(applicableChecks));
      await guard.drain();
      await page.screenshot(screenshot);
      const blockedWriteRequests = [...guard.blockedWriteRequests];
      const blockedExternalRequests = [...guard.blockedExternalRequests];
      const allowedReadRequestCount = guard.allowed.length;
      await guard.close();
      guard = undefined;
      viewportResults.push({
        ...viewport,
        ok: checks.every((check) => check.ok)
          && blockedWriteRequests.length === 0
          && blockedExternalRequests.length === 0,
        checks,
        network: { blockedWriteRequests, blockedExternalRequests, allowedReadRequestCount },
        screenshot,
        screenshotSha256: createHash('sha256').update(readFileSync(screenshot)).digest('hex'),
      });
    } catch (error) {
      let guardError;
      if (guard) {
        try { await guard.close(); } catch (failure) { guardError = String(failure?.message ?? failure); }
      }
      if (page) {
        try { await page.screenshot(screenshot); } catch { /* preserve the original verifier failure */ }
      }
      viewportResults.push({
        ...viewport,
        ok: false,
        checks: [],
        network: {
          blockedWriteRequests: [...(guard?.blockedWriteRequests ?? [])],
          blockedExternalRequests: [...(guard?.blockedExternalRequests ?? [])],
          allowedReadRequestCount: guard?.allowed.length ?? 0,
        },
        screenshot: existsSync(screenshot) ? screenshot : null,
        error: String(error?.message ?? error),
        ...(guardError ? { guardError } : {}),
      });
    } finally {
      try { await page?.close(); } catch { /* report the verifier result even if CDP cleanup fails */ }
      try { await chrome?.close(); } catch { /* the per-viewport profile is already isolated */ }
    }
  }

  const report = {
    schemaVersion: 1,
    verifier: 'agentbean-rendered-acceptance',
    contract: { name: contract.name, sources },
    target: evidenceUrl(targetUrl.href),
    readOnlyPolicy: {
      verifierInteractions: 'navigate-and-observe-only',
      allowedHttpMethods: [...READ_ONLY_METHODS],
      allowedOrigins,
      liveTargetAuthorized: !isLoopbackTarget(targetUrl) && allowLiveTarget,
      preparedReadOnlySessionConfirmed: Boolean(session && preparedReadOnlySession),
      websocketBoundary: 'page-owned frames are not classified; use a prepared observation session',
    },
    ok: viewportResults.every((viewport) => viewport.ok),
    viewports: viewportResults,
    artifacts: {
      dir: evidenceDir,
      report: join(evidenceDir, 'rendered-acceptance-report.json'),
      browserEvents: join(evidenceDir, 'browser-events.json'),
    },
  };
  writeFileSync(report.artifacts.browserEvents, `${JSON.stringify(redactBrowserEvents(browserEvents, session), null, 2)}\n`);
  writeFileSync(report.artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function formatRenderedAcceptanceText(report) {
  const lines = [
    report.ok
      ? `真实渲染验收通过：${report.contract.name}`
      : `真实渲染验收未通过：${report.contract.name}`,
    `目标：${report.target}`,
  ];
  for (const viewport of report.viewports) {
    lines.push(`${viewport.ok ? 'PASS' : 'FAIL'} ${viewport.id} (${viewport.width}x${viewport.height})`);
    for (const check of viewport.checks) {
      lines.push(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
    }
    if (viewport.network.blockedWriteRequests.length > 0) {
      lines.push(`  BLOCKED ${viewport.network.blockedWriteRequests.length} 个非只读 HTTP 请求`);
    }
    if (viewport.network.blockedExternalRequests.length > 0) {
      lines.push(`  BLOCKED ${viewport.network.blockedExternalRequests.length} 个未声明跨域请求`);
    }
    if (viewport.error) lines.push(`  ERROR ${viewport.error}`);
  }
  lines.push(`证据：${report.artifacts.dir}`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const args = { json: false, headed: false, allowLiveTarget: false, preparedReadOnlySession: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { args.json = true; continue; }
    if (arg === '--headed') { args.headed = true; continue; }
    if (arg === '--allow-live-target') { args.allowLiveTarget = true; continue; }
    if (arg === '--prepared-read-only-session') { args.preparedReadOnlySession = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`缺少 ${arg} 的值`);
    if (arg === '--contract') args.contract = value;
    else if (arg === '--url') args.url = value;
    else if (arg === '--session-file') args.sessionFile = value;
    else if (arg === '--artifacts-dir') args.artifactsDir = value;
    else if (arg === '--chrome-bin') args.chromeBin = value;
    else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(value);
      if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) {
        throw new Error('--timeout-ms 必须是正整数');
      }
    }
    else throw new Error(`未知参数：${arg}`);
    index += 1;
  }
  return args;
}

function usage() {
  return [
    '用法：npm run verify:agentbean-next-rendered -- --contract <json> --url <真实页面> [选项]',
    '选项：--session-file <json> --artifacts-dir <dir> --chrome-bin <path> --timeout-ms <ms> --allow-live-target --prepared-read-only-session --headed --json',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      if (!args.contract || !args.url) throw new Error('--contract 与 --url 均为必填');
      const contract = JSON.parse(readFileSync(resolve(args.contract), 'utf8'));
      const session = args.sessionFile
        ? JSON.parse(readFileSync(resolve(args.sessionFile), 'utf8'))
        : undefined;
      const report = await runRenderedAcceptanceVerifier({
        contract,
        targetUrl: args.url,
        session,
        artifactsDir: args.artifactsDir,
        chromeBin: args.chromeBin,
        headed: args.headed,
        timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined,
        allowLiveTarget: args.allowLiveTarget,
        preparedReadOnlySession: args.preparedReadOnlySession,
      });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatRenderedAcceptanceText(report));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(`真实渲染验收器失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
