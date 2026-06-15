#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_EVENTS = {
  device: { hello: 'device:hello', runtimes: 'device:runtimes' },
  dispatch: { request: 'dispatch:request', result: 'dispatch:result' },
};

const WEB_EVENTS = {
  auth: { register: 'auth:register', login: 'auth:login' },
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };

export async function runAgentBeanNextBrowserSmoke({
  baseUrl,
  chromeBin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  artifactsDir,
  headed = false,
  skipBuild = false,
  ioFactory = loadSocketIoClient(),
} = {}) {
  const resolvedArtifactsDir = resolve(
    artifactsDir ?? join(tmpdir(), `agentbean-next-browser-smoke-${Date.now()}`),
  );
  mkdirSync(resolvedArtifactsDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const checks = [];
  const cleanup = [];
  const browserEvents = [];
  const artifacts = {
    dir: resolvedArtifactsDir,
    consoleLog: join(resolvedArtifactsDir, 'browser-console.json'),
    screenshot: join(resolvedArtifactsDir, 'final-page.png'),
    failureScreenshot: join(resolvedArtifactsDir, 'failure-page.png'),
  };

  let page;
  let agentSocket;

  try {
    const target = baseUrl
      ? { baseUrl: normalizeBaseUrlOrThrow(baseUrl).toString(), close: async () => undefined }
      : await startLocalServer({ suffix, skipBuild, timeoutMs });
    cleanup.push(target.close);
    checks.push(check('browser-target-ready', true, `Browser smoke target is ${target.baseUrl}`));

    const seededSession = await createSmokeBrowserSession({
      baseUrl: target.baseUrl,
      ioFactory,
      suffix,
      timeoutMs,
    });
    cleanup.push(async () => {
      seededSession.socket.disconnect?.();
    });
    checks.push(check('browser-session-seeded', true, 'Created an isolated browser session for this smoke run'));

    const chrome = await launchChrome({
      chromeBin: chromeBin ?? process.env.CHROME_BIN,
      artifactsDir: resolvedArtifactsDir,
      headed,
      timeoutMs,
    });
    cleanup.push(chrome.close);
    checks.push(check('browser-chrome-ready', true, `Chrome DevTools is listening on ${chrome.debugUrl}`));

    page = await openPage(chrome.debugUrl, browserEvents);
    cleanup.push(page.close);
    await page.setViewport(DEFAULT_VIEWPORT);
    await page.addScriptOnNewDocument(`
      localStorage.setItem(
        "agentbean-next-preview-session",
        ${JSON.stringify(JSON.stringify(seededSession.session))}
      );
    `);
    await page.navigate(target.baseUrl);

    await page.waitForText('#connection-status', '已连接', timeoutMs);
    await page.waitForFunction(
      `document.body.dataset.auth === "true" && Boolean(localStorage.getItem("agentbean-next-preview-session"))`,
      'preview page auto-authenticates and stores a session',
      timeoutMs,
    );
    checks.push(check('browser-login-session', true, 'Preview page logs in or registers and stores session token'));

    const session = await page.evaluateJson(`
      (() => {
        const raw = localStorage.getItem("agentbean-next-preview-session");
        return raw ? JSON.parse(raw) : null;
      })()
    `);
    assertSession(session);
    checks.push(check('browser-session-readable', true, 'Browser session exposes user and current team for daemon smoke'));

    agentSocket = await connectSmokeDaemon({
      baseUrl: target.baseUrl,
      ioFactory,
      session,
      suffix,
      timeoutMs,
    });
    cleanup.push(async () => {
      agentSocket?.disconnect?.();
    });
    checks.push(check('browser-daemon-connected', true, 'Smoke daemon reports an online device and runtime'));

    await page.waitForFunction(
      `document.querySelector('#agent-create-form [name="runtimeId"]')?.options.length > 0`,
      'runtime options are visible in the browser after daemon report',
      timeoutMs,
    );
    checks.push(check('browser-resubscribe-snapshots', true, 'Browser renders device/runtime snapshots'));

    const agentName = `BrowserSmoke${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
    await page.setInputValue('#agent-create-form [name="name"]', agentName);
    await page.setInputValue('#agent-create-form [name="envValue"]', '1');
    await page.click('#agent-create-form button[type="submit"]');
    await page.waitForText('#agents', agentName, timeoutMs);
    checks.push(check('browser-custom-agent-create', true, 'Browser creates a custom agent through the preview form'));

    const firstPrompt = `@${agentName} hello`;
    await sendBrowserMessage(page, firstPrompt);
    await page.waitForText('#messages', `browser-smoke:${firstPrompt}`, timeoutMs);
    checks.push(check('browser-agent-reply-visible', true, 'Browser sends a message and sees the agent reply'));

    await page.reload();
    await page.waitForText('#connection-status', '已连接', timeoutMs);
    await page.waitForFunction(
      `document.body.dataset.auth === "true" && document.querySelector("#agents")?.textContent.includes(${JSON.stringify(agentName)})`,
      'refresh restores session and subscribed agent snapshot',
      timeoutMs,
    );
    await page.waitForFunction(
      `document.querySelector('#agent-create-form [name="runtimeId"]')?.options.length > 0`,
      'refresh restores runtime snapshot',
      timeoutMs,
    );
    checks.push(
      check(
        'browser-refresh-resubscribe',
        true,
        'Browser refresh restores auth session and resubscribes devices, runtimes, agents, and channels',
      ),
    );

    const secondPrompt = `@${agentName} after refresh`;
    await sendBrowserMessage(page, secondPrompt);
    await page.waitForText('#messages', `browser-smoke:${secondPrompt}`, timeoutMs);
    checks.push(check('browser-post-refresh-dispatch', true, 'Browser can dispatch and see replies after refresh'));

    const taskSmoke = await exerciseTaskBrowserSmoke({ page, suffix, timeoutMs });
    checks.push(
      check('browser-task-create-visible', true, `Browser created and rendered task ${taskSmoke.title}`),
      check('browser-task-status-update', true, 'Browser updated the task status through the preview task controls'),
      check('browser-task-refresh-restore', true, 'Browser refresh restored the task list through task:list'),
    );

    const artifactSmoke = await exerciseArtifactBrowserSmoke({ page, suffix, timeoutMs });
    checks.push(
      check('browser-artifact-upload-visible', true, `Browser uploaded and rendered ${artifactSmoke.filename}`),
      check('browser-artifact-preview-readable', true, 'Browser can fetch artifact preview bytes from the rendered link'),
      check('browser-artifact-download-readable', true, 'Browser can fetch artifact download bytes from the rendered link'),
    );

    await page.screenshot(artifacts.screenshot);
    checks.push(check('browser-final-screenshot', true, `Saved final screenshot: ${artifacts.screenshot}`));

    const pageErrors = browserEvents.filter((event) => event.level === 'error' || event.type === 'exception');
    checks.push(
      check(
        'browser-console-clean',
        pageErrors.length === 0,
        pageErrors.length === 0
          ? 'No browser console errors or uncaught exceptions were observed'
          : `Browser reported ${pageErrors.length} console errors or exceptions`,
      ),
    );

    return summarizeBrowserSmoke(checks, artifacts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check('browser-smoke-runtime-error', false, message));
    if (page) {
      try {
        await page.screenshot(artifacts.failureScreenshot);
      } catch {
        // The page may already be closed; keep the original failure.
      }
    }
    return summarizeBrowserSmoke(checks, artifacts);
  } finally {
    writeFileSync(artifacts.consoleLog, JSON.stringify(browserEvents, null, 2));
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch {
        // Cleanup errors should not hide the smoke result.
      }
    }
  }
}

export function summarizeBrowserSmoke(checks, artifacts) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
    artifacts,
  };
}

async function startLocalServer({ suffix, skipBuild, timeoutMs }) {
  if (!skipBuild) {
    await runCommand('npm', ['run', 'build:server-next'], { timeoutMs: Math.max(timeoutMs, 60_000) });
  }

  const dataDir = mkdtempSync(join(tmpdir(), `agentbean-next-browser-smoke-data-${suffix}-`));
  const server = spawn(
    process.execPath,
    [
      'apps/server-next/dist/apps/server-next/src/bin.js',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--storage',
      'sqlite',
      '--data-dir',
      dataDir,
      '--session-secret',
      `browser-smoke-secret-${suffix}`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const baseUrl = await waitForLocalServerUrl(server, () => output, timeoutMs).catch(async (error) => {
    await stopProcess(server);
    throw error;
  });
  return {
    baseUrl,
    async close() {
      await stopProcess(server);
    },
  };
}

async function connectSmokeDaemon({ baseUrl, ioFactory, session, suffix, timeoutMs }) {
  const socket = await connectSocket(ioFactory, new URL('/agent', baseUrl).toString(), timeoutMs);
  socket.on(AGENT_EVENTS.dispatch.request, (request) => {
    emitAck(socket, AGENT_EVENTS.dispatch.result, {
      dispatchId: request.id,
      agentId: request.agentId,
      body: `browser-smoke:${request.prompt}`,
    }, timeoutMs).catch(() => {});
  });

  const helloAck = await emitAck(socket, AGENT_EVENTS.device.hello, {
    teamId: session.team.id,
    ownerId: session.user.id,
    machineId: `agentbean-browser-smoke:${suffix}`,
    profileId: 'browser-smoke',
    hostname: 'agentbean-browser-smoke',
  }, timeoutMs);
  const deviceId = readNestedString(helloAck, ['device', 'id']);
  if (!deviceId) {
    throw new Error(`Smoke daemon hello did not return a device id: ${formatAck(helloAck)}`);
  }

  const runtimesAck = await emitAck(socket, AGENT_EVENTS.device.runtimes, {
    teamId: session.team.id,
    deviceId,
    runtimes: [{
      adapterKind: 'codex',
      name: 'Codex CLI',
      command: 'agentbean-browser-smoke',
      installed: true,
    }],
  }, timeoutMs);
  const runtimeId = Array.isArray(runtimesAck?.runtimes) ? runtimesAck.runtimes[0]?.id : undefined;
  if (typeof runtimeId !== 'string') {
    throw new Error(`Smoke daemon runtime report did not return a runtime id: ${formatAck(runtimesAck)}`);
  }

  return socket;
}

async function createSmokeBrowserSession({ baseUrl, ioFactory, suffix, timeoutMs }) {
  const socket = await connectSocket(ioFactory, new URL('/web', baseUrl).toString(), timeoutMs);
  const username = `browser-smoke-${suffix}`;
  const password = `secret-${suffix}`;
  const teamName = `AgentBean Browser Smoke ${suffix}`;
  const registerAck = await emitAck(socket, WEB_EVENTS.auth.register, { username, password, teamName }, timeoutMs);
  const ack = registerAck?.ok
    ? registerAck
    : registerAck?.error === 'CONFLICT'
      ? await emitAck(socket, WEB_EVENTS.auth.login, { username, password }, timeoutMs)
      : registerAck;
  if (
    ack?.ok === true &&
    typeof ack.token === 'string' &&
    typeof ack.user?.id === 'string' &&
    typeof ack.currentTeam?.id === 'string'
  ) {
    return {
      socket,
      session: {
        token: ack.token,
        user: ack.user,
        team: ack.currentTeam,
        channel: ack.defaultChannel ?? null,
      },
    };
  }
  socket.disconnect?.();
  throw new Error(`Browser smoke session did not return token, user, and current team: ${formatAck(ack)}`);
}

async function sendBrowserMessage(page, body) {
  await page.setInputValue('#message-form [name="body"]', body);
  await page.click('#message-form button[type="submit"]');
}

export async function exerciseArtifactBrowserSmoke({ page, suffix, timeoutMs }) {
  const filename = 'browser-smoke-artifact.md';
  const content = '# artifact browser smoke\n';
  await page.setFileInputFiles('#message-artifact-files', [{
    name: filename,
    type: 'text/markdown',
    content,
  }]);
  await sendBrowserMessage(page, `artifact upload ${suffix}`);
  await page.waitForText('#messages', filename, timeoutMs);
  const renderedArtifact = await page.evaluateJson(`
    (() => {
      const filename = ${JSON.stringify(filename)};
      const row = Array.from(document.querySelectorAll(".message-artifact"))
        .find((candidate) => candidate.textContent.includes(filename));
      if (!row) return null;
      const links = Array.from(row.querySelectorAll("a"));
      return {
        filename,
        previewHref: links.find((link) => link.textContent.includes("预览"))?.href,
        downloadHref: links.find((link) => link.textContent.includes("下载"))?.href,
      };
    })()
  `);
  if (!renderedArtifact) {
    throw new Error(`Browser artifact row was not rendered for ${filename}`);
  }
  if (!renderedArtifact.previewHref || !renderedArtifact.downloadHref) {
    throw new Error(`Browser artifact links were not rendered: ${formatAck(renderedArtifact)}`);
  }
  const http = await page.evaluateJson(`
    (async () => {
      const previewResponse = await fetch(${JSON.stringify(renderedArtifact.previewHref)});
      const downloadResponse = await fetch(${JSON.stringify(renderedArtifact.downloadHref)});
      return {
        preview: {
          status: previewResponse.status,
          body: await previewResponse.text(),
        },
        download: {
          status: downloadResponse.status,
          body: await downloadResponse.text(),
          disposition: downloadResponse.headers.get("content-disposition") || "",
        },
      };
    })()
  `);
  if (http?.preview?.status !== 200 || http.preview.body !== content) {
    throw new Error(`Artifact preview fetch failed: ${formatAck(http?.preview)}`);
  }
  if (http?.download?.status !== 200 || http.download.body !== content || !http.download.disposition.includes(filename)) {
    throw new Error(`Artifact download fetch failed: ${formatAck(http?.download)}`);
  }
  return {
    filename,
    previewBody: http.preview.body,
    downloadBody: http.download.body,
  };
}

export async function exerciseTaskBrowserSmoke({ page, suffix, timeoutMs }) {
  const title = `Browser task ${suffix}`;
  await page.setInputValue('#task-create-form [name="title"]', title);
  await page.click('#task-create-form button[type="submit"]');
  await page.waitForText('#task-results', title, timeoutMs);
  await page.waitForText('#task-results', 'todo', timeoutMs);

  await page.click('#task-results button[data-status="done"]');
  await page.waitForText('#task-results', 'done', timeoutMs);

  await page.reload();
  await page.waitForText('#connection-status', '已连接', timeoutMs);
  await page.waitForFunction(
    `document.body.dataset.auth === "true" && document.querySelector("#task-results")?.textContent.includes(${JSON.stringify(title)})`,
    'refresh restores task list',
    timeoutMs,
  );
  await page.waitForText('#task-results', 'done', timeoutMs);

  return { title, status: 'done' };
}

async function launchChrome({ chromeBin, artifactsDir, headed, timeoutMs }) {
  const executable = findChromeExecutable(chromeBin);
  if (!executable) {
    throw new Error('Chrome executable not found; set CHROME_BIN or pass --chrome-bin');
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-browser-smoke-chrome-'));
  const remoteDebuggingPort = await findOpenPort();
  const args = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--window-size=1440,1000',
  ];
  if (!headed) {
    args.push('--headless=new', '--disable-gpu');
  }
  args.push('about:blank');

  const stderrPath = join(artifactsDir, 'chrome-stderr.log');
  const chrome = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.setEncoding('utf8');
  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk;
    writeFileSync(stderrPath, stderr);
  });

  const debugUrl = `http://127.0.0.1:${remoteDebuggingPort}`;
  await waitForChromeDebugEndpoint(debugUrl, chrome, timeoutMs, () => stderr).catch(async (error) => {
    await stopProcess(chrome);
    throw error;
  });
  return {
    debugUrl,
    async close() {
      await stopProcess(chrome);
    },
  };
}

async function openPage(debugUrl, events) {
  const target = await fetchJson(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Chrome did not create a debuggable page: ${JSON.stringify(target)}`);
  }
  const cdp = await connectCdp(target.webSocketDebuggerUrl, events);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  return cdp;
}

async function connectCdp(webSocketUrl, events) {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error('This Node.js runtime does not provide global WebSocket; use Node 22+');
  }

  const socket = new WebSocketCtor(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  const temporaryDirectories = new Set();
  let nextId = 1;
  let closedError;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', async (event) => {
    const raw = typeof event.data === 'string'
      ? event.data
      : event.data instanceof ArrayBuffer
        ? Buffer.from(event.data).toString('utf8')
        : ArrayBuffer.isView(event.data)
          ? Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString('utf8')
          : Buffer.from(await event.data.arrayBuffer()).toString('utf8');
    const message = JSON.parse(raw);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${entry.method} failed: ${message.error.message}`));
        return;
      }
      entry.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) {
      listener(message.params);
    }
  });

  const rejectPending = (error) => {
    closedError = error;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };
  socket.addEventListener('close', () => {
    rejectPending(new Error('Chrome DevTools WebSocket closed'));
  });
  socket.addEventListener('error', () => {
    rejectPending(new Error('Chrome DevTools WebSocket errored'));
  });

  const send = (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    if (closedError) {
      reject(closedError);
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  const on = (method, listener) => {
    const current = listeners.get(method) ?? [];
    current.push(listener);
    listeners.set(method, current);
  };

  on('Runtime.consoleAPICalled', (params) => {
    events.push({
      type: 'console',
      level: params.type,
      text: (params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '),
    });
  });
  on('Runtime.exceptionThrown', (params) => {
    events.push({
      type: 'exception',
      level: 'error',
      text: params.exceptionDetails?.text ?? 'Uncaught exception',
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
    });
  });
  on('Log.entryAdded', (params) => {
    events.push({
      type: 'log',
      level: params.entry?.level,
      text: params.entry?.text,
      url: params.entry?.url,
    });
  });

  return {
    async navigate(url) {
      const navigation = this.waitForEvent('Page.frameNavigated', (params) => !params.frame.parentId, DEFAULT_TIMEOUT_MS);
      await send('Page.navigate', { url });
      await navigation;
      await this.waitForFunction('document.readyState === "complete"', 'page load', DEFAULT_TIMEOUT_MS);
    },
    async reload() {
      const navigation = this.waitForEvent('Page.frameNavigated', (params) => !params.frame.parentId, DEFAULT_TIMEOUT_MS);
      await send('Page.reload', { ignoreCache: true });
      await navigation;
      await this.waitForFunction('document.readyState === "complete"', 'page reload', DEFAULT_TIMEOUT_MS);
    },
    async addScriptOnNewDocument(source) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source });
    },
    async setViewport({ width, height }) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    async evaluateJson(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
      }
      return result.result?.value;
    },
    async waitForFunction(expression, description, timeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const passed = await this.evaluateJson(`Boolean(${expression})`);
        if (passed) {
          return;
        }
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${description}`);
    },
    async waitForText(selector, text, timeoutMs) {
      await this.waitForFunction(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(text)})`,
        `${selector} to contain ${text}`,
        timeoutMs,
      );
    },
    async waitForEvent(method, predicate, timeoutMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs);
        const listener = (params) => {
          if (!predicate(params)) {
            return;
          }
          clearTimeout(timer);
          const current = listeners.get(method) ?? [];
          listeners.set(method, current.filter((candidate) => candidate !== listener));
          resolve();
        };
        on(method, listener);
      });
    },
    async setInputValue(selector, value) {
      await this.evaluateJson(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Missing input: ${selector.replaceAll('"', '\\"')}");
          element.value = ${JSON.stringify(value)};
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()
      `);
    },
    async setFileInputFiles(selector, files) {
      const dir = mkdtempSync(join(tmpdir(), 'agentbean-next-browser-smoke-upload-'));
      temporaryDirectories.add(dir);
      const paths = files.map((file) => {
        const safeName = basename(file.name).replace(/[^\w .@-]/g, '_') || 'artifact.bin';
        const path = join(dir, safeName);
        writeFileSync(path, file.content);
        return path;
      });
      const document = await send('DOM.getDocument', { depth: -1, pierce: true });
      const rootNodeId = document.root?.nodeId;
      if (!rootNodeId) {
        throw new Error('Chrome DOM root was not available for file upload');
      }
      const target = await send('DOM.querySelector', { nodeId: rootNodeId, selector });
      if (!target.nodeId) {
        throw new Error(`Missing file input: ${selector}`);
      }
      await send('DOM.setFileInputFiles', { nodeId: target.nodeId, files: paths });
      await this.evaluateJson(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Missing file input: ${selector.replaceAll('"', '\\"')}");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()
      `);
    },
    async click(selector) {
      await this.evaluateJson(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Missing clickable: ${selector.replaceAll('"', '\\"')}");
          element.click();
          return true;
        })()
      `);
    },
    async screenshot(path) {
      const result = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      writeFileSync(path, Buffer.from(result.data, 'base64'));
    },
    async close() {
      try {
        socket.close();
      } finally {
        for (const dir of temporaryDirectories) {
          rmSync(dir, { recursive: true, force: true });
        }
        temporaryDirectories.clear();
      }
    },
    send,
  };
}

async function runCommand(command, args, { timeoutMs }) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const exitCode = await waitForProcess(child, timeoutMs);
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}\n${output}`);
  }
}

async function waitForLocalServerUrl(process, readOutput, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`AgentBean Next server exited before listening:\n${readOutput()}`);
    }
    const match = readOutput().match(/AgentBean Next server listening at (http:\/\/[^\s]+)/);
    if (match?.[1]) {
      return match[1];
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for AgentBean Next server URL:\n${readOutput()}`);
}

async function waitForChromeDebugEndpoint(debugUrl, process, timeoutMs, readStderr) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools was ready:\n${readStderr()}`);
    }
    try {
      await fetchJson(`${debugUrl}/json/version`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint ${debugUrl}:\n${readStderr()}`);
}

async function connectSocket(ioFactory, url, timeoutMs) {
  const socket = ioFactory(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.disconnect?.();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off?.('connect', onConnect);
      socket.off?.('connect_error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.connect();
  });
  return socket;
}

async function emitAck(socket, event, payload, timeoutMs) {
  if (typeof socket.timeout === 'function' && typeof socket.timeout(timeoutMs)?.emitWithAck === 'function') {
    return socket.timeout(timeoutMs).emitWithAck(event, payload);
  }
  if (typeof socket.emitWithAck === 'function') {
    return socket.emitWithAck(event, payload);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event} ack`)), timeoutMs);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function loadSocketIoClient() {
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { io } = requireFromServer('socket.io-client');
  return io;
}

function findChromeExecutable(preferred) {
  const candidates = [
    preferred,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function findOpenPort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) {
    throw new Error('Could not allocate a local Chrome debugging port');
  }
  return port;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed with ${response.status}`);
  }
  return response.json();
}

async function waitForProcess(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void stopProcess(child).then(() => reject(new Error(`Timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(3000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', () => resolve(true)));
  }
}

function normalizeBaseUrlOrThrow(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AgentBean Next browser smoke URL must be http or https');
  }
  return url;
}

function assertSession(session) {
  if (
    !session ||
    typeof session.token !== 'string' ||
    typeof session.user?.id !== 'string' ||
    typeof session.team?.id !== 'string'
  ) {
    throw new Error(`Preview browser session is incomplete: ${formatAck(session)}`);
  }
}

function readNestedString(value, path) {
  let current = value;
  for (const key of path) {
    current = current?.[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function check(id, ok, message) {
  return { id, ok, message };
}

function formatAck(ack) {
  try {
    return JSON.stringify(ack);
  } catch {
    return String(ack);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    json: argv.includes('--json'),
    headed: argv.includes('--headed'),
    skipBuild: argv.includes('--skip-build'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    if (['--json', '--headed', '--skip-build'].includes(arg)) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === '--url') args.url = value;
    if (arg === '--timeout-ms') args.timeoutMs = Number(value);
    if (arg === '--artifacts-dir') args.artifactsDir = value;
    if (arg === '--chrome-bin') args.chromeBin = value;
    index += 1;
  }
  return args;
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next browser smoke passed (${summary.total}/${summary.total}).`
      : `AgentBean Next browser smoke failed (${summary.failed}/${summary.total}).`,
    `Artifacts: ${summary.artifacts.dir}`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runAgentBeanNextBrowserSmoke({
    baseUrl: args.url ?? process.env.AGENTBEAN_NEXT_ENTRY_URL,
    chromeBin: args.chromeBin,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined,
    artifactsDir: args.artifactsDir ?? process.env.AGENTBEAN_NEXT_BROWSER_SMOKE_ARTIFACTS_DIR,
    headed: args.headed,
    skipBuild: args.skipBuild,
  });
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
