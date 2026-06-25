#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_EVENTS = {
  device: { hello: 'device:hello', runtimes: 'device:runtimes', scanRequested: 'device:scan-requested' },
  agent: { registerBatch: 'agent:register-batch' },
  dispatch: { request: 'dispatch:request', result: 'dispatch:result' },
};

const WEB_EVENTS = {
  auth: { register: 'auth:register', login: 'auth:login' },
  agent: {
    subscribe: 'agents:subscribe',
    create: 'agent:create',
    publish: 'agent:publish',
    unpublish: 'agent:unpublish',
  },
  channel: {
    subscribe: 'channels:subscribe',
    addMember: 'channel:add-member',
    removeMember: 'channel:remove-member',
    addAgent: 'channel:add-agent',
    removeAgent: 'channel:remove-agent',
    members: 'channel:members',
  },
  device: {
    rename: 'device:rename',
  },
  join: { create: 'join:create' },
  member: {
    list: 'members:list',
  },
  message: { send: 'message:send' },
  team: {
    create: 'team:create',
    switch: 'team:switch',
  },
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
    if (target.dataDir) {
      promoteSmokeUserToAdmin({ dataDir: target.dataDir, userId: seededSession.session.user.id });
      seededSession.session.user = { ...seededSession.session.user, role: 'admin' };
    }
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

    page = await openPage(chrome.debugUrl, browserEvents, timeoutMs);
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

    const daemon = await connectSmokeDaemon({
      baseUrl: target.baseUrl,
      ioFactory,
      session,
      suffix,
      timeoutMs,
    });
    agentSocket = daemon.socket;
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

    const threadSmoke = await exerciseThreadBrowserSmoke({ page, suffix, timeoutMs });
    checks.push(
      check(
        'browser-thread-reply-nested',
        true,
        `Browser sent a thread reply (threadId=${threadSmoke.rootThreadId}) and it rendered nested under the root message`,
      ),
    );

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

export async function runAgentBeanNextWebUiBrowserSmoke({
  baseUrl,
  chromeBin,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  artifactsDir,
  headed = false,
  skipBuild = false,
  ioFactory = loadSocketIoClient(),
} = {}) {
  const resolvedArtifactsDir = resolve(
    artifactsDir ?? join(tmpdir(), `agentbean-next-webui-smoke-${Date.now()}`),
  );
  mkdirSync(resolvedArtifactsDir, { recursive: true });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const checks = [];
  const cleanup = [];
  const browserEvents = [];
  const artifacts = {
    dir: resolvedArtifactsDir,
    consoleLog: join(resolvedArtifactsDir, 'webui-browser-console.json'),
    screenshot: join(resolvedArtifactsDir, 'webui-final-page.png'),
    failureScreenshot: join(resolvedArtifactsDir, 'webui-failure-page.png'),
  };
  let page;
  try {
    const target = baseUrl
      ? { baseUrl: normalizeBaseUrlOrThrow(baseUrl).toString(), close: async () => undefined }
      : await startLocalServer({ suffix, skipBuild, timeoutMs, webEntry: 'app' });
    cleanup.push(target.close);
    checks.push(check('webui-target-ready', true, `WebUI smoke target is ${target.baseUrl}`));

    const chrome = await launchChrome({
      chromeBin: chromeBin ?? process.env.CHROME_BIN,
      artifactsDir: resolvedArtifactsDir,
      headed,
      timeoutMs,
    });
    cleanup.push(chrome.close);
    checks.push(check('webui-chrome-ready', true, `Chrome DevTools is listening on ${chrome.debugUrl}`));

    page = await openPage(chrome.debugUrl, browserEvents);
    cleanup.push(page.close);
    await page.setViewport(DEFAULT_VIEWPORT);
    const publicRoutes = await exerciseWebUiRouteSmoke({
      page,
      baseUrl: target.baseUrl,
      timeoutMs,
      routes: ['/', '/login', '/signup', '/register'],
    });
    checks.push(check('webui-public-routes-render', true, `Rendered ${publicRoutes.length} public App Router pages`));

    const seededSession = await createSmokeBrowserSession({
      baseUrl: target.baseUrl,
      ioFactory,
      suffix,
      timeoutMs,
    });
    cleanup.push(async () => {
      seededSession.socket.disconnect?.();
    });
    checks.push(check('webui-session-seeded', true, 'Created an isolated WebUI session for authenticated route smoke'));

    await seedWebUiAuthStorage({ page, session: seededSession.session });
    const authenticatedRoutes = await exerciseWebUiAuthenticatedRouteSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-authenticated-routes-render',
        true,
        `Rendered ${authenticatedRoutes.length} authenticated App Router pages`,
      ),
    );
    checks.push(
      check(
        'webui-routes-render',
        true,
        `Rendered ${publicRoutes.length + authenticatedRoutes.length} App Router pages`,
      ),
    );

    const chatResult = await exerciseWebUiChatBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-chat-business-flow',
        true,
        `Sent chat message "${chatResult.body}" and restored it after refresh`,
      ),
    );

    const channelResult = await exerciseWebUiChannelsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      ioFactory,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-channels-business-flow',
        true,
        `Created channel "${channelResult.channelName}", opened detail, archived it, and verified it disappeared from the list`,
      ),
      check(
        'webui-channel-members-business-flow',
        true,
        `Managed human member ${channelResult.memberUserId} and agent member ${channelResult.agentId}, then verified private visibility and mention scope`,
      ),
    );

    const teamResult = await exerciseWebUiNetworksBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-networks-business-flow',
        true,
        `Created team "${teamResult.teamName}", switched to ${teamResult.teamPath}, deleted it, and restored ${teamResult.restoredTeamPath}`,
      ),
    );

    const taskResult = await exerciseWebUiTaskBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-task-business-flow',
        true,
        `Created task "${taskResult.title}", reordered it, moved it to ${taskResult.status}, deleted "${taskResult.deletedTitle}", and restored after refresh`,
      ),
    );

    const runResult = await exerciseWebUiRunsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      ioFactory,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-runs-business-flow',
        true,
        `Created workspace run "${runResult.command}" and verified list, detail route, full log artifact, artifact tree, inline log search, and source message jump`,
      ),
    );

    const memberResult = await exerciseWebUiMembersBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      ioFactory,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-members-business-flow',
        true,
        `Joined member "${memberResult.username}", promoted to admin, demoted to member, and restored after refresh`,
      ),
    );

    const deviceResult = await exerciseWebUiDevicesBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      ioFactory,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-devices-business-flow',
        true,
        `Verified device ${deviceResult.deviceId} detail runtimes, custom agent, scanned AgentOS agent, rename refresh restore, and delete redirect`,
      ),
    );

    const settingsResult = await exerciseWebUiSettingsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-settings-business-flow',
        true,
        `Verified account "${settingsResult.username}", persisted/reset browser preferences, renamed team to "${settingsResult.teamName}", created join link ${settingsResult.joinCode}, revoked it, and restored settings after refresh`,
      ),
    );

    const agentsResult = await exerciseWebUiAgentsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      ioFactory,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-agents-business-flow',
        true,
        `Created agent "${agentsResult.agentName}", updated config, toggled publish to ${agentsResult.targetTeamName}, verified metrics, and deleted it from the list`,
      ),
    );

    if (target.dataDir) {
      const adminResult = await exerciseWebUiAdminDashboardBusinessSmoke({
        page,
        baseUrl: target.baseUrl,
        dataDir: target.dataDir,
        ioFactory,
        suffix,
        timeoutMs,
      });
      checks.push(
        check(
          'webui-admin-dashboard-business-flow',
          true,
          `Verified admin dashboard teams/users/devices/agents tabs and transferred device ${adminResult.deviceId} from ${adminResult.initialOwnerUsername} to ${adminResult.targetOwnerUsername}`,
        ),
      );
    } else {
      checks.push(
        check(
          'webui-admin-dashboard-business-flow',
          true,
          'Skipped admin dashboard browser flow for external target without local smoke database access',
        ),
      );
    }

    await page.screenshot(artifacts.screenshot);
    checks.push(check('webui-final-screenshot', true, `Saved final screenshot: ${artifacts.screenshot}`));

    const pageErrors = browserEvents.filter((event) => event.level === 'error' || event.type === 'exception');
    checks.push(
      check(
        'webui-console-clean',
        pageErrors.length === 0,
        pageErrors.length === 0
          ? 'No WebUI console errors or uncaught exceptions were observed'
          : `WebUI reported ${pageErrors.length} console errors or exceptions`,
      ),
    );
    return summarizeBrowserSmoke(checks, artifacts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(check('webui-smoke-runtime-error', false, message));
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

async function startLocalServer({ suffix, skipBuild, timeoutMs, webEntry = 'preview' }) {
  if (!skipBuild) {
    await runCommand('npm', ['run', webEntry === 'app' ? 'build:packages' : 'build:server-next'], { timeoutMs: Math.max(timeoutMs, 60_000) });
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
      '--web-entry',
      webEntry,
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
    dataDir,
    async close() {
      await stopProcess(server);
    },
  };
}

export async function exerciseWebUiRouteSmoke({
  page,
  baseUrl,
  timeoutMs,
  routes = [
    '/',
    '/login',
    '/signup',
    '/register',
    '/agentbean/dashboard',
    '/agentbean/chat',
    '/agentbean/tasks',
    '/agentbean/runs',
    '/agentbean/members',
    '/agentbean/devices',
    '/agentbean/settings',
  ],
}) {
  const rendered = [];
  const root = normalizeBaseUrlOrThrow(baseUrl);
  for (const route of routes) {
    const url = new URL(route, root);
    await page.navigate(url.toString());
    await page.waitForFunction(
      `document.readyState === "complete" && document.body && document.body.textContent.trim().length > 0`,
      `route ${route} renders non-empty content`,
      timeoutMs,
    );
    await page.waitForFunction(
      `!document.body.textContent.includes("Application error") && !document.body.textContent.includes("Unhandled Runtime Error")`,
      `route ${route} has no visible Next.js runtime error`,
      timeoutMs,
    );
    rendered.push(route);
  }
  return rendered;
}

export async function seedWebUiAuthStorage({ page, session }) {
  assertSession(session);
  const networkPath = session.team.path ?? session.team.id;
  const script = `
    localStorage.setItem("agentbean.token", ${JSON.stringify(session.token)});
    localStorage.setItem("agentbean.networkPath", ${JSON.stringify(networkPath)});
  `;
  await page.addScriptOnNewDocument(script);
  await page.evaluateJson(`
    (() => {
      ${script}
      return true;
    })()
  `);
  return { networkPath };
}

export async function exerciseWebUiAuthenticatedRouteSmoke({
  page,
  baseUrl,
  session,
  timeoutMs,
  routes,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const expectedRoutes = routes ?? [
    { path: `/${networkPath}/dashboard`, label: '仪表盘' },
    { path: `/${networkPath}/chat`, label: '聊天' },
    { path: `/${networkPath}/tasks`, label: '任务' },
    { path: `/${networkPath}/runs`, label: '执行记录' },
    { path: `/${networkPath}/members`, label: '成员' },
    { path: `/${networkPath}/devices`, label: '设备' },
    { path: `/${networkPath}/settings`, label: '设置' },
  ];
  const rendered = [];
  for (const route of expectedRoutes) {
    const descriptor = typeof route === 'string' ? { path: route, label: null } : route;
    const url = new URL(descriptor.path, root);
    await page.navigate(url.toString());
    await page.waitForFunction(
      `document.readyState === "complete" && document.body && document.body.textContent.trim().length > 0`,
      `authenticated route ${descriptor.path} renders non-empty content`,
      timeoutMs,
    );
    await page.waitForFunction(
      `location.pathname === ${JSON.stringify(descriptor.path)} && localStorage.getItem("agentbean.token") === ${JSON.stringify(session.token)}`,
      `authenticated route ${descriptor.path} keeps the seeded session`,
      timeoutMs,
    );
    await page.waitForFunction(
      `!document.body.textContent.includes("Application error") && !document.body.textContent.includes("Unhandled Runtime Error")`,
      `authenticated route ${descriptor.path} has no visible Next.js runtime error`,
      timeoutMs,
    );
    await page.waitForFunction(
      `
      (() => {
        const links = Array.from(document.querySelectorAll("a"));
        const hasSidebar = links.some((link) =>
          link.getAttribute("href") === ${JSON.stringify(`/${networkPath}/chat`)}
          && link.textContent.includes("聊天")
        );
        const hasRouteLabel = ${descriptor.label ? `document.body.textContent.includes(${JSON.stringify(descriptor.label)})` : 'true'};
        return hasSidebar && hasRouteLabel;
      })()
      `,
      `authenticated route ${descriptor.path} renders sidebar and route content`,
      timeoutMs,
    );
    rendered.push(descriptor.path);
  }
  return rendered;
}

export async function exerciseWebUiChatBusinessSmoke({
  page,
  baseUrl,
  session,
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const body = `WebUI smoke chat ${suffix}`;
  await page.navigate(new URL(`/${networkPath}/chat`, root).toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="chat-message-input"]') !== null && document.querySelector('[data-smoke="chat-message-send"]') !== null`,
    'chat page exposes the message composer',
    timeoutMs,
  );
  await page.setInputValue('[data-smoke="chat-message-input"]', body);
  await page.click('[data-smoke="chat-message-send"]');
  await waitForWebUiChatMessage({ page, body, timeoutMs });

  await page.reload();
  await waitForWebUiChatMessage({ page, body, timeoutMs });
  return { body };
}

async function waitForWebUiChatMessage({ page, body, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const body = ${JSON.stringify(body)};
      return Array.from(document.querySelectorAll('[data-smoke="chat-message"]'))
        .some((candidate) => candidate.dataset.messageBody === body);
    })()
    `,
    `chat message "${body}" to render`,
    timeoutMs,
  );
}

export async function exerciseWebUiChannelsBusinessSmoke({
  page,
  baseUrl,
  session,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-28);
  const channelName = `webui-channel-${safeSuffix}`;
  const memberUsername = `webui-channel-member-${safeSuffix}`.toLowerCase();
  const agentName = `WebUIChannelAgent${safeSuffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
  const ownerSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs, {
    auth: { token: session.token },
  });
  const joinSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs);
  let memberSocket;
  let daemon;
  try {
    const linkAck = await emitAck(ownerSocket, WEB_EVENTS.join.create, { maxUses: 1 }, timeoutMs);
    const joinCode = readNestedString(linkAck, ['link', 'code']);
    if (!joinCode) {
      throw new Error(`WebUI channels smoke could not create a join link: ${formatAck(linkAck)}`);
    }
    const registerAck = await emitAck(joinSocket, WEB_EVENTS.auth.register, {
      username: memberUsername,
      password: `secret-${safeSuffix}`,
      teamName: `Unused Channel Member ${safeSuffix}`,
      joinCode,
    }, timeoutMs);
    const targetUserId = readNestedString(registerAck, ['user', 'id']);
    const targetToken = readNestedString(registerAck, ['token']);
    if (registerAck?.ok !== true || !targetUserId || !targetToken) {
      throw new Error(`WebUI channels smoke could not register a channel member: ${formatAck(registerAck)}`);
    }
    memberSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs, {
      auth: { token: targetToken },
    });

    daemon = await connectSmokeDaemon({
      baseUrl: root,
      ioFactory,
      session,
      suffix: `channel-${safeSuffix}`,
      timeoutMs,
    });
    const agentAck = await emitAck(ownerSocket, WEB_EVENTS.agent.create, {
      userId: session.user.id,
      teamId: session.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      env: { AGENTBEAN_WEBUI_CHANNEL_MEMBER_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    if (!agentId) {
      throw new Error(`WebUI channels smoke could not create a channel agent: ${formatAck(agentAck)}`);
    }

    await page.navigate(new URL(`/${networkPath}/channels`, root).toString());
    await page.waitForFunction(
      `document.querySelector('[data-smoke="channel-create-open"]') !== null`,
      'channels page exposes the create channel control',
      timeoutMs,
    );
    await page.click('[data-smoke="channel-create-open"]');
    await page.waitForFunction(
      `document.querySelector('[data-smoke="channel-create-dialog"]') !== null`,
      'channel create dialog opens',
      timeoutMs,
    );
    await page.setInputValue('[data-smoke="channel-create-name"]', channelName);
    await page.click('[data-smoke="channel-create-visibility-private"]');
    await page.click('[data-smoke="channel-create-submit"]');
    await waitForWebUiChannelDetail({ page, channelName, timeoutMs });
    const channelId = await page.evaluateJson(`
      (() => {
        const match = window.location.pathname.match(/\\/channels?\\/([^/?#]+)/);
        return match?.[1] ?? null;
      })()
    `);
    if (typeof channelId !== 'string' || !channelId) {
      throw new Error(`WebUI channels smoke could not resolve created channel id for "${channelName}"`);
    }

    await page.click('[data-smoke="channel-members-open"]');
    await waitForWebUiChannelMembersDialog({ page, channelName, timeoutMs });
    await page.click('[data-smoke="channel-members-add-toggle"]');
    await clickWebUiChannelMemberCandidate({ page, kind: 'human', id: targetUserId });
    await waitForWebUiChannelMemberItem({ page, kind: 'human', id: targetUserId, timeoutMs });
    await assertWebUiChannelMembersAck({
      socket: ownerSocket,
      teamId: session.team.id,
      channelId,
      timeoutMs,
      expectedHumanId: targetUserId,
    });
    await assertWebUiChannelVisibleToMember({
      socket: memberSocket,
      teamId: session.team.id,
      channelId,
      timeoutMs,
      expectedVisible: true,
    });

    await page.click('[data-smoke="channel-members-add-toggle"]');
    await clickWebUiChannelMemberCandidate({ page, kind: 'agent', id: agentId });
    await waitForWebUiChannelMemberItem({ page, kind: 'agent', id: agentId, timeoutMs });
    await assertWebUiChannelMembersAck({
      socket: ownerSocket,
      teamId: session.team.id,
      channelId,
      timeoutMs,
      expectedHumanId: targetUserId,
      expectedAgentId: agentId,
    });

    await clickWebUiChannelMemberRemove({ page, kind: 'human', id: targetUserId });
    await waitForWebUiChannelMemberMissing({ page, kind: 'human', id: targetUserId, timeoutMs });
    await assertWebUiChannelMembersAck({
      socket: ownerSocket,
      teamId: session.team.id,
      channelId,
      timeoutMs,
      absentHumanId: targetUserId,
      expectedAgentId: agentId,
    });
    await assertWebUiChannelVisibleToMember({
      socket: memberSocket,
      teamId: session.team.id,
      channelId,
      timeoutMs,
      expectedVisible: false,
    });
    await page.setInputValue('[data-smoke="chat-message-input"]', '@');
    await waitForWebUiMentionScope({
      page,
      expectedAgentId: agentId,
      absentHumanId: targetUserId,
      timeoutMs,
    });

    await page.click('[data-smoke="channel-edit-open"]');
    await page.waitForFunction(
      `document.querySelector('[data-smoke="channel-edit-dialog"]')?.dataset.channelId === ${JSON.stringify(channelId)}`,
      `channel "${channelId}" edit dialog opens`,
      timeoutMs,
    );
    await page.click('[data-smoke="channel-archive-open"]');
    await page.click('[data-smoke="channel-confirm-archive"]');
    await waitForWebUiChannelListMissing({ page, channelId, channelName, timeoutMs });

    await page.navigate(new URL(`/${networkPath}/channels`, root).toString());
    await waitForWebUiChannelListMissing({ page, channelId, channelName, timeoutMs });
    return { channelId, channelName, memberUserId: targetUserId, agentId };
  } finally {
    daemon?.socket?.disconnect?.();
    memberSocket?.disconnect?.();
    joinSocket.disconnect?.();
    ownerSocket.disconnect?.();
  }
}

async function waitForWebUiChannelDetail({ page, channelName, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const channelName = ${JSON.stringify(channelName)};
      return window.location.pathname.includes('/channels/') &&
        document.querySelector('[data-smoke="channel-edit-open"]') !== null &&
        document.body.textContent.includes(channelName);
    })()
    `,
    `channel "${channelName}" detail to render`,
    timeoutMs,
  );
}

async function waitForWebUiChannelListMissing({ page, channelId, channelName, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const channelId = ${JSON.stringify(channelId)};
      const channelName = ${JSON.stringify(channelName)};
      return !Array.from(document.querySelectorAll('[data-smoke="channel-list-item"]'))
        .some((candidate) =>
          candidate.dataset.channelId === channelId ||
          candidate.dataset.channelName === channelName ||
          candidate.textContent.includes(channelName)
        );
    })()
    `,
    `channel "${channelName}" to disappear from the list`,
    timeoutMs,
  );
}

async function waitForWebUiChannelMembersDialog({ page, channelName, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const channelName = ${JSON.stringify(channelName)};
      const dialog = document.querySelector('[data-smoke="channel-members-dialog"]');
      return dialog?.dataset.channelName === channelName;
    })()
    `,
    `channel "${channelName}" members dialog to render`,
    timeoutMs,
  );
}

async function clickWebUiChannelMemberCandidate({ page, kind, id }) {
  const clicked = await page.evaluateJson(`
    (() => {
      const kind = ${JSON.stringify(kind)};
      const id = ${JSON.stringify(id)};
      const candidate = Array.from(document.querySelectorAll('[data-smoke="channel-member-add-candidate"]'))
        .find((item) => item.dataset.memberKind === kind && item.dataset.memberId === id);
      if (!candidate) return false;
      candidate.click();
      return true;
    })()
  `);
  if (!clicked) {
    throw new Error(`Could not find addable ${kind} channel member ${id}`);
  }
}

async function clickWebUiChannelMemberRemove({ page, kind, id }) {
  const clicked = await page.evaluateJson(`
    (() => {
      const kind = ${JSON.stringify(kind)};
      const id = ${JSON.stringify(id)};
      const button = Array.from(document.querySelectorAll('[data-smoke="channel-member-remove"]'))
        .find((item) => item.dataset.memberKind === kind && item.dataset.memberId === id);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) {
    throw new Error(`Could not find removable ${kind} channel member ${id}`);
  }
}

async function waitForWebUiChannelMemberItem({ page, kind, id, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const kind = ${JSON.stringify(kind)};
      const id = ${JSON.stringify(id)};
      return Array.from(document.querySelectorAll('[data-smoke="channel-member-item"]'))
        .some((item) => item.dataset.memberKind === kind && item.dataset.memberId === id);
    })()
    `,
    `${kind} channel member ${id} to render`,
    timeoutMs,
  );
}

async function waitForWebUiChannelMemberMissing({ page, kind, id, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const kind = ${JSON.stringify(kind)};
      const id = ${JSON.stringify(id)};
      return !Array.from(document.querySelectorAll('[data-smoke="channel-member-item"]'))
        .some((item) => item.dataset.memberKind === kind && item.dataset.memberId === id);
    })()
    `,
    `${kind} channel member ${id} to disappear`,
    timeoutMs,
  );
}

async function assertWebUiChannelMembersAck({
  socket,
  teamId,
  channelId,
  timeoutMs,
  expectedHumanId,
  absentHumanId,
  expectedAgentId,
}) {
  const ack = await emitAck(socket, WEB_EVENTS.channel.members, { teamId, channelId }, timeoutMs);
  if (ack?.ok !== true) {
    throw new Error(`WebUI channels smoke could not list channel members: ${formatAck(ack)}`);
  }
  const humanIds = Array.isArray(ack.humanMemberIds) ? ack.humanMemberIds : [];
  const agentIds = Array.isArray(ack.agentMemberIds) ? ack.agentMemberIds : [];
  if (expectedHumanId && !humanIds.includes(expectedHumanId)) {
    throw new Error(`WebUI channels smoke missing human member ${expectedHumanId}: ${formatAck(ack)}`);
  }
  if (absentHumanId && humanIds.includes(absentHumanId)) {
    throw new Error(`WebUI channels smoke still exposes removed human member ${absentHumanId}: ${formatAck(ack)}`);
  }
  if (expectedAgentId && !agentIds.includes(expectedAgentId)) {
    throw new Error(`WebUI channels smoke missing agent member ${expectedAgentId}: ${formatAck(ack)}`);
  }
}

async function assertWebUiChannelVisibleToMember({ socket, teamId, channelId, timeoutMs, expectedVisible }) {
  const ack = await emitAck(socket, WEB_EVENTS.channel.subscribe, { teamId }, timeoutMs);
  if (ack?.ok !== true) {
    throw new Error(`WebUI channels smoke could not list channels for joined member: ${formatAck(ack)}`);
  }
  const channels = Array.isArray(ack.channels) ? ack.channels : [];
  const visible = channels.some((channel) => channel.id === channelId);
  if (visible !== expectedVisible) {
    throw new Error(
      `WebUI channels smoke expected private channel ${channelId} visibility=${expectedVisible}, got ${visible}: ${formatAck(ack)}`,
    );
  }
}

async function waitForWebUiMentionScope({ page, expectedAgentId, absentHumanId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const expectedAgentId = ${JSON.stringify(expectedAgentId)};
      const absentHumanId = ${JSON.stringify(absentHumanId)};
      const candidates = Array.from(document.querySelectorAll('[data-smoke="mention-candidate"]'));
      const hasAgent = candidates.some((item) =>
        item.dataset.memberKind === 'agent' && item.dataset.memberId === expectedAgentId
      );
      const hasRemovedHuman = candidates.some((item) =>
        item.dataset.memberKind === 'human' && item.dataset.memberId === absentHumanId
      );
      return hasAgent && !hasRemovedHuman;
    })()
    `,
    'mention candidates follow current channel membership after member removal',
    timeoutMs,
  );
}

export async function exerciseWebUiNetworksBusinessSmoke({
  page,
  baseUrl,
  session,
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-28);
  const teamName = `WebUI Team ${safeSuffix}`;
  const description = `Created by WebUI smoke ${safeSuffix}`;
  await page.navigate(new URL(`/${networkPath}/networks`, root).toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="team-create-form"]') !== null`,
    'networks page exposes the create team form',
    timeoutMs,
  );
  await page.setInputValue('[data-smoke="team-create-name"]', teamName);
  await page.setInputValue('[data-smoke="team-create-description"]', description);
  await page.click('[data-smoke="team-create-submit"]');
  const created = await waitForWebUiTeamListItem({ page, teamName, timeoutMs });
  if (!created?.id || !created?.path) {
    throw new Error(`WebUI networks smoke could not resolve created team from list: ${formatAck(created)}`);
  }

  await page.evaluateJson(`
    (() => {
      const teamId = ${JSON.stringify(created.id)};
      const button = document.querySelector(\`[data-smoke="team-switch"][data-team-id="\${teamId}"]\`);
      if (!button) throw new Error("Missing team switch button");
      button.click();
      return true;
    })()
  `);
  await waitForWebUiCurrentTeam({ page, teamId: created.id, teamName, teamPath: created.path, timeoutMs });
  const restoredTeamPath = session.team.path ?? session.team.id;
  await page.navigate(new URL(`/${created.path}/settings`, root).toString());
  await page.click('[data-smoke="settings-tab-server"]');
  await page.waitForFunction(
    `
    (() => {
      const teamName = ${JSON.stringify(teamName)};
      const button = document.querySelector('[data-smoke="settings-team-delete-open"]');
      return Boolean(button)
        && !button.disabled
        && document.querySelector('[data-smoke="settings-team-name-input"]')?.value === teamName
        && window.location.pathname.includes(${JSON.stringify(`/${created.path}/settings`)});
    })()
    `,
    `temporary team "${teamName}" settings page exposes delete`,
    timeoutMs,
  );
  await page.click('[data-smoke="settings-team-delete-open"]');
  await page.waitForFunction(
    `
    (() => {
      const teamId = ${JSON.stringify(created.id)};
      const dialog = document.querySelector('[data-smoke="settings-team-delete-dialog"]');
      return Boolean(dialog) && dialog.dataset.teamId === teamId;
    })()
    `,
    `temporary team "${teamName}" delete confirmation opens`,
    timeoutMs,
  );
  await page.click('[data-smoke="settings-team-delete-confirm"]');
  await waitForWebUiDeletedTeamFallback({
    page,
    deletedTeamName: teamName,
    deletedTeamPath: created.path,
    timeoutMs,
  });
  await page.navigate(new URL(`/${restoredTeamPath}/networks`, root).toString());
  await waitForWebUiTeamListMissing({ page, teamId: created.id, teamName, timeoutMs });
  return { teamId: created.id, teamPath: created.path, teamName, restoredTeamPath, deleted: true };
}

async function waitForWebUiTeamListItem({ page, teamName, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const teamName = ${JSON.stringify(teamName)};
      return Array.from(document.querySelectorAll('[data-smoke="team-list-item"]'))
        .find((candidate) =>
          candidate.dataset.teamName === teamName ||
          candidate.textContent.includes(teamName)
        ) !== undefined;
    })()
    `,
    `team "${teamName}" to render in networks list`,
    timeoutMs,
  );
  return page.evaluateJson(`
    (() => {
      const teamName = ${JSON.stringify(teamName)};
      const item = Array.from(document.querySelectorAll('[data-smoke="team-list-item"]'))
        .find((candidate) =>
          candidate.dataset.teamName === teamName ||
          candidate.textContent.includes(teamName)
        );
      if (!item) return null;
      return {
        id: item.dataset.teamId,
        name: item.dataset.teamName,
        path: item.dataset.teamPath,
      };
    })()
  `);
}

async function waitForWebUiCurrentTeam({ page, teamId, teamName, teamPath, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const teamId = ${JSON.stringify(teamId)};
      const teamName = ${JSON.stringify(teamName)};
      const teamPath = ${JSON.stringify(teamPath)};
      const item = Array.from(document.querySelectorAll('[data-smoke="team-list-item"]'))
        .find((candidate) => candidate.dataset.teamId === teamId);
      return Boolean(item)
        && item.textContent.includes(teamName)
        && item.querySelector('[data-smoke="team-current-badge"]')
        && window.location.pathname.includes(\`/\${teamPath}/networks\`);
    })()
    `,
    `team "${teamName}" to become current`,
    timeoutMs,
  );
}

async function waitForWebUiDeletedTeamFallback({ page, deletedTeamName, deletedTeamPath, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const deletedTeamPath = ${JSON.stringify(deletedTeamPath)};
      const text = document.body.textContent || '';
      return !window.location.pathname.includes(\`/\${deletedTeamPath}/\`) &&
        document.querySelector('[data-smoke="settings-team-delete-dialog"]') === null &&
        !text.includes('删除失败') &&
        !text.includes('INTERNAL_ERROR');
    })()
    `,
    `delete flow to leave temporary team "${deletedTeamName}"`,
    timeoutMs,
  );
}

async function waitForWebUiTeamListMissing({ page, teamId, teamName, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const teamId = ${JSON.stringify(teamId)};
      const teamName = ${JSON.stringify(teamName)};
      return !Array.from(document.querySelectorAll('[data-smoke="team-list-item"]'))
        .some((candidate) =>
          candidate.dataset.teamId === teamId ||
          candidate.dataset.teamName === teamName ||
          candidate.textContent.includes(teamName)
        );
    })()
    `,
    `deleted team "${teamName}" to disappear from networks list`,
    timeoutMs,
  );
}

export async function exerciseWebUiTaskBusinessSmoke({
  page,
  baseUrl,
  session,
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const title = `WebUI smoke task ${suffix}`;
  const secondaryTitle = `WebUI smoke task secondary ${suffix}`;
  const description = `Created by WebUI smoke ${suffix}`;
  const targetStatus = 'in_progress';
  await page.navigate(new URL(`/${networkPath}/tasks`, root).toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="tasks-create-open"]') !== null`,
    'tasks page exposes the create task control',
    timeoutMs,
  );
  await createWebUiTask({ page, title, description, timeoutMs });
  await waitForWebUiTaskCard({ page, title, status: 'todo', timeoutMs });
  await createWebUiTask({ page, title: secondaryTitle, description: `${description} secondary`, timeoutMs });
  await waitForWebUiTaskCard({ page, title: secondaryTitle, status: 'todo', timeoutMs });

  await clickWebUiTaskAction({ page, title, selector: '[data-smoke="task-reorder-top"]', description: 'move task to top' });
  await waitForWebUiTaskOrder({ page, firstTitle: title, secondTitle: secondaryTitle, timeoutMs });

  const clickedStatusTrigger = await page.evaluateJson(`
    (() => {
      const title = ${JSON.stringify(title)};
      const card = Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .find((candidate) => candidate.dataset.taskTitle === title);
      const trigger = card?.querySelector('[data-smoke="task-status-trigger"]');
      if (!trigger) return false;
      trigger.click();
      return true;
    })()
  `);
  if (!clickedStatusTrigger) {
    throw new Error(`Could not open the status menu for WebUI smoke task "${title}"`);
  }
  await page.click(`[data-smoke="task-status-option-${targetStatus}"]`);
  await waitForWebUiTaskCard({ page, title, status: targetStatus, timeoutMs });

  await clickWebUiTaskAction({ page, title: secondaryTitle, selector: '[data-smoke="task-delete"]', description: 'delete secondary task' });
  await waitForWebUiTaskAbsent({ page, title: secondaryTitle, timeoutMs });

  await page.reload();
  await waitForWebUiTaskCard({ page, title, status: targetStatus, timeoutMs });
  await waitForWebUiTaskAbsent({ page, title: secondaryTitle, timeoutMs });
  return { title, status: targetStatus, reordered: true, deletedTitle: secondaryTitle };
}

async function createWebUiTask({ page, title, description, timeoutMs }) {
  await page.click('[data-smoke="tasks-create-open"]');
  await page.waitForFunction(
    `document.querySelector('[data-smoke="tasks-create-form"]') !== null`,
    'tasks create form opens',
    timeoutMs,
  );
  await page.setInputValue('[data-smoke="tasks-create-title"]', title);
  await page.setInputValue('[data-smoke="tasks-create-description"]', description);
  await page.setInputValue('[data-smoke="tasks-create-tags"]', 'smoke, webui');
  await page.click('[data-smoke="tasks-create-submit"]');
}

async function waitForWebUiTaskCard({ page, title, status, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const title = ${JSON.stringify(title)};
      const status = ${JSON.stringify(status)};
      return Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .some((candidate) =>
          candidate.dataset.taskTitle === title
          && (!status || candidate.dataset.taskStatus === status)
        );
    })()
    `,
    `task "${title}" to render${status ? ` with status ${status}` : ''}`,
    timeoutMs,
  );
}

async function waitForWebUiTaskAbsent({ page, title, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const title = ${JSON.stringify(title)};
      return !Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .some((candidate) => candidate.dataset.taskTitle === title);
    })()
    `,
    `task "${title}" to disappear`,
    timeoutMs,
  );
}

async function waitForWebUiTaskOrder({ page, firstTitle, secondTitle, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const firstTitle = ${JSON.stringify(firstTitle)};
      const secondTitle = ${JSON.stringify(secondTitle)};
      const items = Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .filter((candidate) => candidate.dataset.taskStatus === 'todo');
      const firstIndex = items.findIndex((candidate) => candidate.dataset.taskTitle === firstTitle);
      const secondIndex = items.findIndex((candidate) => candidate.dataset.taskTitle === secondTitle);
      if (firstIndex < 0 || secondIndex < 0) return false;
      const firstSort = Number(items[firstIndex].dataset.taskSortOrder);
      const secondSort = Number(items[secondIndex].dataset.taskSortOrder);
      return firstIndex < secondIndex && Number.isFinite(firstSort) && Number.isFinite(secondSort) && firstSort < secondSort;
    })()
    `,
    `task "${firstTitle}" to render above "${secondTitle}" after reorder`,
    timeoutMs,
  );
}

async function clickWebUiTaskAction({ page, title, selector, description }) {
  const clicked = await page.evaluateJson(`
    (() => {
      const title = ${JSON.stringify(title)};
      const selector = ${JSON.stringify(selector)};
      const item = Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .find((candidate) => candidate.dataset.taskTitle === title);
      const action = item?.querySelector(selector);
      if (!action) return false;
      action.click();
      return true;
    })()
  `);
  if (!clicked) {
    throw new Error(`Could not ${description} for WebUI smoke task "${title}"`);
  }
}

export async function exerciseWebUiRunsBusinessSmoke({
  page,
  baseUrl,
  webSocket,
  session,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  if (!session.channel?.id) {
    throw new Error('WebUI runs smoke needs a default channel in the seeded session');
  }
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const workspaceRunId = `webui-run-${safeSuffix}`;
  const logArtifactId = `webui-log-${safeSuffix}`;
  const summaryArtifactId = `webui-summary-${safeSuffix}`;
  const command = `agentbean-webui-smoke workspace ${safeSuffix}`;
  const logExcerpt = [
    'starting WebUI workspace run smoke',
    `command: ${command}`,
    'finished WebUI workspace run smoke',
  ].join('\n');

  const daemon = await connectSmokeDaemon({
    baseUrl: root,
    ioFactory,
    session,
    suffix,
    timeoutMs,
    dispatchResultFactory(request) {
      const completedAt = Date.now();
      return {
        body: `browser-smoke:${request.prompt}`,
        artifacts: [
          {
            id: logArtifactId,
            filename: 'workspace-run.log',
            mimeType: 'text/plain',
            relativePath: 'logs/workspace-run.log',
            contentBase64: Buffer.from(logExcerpt).toString('base64'),
          },
          {
            id: summaryArtifactId,
            filename: 'summary.md',
            mimeType: 'text/markdown',
            relativePath: 'outputs/summary.md',
            contentBase64: Buffer.from(`# Workspace smoke\n\n${command}\n`).toString('base64'),
          },
        ],
        workspaceRun: {
          id: workspaceRunId,
          cwd: '/tmp/agentbean-webui-smoke',
          command,
          logExcerpt,
          exitCode: 0,
          status: 'succeeded',
          startedAt: completedAt - 750,
          completedAt,
        },
      };
    },
  });

  try {
    await emitAck(webSocket, WEB_EVENTS.channel.subscribe, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);
    await emitAck(webSocket, WEB_EVENTS.agent.subscribe, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);
    const agentName = `WebUIRun${safeSuffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
    const agentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      userId: session.user.id,
      teamId: session.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      env: { AGENTBEAN_WEBUI_RUN_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    if (!agentId) {
      throw new Error(`WebUI runs smoke could not create a custom agent: ${formatAck(agentAck)}`);
    }

    const sourceMessageBody = `@${agentName} produce workspace run`;
    const sendAck = await emitAck(webSocket, WEB_EVENTS.message.send, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId: session.channel.id,
      body: sourceMessageBody,
    }, timeoutMs);
    const dispatchId = Array.isArray(sendAck?.dispatches) ? sendAck.dispatches[0]?.id : undefined;
    if (typeof dispatchId !== 'string') {
      throw new Error(`WebUI runs smoke message did not create a dispatch: ${formatAck(sendAck)}`);
    }

    await page.navigate(new URL(`/${networkPath}/runs`, root).toString());
    await waitForWebUiWorkspaceRunCard({ page, command, timeoutMs });
    await page.setInputValue('[data-smoke="workspace-runs-filter-status"]', 'succeeded');
    await waitForWebUiWorkspaceRunCard({ page, command, timeoutMs });
    await page.setInputValue('[data-smoke="workspace-runs-filter-agent"]', agentId);
    await waitForWebUiWorkspaceRunCard({ page, command, timeoutMs });
    await page.setInputValue('[data-smoke="workspace-runs-filter-device"]', daemon.deviceId);
    await waitForWebUiWorkspaceRunCard({ page, command, timeoutMs });
    await page.setInputValue('[data-smoke="workspace-runs-filter-group"]', 'status');
    await waitForWebUiWorkspaceRunGroup({ page, key: 'succeeded', label: '成功', timeoutMs });
    const clickedDetail = await page.evaluateJson(`
      (() => {
        const command = ${JSON.stringify(command)};
        const card = Array.from(document.querySelectorAll('[data-smoke="workspace-run-card"]'))
          .find((candidate) => candidate.dataset.runCommand === command);
        const link = card?.querySelector('[data-smoke="workspace-run-detail-link"]');
        if (!link) return false;
        link.click();
        return true;
      })()
    `);
    if (!clickedDetail) {
      throw new Error(`Could not open the workspace run detail link for "${command}"`);
    }
    await waitForWebUiWorkspaceRunDetail({ page, command, timeoutMs });
    await waitForWebUiWorkspaceRunFullLog({ page, artifactId: logArtifactId, timeoutMs });
    await waitForWebUiWorkspaceRunArtifactTree({ page, summaryArtifactId, timeoutMs });
    await waitForWebUiWorkspaceRunSourceMessageLink({ page, timeoutMs });
    await page.click('[data-smoke="workspace-run-full-log-load"]');
    await waitForWebUiWorkspaceRunInlineLog({ page, expectedText: 'finished WebUI workspace run smoke', timeoutMs });
    await page.setInputValue('[data-smoke="workspace-run-full-log-search"]', 'finished');
    await page.click('[data-smoke="workspace-run-full-log-search-submit"]');
    await waitForWebUiWorkspaceRunInlineLogSearch({ page, expectedText: 'finished WebUI workspace run smoke', timeoutMs });
    await page.reload();
    await waitForWebUiWorkspaceRunDetail({ page, command, timeoutMs });
    await waitForWebUiWorkspaceRunFullLog({ page, artifactId: logArtifactId, timeoutMs });
    await waitForWebUiWorkspaceRunArtifactTree({ page, summaryArtifactId, timeoutMs });
    await waitForWebUiWorkspaceRunSourceMessageLink({ page, timeoutMs });
    await page.click('[data-smoke="workspace-run-full-log-load"]');
    await waitForWebUiWorkspaceRunInlineLog({ page, expectedText: 'finished WebUI workspace run smoke', timeoutMs });
    await waitForWebUiWorkspaceRunBackToList({ page, networkPath, timeoutMs });
    await page.click('[data-smoke="workspace-run-source-message-link"]');
    await waitForWebUiWorkspaceRunSourceMessage({ page, expectedText: sourceMessageBody, timeoutMs });
    return { id: workspaceRunId, command, dispatchId, logArtifactId, summaryArtifactId };
  } finally {
    daemon.socket.disconnect?.();
  }
}

async function waitForWebUiWorkspaceRunCard({ page, command, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const command = ${JSON.stringify(command)};
      return Array.from(document.querySelectorAll('[data-smoke="workspace-run-card"]'))
        .some((candidate) => candidate.dataset.runCommand === command);
    })()
    `,
    `workspace run "${command}" to render in the list`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunGroup({ page, key, label, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const key = ${JSON.stringify(key)};
      const label = ${JSON.stringify(label)};
      const group = document.querySelector('[data-smoke="workspace-runs-group"]');
      return group?.dataset.groupKey === key
        && group?.dataset.groupLabel === label
        && group.textContent?.includes(label);
    })()
    `,
    `workspace runs group "${label}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunDetail({ page, command, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const command = ${JSON.stringify(command)};
      const detail = document.querySelector('[data-smoke="workspace-run-detail"]');
      const commandNode = document.querySelector('[data-smoke="workspace-run-command"]');
      return Boolean(detail)
        && detail.dataset.runCommand === command
        && commandNode?.textContent?.includes(command);
    })()
    `,
    `workspace run "${command}" detail to render`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunBackToList({ page, networkPath, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const networkPath = ${JSON.stringify(networkPath)};
      const link = document.querySelector('[data-smoke="workspace-run-back-to-list"]');
      return link?.getAttribute('href') === '/' + networkPath + '/runs';
    })()
    `,
    'workspace run detail back link to return to the runs list',
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunFullLog({ page, artifactId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const artifactId = ${JSON.stringify(artifactId)};
      const panel = document.querySelector('[data-smoke="workspace-run-full-log"]');
      const preview = document.querySelector('[data-smoke="workspace-run-full-log-preview"]');
      const download = document.querySelector('[data-smoke="workspace-run-full-log-download"]');
      return Boolean(panel)
        && panel.dataset.artifactId === artifactId
        && panel.dataset.artifactPath === 'logs/workspace-run.log'
        && preview?.getAttribute('href')?.includes('/api/teams/')
        && preview?.getAttribute('href')?.includes('/artifacts/')
        && preview?.getAttribute('href')?.includes('/preview')
        && preview?.getAttribute('href')?.includes('token=')
        && download?.getAttribute('href')?.includes('/download')
        && download?.getAttribute('href')?.includes('token=');
    })()
    `,
    `workspace run full log artifact "${artifactId}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunArtifactTree({ page, summaryArtifactId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const summaryArtifactId = ${JSON.stringify(summaryArtifactId)};
      const tree = document.querySelector('[data-smoke="workspace-run-artifact-tree"]');
      const dirs = new Set(Array.from(document.querySelectorAll('[data-smoke="workspace-run-artifact-tree-dir"]'))
        .map((candidate) => candidate.dataset.artifactPath));
      const files = Array.from(document.querySelectorAll('[data-smoke="workspace-run-artifact-tree-file"]'));
      const filePaths = new Set(files.map((candidate) => candidate.dataset.artifactPath));
      const summary = files.find((candidate) => candidate.dataset.artifactId === summaryArtifactId);
      const summaryHref = summary?.getAttribute('href') ?? '';
      return tree?.dataset.artifactCount === '2'
        && tree?.dataset.dirCount === '2'
        && dirs.has('logs')
        && dirs.has('outputs')
        && filePaths.has('logs/workspace-run.log')
        && filePaths.has('outputs/summary.md')
        && summaryHref.includes('/api/teams/')
        && summaryHref.includes('/artifacts/')
        && summaryHref.includes('/download')
        && summaryHref.includes('token=');
    })()
    `,
    `workspace run artifact tree to include logs and outputs artifacts`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunSourceMessageLink({ page, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const link = document.querySelector('[data-smoke="workspace-run-source-message-link"]');
      const href = link?.getAttribute('href') ?? '';
      return href.includes('/channel/') && href.includes('message=');
    })()
    `,
    'workspace run source message link to render',
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunSourceMessage({ page, expectedText, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const expectedText = ${JSON.stringify(expectedText)};
      const selected = document.querySelector('[data-smoke="chat-message"][data-message-selected="true"]');
      return window.location.pathname.includes('/channel/')
        && (
          selected?.dataset.messageBody === expectedText
          || Boolean(selected?.textContent?.includes(expectedText))
        );
    })()
    `,
    `workspace run source message "${expectedText}" to render selected`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunInlineLog({ page, expectedText, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const expectedText = ${JSON.stringify(expectedText)};
      const viewer = document.querySelector('[data-smoke="workspace-run-full-log-viewer"]');
      return Boolean(viewer) && viewer.textContent?.includes(expectedText);
    })()
    `,
    `workspace run inline full log to include "${expectedText}"`,
    timeoutMs,
  );
}

async function waitForWebUiWorkspaceRunInlineLogSearch({ page, expectedText, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const expectedText = ${JSON.stringify(expectedText)};
      const viewer = document.querySelector('[data-smoke="workspace-run-full-log-viewer"]');
      const input = document.querySelector('[data-smoke="workspace-run-full-log-search"]');
      const count = document.querySelector('[data-smoke="workspace-run-full-log-match-count"]');
      return input?.value === 'finished'
        && viewer?.dataset.matchCount === '1'
        && viewer?.textContent?.includes(expectedText)
        && count?.textContent?.includes('1 /');
    })()
    `,
    'workspace run inline full log search to filter matching lines',
    timeoutMs,
  );
}

export async function exerciseWebUiMembersBusinessSmoke({
  page,
  baseUrl,
  session,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const username = `webui-member-${safeSuffix}`.toLowerCase();
  const password = `secret-${safeSuffix}`;
  const ownerSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs, {
    auth: { token: session.token },
  });
  const memberSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs);
  try {
    const linkAck = await emitAck(ownerSocket, WEB_EVENTS.join.create, { maxUses: 1 }, timeoutMs);
    const joinCode = readNestedString(linkAck, ['link', 'code']);
    if (!joinCode) {
      throw new Error(`WebUI members smoke could not create a join link: ${formatAck(linkAck)}`);
    }

    const registerAck = await emitAck(memberSocket, WEB_EVENTS.auth.register, {
      username,
      password,
      teamName: `Unused WebUI Member ${safeSuffix}`,
      joinCode,
    }, timeoutMs);
    const targetUserId = readNestedString(registerAck, ['user', 'id']);
    if (registerAck?.ok !== true || !targetUserId) {
      throw new Error(`WebUI members smoke could not register joined member: ${formatAck(registerAck)}`);
    }
    const serverMembersAck = await emitAck(ownerSocket, WEB_EVENTS.member.list, {
      teamId: session.team.id,
    }, timeoutMs);
    const serverHumans = Array.isArray(serverMembersAck?.humans) ? serverMembersAck.humans : [];
    if (!serverHumans.some((human) => human.userId === targetUserId)) {
      throw new Error(
        `WebUI members smoke joined member was not visible from members:list: ${formatAck(serverMembersAck)}`,
      );
    }

    await page.navigate(new URL(`/${networkPath}/members`, root).toString());
    await waitForWebUiHumanMemberItem({ page, userId: targetUserId, role: 'member', timeoutMs });
    const clickedMember = await page.evaluateJson(`
      (() => {
        const userId = ${JSON.stringify(targetUserId)};
        const item = Array.from(document.querySelectorAll('[data-smoke="human-member-item"]'))
          .find((candidate) => candidate.dataset.userId === userId);
        if (!item) return false;
        item.click();
        return true;
      })()
    `);
    if (!clickedMember) {
      throw new Error(`Could not select WebUI smoke member "${username}"`);
    }
    await waitForWebUiHumanMemberDetail({ page, userId: targetUserId, role: 'member', timeoutMs });

    await waitForWebUiHumanMemberAction({ page, selector: '[data-smoke="member-role-promote-admin"]', timeoutMs });
    await page.click('[data-smoke="member-role-promote-admin"]');
    await waitForWebUiHumanMemberDetail({ page, userId: targetUserId, role: 'admin', timeoutMs });
    await waitForWebUiHumanMemberItem({ page, userId: targetUserId, role: 'admin', timeoutMs });

    await waitForWebUiHumanMemberAction({ page, selector: '[data-smoke="member-role-demote-member"]', timeoutMs });
    await page.click('[data-smoke="member-role-demote-member"]');
    await waitForWebUiHumanMemberDetail({ page, userId: targetUserId, role: 'member', timeoutMs });
    await waitForWebUiHumanMemberItem({ page, userId: targetUserId, role: 'member', timeoutMs });

    await page.reload();
    await waitForWebUiHumanMemberDetail({ page, userId: targetUserId, role: 'member', timeoutMs });
    return { userId: targetUserId, username };
  } finally {
    memberSocket.disconnect?.();
    ownerSocket.disconnect?.();
  }
}

async function waitForWebUiHumanMemberItem({ page, userId, role, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const userId = ${JSON.stringify(userId)};
      const role = ${JSON.stringify(role)};
      return Array.from(document.querySelectorAll('[data-smoke="human-member-item"]'))
        .some((candidate) =>
          candidate.dataset.userId === userId
          && (!role || candidate.dataset.memberRole === role)
        );
    })()
    `,
    `human member "${userId}" to render${role ? ` with role ${role}` : ''}`,
    timeoutMs,
  );
}

async function waitForWebUiHumanMemberDetail({ page, userId, role, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const userId = ${JSON.stringify(userId)};
      const role = ${JSON.stringify(role)};
      const detail = document.querySelector('[data-smoke="human-member-detail"]');
      return Boolean(detail)
        && detail.dataset.userId === userId
        && (!role || detail.dataset.memberRole === role);
    })()
    `,
    `human member "${userId}" detail to render${role ? ` with role ${role}` : ''}`,
    timeoutMs,
  );
}

async function waitForWebUiHumanMemberAction({ page, selector, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      return Boolean(button) && !button.disabled;
    })()
    `,
    `human member action "${selector}" to become clickable`,
    timeoutMs,
  );
}

export async function exerciseWebUiDevicesBusinessSmoke({
  page,
  baseUrl,
  webSocket,
  session,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const renamedDeviceName = `webui-device-${safeSuffix}`;
  const customAgentName = `webui-custom-${safeSuffix}`;
  const scannedAgentName = `webui-agentos-${safeSuffix}`;
  const daemon = await connectSmokeDaemon({
    baseUrl: root,
    ioFactory,
    session,
    suffix,
    timeoutMs,
  });

  try {
    if (!webSocket) {
      throw new Error('WebUI devices smoke needs an authenticated web socket for seeded custom agent coverage');
    }
    const customAgentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      userId: session.user.id,
      teamId: session.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: customAgentName,
      env: { AGENTBEAN_WEBUI_DEVICE_SMOKE: '1' },
    }, timeoutMs);
    const customAgentId = readNestedString(customAgentAck, ['agent', 'id']);
    if (!customAgentId) {
      throw new Error(`WebUI devices smoke could not create a custom agent: ${formatAck(customAgentAck)}`);
    }

    const scanReported = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      daemon.socket.on(AGENT_EVENTS.device.scanRequested, async (request) => {
        try {
          if (request?.deviceId !== daemon.deviceId) {
            return;
          }
          await emitAck(daemon.socket, AGENT_EVENTS.device.runtimes, {
            teamId: session.team.id,
            deviceId: daemon.deviceId,
            runtimes: [{
              adapterKind: 'codex',
              name: 'Codex CLI',
              command: 'agentbean-browser-smoke-scan',
              installed: true,
            }],
          }, timeoutMs);
          const scannedAck = await emitAck(daemon.socket, AGENT_EVENTS.agent.registerBatch, {
            teamId: session.team.id,
            deviceId: daemon.deviceId,
            agents: [{
              name: scannedAgentName,
              adapterKind: 'codex',
              category: 'agentos-hosted',
              gatewayInstanceKey: `webui-device-smoke:${safeSuffix}`,
              command: 'agentbean-browser-smoke-scan',
              cwd: '/tmp/agentbean-webui-device-smoke',
            }],
          }, timeoutMs);
          const scannedAgentId = readNestedString(scannedAck, ['agents', 0, 'id']);
          if (!scannedAgentId) {
            throw new Error(`WebUI devices smoke scan did not register an AgentOS agent: ${formatAck(scannedAck)}`);
          }
          settle(resolve, { requestId: request.requestId, scannedAgentId });
        } catch (error) {
          settle(reject, error);
        }
      });
    });

    await page.navigate(new URL(`/${networkPath}/devices`, root).toString());
    await waitForWebUiDeviceListItem({ page, deviceId: daemon.deviceId, timeoutMs });
    await page.navigate(new URL(`/${networkPath}/devices/${daemon.deviceId}`, root).toString());
    await waitForWebUiDeviceDetail({ page, deviceId: daemon.deviceId, timeoutMs });
    await waitForWebUiDeviceRuntime({ page, command: 'agentbean-browser-smoke', timeoutMs });
    await waitForWebUiDeviceAgent({ page, kind: 'custom', agentId: customAgentId, name: customAgentName, timeoutMs });

    await page.click('[data-smoke="device-runtime-scan"]');
    const scanResult = await promiseWithTimeout(
      scanReported,
      timeoutMs,
      `device "${daemon.deviceId}" scan request to reach the smoke daemon`,
    );
    await waitForWebUiDeviceRuntime({ page, command: 'agentbean-browser-smoke-scan', timeoutMs });
    await waitForWebUiDeviceAgent({
      page,
      kind: 'agentos',
      agentId: scanResult.scannedAgentId,
      name: scannedAgentName,
      timeoutMs,
    });

    await page.click('[data-smoke="device-rename-open"]');
    await page.waitForFunction(
      `Boolean(document.querySelector('[data-smoke="device-rename-input"]'))`,
      'device rename input to render',
      timeoutMs,
    );
    await page.fillInputAsUser('[data-smoke="device-rename-input"]', renamedDeviceName);
    await page.waitForFunction(
      `document.querySelector('[data-smoke="device-rename-input"]')?.value === ${JSON.stringify(renamedDeviceName)}`,
      'device rename input value to update',
      timeoutMs,
    );
    await sleep(100);
    await page.click('[data-smoke="device-rename-save"]');
    await waitForWebUiDeviceDetail({ page, deviceId: daemon.deviceId, name: renamedDeviceName, timeoutMs });
    await waitForWebUiDeviceListItem({ page, deviceId: daemon.deviceId, name: renamedDeviceName, timeoutMs });

    await page.reload();
    await waitForWebUiDeviceDetail({ page, deviceId: daemon.deviceId, name: renamedDeviceName, timeoutMs });
    await page.click('[data-smoke="device-delete-open"]');
    await page.waitForFunction(
      `Boolean(document.querySelector('[data-smoke="device-delete-confirm"]'))`,
      'device delete confirmation to render',
      timeoutMs,
    );
    await page.click('[data-smoke="device-delete-confirm"]');
    await waitForWebUiDeviceListItemAbsent({ page, deviceId: daemon.deviceId, timeoutMs });
    return {
      deviceId: daemon.deviceId,
      name: renamedDeviceName,
      customAgentId,
      scannedAgentId: scanResult.scannedAgentId,
    };
  } finally {
    daemon.socket.disconnect?.();
  }
}

async function waitForWebUiDeviceListItem({ page, deviceId, name, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      const name = ${JSON.stringify(name ?? '')};
      return Array.from(document.querySelectorAll('[data-smoke="device-list-item"]'))
        .some((candidate) =>
          candidate.dataset.deviceId === deviceId
          && (!name || candidate.dataset.deviceName === name || candidate.textContent.includes(name))
        );
    })()
    `,
    `device "${deviceId}" to render${name ? ` as ${name}` : ''}`,
    timeoutMs,
  );
}

async function waitForWebUiDeviceListItemAbsent({ page, deviceId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      return !Array.from(document.querySelectorAll('[data-smoke="device-list-item"]'))
        .some((candidate) => candidate.dataset.deviceId === deviceId);
    })()
    `,
    `device "${deviceId}" to disappear from list`,
    timeoutMs,
  );
}

async function waitForWebUiDeviceDetail({ page, deviceId, name, timeoutMs }) {
  const expression = `
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      const name = ${JSON.stringify(name ?? '')};
      const detail = document.querySelector('[data-smoke="device-detail"]');
      const hasExpectedName = Boolean(name && detail?.textContent.includes(name));
      return Boolean(detail)
        && (detail.dataset.deviceId === deviceId || hasExpectedName)
        && (!name || detail.dataset.deviceName === name || hasExpectedName);
    })()
  `;
  const description = `device "${deviceId}" detail to render${name ? ` as ${name}` : ''}`;
  try {
    await page.waitForFunction(expression, description, timeoutMs);
  } catch (error) {
    const debug = await page.evaluateJson(`
      (() => {
        const name = ${JSON.stringify(name ?? '')};
        const detail = document.querySelector('[data-smoke="device-detail"]');
        return {
          path: location.pathname,
          found: Boolean(detail),
          dataset: detail ? { ...detail.dataset } : null,
          includesName: Boolean(name && detail?.textContent.includes(name)),
          text: detail?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 500) ?? null,
        };
      })()
    `).catch((debugError) => ({ debugError: debugError instanceof Error ? debugError.message : String(debugError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; current detail ${JSON.stringify(debug)}`);
  }
}

async function waitForWebUiDeviceRuntime({ page, command, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const command = ${JSON.stringify(command)};
      return Array.from(document.querySelectorAll('[data-smoke="device-runtime-item"]'))
        .some((candidate) => candidate.dataset.runtimeCommand === command || candidate.textContent.includes(command));
    })()
    `,
    `device runtime "${command}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiDeviceAgent({ page, kind, agentId, name, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const kind = ${JSON.stringify(kind)};
      const agentId = ${JSON.stringify(agentId)};
      const name = ${JSON.stringify(name)};
      return Array.from(document.querySelectorAll('[data-smoke="device-agent-item"]'))
        .some((candidate) =>
          candidate.dataset.agentKind === kind
          && (!agentId || candidate.dataset.agentId === agentId)
          && (!name || candidate.dataset.agentName === name || candidate.textContent.includes(name))
        );
    })()
    `,
    `device ${kind} agent "${name || agentId}" to render`,
    timeoutMs,
  );
}

export async function exerciseWebUiSettingsBusinessSmoke({
  page,
  baseUrl,
  session,
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const teamName = `WebUI Settings ${safeSuffix}`;
  await page.navigate(new URL(`/${networkPath}/settings`, root).toString());
  await page.waitForFunction(
    `
    (() => {
      const panel = document.querySelector('[data-smoke="settings-account-panel"]');
      return panel?.dataset.settingsUsername === ${JSON.stringify(session.user.username)}
        && document.querySelector('[data-smoke="settings-account-logout"]');
    })()
    `,
    `settings account tab to expose current user "${session.user.username}" and logout`,
    timeoutMs,
  );

  await page.click('[data-smoke="settings-tab-browser"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="settings-browser-panel"]'))`,
    'settings browser panel to render',
    timeoutMs,
  );
  await page.click('[data-smoke="settings-browser-sound"]');
  await page.click('[data-smoke="settings-browser-compact-mode"]');
  await page.click('[data-smoke="settings-browser-send-enter"]');
  await page.setInputValue('[data-smoke="settings-browser-attachment-open-mode"]', 'new-tab');
  await page.waitForFunction(
    `
    (() => {
      const raw = window.localStorage.getItem('agentbean.browserSettings.v1');
      if (!raw) return false;
      const settings = JSON.parse(raw);
      return settings.sound === false
        && settings.compactMode === true
        && settings.messageSendMode === 'enter'
        && settings.attachmentOpenMode === 'new-tab'
        && document.querySelector('[data-smoke="settings-browser-sound"]')?.dataset.settingsChecked === 'false'
        && document.querySelector('[data-smoke="settings-browser-compact-mode"]')?.dataset.settingsChecked === 'true'
        && document.querySelector('[data-smoke="settings-browser-send-enter"]')?.dataset.settingsSelected === 'true'
        && document.querySelector('[data-smoke="settings-browser-attachment-open-mode"]')?.value === 'new-tab';
    })()
    `,
    'settings browser preferences to save into localStorage',
    timeoutMs,
  );

  await page.reload();
  await page.click('[data-smoke="settings-tab-browser"]');
  await page.waitForFunction(
    `
    (() => {
      return document.querySelector('[data-smoke="settings-browser-sound"]')?.dataset.settingsChecked === 'false'
        && document.querySelector('[data-smoke="settings-browser-compact-mode"]')?.dataset.settingsChecked === 'true'
        && document.querySelector('[data-smoke="settings-browser-send-enter"]')?.dataset.settingsSelected === 'true'
        && document.querySelector('[data-smoke="settings-browser-attachment-open-mode"]')?.value === 'new-tab';
    })()
    `,
    'settings browser preferences to restore after refresh',
    timeoutMs,
  );
  await page.click('[data-smoke="settings-browser-reset"]');
  await page.waitForFunction(
    `
    (() => {
      return window.localStorage.getItem('agentbean.browserSettings.v1') === null
        && document.querySelector('[data-smoke="settings-browser-sound"]')?.dataset.settingsChecked === 'true'
        && document.querySelector('[data-smoke="settings-browser-compact-mode"]')?.dataset.settingsChecked === 'false'
        && document.querySelector('[data-smoke="settings-browser-send-mod-enter"]')?.dataset.settingsSelected === 'true'
        && document.querySelector('[data-smoke="settings-browser-attachment-open-mode"]')?.value === 'inline';
    })()
    `,
    'settings browser preferences to reset to defaults',
    timeoutMs,
  );

  await page.click('[data-smoke="settings-tab-server"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="settings-team-name-input"]'))`,
    'settings team name input to render',
    timeoutMs,
  );

  await page.setInputValue('[data-smoke="settings-team-name-input"]', teamName);
  await page.waitForFunction(
    `
    (() => {
      const input = document.querySelector('[data-smoke="settings-team-name-input"]');
      const button = document.querySelector('[data-smoke="settings-team-name-save"]');
      return input?.value === ${JSON.stringify(teamName)} && button && !button.disabled;
    })()
    `,
    'settings team name input value to update and enable save',
    timeoutMs,
  );
  await page.click('[data-smoke="settings-team-name-save"]');
  await page.waitForFunction(
    `
    (() => {
      const input = document.querySelector('[data-smoke="settings-team-name-input"]');
      const button = document.querySelector('[data-smoke="settings-team-name-save"]');
      const message = document.querySelector('[data-smoke="settings-team-name-message"]');
      return document.body.textContent.includes(${JSON.stringify(teamName)})
        && input?.value === ${JSON.stringify(teamName)}
        && (message?.textContent.includes('保存成功') || Boolean(button?.disabled));
    })()
    `,
    `settings team name "${teamName}" to save`,
    timeoutMs,
  );

  await page.setInputValue('[data-smoke="settings-join-max-uses"]', '2');
  await page.click('[data-smoke="settings-join-create"]');
  const joinCode = await waitForWebUiSettingsJoinLink({ page, timeoutMs });

  const revoked = await page.evaluateJson(`
    (() => {
      const code = ${JSON.stringify(joinCode)};
      const button = Array.from(document.querySelectorAll('[data-smoke="settings-join-revoke"]'))
        .find((candidate) => candidate.dataset.joinCode === code);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!revoked) {
    throw new Error(`Could not revoke WebUI settings join link "${joinCode}"`);
  }
  await page.waitForFunction(
    `
    (() => {
      const code = ${JSON.stringify(joinCode)};
      return !Array.from(document.querySelectorAll('[data-smoke="settings-join-link"]'))
        .some((candidate) => candidate.dataset.joinCode === code);
    })()
    `,
    `settings join link "${joinCode}" to disappear after revoke`,
    timeoutMs,
  );

  await page.reload();
  await page.click('[data-smoke="settings-tab-server"]');
  await page.waitForFunction(
    `
    (() => {
      const code = ${JSON.stringify(joinCode)};
      return document.body.textContent.includes(${JSON.stringify(teamName)})
        && !Array.from(document.querySelectorAll('[data-smoke="settings-join-link"]'))
          .some((candidate) => candidate.dataset.joinCode === code);
    })()
    `,
    `settings team name "${teamName}" and revoked join link state to restore after refresh`,
    timeoutMs,
  );
  return { teamName, joinCode, username: session.user.username, browserPreferencesReset: true };
}

async function waitForWebUiSettingsJoinLink({ page, timeoutMs }) {
  await page.waitForFunction(
    `document.querySelector('[data-smoke="settings-join-link"]')?.dataset.joinCode`,
    'settings join link to render',
    timeoutMs,
  );
  const joinCode = await page.evaluateJson(`
    document.querySelector('[data-smoke="settings-join-link"]')?.dataset.joinCode ?? null
  `);
  if (typeof joinCode !== 'string' || joinCode.length === 0) {
    throw new Error(`Settings join link did not expose a code: ${String(joinCode)}`);
  }
  return joinCode;
}

export async function exerciseWebUiAgentsBusinessSmoke({
  page,
  baseUrl,
  webSocket,
  session,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  assertSession(session);
  if (!session.channel?.id) {
    throw new Error('WebUI agents smoke needs a default channel in the seeded session');
  }
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const networkPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const agentName = `WebUIAgent${safeSuffix.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
  const configuredAgentName = `${agentName}Cfg`;
  const targetTeamName = `WebUI Agent Target ${safeSuffix}`;
  const daemon = await connectSmokeDaemon({
    baseUrl: root,
    ioFactory,
    session,
    suffix,
    timeoutMs,
  });

  try {
    await emitAck(webSocket, WEB_EVENTS.agent.subscribe, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);
    const agentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      userId: session.user.id,
      teamId: session.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      env: { AGENTBEAN_WEBUI_AGENT_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    if (!agentId) {
      throw new Error(`WebUI agents smoke could not create a custom agent: ${formatAck(agentAck)}`);
    }

    const targetTeamAck = await emitAck(webSocket, WEB_EVENTS.team.create, {
      userId: session.user.id,
      name: targetTeamName,
      visibility: 'private',
    }, timeoutMs);
    const targetTeamId = readNestedString(targetTeamAck, ['team', 'id']);
    if (!targetTeamId) {
      throw new Error(`WebUI agents smoke could not create target team: ${formatAck(targetTeamAck)}`);
    }
    await emitAck(webSocket, WEB_EVENTS.team.switch, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);

    await page.navigate(new URL(`/${networkPath}/agents`, root).toString());
    await waitForWebUiAgentListItem({ page, agentId, name: agentName, timeoutMs });
    await page.navigate(new URL(`/${networkPath}/agents/${agentId}`, root).toString());
    await waitForWebUiAgentDetail({ page, agentId, name: agentName, timeoutMs });

    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-config-open"]', timeoutMs });
    await page.click('[data-smoke="agent-config-open"]');
    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-config-dialog"]', timeoutMs });
    await page.setInputValue('[data-smoke="agent-config-name"]', configuredAgentName);
    await page.setInputValue('[data-smoke="agent-config-description"]', 'Updated by AgentBean Next WebUI agents parity smoke');
    await page.setInputValue('[data-smoke="agent-config-command"]', 'codex');
    await page.setInputValue('[data-smoke="agent-config-cwd"]', '/tmp/agentbean-next-agents-smoke');
    await page.click('[data-smoke="agent-config-save"]');
    await waitForWebUiAgentDetail({ page, agentId, name: configuredAgentName, timeoutMs });

    await waitForWebUiAgentPublishToggle({ page, targetTeamId, published: false, timeoutMs });
    await page.evaluateJson(`
      (() => {
        const teamId = ${JSON.stringify(targetTeamId)};
        const button = Array.from(document.querySelectorAll('[data-smoke="agent-publish-toggle"]'))
          .find((candidate) => candidate.dataset.teamId === teamId);
        if (!button) throw new Error("Missing publish toggle for target team");
        button.click();
        return true;
      })()
    `);
    await waitForWebUiAgentPublishToggle({ page, targetTeamId, published: true, timeoutMs });
    await page.evaluateJson(`
      (() => {
        const teamId = ${JSON.stringify(targetTeamId)};
        const button = Array.from(document.querySelectorAll('[data-smoke="agent-publish-toggle"]'))
          .find((candidate) => candidate.dataset.teamId === teamId);
        if (!button) throw new Error("Missing publish toggle for target team");
        button.click();
        return true;
      })()
    `);
    await waitForWebUiAgentPublishToggle({ page, targetTeamId, published: false, timeoutMs });

    await emitAck(webSocket, WEB_EVENTS.channel.subscribe, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);
    const sendAck = await emitAck(webSocket, WEB_EVENTS.message.send, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId: session.channel.id,
      body: `@${configuredAgentName} metrics ping`,
    }, timeoutMs);
    const dispatchId = Array.isArray(sendAck?.dispatches) ? sendAck.dispatches[0]?.id : undefined;
    if (typeof dispatchId !== 'string') {
      throw new Error(`WebUI agents smoke message did not create a dispatch: ${formatAck(sendAck)}`);
    }
    await sleep(250);

    await page.navigate(new URL(`/${networkPath}/agents/metrics`, root).toString());
    await waitForWebUiAgentMetricsPanel({ page, agentId, timeoutMs });
    await page.navigate(new URL(`/${networkPath}/agents/${agentId}`, root).toString());
    await waitForWebUiAgentDetail({ page, agentId, name: configuredAgentName, timeoutMs });
    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-delete-open"]', timeoutMs });
    await page.click('[data-smoke="agent-delete-open"]');
    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-delete-dialog"]', timeoutMs });
    await page.click('[data-smoke="agent-delete-confirm"]');
    await waitForWebUiAgentListItemAbsent({ page, agentId, timeoutMs });
    return { agentId, agentName: configuredAgentName, targetTeamId, targetTeamName, dispatchId, deleted: true };
  } finally {
    daemon.socket.disconnect?.();
  }
}

async function waitForWebUiAgentListItem({ page, agentId, name, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      const name = ${JSON.stringify(name)};
      return Array.from(document.querySelectorAll('[data-smoke="agent-list-item"]'))
        .some((candidate) =>
          candidate.dataset.agentId === agentId
          && (!name || candidate.dataset.agentName === name || candidate.textContent.includes(name))
        );
    })()
    `,
    `agent "${agentId}" to render in the list`,
    timeoutMs,
  );
}

async function waitForWebUiAgentListItemAbsent({ page, agentId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      const listPage = document.querySelector('[data-smoke="agent-list-page"]');
      if (!listPage) return false;
      return !Array.from(document.querySelectorAll('[data-smoke="agent-list-item"]'))
        .some((candidate) => candidate.dataset.agentId === agentId);
    })()
    `,
    `agent "${agentId}" to disappear from the list`,
    timeoutMs,
  );
}

async function waitForWebUiAgentDetail({ page, agentId, name, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      const name = ${JSON.stringify(name)};
      const detail = document.querySelector('[data-smoke="agent-detail"]');
      return Boolean(detail)
        && detail.dataset.agentId === agentId
        && (!name || detail.dataset.agentName === name || detail.textContent.includes(name));
    })()
    `,
    `agent "${agentId}" detail to render`,
    timeoutMs,
  );
}

async function waitForWebUiAgentAction({ page, selector, timeoutMs }) {
  await page.waitForFunction(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    `${selector} to render`,
    timeoutMs,
  );
}

async function waitForWebUiAgentPublishToggle({ page, targetTeamId, published, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const targetTeamId = ${JSON.stringify(targetTeamId)};
      const published = ${JSON.stringify(String(published))};
      return Array.from(document.querySelectorAll('[data-smoke="agent-publish-toggle"]'))
        .some((candidate) =>
          candidate.dataset.teamId === targetTeamId
          && candidate.dataset.published === published
        );
    })()
    `,
    `agent publish toggle for team "${targetTeamId}" to become ${published}`,
    timeoutMs,
  );
}

async function waitForWebUiAgentMetricsPanel({ page, agentId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      return Array.from(document.querySelectorAll('[data-smoke="agent-metrics-panel"]'))
        .some((candidate) => candidate.dataset.agentId === agentId);
    })()
    `,
    `agent metrics for "${agentId}" to render`,
    timeoutMs,
  );
}

export async function exerciseWebUiAdminDashboardBusinessSmoke({
  page,
  baseUrl,
  dataDir,
  ioFactory = loadSocketIoClient(),
  suffix,
  timeoutMs,
}) {
  if (!dataDir) {
    throw new Error('WebUI admin dashboard smoke needs local dataDir access to seed a global admin');
  }
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32).toLowerCase();
  const admin = await registerStandaloneWebUiAdmin({
    baseUrl: root,
    dataDir,
    ioFactory,
    username: `admin-dashboard-${safeSuffix}`,
    teamName: `Admin Dashboard ${safeSuffix}`,
    timeoutMs,
  });
  const adminSocket = admin.socket;
  const adminSession = admin.session;
  const networkPath = adminSession.team.path ?? adminSession.team.id;
  let initialOwner;
  let targetOwner;
  let memberSocket;
  let daemon;
  try {
    initialOwner = await registerJoinedWebUiMember({
      baseUrl: root,
      ownerSocket: adminSocket,
      ioFactory,
      username: `admin-owner-${safeSuffix}`,
      teamName: `Unused Admin Owner ${safeSuffix}`,
      timeoutMs,
    });
    targetOwner = await registerJoinedWebUiMember({
      baseUrl: root,
      ownerSocket: adminSocket,
      ioFactory,
      username: `admin-target-${safeSuffix}`,
      teamName: `Unused Admin Target ${safeSuffix}`,
      timeoutMs,
    });
    memberSocket = await connectSocket(ioFactory, new URL('/web', root).toString(), timeoutMs, {
      auth: { token: initialOwner.session.token },
    });
    daemon = await connectSmokeDaemon({
      baseUrl: root,
      ioFactory,
      session: initialOwner.session,
      suffix: `admin-${safeSuffix}`,
      timeoutMs,
    });
    const agentName = `admin-agent-${safeSuffix}`;
    const agentAck = await emitAck(memberSocket, WEB_EVENTS.agent.create, {
      userId: initialOwner.session.user.id,
      teamId: adminSession.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      env: { AGENTBEAN_WEBUI_ADMIN_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    if (!agentId) {
      throw new Error(`WebUI admin dashboard smoke could not create device agent: ${formatAck(agentAck)}`);
    }

    await seedWebUiAuthStorage({ page, session: adminSession });
    await page.navigate(new URL(`/${networkPath}/dashboard`, root).toString());
    await waitForWebUiAdminDashboard({ page, timeoutMs });
    await waitForWebUiAdminTeam({ page, teamId: adminSession.team.id, timeoutMs });
    await page.click('[data-smoke="admin-tab-users"]');
    await waitForWebUiAdminUser({ page, userId: adminSession.user.id, username: adminSession.user.username, timeoutMs });
    await waitForWebUiAdminUser({ page, userId: initialOwner.session.user.id, username: initialOwner.username, timeoutMs });
    await waitForWebUiAdminUser({ page, userId: targetOwner.session.user.id, username: targetOwner.username, timeoutMs });

    await page.click('[data-smoke="admin-tab-devices"]');
    await waitForWebUiAdminDevice({
      page,
      deviceId: daemon.deviceId,
      ownerId: initialOwner.session.user.id,
      timeoutMs,
    });
    await clickWebUiAdminDevice({ page, deviceId: daemon.deviceId, timeoutMs });
    await waitForWebUiAdminDeviceDetail({
      page,
      deviceId: daemon.deviceId,
      ownerId: initialOwner.session.user.id,
      timeoutMs,
    });
    await waitForWebUiAdminDeviceRuntime({ page, timeoutMs });
    await waitForWebUiAdminDevicePublicAgent({ page, agentId, timeoutMs });
    await page.setInputValue('[data-smoke="admin-device-owner-select"]', targetOwner.session.user.id);
    await page.waitForFunction(
      `
      (() => {
        const save = document.querySelector('[data-smoke="admin-device-owner-save"]');
        const select = document.querySelector('[data-smoke="admin-device-owner-select"]');
        return select?.value === ${JSON.stringify(targetOwner.session.user.id)}
          && save
          && !save.disabled;
      })()
      `,
      'admin device owner transfer button to enable',
      timeoutMs,
    );
    await page.click('[data-smoke="admin-device-owner-save"]');
    await waitForWebUiAdminDeviceDetail({
      page,
      deviceId: daemon.deviceId,
      ownerId: targetOwner.session.user.id,
      timeoutMs,
    });

    await page.click('[data-smoke="admin-tab-devices"]');
    await waitForWebUiAdminDevice({
      page,
      deviceId: daemon.deviceId,
      ownerId: targetOwner.session.user.id,
      timeoutMs,
    });
    await page.click('[data-smoke="admin-tab-agents"]');
    await waitForWebUiAdminAgent({
      page,
      agentId,
      ownerId: targetOwner.session.user.id,
      deviceId: daemon.deviceId,
      timeoutMs,
    });
    await clickWebUiAdminAgent({ page, agentId, timeoutMs });
    await waitForWebUiAdminAgentDetail({
      page,
      agentId,
      ownerId: targetOwner.session.user.id,
      deviceId: daemon.deviceId,
      timeoutMs,
    });

    return {
      deviceId: daemon.deviceId,
      agentId,
      initialOwnerUsername: initialOwner.username,
      targetOwnerUsername: targetOwner.username,
    };
  } finally {
    daemon?.socket.disconnect?.();
    memberSocket?.disconnect?.();
    initialOwner?.socket.disconnect?.();
    targetOwner?.socket.disconnect?.();
    adminSocket.disconnect?.();
  }
}

function promoteSmokeUserToAdmin({ dataDir, userId }) {
  const Sqlite = loadBetterSqlite3();
  const db = new Sqlite(join(dataDir, 'global.sqlite'));
  try {
    const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', userId);
    if (result.changes !== 1) {
      throw new Error(`Could not promote smoke user "${userId}" to admin`);
    }
  } finally {
    db.close();
  }
}

async function registerStandaloneWebUiAdmin({ baseUrl, dataDir, ioFactory, username, teamName, timeoutMs }) {
  const bootstrapSocket = await connectSocket(ioFactory, new URL('/web', baseUrl).toString(), timeoutMs);
  try {
    const password = `secret-${username}`;
    const registerAck = await emitAck(bootstrapSocket, WEB_EVENTS.auth.register, {
      username,
      password,
      teamName,
    }, timeoutMs);
    if (
      registerAck?.ok !== true ||
      typeof registerAck.token !== 'string' ||
      typeof registerAck.user?.id !== 'string' ||
      typeof registerAck.currentTeam?.id !== 'string'
    ) {
      throw new Error(`WebUI admin dashboard smoke could not register standalone admin: ${formatAck(registerAck)}`);
    }
    promoteSmokeUserToAdmin({ dataDir, userId: registerAck.user.id });
    bootstrapSocket.disconnect?.();
    const loginSocket = await connectSocket(ioFactory, new URL('/web', baseUrl).toString(), timeoutMs);
    const loginAck = await emitAck(loginSocket, WEB_EVENTS.auth.login, { username, password }, timeoutMs);
    loginSocket.disconnect?.();
    if (
      loginAck?.ok !== true ||
      typeof loginAck.token !== 'string' ||
      typeof loginAck.user?.id !== 'string' ||
      typeof loginAck.currentTeam?.id !== 'string'
    ) {
      throw new Error(`WebUI admin dashboard smoke could not login standalone admin: ${formatAck(loginAck)}`);
    }
    const adminSocket = await connectSocket(ioFactory, new URL('/web', baseUrl).toString(), timeoutMs, {
      auth: { token: loginAck.token },
    });
    return {
      socket: adminSocket,
      username,
      session: {
        token: loginAck.token,
        user: { ...loginAck.user, role: 'admin' },
        team: loginAck.currentTeam,
        channel: registerAck.defaultChannel ?? null,
      },
    };
  } catch (error) {
    bootstrapSocket.disconnect?.();
    throw error;
  }
}

function loadBetterSqlite3() {
  const requireFromServerNext = createRequire(new URL('../apps/server-next/package.json', import.meta.url));
  return requireFromServerNext('better-sqlite3');
}

async function registerJoinedWebUiMember({ baseUrl, ownerSocket, ioFactory, username, teamName, timeoutMs }) {
  const joinSocket = await connectSocket(ioFactory, new URL('/web', baseUrl).toString(), timeoutMs);
  try {
    const linkAck = await emitAck(ownerSocket, WEB_EVENTS.join.create, { maxUses: 1 }, timeoutMs);
    const joinCode = readNestedString(linkAck, ['link', 'code']);
    if (!joinCode) {
      throw new Error(`WebUI admin dashboard smoke could not create a join link: ${formatAck(linkAck)}`);
    }
    const password = `secret-${username}`;
    const registerAck = await emitAck(joinSocket, WEB_EVENTS.auth.register, {
      username,
      password,
      teamName,
      joinCode,
    }, timeoutMs);
    if (
      registerAck?.ok !== true ||
      typeof registerAck.token !== 'string' ||
      typeof registerAck.user?.id !== 'string' ||
      typeof registerAck.currentTeam?.id !== 'string'
    ) {
      throw new Error(`WebUI admin dashboard smoke could not register joined member: ${formatAck(registerAck)}`);
    }
    return {
      socket: joinSocket,
      username,
      session: {
        token: registerAck.token,
        user: registerAck.user,
        team: registerAck.currentTeam,
        channel: registerAck.defaultChannel ?? null,
      },
    };
  } catch (error) {
    joinSocket.disconnect?.();
    throw error;
  }
}

async function waitForWebUiAdminDashboard({ page, timeoutMs }) {
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="admin-dashboard-page"]')) && !document.querySelector('[data-smoke="admin-dashboard-forbidden"]')`,
    'admin dashboard page to render for global admin',
    timeoutMs,
  );
}

async function waitForWebUiAdminTeam({ page, teamId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const teamId = ${JSON.stringify(teamId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-team-item"]'))
        .some((candidate) => candidate.dataset.teamId === teamId);
    })()
    `,
    `admin team "${teamId}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiAdminUser({ page, userId, username, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const userId = ${JSON.stringify(userId)};
      const username = ${JSON.stringify(username)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-user-row"]'))
        .some((candidate) =>
          candidate.dataset.userId === userId
          && (!username || candidate.dataset.username === username || candidate.textContent.includes(username))
        );
    })()
    `,
    `admin user "${username || userId}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiAdminDevice({ page, deviceId, ownerId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      const ownerId = ${JSON.stringify(ownerId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-device-row"]'))
        .some((candidate) =>
          candidate.dataset.deviceId === deviceId
          && (!ownerId || candidate.dataset.ownerId === ownerId)
        );
    })()
    `,
    `admin device "${deviceId}" to render${ownerId ? ` with owner ${ownerId}` : ''}`,
    timeoutMs,
  );
}

async function clickWebUiAdminDevice({ page, deviceId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-device-open"]'))
        .some((candidate) => candidate.dataset.deviceId === deviceId);
    })()
    `,
    `admin device "${deviceId}" open button to render`,
    timeoutMs,
  );
  const clicked = await page.evaluateJson(`
    (() => {
      const deviceId = ${JSON.stringify(deviceId)};
      const button = Array.from(document.querySelectorAll('[data-smoke="admin-device-open"]'))
        .find((candidate) => candidate.dataset.deviceId === deviceId);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) {
    throw new Error(`Could not open admin device "${deviceId}"`);
  }
}

async function waitForWebUiAdminDeviceDetail({ page, deviceId, ownerId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const detail = document.querySelector('[data-smoke="admin-device-detail"]');
      return detail?.dataset.deviceId === ${JSON.stringify(deviceId)}
        && (!${JSON.stringify(ownerId)} || detail.dataset.ownerId === ${JSON.stringify(ownerId)});
    })()
    `,
    `admin device "${deviceId}" detail to render${ownerId ? ` with owner ${ownerId}` : ''}`,
    timeoutMs,
  );
}

async function waitForWebUiAdminDeviceRuntime({ page, timeoutMs }) {
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('[data-smoke="admin-device-runtime"]')).some((candidate) => candidate.dataset.runtimeInstalled === 'true')`,
    'admin device detail to show an installed runtime',
    timeoutMs,
  );
}

async function waitForWebUiAdminDevicePublicAgent({ page, agentId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-device-public-agent"]'))
        .some((candidate) => candidate.dataset.agentId === agentId);
    })()
    `,
    `admin device detail public agent "${agentId}" to render`,
    timeoutMs,
  );
}

async function waitForWebUiAdminAgent({ page, agentId, ownerId, deviceId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      const ownerId = ${JSON.stringify(ownerId)};
      const deviceId = ${JSON.stringify(deviceId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-agent-row"]'))
        .some((candidate) =>
          candidate.dataset.agentId === agentId
          && (!ownerId || candidate.dataset.ownerId === ownerId)
          && (!deviceId || candidate.dataset.deviceId === deviceId)
        );
    })()
    `,
    `admin agent "${agentId}" to render`,
    timeoutMs,
  );
}

async function clickWebUiAdminAgent({ page, agentId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      return Array.from(document.querySelectorAll('[data-smoke="admin-agent-open"]'))
        .some((candidate) => candidate.dataset.agentId === agentId);
    })()
    `,
    `admin agent "${agentId}" open button to render`,
    timeoutMs,
  );
  const clicked = await page.evaluateJson(`
    (() => {
      const agentId = ${JSON.stringify(agentId)};
      const button = Array.from(document.querySelectorAll('[data-smoke="admin-agent-open"]'))
        .find((candidate) => candidate.dataset.agentId === agentId);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) {
    throw new Error(`Could not open admin agent "${agentId}"`);
  }
}

async function waitForWebUiAdminAgentDetail({ page, agentId, ownerId, deviceId, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const detail = document.querySelector('[data-smoke="admin-agent-detail"]');
      return detail?.dataset.agentId === ${JSON.stringify(agentId)}
        && (!${JSON.stringify(ownerId)} || detail.dataset.ownerId === ${JSON.stringify(ownerId)})
        && (!${JSON.stringify(deviceId)} || detail.dataset.deviceId === ${JSON.stringify(deviceId)});
    })()
    `,
    `admin agent "${agentId}" detail to render`,
    timeoutMs,
  );
}

async function connectSmokeDaemon({ baseUrl, ioFactory, session, suffix, timeoutMs, dispatchResultFactory }) {
  const socket = await connectSocket(ioFactory, new URL('/agent', baseUrl).toString(), timeoutMs);
  socket.on(AGENT_EVENTS.dispatch.request, (request) => {
    const result = dispatchResultFactory?.(request) ?? {
      body: `browser-smoke:${request.prompt}`,
    };
    emitAck(socket, AGENT_EVENTS.dispatch.result, {
      dispatchId: request.id,
      agentId: request.agentId,
      ...result,
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

  return { socket, deviceId, runtimeId };
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

export async function exerciseThreadBrowserSmoke({ page, suffix, timeoutMs }) {
  await page.waitForFunction(
    `document.querySelector('#messages button[data-thread-id]') !== null`,
    'a root message renders a thread reply button',
    timeoutMs,
  );
  const rootThreadId = await page.evaluateJson(`
    (() => {
      const btn = document.querySelector('#messages button[data-thread-id]');
      return btn ? btn.dataset.threadId : null;
    })()
  `);
  if (!rootThreadId) {
    throw new Error('Browser smoke could not resolve a root thread id for the thread reply step');
  }
  await page.click('#messages button[data-thread-id]');
  await page.waitForFunction(
    `document.getElementById('message-reply-indicator') && document.getElementById('message-reply-indicator').hidden === false`,
    'thread reply indicator shows after clicking reply',
    timeoutMs,
  );
  const threadReplyBody = `browser-smoke:thread-reply:${suffix}`;
  await sendBrowserMessage(page, threadReplyBody);
  await page.waitForText('#messages', threadReplyBody, timeoutMs);
  await page.waitForFunction(
    `
    (() => {
      const rootThreadId = ${JSON.stringify(rootThreadId)};
      const threadReplyBody = ${JSON.stringify(threadReplyBody)};
      const replyButton = Array.from(document.querySelectorAll('#messages button[data-thread-id]'))
        .find((button) => button.dataset.threadId === rootThreadId);
      const rootMessage = replyButton?.closest('article.message');
      const replies = rootMessage?.nextElementSibling;
      return Boolean(
        replies?.classList.contains('thread-replies')
        && Array.from(replies.querySelectorAll('.thread-reply'))
          .some((reply) => reply.textContent.includes(threadReplyBody)),
      );
    })()
    `,
    'new thread reply is nested under the selected root message',
    timeoutMs,
  );
  return { rootThreadId, threadReplyBody };
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

async function openPage(debugUrl, events, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const target = await fetchJson(`${debugUrl}/json/new?about:blank`, { method: 'PUT' });
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Chrome did not create a debuggable page: ${JSON.stringify(target)}`);
  }
  const cdp = await connectCdp(target.webSocketDebuggerUrl, events, timeoutMs);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  return cdp;
}

async function connectCdp(webSocketUrl, events, defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
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

  const send = (method, params = {}, timeoutMs = defaultTimeoutMs) => new Promise((resolve, reject) => {
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
      const navigation = this.waitForEvent('Page.frameNavigated', (params) => !params.frame.parentId, 1_000).catch(() => undefined);
      await send('Page.navigate', { url });
      await navigation;
      await this.waitForFunction('document.readyState === "complete"', 'page load', DEFAULT_TIMEOUT_MS);
    },
    async reload() {
      const navigation = this.waitForEvent('Page.frameNavigated', (params) => !params.frame.parentId, 1_000).catch(() => undefined);
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
        const details = result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.exception?.value
          ?? result.exceptionDetails.text
          ?? 'Runtime.evaluate failed';
        throw new Error(String(details));
      }
      return result.result?.value;
    },
    async waitForFunction(expression, description, timeoutMs) {
      const startedAt = Date.now();
      let lastError;
      while (Date.now() - startedAt < timeoutMs) {
        try {
          const passed = await this.evaluateJson(`Boolean(${expression})`);
          if (passed) {
            return;
          }
        } catch (error) {
          lastError = error;
        }
        await sleep(100);
      }
      const suffix = lastError instanceof Error ? ` after ${lastError.message}` : '';
      throw new Error(`Timed out waiting for ${description}${suffix}`);
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
          const value = ${JSON.stringify(value)};
          element.focus();
          const prototype =
            element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
            element instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
            HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(element, value);
          else element.value = value;
          const inputEvent = typeof InputEvent === "function"
            ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })
            : new Event("input", { bubbles: true });
          element.dispatchEvent(inputEvent);
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
    async fillInputAsUser(selector, value) {
      await this.evaluateJson(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Missing input: ${selector.replaceAll('"', '\\"')}");
          element.focus();
          if (typeof element.select === "function") {
            element.select();
          }
          return true;
        })()
      `);
      await send('Input.insertText', { text: value });
      await this.evaluateJson(`
        (() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) throw new Error("Missing input: ${selector.replaceAll('"', '\\"')}");
          const inputEvent = typeof InputEvent === "function"
            ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} })
            : new Event("input", { bubbles: true });
          element.dispatchEvent(inputEvent);
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return element.value;
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

async function connectSocket(ioFactory, url, timeoutMs, options = {}) {
  const socket = ioFactory(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    ...options,
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

function promiseWithTimeout(promise, timeoutMs, description) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

export function formatBrowserSmokeText(summary) {
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
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatBrowserSmokeText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
