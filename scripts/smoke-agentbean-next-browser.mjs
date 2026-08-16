#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { accessSync, constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_EVENTS = {
  device: { hello: 'device:hello', runtimes: 'device:runtimes', scanRequested: 'device:scan-requested' },
  agent: { registerBatch: 'agent:register-batch' },
  dispatch: { request: 'dispatch:request', result: 'dispatch:result' },
  managementWorker: {
    register: 'management-worker:register',
    leaseOffer: 'management-worker:lease-offer',
    leaseAcquire: 'management-worker:lease-acquire',
    leaseRelease: 'management-worker:lease-release',
    toolRequest: 'management-worker:tool-request',
    checkpointFetch: 'management-worker:checkpoint-fetch',
  },
  taskClaim: {
    offer: 'task-claim:offer',
    acquire: 'task-claim:acquire',
    respond: 'task-claim:respond',
  },
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
    create: 'channel:create',
    addMember: 'channel:add-member',
    removeMember: 'channel:remove-member',
    addAgent: 'channel:add-agent',
    removeAgent: 'channel:remove-agent',
    members: 'channel:members',
  },
  channelDocuments: {
    list: 'channel-documents:list',
    derive: 'channel-documents:derive',
    save: 'channel-documents:save',
  },
  device: {
    rename: 'device:rename',
  },
  join: { create: 'join:create' },
  member: {
    list: 'members:list',
  },
  message: { send: 'message:send' },
  project: {
    overview: 'project:overview',
    createInitialStage: 'project:create-initial-stage',
    createStage: 'project:create-stage',
    createStageEdge: 'project:create-stage-edge',
    artifactCollections: 'project:artifact-collections',
    promoteArtifact: 'project:promote-artifact',
    submitArtifactReview: 'project:submit-artifact-review',
    setArtifactFinalVersion: 'project:set-artifact-final-version',
    createDocumentBundle: 'project:create-document-bundle',
    resolveReferences: 'project:resolve-references',
    workspace: 'project:workspace',
    listOutputPackages: 'project:list-output-packages',
    getOutputPackage: 'project:get-output-package',
    submitPackageReviewAndFinalize: 'project:submit-package-review-and-finalize',
  },
  task: {
    create: 'task:create',
    list: 'task:list',
    stageDeliveryReviewWorkspace: 'task:stage-delivery-review-workspace',
  },
  piPolicy: { get: 'pi-policy:get', update: 'pi-policy:update' },
  team: {
    create: 'team:create',
    switch: 'team:switch',
  },
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };

export function webUiFlowSuffix(suffix, flow) {
  return `${suffix}-${flow}`;
}

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
      check('browser-artifact-upload-visible', true, 'Browser uploaded and rendered an artifact'),
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

    // Memory / 执行记录诊断已迁入 System Admin Console，仅管理员可见。
    // 在通用路由 smoke 之后提权，避免 /dashboard 根路径重定向干扰 pathname 断言。
    // 外部目标（--url / AGENTBEAN_NEXT_WEBUI_URL）没有 dataDir，无法本地提权；
    // 后续仅在 isAdminSession 时进入 admin-only 页面，否则会稳定超时。
    if (target.dataDir) {
      promoteSmokeUserToAdmin({ dataDir: target.dataDir, userId: seededSession.session.user.id });
      seededSession.session.user = { ...seededSession.session.user, role: 'admin' };
      await seedWebUiAuthStorage({ page, session: seededSession.session });
    }
    const isAdminSession = seededSession.session.user?.role === 'admin';

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
    const channelFilesResult = await exerciseWebUiChannelFilesBrowserSmoke({
      page,
      suffix,
      timeoutMs,
    });
    checks.push(
      check('webui-channel-file-upload-readable', channelFilesResult.uploadReadable === true, `WebUI uploaded and downloaded ordinary attachment ${channelFilesResult.filename}`),
      check(
        'webui-channel-files-attachment-surface',
        channelFilesResult.attachmentSurfaceVisible === true
          && channelFilesResult.logicalBoardVisible === false
          && channelFilesResult.ordinaryEntryVisible === true,
        `WebUI opens attachment files surface and lists ordinary attachment ${channelFilesResult.filename}`,
      ),
    );

    const channelResult = await exerciseWebUiChannelsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      ioFactory,
      suffix: webUiFlowSuffix(suffix, 'channels'),
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

    const taskResult = await exerciseWebUiTaskBusinessSmoke({
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
        'webui-task-business-flow',
        true,
        `Created task "${taskResult.title}", reordered it, moved it to ${taskResult.status}, deleted "${taskResult.deletedTitle}", and restored after refresh`,
      ),
      check(
        'webui-phase2-task-dag-business-flow',
        true,
        `Created managed Phase 2 task "${taskResult.phase2Title}" through real Web/Agent sockets and rendered its Task DAG panel`,
      ),
      check(
        'webui-channel-tasks-no-project-facts',
        taskResult.channelNoProjectFactsVerified === true,
        'Verified a no-stage channel defaults to ordinary Tasks, hides empty project facts, guides explicit setup, and clears stale detail when switching subviews',
      ),
    );

    // 始终创建 workspace run 数据供 project collaboration 使用；
    // admin UI（/dashboard/runs）仅在管理员会话下验证。
    const runResult = await exerciseWebUiRunsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      ioFactory,
      suffix: webUiFlowSuffix(suffix, 'runs'),
      timeoutMs,
      verifyAdminUi: isAdminSession,
    });
    checks.push(
      check(
        'webui-runs-business-flow',
        true,
        isAdminSession
          ? `Created workspace run "${runResult.command}" and verified list, detail route, full log artifact, artifact tree, inline log search, and source message jump`
          : `Created workspace run "${runResult.command}" data for downstream smoke; skipped admin-only /dashboard/runs UI without local admin promotion`,
      ),
    );

    const projectResult = await exerciseWebUiProjectCollaborationSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      taskTitle: taskResult.title,
      workspaceRun: runResult,
      ioFactory,
      archivedChannelId: channelResult.channelId,
      archivedProjectStageName: channelResult.archivedProjectStageName,
      memberToken: channelResult.memberToken,
      suffix: webUiFlowSuffix(suffix, 'project'),
      timeoutMs,
    });
    checks.push(
      check(
        'webui-project-stage-overview',
        true,
        `Rendered project Stage "${projectResult.stageName}" from the authoritative Server projection`,
      ),
      check(
        'webui-project-review-finalization',
        true,
        `Reviewed and finalized project artifact version ${projectResult.versionId}`,
      ),
      check(
        'webui-project-bundle-selection-reference',
        true,
        `Created Bundle ${projectResult.bundleId} and persisted stable message references`,
      ),
      check(
        'webui-project-stale-revision-negative',
        true,
        'Rejected a stale project revision without changing the authoritative project facts',
      ),
      check(
        'webui-project-permission-archived-negative',
        true,
        'Rejected unauthorized and archived-channel project writes',
      ),
      check(
        'webui-project-archived-history-readable',
        true,
        'Read the authoritative Stage history after its channel was archived',
      ),
      check(
        'webui-project-scope-required-input-negative',
        true,
        'Rejected a cross-channel Bundle reference and kept a downstream Stage blocked on missing required input',
      ),
      check(
        'webui-project-document-http-materialization',
        true,
        `Downloaded exact selected project document bytes through authenticated HTTP for Bundle ${projectResult.bundleId}`,
      ),
      check(
        'webui-project-inputset-partial-conflict',
        projectResult.inputSetResult?.statuses?.includes('conflict') === true,
        'Executed a real V2 InputSet through Management Worker → Agent Socket → HTTP/SQLite and retained a per-item OCC conflict',
      ),
    );

    const teamResult = await exerciseWebUiTeamsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      session: seededSession.session,
      suffix,
      timeoutMs,
    });
    checks.push(
      check(
        'webui-teams-business-flow',
        true,
        `Created team "${teamResult.teamName}", switched to ${teamResult.teamPath}, deleted it, and restored ${teamResult.restoredTeamPath}`,
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
      suffix: webUiFlowSuffix(suffix, 'devices'),
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

    if (isAdminSession) {
      const memoryResult = await exerciseWebUiMemoryBusinessSmoke({
        page,
        baseUrl: target.baseUrl,
        session: seededSession.session,
        suffix,
        timeoutMs,
      });
      checks.push(
        check(
          'webui-memory-governance-flow',
          true,
          `Created collaborative Memory "${memoryResult.content}", restored it after refresh, and rendered governance status`,
        ),
      );
    } else {
      checks.push(
        check(
          'webui-memory-governance-flow',
          true,
          'Skipped Memory governance browser flow for external target without local smoke database admin promotion',
        ),
      );
    }

    const agentsResult = await exerciseWebUiAgentsBusinessSmoke({
      page,
      baseUrl: target.baseUrl,
      webSocket: seededSession.socket,
      session: seededSession.session,
      ioFactory,
      suffix: webUiFlowSuffix(suffix, 'agents'),
      timeoutMs,
    });
    checks.push(
      check(
        'webui-agents-business-flow',
        true,
        `Created agent "${agentsResult.agentName}", updated config, verified metrics, and deleted it from the list`,
      ),
    );

    if (target.dataDir) {
      const adminResult = await exerciseWebUiAdminDashboardBusinessSmoke({
        page,
        baseUrl: target.baseUrl,
        dataDir: target.dataDir,
        ioFactory,
        suffix: webUiFlowSuffix(suffix, 'admin'),
        timeoutMs,
      });
      checks.push(
        check(
          'webui-admin-dashboard-business-flow',
          true,
          `Verified System Admin Console middle-nav sections (teams/users/devices/agents/pi), transferred device ${adminResult.deviceId} from ${adminResult.initialOwnerUsername} to ${adminResult.targetOwnerUsername}, and confirmed PI lives at dashboard/pi with settings?tab=pi redirect`,
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

export async function runAgentBeanNextReleaseABrowserGate(
  options = {},
  {
    previewRunner = runAgentBeanNextBrowserSmoke,
    webUiRunner = runAgentBeanNextWebUiBrowserSmoke,
  } = {},
) {
  const resolvedArtifactsDir = resolve(
    options.artifactsDir ?? join(tmpdir(), `agentbean-next-release-a-browser-smoke-${Date.now()}`),
  );
  mkdirSync(resolvedArtifactsDir, { recursive: true });

  const sharedOptions = { ...options };
  delete sharedOptions.artifactsDir;
  const externalBaseUrl = options.baseUrl
    ? normalizeBaseUrlOrThrow(options.baseUrl)
    : undefined;
  const previewBaseUrl = externalBaseUrl
    ? new URL('/preview', externalBaseUrl).toString()
    : undefined;
  const webUiBaseUrl = externalBaseUrl?.toString();

  const preview = await previewRunner({
    ...sharedOptions,
    ...(previewBaseUrl ? { baseUrl: previewBaseUrl } : {}),
    artifactsDir: join(resolvedArtifactsDir, 'preview'),
  });
  const webUi = await webUiRunner({
    ...sharedOptions,
    ...(webUiBaseUrl ? { baseUrl: webUiBaseUrl } : {}),
    artifactsDir: join(resolvedArtifactsDir, 'webui'),
  });
  const checks = [...preview.checks, ...webUi.checks];

  return {
    ok: preview.ok && webUi.ok,
    total: preview.total + webUi.total,
    failed: preview.failed + webUi.failed,
    checks,
    summaries: { preview, webUi },
    artifacts: {
      dir: resolvedArtifactsDir,
      preview: preview.artifacts,
      webUi: webUi.artifacts,
    },
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
      env: {
        ...process.env,
        PORT: '',
        AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'true',
        AGENTBEAN_PROJECT_STAGE: 'true',
        AGENTBEAN_PROJECT_REVIEW_FINALIZATION: 'true',
        AGENTBEAN_PROJECT_BUNDLE_SELECTION: 'true',
        AGENTBEAN_PROJECT_INPUT_SET_OUTPUT: 'true',
        AGENTBEAN_PROJECT_MANAGER_AUTO_ADVANCE: 'true',
      },
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
  const teamPath = session.team.path ?? session.team.id;
  const script = `
    localStorage.setItem("agentbean.token", ${JSON.stringify(session.token)});
    localStorage.setItem("agentbean.teamPath", ${JSON.stringify(teamPath)});
  `;
  await page.addScriptOnNewDocument(script);
  await page.evaluateJson(`
    (() => {
      ${script}
      return true;
    })()
  `);
  return { teamPath };
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
  const teamPath = session.team.path ?? session.team.id;
  const expectedRoutes = routes ?? [
    // Console 根路径会重定向到 /dashboard/teams；非管理员停在 forbidden 壳。
    { path: `/${teamPath}/dashboard`, label: '仪表盘', allowPathPrefix: true },
    { path: `/${teamPath}/chat`, label: '聊天' },
    { path: `/${teamPath}/tasks`, label: '任务' },
    { path: `/${teamPath}/members`, label: '成员' },
    { path: `/${teamPath}/devices`, label: '设备' },
    { path: `/${teamPath}/settings`, label: '设置' },
  ];
  const rendered = [];
  for (const route of expectedRoutes) {
    const descriptor = typeof route === 'string' ? { path: route, label: null, allowPathPrefix: false } : route;
    const url = new URL(descriptor.path, root);
    await page.navigate(url.toString());
    await page.waitForFunction(
      `document.readyState === "complete" && document.body && document.body.textContent.trim().length > 0`,
      `authenticated route ${descriptor.path} renders non-empty content`,
      timeoutMs,
    );
    const pathAssertion = descriptor.allowPathPrefix
      ? `(location.pathname === ${JSON.stringify(descriptor.path)} || location.pathname.startsWith(${JSON.stringify(`${descriptor.path}/`)}))`
      : `location.pathname === ${JSON.stringify(descriptor.path)}`;
    await page.waitForFunction(
      `${pathAssertion} && localStorage.getItem("agentbean.token") === ${JSON.stringify(session.token)}`,
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
          link.getAttribute("href") === ${JSON.stringify(`/${teamPath}/chat`)}
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
  const teamPath = session.team.path ?? session.team.id;
  const body = `WebUI smoke chat ${suffix}`;
  await page.navigate(new URL(`/${teamPath}/chat`, root).toString());
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
  const teamPath = session.team.path ?? session.team.id;
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

    await page.navigate(new URL(`/${teamPath}/channels`, root).toString());
    await page.waitForFunction(
      `
      (() => {
        const control = document.querySelector('[data-smoke="channel-create-open"]');
        return control !== null
          && control.getAttribute('data-team-id') === ${JSON.stringify(session.team.id)}
          && control.disabled === false;
      })()
      `,
      `channels page exposes the create channel control for Team ${session.team.id}`,
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

    const archivedProjectStageName = `归档保留 ${safeSuffix}`;
    const projectTask = await emitAck(ownerSocket, WEB_EVENTS.task.create, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId,
      title: `Archived project task ${safeSuffix}`,
    }, timeoutMs);
    if (projectTask?.ok !== true || typeof projectTask.task?.id !== 'string') {
      throw new Error(`WebUI channels smoke could not seed archived project Task: ${formatAck(projectTask)}`);
    }
    const archivedProject = await emitAck(ownerSocket, WEB_EVENTS.project.createInitialStage, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId,
      expectedRevision: 0,
      idempotencyKey: `archived-project-${safeSuffix}`,
      projectLeadId: session.user.id,
      defaultReviewerIds: [session.user.id],
      stage: {
        name: archivedProjectStageName,
        goal: '验证归档后历史项目事实仍可读取',
        ownerId: session.user.id,
        reviewerIds: [session.user.id],
        acceptanceCriteria: ['归档只读'],
        taskId: projectTask.task.id,
      },
    }, timeoutMs);
    if (archivedProject?.ok !== true) {
      throw new Error(`WebUI channels smoke could not seed archived project Stage: ${formatAck(archivedProject)}`);
    }

    await page.click('[data-smoke="channel-edit-open"]');
    await page.waitForFunction(
      `document.querySelector('[data-smoke="channel-edit-dialog"]')?.dataset.channelId === ${JSON.stringify(channelId)}`,
      `channel "${channelId}" edit dialog opens`,
      timeoutMs,
    );
    await page.click('[data-smoke="channel-archive-open"]');
    await page.waitForFunction(
      `document.querySelector('[data-smoke="channel-confirm-archive"]') !== null`,
      'channel archive preflight completes and confirm button appears',
      timeoutMs,
    );
    await page.click('[data-smoke="channel-confirm-archive"]');
    await waitForWebUiChannelListMissing({ page, channelId, channelName, timeoutMs });

    await page.navigate(new URL(`/${teamPath}/channels`, root).toString());
    await waitForWebUiChannelListMissing({ page, channelId, channelName, timeoutMs });
    return {
      channelId,
      channelName,
      memberUserId: targetUserId,
      memberToken: targetToken,
      agentId,
      archivedProjectStageName,
    };
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
  const startedAt = Date.now();
  let ack;
  let humanIds = [];
  let agentIds = [];
  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    ack = await emitAck(socket, WEB_EVENTS.channel.members, { teamId, channelId }, remainingMs);
    if (ack?.ok !== true) {
      throw new Error(`WebUI channels smoke could not list channel members: ${formatAck(ack)}`);
    }
    humanIds = Array.isArray(ack.humanMemberIds) ? ack.humanMemberIds : [];
    agentIds = Array.isArray(ack.agentMemberIds) ? ack.agentMemberIds : [];
    const matches = (!expectedHumanId || humanIds.includes(expectedHumanId))
      && (!absentHumanId || !humanIds.includes(absentHumanId))
      && (!expectedAgentId || agentIds.includes(expectedAgentId));
    if (matches) return;
    await sleep(100);
  }
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

export async function exerciseWebUiTeamsBusinessSmoke({
  page,
  baseUrl,
  session,
  suffix,
  timeoutMs,
  fetchImpl = fetch,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const teamPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-28);
  const teamName = `WebUI Team ${safeSuffix}`;
  const description = `Created by WebUI smoke ${safeSuffix}`;
  const compatibilityTeamsSegment = ['net', 'works'].join('');
  const legacyTeamsUrl = new URL(`/${teamPath}/${compatibilityTeamsSegment}`, root);
  const canonicalTeamsUrl = new URL(`/${teamPath}/teams`, root);
  const removedAliasResponse = await fetchImpl(legacyTeamsUrl.toString(), { redirect: 'manual' });
  const removedAliasLocation = removedAliasResponse.headers.get('location');
  if (removedAliasResponse.status !== 404 || removedAliasLocation !== null) {
    throw new Error(
      `Release B removed Team page alias mismatch: expected 404 without redirect, received ${removedAliasResponse.status} ${removedAliasLocation ?? '<no location>'}`,
    );
  }
  await page.navigate(canonicalTeamsUrl.toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="team-create-form"]') !== null`,
    'teams page exposes the create team form',
    timeoutMs,
  );
  await waitForWebUiCurrentTeam({
    page,
    teamId: session.team.id,
    teamName: session.team.name,
    teamPath,
    phase: 'initial session team before create',
    timeoutMs,
  });
  await page.setInputValue('[data-smoke="team-create-name"]', teamName);
  await page.setInputValue('[data-smoke="team-create-description"]', description);
  await page.click('[data-smoke="team-create-submit"]');
  const created = await waitForWebUiTeamListItem({ page, teamName, timeoutMs });
  if (!created?.id || !created?.path) {
    throw new Error(`WebUI teams smoke could not resolve created team from list: ${formatAck(created)}`);
  }
  await waitForWebUiCurrentTeam({
    page,
    teamId: created.id,
    teamName,
    teamPath: created.path,
    phase: 'created team immediately after create',
    timeoutMs,
  });
  await page.reload();
  await waitForWebUiCurrentTeam({
    page,
    teamId: created.id,
    teamName,
    teamPath: created.path,
    phase: 'created team after create refresh',
    timeoutMs,
  });

  await switchWebUiTeam({ page, teamId: session.team.id });
  await waitForWebUiCurrentTeam({
    page,
    teamId: session.team.id,
    teamName: session.team.name,
    teamPath,
    phase: 'session team after explicit switch back',
    timeoutMs,
  });
  await page.reload();
  await waitForWebUiCurrentTeam({
    page,
    teamId: session.team.id,
    teamName: session.team.name,
    teamPath,
    phase: 'session team after explicit switch refresh',
    timeoutMs,
  });

  await switchWebUiTeam({ page, teamId: created.id });
  await waitForWebUiCurrentTeam({
    page,
    teamId: created.id,
    teamName,
    teamPath: created.path,
    phase: 'created team after explicit switch for delete',
    timeoutMs,
  });
  const restoredTeamPath = session.team.path ?? session.team.id;
  await page.navigate(new URL(`/${created.path}/settings`, root).toString());
  await openWebUiSettingsTab({ page, tab: 'server', timeoutMs });
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
  await page.navigate(new URL(`/${restoredTeamPath}/teams`, root).toString());
  await waitForWebUiCurrentTeam({
    page,
    teamId: session.team.id,
    teamName: session.team.name,
    teamPath: restoredTeamPath,
    phase: 'fallback team after delete',
    timeoutMs,
  });
  await waitForWebUiTeamListMissing({ page, teamId: created.id, teamName, timeoutMs });
  await page.reload();
  await waitForWebUiCurrentTeam({
    page,
    teamId: session.team.id,
    teamName: session.team.name,
    teamPath: restoredTeamPath,
    phase: 'fallback team after delete refresh',
    timeoutMs,
  });
  await waitForWebUiTeamListMissing({ page, teamId: created.id, teamName, timeoutMs });
  return { teamId: created.id, teamPath: created.path, teamName, restoredTeamPath, deleted: true };
}

async function switchWebUiTeam({ page, teamId }) {
  const switched = await page.evaluateJson(`
    (() => {
      const teamId = ${JSON.stringify(teamId)};
      const button = document.querySelector(\`[data-smoke="team-switch"][data-team-id="\${teamId}"]\`);
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!switched) {
    throw new Error(`Missing team switch button for ${teamId}`);
  }
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
    `team "${teamName}" to render in teams list`,
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

async function waitForWebUiCurrentTeam({ page, teamId, teamName, teamPath, phase, timeoutMs }) {
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
        && window.location.pathname.includes(\`/\${teamPath}/teams\`);
    })()
    `,
    `${phase}: team "${teamName}" to be current`,
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
    `deleted team "${teamName}" to disappear from teams list`,
    timeoutMs,
  );
}

export async function exerciseWebUiTaskBusinessSmoke({
  page,
  baseUrl,
  webSocket,
  session,
  ioFactory,
  suffix,
  timeoutMs,
  phase2TaskSeeder = seedPhase2BrowserTask,
  ordinaryTaskSeeder = seedWebUiOrdinaryTaskFacts,
}) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const teamPath = session.team.path ?? session.team.id;
  const title = `WebUI smoke task ${suffix}`;
  const secondaryTitle = `WebUI smoke task secondary ${suffix}`;
  const description = `Created by WebUI smoke ${suffix}`;
  const targetStatus = 'in_progress';
  const channelId = session.channel?.id;
  if (!channelId) throw new Error('WebUI task smoke needs a default channel in the seeded session');
  await ordinaryTaskSeeder({
    webSocket,
    session,
    channelId,
    tasks: [
      { title, description },
      { title: secondaryTitle, description: `${description} secondary` },
    ],
    timeoutMs,
  });
  await page.navigate(new URL(`/${teamPath}/tasks`, root).toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="tasks-create-open"]') === null`,
    'tasks page keeps Agent-managed creation in the channel conversation',
    timeoutMs,
  );
  await waitForWebUiTaskCard({ page, title, status: 'todo', timeoutMs });
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
  const openedTaskDetail = await page.evaluateJson(`
    (() => {
      const title = ${JSON.stringify(title)};
      const card = Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
        .find((candidate) => candidate.dataset.taskTitle === title);
      if (!card) return false;
      card.click();
      return true;
    })()
  `);
  if (!openedTaskDetail) throw new Error(`Could not open WebUI smoke task "${title}"`);
  await page.waitForFunction(
    `document.querySelector('[data-smoke="task-dag-unmanaged"], [data-smoke="task-dag-panel"]') !== null`,
    'task detail exposes the Task DAG surface',
    timeoutMs,
  );

  const phase2 = await phase2TaskSeeder({
    baseUrl,
    webSocket,
    session,
    ioFactory,
    suffix,
    timeoutMs,
  });
  try {
    await page.navigate(new URL(`/${teamPath}/tasks`, root).toString());
    await waitForWebUiTaskCard({ page, title: phase2.title, status: 'in_progress', timeoutMs });
    const openedPhase2Task = await page.evaluateJson(`
      (() => {
        const title = ${JSON.stringify(phase2.title)};
        const card = Array.from(document.querySelectorAll('[data-smoke="task-card"], [data-smoke="task-row"]'))
          .find((candidate) => candidate.dataset.taskTitle === title);
        if (!card) return false;
        card.click();
        return true;
      })()
    `);
    if (!openedPhase2Task) throw new Error(`Could not open Phase 2 WebUI smoke task "${phase2.title}"`);
    await page.waitForFunction(
      `document.querySelector('[data-smoke="task-dag-panel"]') !== null`,
      'managed Phase 2 task renders the Task DAG panel',
      timeoutMs,
    );
  } finally {
    await phase2.close();
  }
  if (webSocket) {
    await exerciseWebUiChannelNoProjectFactsSmoke({
      page,
      root,
      teamPath,
      webSocket,
      session,
      suffix,
      timeoutMs,
    });
  }
  await exerciseWebUiChannelTaskSubviewSmoke({ page, root, teamPath, channelId, timeoutMs });
  return {
    title,
    status: targetStatus,
    reordered: true,
    deletedTitle: secondaryTitle,
    phase2Title: phase2.title,
    channelNoProjectFactsVerified: Boolean(webSocket),
  };
}

async function seedWebUiOrdinaryTaskFacts({ webSocket, session, channelId, tasks, timeoutMs }) {
  if (!webSocket) throw new Error('WebUI task smoke needs a Socket client to seed ordinary Task facts');
  for (const task of tasks) {
    const taskAck = await emitAck(webSocket, WEB_EVENTS.task.create, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId,
      title: task.title,
      description: task.description,
      tags: ['smoke', 'webui'],
    }, timeoutMs);
    if (taskAck?.ok !== true || typeof taskAck?.task?.id !== 'string') {
      throw new Error(`WebUI task smoke could not seed ordinary Task "${task.title}": ${formatAck(taskAck)}`);
    }
  }
}

export async function exerciseWebUiChannelNoProjectFactsSmoke({
  page,
  root,
  teamPath,
  webSocket,
  session,
  suffix,
  timeoutMs,
}) {
  const channelAck = await emitAck(webSocket, WEB_EVENTS.channel.create, {
    userId: session.user.id,
    teamId: session.team.id,
    name: `plain-task-workbench-${suffix}`,
    visibility: 'public',
  }, timeoutMs);
  const channelId = readNestedString(channelAck, ['channel', 'id']);
  if (!channelId) {
    throw new Error(`Channel Tasks no-project smoke could not create its isolated channel: ${formatAck(channelAck)}`);
  }

  const titles = [`普通任务甲 ${suffix}`, `普通任务乙 ${suffix}`];
  for (const title of titles) {
    const taskAck = await emitAck(webSocket, WEB_EVENTS.task.create, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId,
      title,
    }, timeoutMs);
    if (taskAck?.ok !== true || typeof taskAck?.task?.id !== 'string') {
      throw new Error(`Channel Tasks no-project smoke could not create ordinary Task "${title}": ${formatAck(taskAck)}`);
    }
  }

  await page.navigate(new URL(`/${teamPath}/channel/${channelId}?chatTab=tasks`, root).toString());
  await page.waitForFunction(
    `
    (() => {
      const titles = ${JSON.stringify(titles)};
      const plainWorkspace = document.querySelector('[data-smoke="channel-plain-task-workspace"]');
      const taskList = document.querySelector('[data-smoke="channel-plain-task-list"]');
      const params = new URLSearchParams(window.location.search);
      return params.get('tasksView') === 'plain'
        && document.querySelector('[data-smoke="channel-tasks-view-plain"][aria-selected="true"]') !== null
        && document.querySelector('[data-smoke="channel-project-setup-prompt"]') !== null
        && document.querySelector('[data-smoke="channel-plain-secondary-label"]') !== null
        && document.querySelector('[title="列表"]')?.className.includes('bg-amber-300') === true
        && taskList !== null
        && titles.every((title) => taskList.textContent?.includes(title))
        && plainWorkspace?.textContent?.includes('未进入阶段流程的任务') === true
        && document.querySelector('[data-smoke="task-card-facts"]') === null;
    })()
    `,
    'no-stage channel defaults to ordinary Tasks, exposes setup guidance, and hides empty project facts',
    timeoutMs,
  );

  const openedTask = await page.evaluateJson(`
    (() => {
      const title = ${JSON.stringify(titles[0])};
      const taskList = document.querySelector('[data-smoke="channel-plain-task-list"]');
      const button = Array.from(taskList?.querySelectorAll('button') ?? [])
        .find((candidate) => candidate.textContent?.trim() === title);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()
  `);
  if (!openedTask) throw new Error(`Could not open ordinary channel Task "${titles[0]}"`);
  await page.waitForFunction(
    `document.querySelector('[data-smoke="chat-task-detail"]') !== null
      && new URLSearchParams(window.location.search).get('task')?.startsWith('task:') === true`,
    'ordinary channel Task opens its task-only detail',
    timeoutMs,
  );

  const selectedTaskParam = await page.evaluateJson(
    `new URLSearchParams(window.location.search).get('task')`,
  );
  await page.click('[data-smoke="channel-tasks-view-plain"]');
  await page.waitForFunction(
    `new URLSearchParams(window.location.search).get('task') === ${JSON.stringify(selectedTaskParam)}
      && document.querySelector('[data-smoke="chat-task-detail"]') !== null`,
    'reselecting the active channel Tasks subview preserves the selected Task deep link',
    timeoutMs,
  );

  await page.click('[data-smoke="channel-tasks-view-project"]');
  await page.waitForFunction(
    `new URLSearchParams(window.location.search).get('tasksView') === 'project'
      && !new URLSearchParams(window.location.search).has('task')
      && document.querySelector('[data-smoke="chat-task-detail"]') === null
      && document.querySelector('[data-smoke="channel-project-setup-prompt"]') !== null`,
    'switching to project progress clears stale ordinary Task detail and keeps explicit setup guidance',
    timeoutMs,
  );
}

async function exerciseWebUiChannelTaskSubviewSmoke({ page, root, teamPath, channelId, timeoutMs }) {
  await page.navigate(new URL(`/${teamPath}/channel/${channelId}?chatTab=tasks&tasksView=plain`, root).toString());
  await page.waitForFunction(
    `document.querySelector('[data-smoke="channel-tasks-view-plain"][aria-selected="true"]') !== null`,
    'channel Tasks restores the plain subview from URL',
    timeoutMs,
  );
  await page.click('[data-smoke="channel-tasks-view-project"]');
  await page.waitForFunction(
    `window.location.search.includes('tasksView=project') && document.querySelector('[data-smoke="channel-tasks-view-project"][aria-selected="true"]') !== null`,
    'channel Tasks switches to project progress and records it in URL',
    timeoutMs,
  );
  await page.evaluateJson('history.back(); true');
  await page.waitForFunction(
    `window.location.search.includes('tasksView=plain') && document.querySelector('[data-smoke="channel-tasks-view-plain"][aria-selected="true"]') !== null`,
    'channel Tasks browser back restores the previous subview',
    timeoutMs,
  );
  await page.evaluateJson('history.forward(); true');
  await page.waitForFunction(
    `window.location.search.includes('tasksView=project') && document.querySelector('[data-smoke="channel-tasks-view-project"][aria-selected="true"]') !== null`,
    'channel Tasks browser forward restores the selected subview',
    timeoutMs,
  );
  await page.reload();
  await page.waitForFunction(
    `window.location.search.includes('tasksView=project') && document.querySelector('[data-smoke="channel-tasks-view-project"][aria-selected="true"]') !== null`,
    'channel Tasks preserves the project subview after refresh',
    timeoutMs,
  );

  // #1179：项目设置独立于默认推进面；打开后可见配置面，推进面本身不混排创建阶段/依赖表单。
  await page.waitForFunction(
    `
    (() => {
      const progress = document.querySelector('[data-smoke="channel-project-progress"]');
      if (!progress) return false;
      const text = progress.textContent ?? '';
      const settingsButton = Array.from(progress.querySelectorAll('button'))
        .find((candidate) => {
          const label = candidate.textContent?.trim() ?? '';
          return label === '项目设置 / 阶段配置' || label === '查看项目设置';
        });
      return !text.includes('创建首个项目阶段')
        && !text.includes('阶段依赖')
        && !text.includes('添加依赖')
        && Boolean(settingsButton)
        && document.body.querySelector('[data-smoke="channel-project-settings-dialog"]') === null;
    })()
    `,
    'project progress view keeps config forms out of the runtime surface',
    timeoutMs,
  );
  const openedSettings = await page.evaluateJson(`
    (() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => {
          const label = candidate.textContent?.trim() ?? '';
          return label === '项目设置 / 阶段配置' || label === '查看项目设置';
        });
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!openedSettings) throw new Error('Could not open channel project settings from project progress');
  await page.waitForFunction(
    `document.querySelector('[data-smoke="channel-project-settings-dialog"]') !== null
      && document.querySelector('[data-smoke="channel-project-settings"]') !== null`,
    'project settings dialog renders the configuration surface',
    timeoutMs,
  );
  await page.click('[data-smoke="channel-project-settings-close"]');
  await page.waitForFunction(
    `document.querySelector('[data-smoke="channel-project-settings-dialog"]') === null`,
    'project settings dialog closes and returns to the runtime view',
    timeoutMs,
  );

  await page.click('[data-smoke="channel-tasks-view-plain"]');
  await page.waitForFunction(
    `window.location.search.includes('tasksView=plain') && document.querySelector('[data-smoke="channel-tasks-view-plain"][aria-selected="true"]') !== null`,
    'channel Tasks can return to plain tasks',
    timeoutMs,
  );
}

async function seedPhase2BrowserTask({ baseUrl, webSocket, session, ioFactory, suffix, timeoutMs }) {
  const daemon = await connectSmokeDaemon({
    baseUrl,
    ioFactory,
    session,
    suffix: webUiFlowSuffix(suffix, 'phase2'),
    timeoutMs,
  });
  let policyChanged = false;
  let originalAutoCoordination;
  const restorePolicy = async () => {
    if (!policyChanged || originalAutoCoordination === undefined) return;
    await emitAck(webSocket, WEB_EVENTS.piPolicy.update, {
      userId: session.user.id,
      teamId: session.team.id,
      autoCoordinationEnabled: originalAutoCoordination,
    }, timeoutMs).catch(() => undefined);
    policyChanged = false;
  };
  daemon.socket.on(AGENT_EVENTS.managementWorker.leaseOffer, (_offer, ack) => {
    ack?.({ ok: false, errorCode: 'UNAVAILABLE' });
  });
  try {
    const workerAck = await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.register, {
      schemaVersion: 2,
      workerInstanceId: `browser-phase2-${suffix}`,
      profileId: 'browser-smoke',
      runtimeVersion: '0.1.0',
      supportedProtocolVersions: [1, 2],
      supportedPhases: [1, 2, 3],
      credentialStatus: 'production_ready',
      providerId: 'browser-smoke',
      modelId: 'browser-smoke',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }, timeoutMs);
    if (workerAck?.ok !== true) {
      throw new Error(`Phase 2 browser smoke could not register a V2 worker: ${formatAck(workerAck)}`);
    }

    const currentPolicy = await emitAck(webSocket, WEB_EVENTS.piPolicy.get, {
      userId: session.user.id,
      teamId: session.team.id,
    }, timeoutMs);
    if (currentPolicy?.ok !== true) {
      throw new Error(`Phase 2 browser smoke could not read the current piPolicy: ${formatAck(currentPolicy)}`);
    }
    originalAutoCoordination = currentPolicy.autoCoordinationEnabled;
    const policyAck = await emitAck(webSocket, WEB_EVENTS.piPolicy.update, {
      userId: session.user.id,
      teamId: session.team.id,
      autoCoordinationEnabled: true,
    }, timeoutMs);
    if (policyAck?.ok !== true) {
      throw new Error(`Phase 2 browser smoke could not enable pi auto-coordination: ${formatAck(policyAck)}`);
    }
    policyChanged = true;

    const title = `WebUI Phase 2 DAG ${suffix}`;
    // #724：桥接对"无 target 的 rooted 消息"只会给 managed placement（server worker pool），
    // 而本 smoke 注册的是 device worker。@mention 一个 device 上的 agent 让桥接落到
    // device placement（有 target → DEFAULT_PLACEMENT_POLICY），与 main 上的原语义一致。
    const agentName = `WebUIPhase2${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
    const agentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      userId: session.user.id,
      teamId: session.team.id,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      env: { AGENTBEAN_WEBUI_PHASE2_SMOKE: '1' },
    }, timeoutMs);
    const phase2AgentId = readNestedString(agentAck, ['agent', 'id']);
    if (!phase2AgentId) {
      throw new Error(`Phase 2 browser smoke could not create a device agent: ${formatAck(agentAck)}`);
    }

    const body = `@${agentName} ${title}`;
    const sent = await emitAck(webSocket, WEB_EVENTS.message.send, {
      userId: session.user.id,
      teamId: session.team.id,
      channelId: session.channel.id,
      body,
      asTask: true,
      clientMessageId: `webui-phase2-task-dag-business-flow-${suffix}`,
    }, timeoutMs);
    if (sent?.ok !== true || typeof sent.task?.id !== 'string' || sent.management?.kind !== 'managed') {
      throw new Error(`Phase 2 browser smoke did not create a managed root task: ${formatAck(sent)}`);
    }

    return {
      // task.title 取自完整消息 body（含 @mention 前缀），UI 精确匹配须用同一值。
      title: body,
      async close() {
        await restorePolicy();
        daemon.socket.disconnect?.();
      },
    };
  } catch (error) {
    await restorePolicy();
    daemon.socket.disconnect?.();
    throw error;
  }
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
  // /dashboard/runs 仅管理员可见。外部目标无法本地提权时传 false：
  // 仍创建 workspace run 数据供下游 project smoke，但跳过 admin UI 断言。
  verifyAdminUi = true,
}) {
  assertSession(session);
  if (!session.channel?.id) {
    throw new Error('WebUI runs smoke needs a default channel in the seeded session');
  }
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const teamPath = session.team.path ?? session.team.id;
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
            sourceRoot: {
              id: 'browser-smoke-output',
              kind: 'run_output',
              label: 'Browser smoke output',
            },
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
    await daemon.waitForDispatchResult(dispatchId);

    if (!verifyAdminUi) {
      return {
        id: workspaceRunId,
        command,
        dispatchId,
        logArtifactId,
        summaryArtifactId,
        agentId,
        adminUiVerified: false,
      };
    }

    await page.navigate(new URL(`/${teamPath}/dashboard/runs`, root).toString());
    await waitForWebUiAdminRunsPage({ page, timeoutMs });
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
    await waitForWebUiWorkspaceRunBackToList({ page, teamPath, timeoutMs });
    await page.click('[data-smoke="workspace-run-source-message-link"]');
    await waitForWebUiWorkspaceRunSourceMessage({ page, expectedText: sourceMessageBody, timeoutMs });
    return {
      id: workspaceRunId,
      command,
      dispatchId,
      logArtifactId,
      summaryArtifactId,
      agentId,
      adminUiVerified: true,
    };
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

async function waitForWebUiWorkspaceRunBackToList({ page, teamPath, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const teamPath = ${JSON.stringify(teamPath)};
      const link = document.querySelector('[data-smoke="workspace-run-back-to-list"]');
      return link?.getAttribute('href') === '/' + teamPath + '/dashboard/runs';
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

export async function exerciseWebUiProjectCollaborationSmoke({
  page,
  baseUrl,
  webSocket,
  session,
  taskTitle,
  workspaceRun,
  ioFactory,
  archivedChannelId,
  archivedProjectStageName,
  memberToken,
  suffix,
  timeoutMs,
  fetchImpl = fetch,
}) {
  assertSession(session);
  if (!session.channel?.id) {
    throw new Error('Project collaboration smoke needs a default channel');
  }
  const scope = {
    userId: session.user.id,
    teamId: session.team.id,
    channelId: session.channel.id,
  };
  const tasksAck = await emitAck(webSocket, WEB_EVENTS.task.list, scope, timeoutMs);
  const task = Array.isArray(tasksAck?.tasks)
    ? tasksAck.tasks.find((candidate) => candidate?.title === taskTitle)
    : undefined;
  if (!task?.id) {
    throw new Error(`Project collaboration smoke could not find Task "${taskTitle}": ${formatAck(tasksAck)}`);
  }

  const stageName = `发布保护 ${suffix}`;
  const created = await emitAck(webSocket, WEB_EVENTS.project.createInitialStage, {
    ...scope,
    expectedRevision: 0,
    idempotencyKey: `project-stage-${suffix}`,
    projectLeadId: session.user.id,
    defaultReviewerIds: [session.user.id],
    stage: {
      name: stageName,
      goal: '验证灰度、监控与可回退协作链路',
      ownerId: session.user.id,
      reviewerIds: [session.user.id],
      acceptanceCriteria: ['项目事实可读', '回退不改写既有事实'],
      taskId: task.id,
    },
  }, timeoutMs);
  const stage = created?.overview?.stages?.[0];
  if (created?.ok !== true || !stage?.id) {
    throw new Error(`Project collaboration smoke could not create the Stage: ${formatAck(created)}`);
  }
  const createdRevision = created.overview?.profile?.revision;
  if (!Number.isInteger(createdRevision)) {
    throw new Error(`Project collaboration smoke received an invalid Stage revision: ${formatAck(created)}`);
  }

  const stale = await emitAck(webSocket, WEB_EVENTS.project.createInitialStage, {
    ...scope,
    expectedRevision: 0,
    idempotencyKey: `project-stage-stale-${suffix}`,
    projectLeadId: session.user.id,
    defaultReviewerIds: [session.user.id],
    stage: {
      name: `${stageName} stale`,
      goal: '此陈旧写入必须被拒绝',
      ownerId: session.user.id,
      reviewerIds: [session.user.id],
      acceptanceCriteria: ['拒绝陈旧 revision'],
      taskId: task.id,
    },
  }, timeoutMs);
  if (stale?.ok !== false || stale?.error !== 'CONFLICT') {
    throw new Error(`Project collaboration smoke accepted a stale revision: ${formatAck(stale)}`);
  }
  const afterConflict = await emitAck(webSocket, WEB_EVENTS.project.overview, scope, timeoutMs);
  if (afterConflict?.ok !== true
    || afterConflict.overview?.profile?.revision !== createdRevision
    || afterConflict.overview?.stages?.length !== 1
    || afterConflict.overview.stages[0]?.id !== stage.id
    || afterConflict.overview.stages.some((candidate) => candidate?.name === `${stageName} stale`)) {
    throw new Error(
      `Project collaboration smoke observed changed facts after stale revision rejection: ${formatAck(afterConflict)}`,
    );
  }

  if (archivedChannelId) {
    const archivedOverview = await emitAck(webSocket, WEB_EVENTS.project.overview, {
      ...scope,
      channelId: archivedChannelId,
    }, timeoutMs);
    if (archivedOverview?.ok !== true
      || archivedOverview.overview?.archived !== true
      || !archivedOverview.overview?.stages?.some(
        (candidate) => candidate?.name === archivedProjectStageName,
      )) {
      throw new Error(`Project collaboration smoke could not read archived project facts: ${formatAck(archivedOverview)}`);
    }
    const archivedWrite = await emitAck(webSocket, WEB_EVENTS.project.createInitialStage, {
      ...scope,
      channelId: archivedChannelId,
      expectedRevision: 0,
      idempotencyKey: `project-archived-${suffix}`,
      projectLeadId: session.user.id,
      defaultReviewerIds: [session.user.id],
      stage: {
        name: `${stageName} archived`,
        goal: '归档频道必须拒绝写入',
        ownerId: session.user.id,
        reviewerIds: [session.user.id],
        acceptanceCriteria: ['只读'],
        taskId: task.id,
      },
    }, timeoutMs);
    if (archivedWrite?.ok !== false || archivedWrite?.error !== 'CONFLICT') {
      throw new Error(`Project collaboration smoke accepted an archived channel write: ${formatAck(archivedWrite)}`);
    }
  }
  if (memberToken && ioFactory) {
    const memberSocket = await connectSocket(
      ioFactory,
      new URL('/web', normalizeBaseUrlOrThrow(baseUrl)).toString(),
      timeoutMs,
      { auth: { token: memberToken } },
    );
    try {
      const forbiddenWrite = await emitAck(memberSocket, WEB_EVENTS.project.createStage, {
        teamId: scope.teamId,
        channelId: scope.channelId,
        expectedRevision: createdRevision,
        idempotencyKey: `project-forbidden-${suffix}`,
        stage: {
          name: `${stageName} forbidden`,
          goal: '普通成员不得配置项目',
          ownerId: session.user.id,
          reviewerIds: [session.user.id],
          acceptanceCriteria: ['拒绝越权'],
          taskId: task.id,
        },
      }, timeoutMs);
      if (forbiddenWrite?.ok !== false || forbiddenWrite?.error !== 'FORBIDDEN') {
        throw new Error(`Project collaboration smoke accepted an unauthorized project write: ${formatAck(forbiddenWrite)}`);
      }
    } finally {
      memberSocket.disconnect?.();
    }
  }

  const blockedTask = await emitAck(webSocket, WEB_EVENTS.task.create, {
    ...scope,
    title: `Blocked project task ${suffix}`,
  }, timeoutMs);
  if (blockedTask?.ok !== true || typeof blockedTask.task?.id !== 'string') {
    throw new Error(`Project collaboration smoke could not create blocked Task: ${formatAck(blockedTask)}`);
  }
  const downstream = await emitAck(webSocket, WEB_EVENTS.project.createStage, {
    ...scope,
    expectedRevision: createdRevision,
    idempotencyKey: `project-downstream-${suffix}`,
    stage: {
      name: `待输入 ${suffix}`,
      goal: '验证缺失必需输入保持阻塞',
      ownerId: session.user.id,
      reviewerIds: [session.user.id],
      acceptanceCriteria: ['必需输入齐备后才可执行'],
      taskId: blockedTask.task.id,
    },
  }, timeoutMs);
  const downstreamStage = downstream?.overview?.stages?.find(
    (candidate) => candidate?.task?.id === blockedTask.task.id
      || candidate?.taskId === blockedTask.task.id,
  );
  if (downstream?.ok !== true || !downstreamStage?.id) {
    throw new Error(`Project collaboration smoke could not create downstream Stage: ${formatAck(downstream)}`);
  }
  const missingInput = await emitAck(webSocket, WEB_EVENTS.project.createStageEdge, {
    ...scope,
    expectedRevision: downstream.overview.profile.revision,
    idempotencyKey: `project-required-input-${suffix}`,
    upstreamStageId: stage.id,
    downstreamStageId: downstreamStage.id,
    semantics: 'blocks_start',
    requiredInputs: [{ key: 'release-proof', kind: 'artifact', label: '发布证明' }],
    expectedUpstreamTaskRevision: stage.taskRevision,
    expectedDownstreamTaskRevision: downstreamStage.taskRevision,
  }, timeoutMs);
  const blockedProjection = missingInput?.overview?.stages?.find(
    (candidate) => candidate?.id === downstreamStage.id,
  );
  if (missingInput?.ok !== true
    || blockedProjection?.executionAllowed !== false
    || !blockedProjection.blockingReasons?.some(
      (reason) => reason?.code === 'required_input_missing'
        && reason.requiredInputKey === 'release-proof',
    )) {
    throw new Error(`Project collaboration smoke did not fail closed on missing required input: ${formatAck(missingInput)}`);
  }

  const promoted = await emitAck(webSocket, WEB_EVENTS.project.promoteArtifact, {
    ...scope,
    idempotencyKey: `project-promote-${suffix}`,
    artifactId: workspaceRun.summaryArtifactId,
    stageId: stage.id,
    collection: {
      name: `Smoke 发布包 ${suffix}`,
      kind: 'release_bundle',
    },
  }, timeoutMs);
  if (promoted?.ok !== true || !promoted?.version?.id || !promoted?.collection?.id) {
    throw new Error(`Project collaboration smoke could not promote an Artifact: ${formatAck(promoted)}`);
  }
  const reviewed = await emitAck(webSocket, WEB_EVENTS.project.submitArtifactReview, {
    ...scope,
    idempotencyKey: `project-review-${suffix}`,
    versionId: promoted.version.id,
    decision: 'approved',
    comment: '真实浏览器 smoke 审核通过',
    basis: [{ kind: 'artifact', refId: workspaceRun.summaryArtifactId }],
  }, timeoutMs);
  if (reviewed?.ok !== true || reviewed?.version?.reviewState !== 'approved') {
    throw new Error(`Project collaboration smoke could not review the version: ${formatAck(reviewed)}`);
  }
  const finalized = await emitAck(webSocket, WEB_EVENTS.project.setArtifactFinalVersion, {
    ...scope,
    idempotencyKey: `project-finalize-${suffix}`,
    collectionId: promoted.collection.id,
    versionId: promoted.version.id,
    expectedCollectionRevision: reviewed.collection?.revision ?? promoted.collection.revision,
    reason: '真实浏览器 smoke 人工确认',
  }, timeoutMs);
  if (finalized?.ok !== true || finalized?.collection?.finalVersionId !== promoted.version.id) {
    throw new Error(`Project collaboration smoke could not finalize the version: ${formatAck(finalized)}`);
  }

  const derivedAck = await emitAck(webSocket, WEB_EVENTS.channelDocuments.derive, {
    ...scope,
    sourceArtifactId: workspaceRun.summaryArtifactId,
    content: `# Project rollout smoke\n\n${suffix}\n`,
    filename: `project-rollout-${suffix}.md`,
  }, timeoutMs);
  const document = derivedAck?.document;
  if (derivedAck?.ok !== true || !document?.id) {
    throw new Error(`Project collaboration smoke could not derive the run document: ${formatAck(derivedAck)}`);
  }
  const secondDerivedAck = await emitAck(webSocket, WEB_EVENTS.channelDocuments.derive, {
    ...scope,
    sourceArtifactId: workspaceRun.summaryArtifactId,
    content: `# Project rollout companion\n\n${suffix}\n`,
    filename: `project-rollout-companion-${suffix}.md`,
  }, timeoutMs);
  const secondDocument = secondDerivedAck?.document;
  if (secondDerivedAck?.ok !== true || !secondDocument?.id) {
    throw new Error(`Project collaboration smoke could not derive the companion document: ${formatAck(secondDerivedAck)}`);
  }
  const derivedArtifactId = document.currentRevision?.artifact?.id;
  if (typeof derivedArtifactId !== 'string') {
    throw new Error(`Project collaboration smoke derived document has no Artifact: ${formatAck(derivedAck)}`);
  }
  const materializedContent = `# Project rollout smoke\n\n${suffix}\n`;
  const materializedResponse = await fetchImpl(
    new URL(
      `/api/teams/${encodeURIComponent(scope.teamId)}/artifacts/${encodeURIComponent(derivedArtifactId)}/download`,
      normalizeBaseUrlOrThrow(baseUrl),
    ),
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  if (!materializedResponse.ok || await materializedResponse.text() !== materializedContent) {
    throw new Error('Project collaboration smoke could not materialize exact document bytes through HTTP');
  }
  const bundleAck = await emitAck(webSocket, WEB_EVENTS.project.createDocumentBundle, {
    ...scope,
    idempotencyKey: `project-bundle-${suffix}`,
    name: `Smoke 文档包 ${suffix}`,
    workspaceRunId: workspaceRun.id,
    documentIds: [document.id, secondDocument.id],
  }, timeoutMs);
  const bundleId = bundleAck?.bundle?.id;
  if (bundleAck?.ok !== true || typeof bundleId !== 'string') {
    throw new Error(`Project collaboration smoke could not create a Bundle: ${formatAck(bundleAck)}`);
  }
  const referencesAck = await emitAck(webSocket, WEB_EVENTS.project.resolveReferences, {
    ...scope,
    selections: [{ kind: 'bundle_all', bundleId }],
  }, timeoutMs);
  if (referencesAck?.ok !== true || referencesAck?.selections?.[0]?.items?.length !== 2) {
    throw new Error(`Project collaboration smoke could not freeze Bundle references: ${formatAck(referencesAck)}`);
  }
  const alternateChannelAck = await emitAck(webSocket, WEB_EVENTS.channel.create, {
    userId: session.user.id,
    teamId: scope.teamId,
    name: `project-cross-channel-${suffix}`,
    visibility: 'public',
  }, timeoutMs);
  const alternateChannelId = readNestedString(alternateChannelAck, ['channel', 'id']);
  if (!alternateChannelId) {
    throw new Error(`Project collaboration smoke could not create an active cross-channel scope: ${formatAck(alternateChannelAck)}`);
  }
  const crossChannel = await emitAck(webSocket, WEB_EVENTS.project.resolveReferences, {
    ...scope,
    channelId: alternateChannelId,
    selections: [{ kind: 'bundle_all', bundleId }],
  }, timeoutMs);
  if (crossChannel?.ok !== false
    || crossChannel?.details?.reason !== 'selections_rejected'
    || crossChannel.details.rejections?.[0]?.code !== 'not_found') {
    throw new Error(`Project collaboration smoke did not reject an active cross-channel Bundle reference: ${formatAck(crossChannel)}`);
  }
  const sent = await emitAck(webSocket, WEB_EVENTS.message.send, {
    ...scope,
    clientMessageId: `project-reference-${suffix}`,
    body: `Project reference smoke ${suffix}`,
    selections: [{ kind: 'bundle_all', bundleId }],
  }, timeoutMs);
  if (sent?.ok !== true || sent?.referenceSet?.selections?.[0]?.items?.length !== 2) {
    throw new Error(`Project collaboration smoke did not persist stable references: ${formatAck(sent)}`);
  }
  const inputSetResult = ioFactory
    ? await exerciseProjectInputSetLifecycleSmoke({
        baseUrl,
        ioFactory,
        webSocket,
        session,
        scope,
        bundleId,
        suffix,
        timeoutMs,
      })
    : undefined;

  const reviewChannelAck = await emitAck(webSocket, WEB_EVENTS.channel.create, {
    userId: session.user.id,
    teamId: scope.teamId,
    name: `stage-review-${suffix}`,
    visibility: 'public',
  }, timeoutMs);
  const reviewChannelId = readNestedString(reviewChannelAck, ['channel', 'id']);
  if (!reviewChannelId) {
    throw new Error(`Stage delivery review smoke could not create its isolated channel: ${formatAck(reviewChannelAck)}`);
  }
  const reviewScope = { ...scope, channelId: reviewChannelId };
  const membershipAck = await emitAck(webSocket, WEB_EVENTS.channel.addAgent, {
    ...reviewScope,
    agentId: workspaceRun.agentId,
  }, timeoutMs);
  if (membershipAck?.ok !== true) {
    throw new Error(`Stage delivery review smoke could not bind the real Agent: ${formatAck(membershipAck)}`);
  }
  const reviewTaskAck = await emitAck(webSocket, WEB_EVENTS.task.create, {
    ...reviewScope,
    title: `Stage delivery review ${suffix}`,
  }, timeoutMs);
  const reviewTask = reviewTaskAck?.task;
  if (reviewTaskAck?.ok !== true || typeof reviewTask?.id !== 'string') {
    throw new Error(`Stage delivery review smoke could not create its Task: ${formatAck(reviewTaskAck)}`);
  }
  const reviewStageName = `交付审核 ${suffix}`;
  const reviewStageAck = await emitAck(webSocket, WEB_EVENTS.project.createInitialStage, {
    ...reviewScope,
    expectedRevision: 0,
    idempotencyKey: `stage-review-project-${suffix}`,
    projectLeadId: session.user.id,
    defaultReviewerIds: [session.user.id],
    stage: {
      name: reviewStageName,
      goal: '核对真实 OutputPackage 版本与审核人事实',
      ownerId: session.user.id,
      reviewerIds: [session.user.id],
      acceptanceCriteria: ['交付版本与实际审核人可核验'],
      taskId: reviewTask.id,
    },
  }, timeoutMs);
  const reviewStage = reviewStageAck?.overview?.stages?.[0];
  if (reviewStageAck?.ok !== true || typeof reviewStage?.id !== 'string') {
    throw new Error(`Stage delivery review smoke could not create its Stage: ${formatAck(reviewStageAck)}`);
  }
  const deliveryReview = await createStageDeliveryReviewSmokeFacts({
    baseUrl,
    fetchImpl,
    webSocket,
    session,
    scope: reviewScope,
    task: reviewTask,
    stage: reviewStage,
    workspaceRun,
    suffix,
    timeoutMs,
  });

  const root = normalizeBaseUrlOrThrow(baseUrl);
  const teamPath = session.team.path ?? session.team.id;
  await page.navigate(new URL(`/${teamPath}/channel/${reviewScope.channelId}`, root).toString());
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('button'))
      .some((candidate) => candidate.textContent?.trim() === '任务')`,
    `channel task tab to render for project review Task "${reviewTask.id}"`,
    timeoutMs,
  );
  const openedTasksTab = await page.evaluateJson(`
    (() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === '任务');
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!openedTasksTab) throw new Error(`Could not open channel task view for project Task "${reviewTask.id}"`);
  await page.waitForFunction(
    `(() => { const text = document.querySelector('[data-smoke="channel-project-progress"]')?.textContent ?? ''; return text.includes(${JSON.stringify(reviewStageName)}); })()`,
    `project Stage "${reviewStageName}" to render from the Server projection`,
    timeoutMs,
  );
  const openedStage = await page.evaluateJson(`
    (() => {
      const stageId = ${JSON.stringify(reviewStage.id)};
      const card = Array.from(document.querySelectorAll('[data-smoke="channel-project-stage-card"]'))
        .find((candidate) => candidate.dataset.stageId === stageId);
      if (!card) return false;
      const button = card.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()
  `);
  if (!openedStage) throw new Error(`Could not open project Stage "${reviewStageName}" review workspace`);
  await page.waitForFunction(
    `
    (() => {
      const workspace = document.querySelector('[data-smoke="stage-delivery-review-workspace"]');
      const text = workspace?.textContent ?? '';
      const preview = document.querySelector('[data-smoke="stage-review-open-package-preview"]');
      return text.includes(${JSON.stringify(deliveryReview.packageId)})
        && text.includes(${JSON.stringify(deliveryReview.versionId)})
        && Boolean(preview instanceof HTMLButtonElement && !preview.disabled)
        && !document.querySelector('[data-smoke="package-review-action"]');
    })()
    `,
    `stage review workspace to render package ${deliveryReview.packageId}, version ${deliveryReview.versionId}, and shared preview entry`,
    timeoutMs,
  );

  // #1200：Task 不再直接修改文件审核事实；Task/Files/Thread 共用同一个预览审核弹窗。
  await page.click('[data-smoke="stage-review-open-package-preview"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="output-package-preview-modal"]') && document.querySelector('[data-smoke="package-preview-approve"]'))`,
    'shared package preview modal to open from Task',
    timeoutMs,
  );
  await page.click('[data-smoke="package-preview-approve"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="package-preview-review-panel"]'))`,
    'package preview approval panel to open',
    timeoutMs,
  );
  await page.setInputValue('[data-smoke="package-preview-review-panel"] textarea', '真实浏览器 smoke 审核并最终化');
  await page.click('[data-smoke="package-preview-review-panel"] input[type="checkbox"]');
  await page.click('[data-smoke="package-preview-review-submit"]');
  await page.waitForFunction(
    `
    (() => {
      const saved = document.querySelector('[data-smoke="package-preview-saved"]')?.textContent ?? '';
      return saved.includes('已设为 final');
    })()
    `,
    `shared package preview to project the review and finalization result`,
    timeoutMs,
  );

  await page.click('[data-smoke="output-package-preview-modal"] header button[title="关闭"]');
  await page.click('[data-smoke="channel-files-tab"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="project-files-board"]') && document.querySelector('[data-smoke="files-row-preview-edit"]'))`,
    'Files to render the reviewed package row',
    timeoutMs,
  );
  await page.click('[data-smoke="files-row-preview-edit"]');
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="output-package-preview-modal"]'))`,
    'the same package preview modal to open from Files',
    timeoutMs,
  );
  await page.click('[data-smoke="output-package-preview-modal"] header button[title="关闭"]');

  const hasAccept = await page.evaluateJson(`
    (() => {
      const button = document.querySelector('[data-smoke="stage-delivery-action"][data-action="accept-delivery"]');
      return Boolean(button instanceof HTMLButtonElement && !button.disabled);
    })()
  `);
  if (hasAccept) {
    await page.click('[data-smoke="stage-delivery-action"][data-action="accept-delivery"]');
    await page.waitForFunction(
      `Boolean(document.querySelector('[data-smoke="stage-review-mutation-dialog"]'))`,
      'delivery acceptance dialog to open',
      timeoutMs,
    );
    await page.click('[data-smoke="stage-review-mutation-confirm"]');
    await page.waitForFunction(
      `!document.querySelector('[data-smoke="stage-review-mutation-dialog"]')`,
      'delivery acceptance dialog to close after success',
      timeoutMs,
    );
  }

  return {
    stageName,
    stageId: stage.id,
    versionId: promoted.version.id,
    bundleId,
    referenceSetId: sent.referenceSet.id,
    outputPackageId: deliveryReview.packageId,
    outputPackageVersionId: deliveryReview.versionId,
    deliveryReviewStageId: reviewStage.id,
    ...(inputSetResult ? { inputSetResult } : {}),
  };
}

async function createStageDeliveryReviewSmokeFacts({
  baseUrl,
  fetchImpl,
  webSocket,
  session,
  scope,
  task,
  stage,
  workspaceRun,
  suffix,
  timeoutMs,
}) {
  if (typeof workspaceRun?.agentId !== 'string') {
    throw new Error('Stage delivery review smoke needs the real Agent created by the workspace run flow');
  }
  const workspaceAck = await emitAck(webSocket, WEB_EVENTS.project.workspace, scope, timeoutMs);
  const baselineRevisionId = workspaceAck?.ok === true
    ? workspaceAck.workspace?.currentRevisionId ?? ''
    : '';
  const publishId = `stage-review-${suffix}`;
  const path = `docs/stage-review-${suffix}.md`;
  const body = Buffer.from(`# Stage delivery review smoke\n\n${suffix}\n`);
  const stagingUrl = new URL(
    `/api/teams/${encodeURIComponent(scope.teamId)}/workspace-publish-staging`,
    normalizeBaseUrlOrThrow(baseUrl),
  );
  const authorization = { Authorization: `Bearer ${session.token}` };
  const beginResponse = await fetchImpl(new URL(`${stagingUrl.pathname}/begin`, stagingUrl), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId: scope.channelId,
      publishId,
      baselineRevisionId,
      files: [{
        path,
        filename: path.split('/').pop(),
        mimeType: 'text/markdown',
        expectedSizeBytes: body.byteLength,
        expectedSha256: createHash('sha256').update(body).digest('hex'),
      }],
      provenance: {
        agentId: workspaceRun.agentId,
        taskId: task.id,
        taskAttempt: 1,
        workspaceRunId: workspaceRun.id,
      },
    }),
  });
  const begin = await beginResponse.json();
  if (!beginResponse.ok || begin?.ok !== true) {
    throw new Error(`Stage delivery review smoke could not begin OutputPackage staging: ${formatAck(begin)}`);
  }

  const putUrl = new URL(`${stagingUrl.pathname}/put`, stagingUrl);
  putUrl.searchParams.set('channelId', scope.channelId);
  putUrl.searchParams.set('publishId', publishId);
  putUrl.searchParams.set('path', path);
  putUrl.searchParams.set('offset', '0');
  const putResponse = await fetchImpl(putUrl, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/octet-stream' },
    body,
  });
  const put = await putResponse.json();
  if (!putResponse.ok || put?.ok !== true) {
    throw new Error(`Stage delivery review smoke could not upload OutputPackage bytes: ${formatAck(put)}`);
  }

  const commitResponse = await fetchImpl(new URL(`${stagingUrl.pathname}/commit`, stagingUrl), {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId: scope.channelId, publishId }),
  });
  const commit = await commitResponse.json();
  if (!commitResponse.ok || commit?.ok !== true) {
    throw new Error(`Stage delivery review smoke could not commit OutputPackage staging: ${formatAck(commit)}`);
  }

  const listed = await emitAck(webSocket, WEB_EVENTS.project.listOutputPackages, {
    ...scope,
    taskId: task.id,
  }, timeoutMs);
  const packageSummary = Array.isArray(listed?.packages)
    ? listed.packages.find((candidate) => candidate?.publishId === publishId)
    : undefined;
  if (listed?.ok !== true || typeof packageSummary?.packageId !== 'string') {
    throw new Error(`Stage delivery review smoke could not read the formed OutputPackage: ${formatAck(listed)}`);
  }
  const detail = await emitAck(webSocket, WEB_EVENTS.project.getOutputPackage, {
    ...scope,
    packageId: packageSummary.packageId,
  }, timeoutMs);
  const member = detail?.package?.members?.[0];
  const actions = detail?.availableActions?.find(
    (candidate) => candidate?.collectionId === member?.collectionId
      && candidate?.versionId === member?.artifactVersionId,
  );
  if (detail?.ok !== true || !member?.artifactVersionId || !actions) {
    throw new Error(`Stage delivery review smoke could not read the package member facts: ${formatAck(detail)}`);
  }
  // #1177：留下 pending package，让浏览器在 Tasks 工作区通过 UI 提交审核/最终化/验收。
  if (!Array.isArray(actions.actions) || !actions.actions.includes('review-and-finalize')) {
    throw new Error(`Stage delivery review smoke expected review-and-finalize discovery for the owner: ${formatAck(detail)}`);
  }
  return {
    packageId: packageSummary.packageId,
    versionId: member.artifactVersionId,
    collectionId: member.collectionId,
    collectionRevision: actions.collectionRevision,
  };
}

async function exerciseProjectInputSetLifecycleSmoke({
  baseUrl,
  ioFactory,
  webSocket,
  session,
  scope,
  bundleId,
  suffix,
  timeoutMs,
}) {
  const root = normalizeBaseUrlOrThrow(baseUrl);
  let dispatchStep = 'waiting for dispatch request';
  let dispatchAck;
  let resolveDispatchAck;
  const dispatchAckReceived = new Promise((resolve) => {
    resolveDispatchAck = resolve;
  });
  let conflictInjected = false;
  const daemon = await connectSmokeDaemon({
    baseUrl: root,
    ioFactory,
    session,
    suffix: `inputset-${suffix}`,
    timeoutMs,
    onDispatchResultAck: (ack) => {
      dispatchStep = 'dispatch result acknowledged';
      dispatchAck = ack;
      resolveDispatchAck(ack);
    },
    dispatchResultFactory: async (request) => {
      dispatchStep = 'validating InputSet dispatch request';
      const inputSet = request.projectDocumentInputSet;
      if (!inputSet || inputSet.items?.length !== 2 || !request.managementInvocationId) {
        throw new Error(`InputSet smoke received an invalid Dispatch request: ${formatAck(request)}`);
      }
      for (const item of inputSet.items) {
        dispatchStep = `materializing ${item.documentId}`;
        const response = await fetch(
          new URL(
            `/api/teams/${encodeURIComponent(scope.teamId)}/artifacts/${encodeURIComponent(item.artifactId)}/download`,
            root,
          ),
          { headers: { Authorization: `Bearer ${session.token}` } },
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!response.ok
          || bytes.byteLength !== item.sizeBytes
          || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
          throw new Error(`InputSet smoke could not materialize ${item.documentId}`);
        }
      }

      const changedArtifacts = inputSet.items.map((item, index) => {
        const bytes = Buffer.from(`# Agent changed InputSet ${index + 1}\n\n${suffix}\n`);
        const artifactId = `inputset-result-${index + 1}-${suffix}`;
        const filename = `inputset-result-${index + 1}-${suffix}.md`;
        return {
          id: artifactId,
          filename,
          mimeType: 'text/markdown',
          sizeBytes: bytes.byteLength,
          relativePath: filename,
          pathKind: 'generated',
          role: 'intermediate',
          sourceRoot: {
            id: `project-document-input-set:${inputSet.id}`,
            kind: 'configured_output',
            label: '项目文档回写',
          },
          sha256: createHash('sha256').update(bytes).digest('hex'),
          contentBase64: bytes.toString('base64'),
          documentId: item.documentId,
          baseRevisionId: item.baseRevisionId,
        };
      });
      const first = inputSet.items[0];
      dispatchStep = 'injecting concurrent document revision';
      const humanEdit = await emitAck(webSocket, WEB_EVENTS.channelDocuments.save, {
        ...scope,
        documentId: first.documentId,
        baseRevisionId: first.baseRevisionId,
        content: `# Human concurrent edit\n\n${suffix}\n`,
        filename: first.displayName,
        idempotencyKey: `inputset-human-conflict-${suffix}`,
      }, timeoutMs);
      if (humanEdit?.ok !== true) {
        throw new Error(`InputSet smoke could not inject a human OCC edit: ${formatAck(humanEdit)}`);
      }
      conflictInjected = true;
      dispatchStep = 'submitting InputSet result';
      return {
        body: `InputSet partial conflict ${suffix}`,
        artifacts: changedArtifacts.map(({ documentId: _documentId, baseRevisionId: _baseRevisionId, ...artifact }) => artifact),
        workspaceRun: {
          id: `inputset-run-${suffix}`,
          status: 'succeeded',
          command: 'browser-inputset-smoke',
        },
        projectDocumentInputSetResult: {
          contractVersion: 1,
          inputSetId: inputSet.id,
          invocationId: request.managementInvocationId,
          items: changedArtifacts.map((artifact) => ({
            documentId: artifact.documentId,
            baseRevisionId: artifact.baseRevisionId,
            status: 'changed',
            sha256: artifact.sha256,
            artifactId: artifact.id,
          })),
        },
      };
    },
  });
  let policyChanged = false;
  let originalAutoCoordination;
  try {
    const agentName = `InputSet${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`;
    const agentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      ...scope,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: agentName,
      projectDocumentInputSetVersions: [1],
      env: { AGENTBEAN_INPUT_SET_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    if (!agentId) throw new Error(`InputSet smoke could not create Agent: ${formatAck(agentAck)}`);
    const managerAgentName = `InputSetManager${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
    const managerAgentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      ...scope,
      deviceId: daemon.deviceId,
      runtimeId: daemon.runtimeId,
      name: managerAgentName,
      env: { AGENTBEAN_INPUT_SET_MANAGER_SMOKE: '1' },
    }, timeoutMs);
    if (!readNestedString(managerAgentAck, ['agent', 'id'])) {
      throw new Error(`InputSet smoke could not create manager Agent: ${formatAck(managerAgentAck)}`);
    }

    let workerResolve;
    let workerReject;
    const workerDone = new Promise((resolve, reject) => {
      workerResolve = resolve;
      workerReject = reject;
    });
    daemon.socket.on(AGENT_EVENTS.taskClaim.offer, async (offer, ack) => {
      ack?.({ schemaVersion: 1, ok: true });
      try {
        const response = await emitAck(daemon.socket, AGENT_EVENTS.taskClaim.respond, {
          schemaVersion: 1,
          offerId: offer.offerId,
          agentId: offer.agentId,
          kind: offer.agentId === agentId ? 'accepted' : 'rejected',
        }, timeoutMs);
        if (offer.agentId === agentId && response?.kind === 'not_accepted'
          && response.diagnosticCode === 'TASK_CLAIM_OFFER_INVALID') {
          const acquired = await emitAck(daemon.socket, AGENT_EVENTS.taskClaim.acquire, {
            schemaVersion: 1,
            offerId: offer.offerId,
            agentId: offer.agentId,
          }, timeoutMs);
          if (acquired?.ok !== true) {
            throw new Error(`InputSet legacy claim fallback failed: ${formatAck(acquired)}`);
          }
        } else if (offer.agentId === agentId && response?.kind !== 'claim_granted') {
          throw new Error(`InputSet claim was not granted: ${formatAck(response)}`);
        }
      } catch (error) {
        workerReject(error);
      }
    });
    daemon.socket.on(AGENT_EVENTS.managementWorker.leaseOffer, async (offer, ack) => {
      ack?.({ ok: true });
      try {
        const lease = await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.leaseAcquire, {
          schemaVersion: 1,
          offerId: offer.offerId,
          workerInstanceId: `inputset-worker-${suffix}`,
        }, timeoutMs);
        if (lease?.ok !== true) throw new Error(`InputSet lease rejected: ${formatAck(lease)}`);
        const checkpoint = await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.checkpointFetch, {
          schemaVersion: 1,
          managementRunId: lease.managementRunId,
          workerId: lease.workerId,
          leaseToken: lease.leaseToken,
          fencingToken: lease.fencingToken,
        }, timeoutMs);
        const rootTaskId = checkpoint?.context?.rootTaskId;
        const managementPhase = checkpoint?.context?.managementPhase;
        if (typeof rootTaskId !== 'string') {
          throw new Error(`InputSet checkpoint has no root Task: ${formatAck(checkpoint)}`);
        }
        if (managementPhase !== 2 && managementPhase !== 3) {
          throw new Error(`InputSet checkpoint has an invalid management phase: ${formatAck(checkpoint)}`);
        }
        let sequence = 0;
        const tool = async (toolName, input) => {
          sequence += 1;
          // agents.invoke 等待 Dispatch 回收、项目事实写入和 Delivery 提交；正式 daemon
          // 协议为终态工具调用预留 6 分钟 ACK 窗口，smoke 至少给它一分钟。
          const toolTimeoutMs = toolName === 'agents.invoke' ? Math.max(timeoutMs, 60_000) : timeoutMs;
          let result;
          try {
            result = await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.toolRequest, {
              schemaVersion: 2,
              // Phase 3 reuses the Phase 2 task/agent protocol; only memory tools
              // are encoded with managementPhase=3.
              managementPhase: 2,
              commandId: `inputset-command-${suffix}-${sequence}`,
              managementRunId: lease.managementRunId,
              workerId: lease.workerId,
              toolCallId: `inputset-tool-${suffix}-${sequence}`,
              toolName,
              leaseToken: lease.leaseToken,
              fencingToken: lease.fencingToken,
              idempotencyKey: `inputset-tool-${suffix}-${sequence}`,
              input,
            }, toolTimeoutMs);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`InputSet tool ${toolName} request failed at ${dispatchStep}; dispatch ack=${formatAck(dispatchAck)}: ${detail}`);
          }
          if (result?.ok !== true) {
            throw new Error(`InputSet tool ${toolName} failed: ${formatAck(result)}`);
          }
          return result.output;
        };
        const created = await tool('tasks.create_subtasks', {
          parentTaskId: rootTaskId,
          subtasks: [{
            clientKey: 'inputset',
            title: `InputSet execution ${suffix}`,
            description: 'Materialize, execute and reclaim a frozen project document InputSet',
            claimPolicy: 'open',
            requiredCapabilities: [],
            acceptanceCriteria: [],
            maxAttempts: 1,
          }],
        });
        const taskId = created.taskIds?.[0];
        if (typeof taskId !== 'string') throw new Error('InputSet smoke created no subtask');
        await tool('tasks.publish_for_claim', {
          taskId,
          expectedTaskRevision: 1,
        });
        let snapshot;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waited = await tool('tasks.wait', { taskIds: [taskId] });
          snapshot = waited.taskSnapshots?.[0];
          if (snapshot?.claimLeaseId && snapshot?.claimedAgentId === agentId) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!snapshot?.claimLeaseId) throw new Error('InputSet smoke Task claim timed out');
        const invocation = await tool('agents.invoke', {
          taskId,
          expectedTaskRevision: snapshot.taskRevision,
          taskAttempt: snapshot.taskAttempt,
          claimLeaseId: snapshot.claimLeaseId,
          targetAgentId: agentId,
          objective: 'Execute the frozen project document InputSet',
          attachmentIds: [],
        });
        await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.leaseRelease, {
          schemaVersion: 1,
          managementRunId: lease.managementRunId,
          workerId: lease.workerId,
          leaseToken: lease.leaseToken,
          fencingToken: lease.fencingToken,
          idempotencyKey: `inputset-release-${suffix}`,
          reasonCode: 'INPUT_SET_SMOKE_COMPLETE',
        }, timeoutMs);
        workerResolve(invocation);
      } catch (error) {
        workerReject(error);
      }
    });
    const workerAck = await emitAck(daemon.socket, AGENT_EVENTS.managementWorker.register, {
      schemaVersion: 2,
      workerInstanceId: `inputset-worker-${suffix}`,
      profileId: 'browser-smoke',
      runtimeVersion: '0.1.0',
      supportedProtocolVersions: [1, 2],
      supportedPhases: [1, 2, 3],
      credentialStatus: 'production_ready',
      providerId: 'browser-smoke',
      modelId: 'browser-smoke',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }, timeoutMs);
    if (workerAck?.ok !== true) throw new Error(`InputSet worker registration failed: ${formatAck(workerAck)}`);

    const currentPolicy = await emitAck(webSocket, WEB_EVENTS.piPolicy.get, scope, timeoutMs);
    if (currentPolicy?.ok !== true) throw new Error(`InputSet policy read failed: ${formatAck(currentPolicy)}`);
    originalAutoCoordination = currentPolicy.autoCoordinationEnabled;
    const policyAck = await emitAck(webSocket, WEB_EVENTS.piPolicy.update, {
      ...scope,
      autoCoordinationEnabled: true,
    }, timeoutMs);
    if (policyAck?.ok !== true) throw new Error(`InputSet policy update failed: ${formatAck(policyAck)}`);
    policyChanged = true;

    const sent = await emitAck(webSocket, WEB_EVENTS.message.send, {
      ...scope,
      // 使用独立 manager Agent 触发 device placement；执行 Agent 不能与根任务
      // 的祖先 Agent 相同，否则 claim broker 会以 ANCESTOR_AGENT_LOOP 拒绝。
      body: `@${managerAgentName} InputSet lifecycle ${suffix}`,
      asTask: true,
      clientMessageId: `inputset-lifecycle-${suffix}`,
      selections: [{ kind: 'bundle_all', bundleId }],
    }, timeoutMs);
    if (sent?.ok !== true || sent.management?.kind !== 'managed') {
      throw new Error(`InputSet managed root Task was not created: ${formatAck(sent)}`);
    }
    await promiseWithTimeout(workerDone, timeoutMs * 4, 'InputSet management worker lifecycle');
    await promiseWithTimeout(dispatchAckReceived, timeoutMs, 'InputSet dispatch result acknowledgement');
    if (!conflictInjected) throw new Error('InputSet smoke did not inject the OCC conflict');
    const result = dispatchAck?.projectDocumentInputSetResult;
    if (!result?.items?.some((item) => item.status === 'conflict')
      || !result.items.some((item) => item.status === 'committed')) {
      throw new Error(`InputSet smoke did not preserve partial results: ${formatAck(dispatchAck)}`);
    }
    return { statuses: result.items.map((item) => item.status) };
  } finally {
    if (policyChanged) {
      await emitAck(webSocket, WEB_EVENTS.piPolicy.update, {
        ...scope,
        autoCoordinationEnabled: originalAutoCoordination,
      }, timeoutMs).catch(() => undefined);
    }
    daemon.socket.disconnect?.();
  }
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
  const teamPath = session.team.path ?? session.team.id;
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

    await page.navigate(new URL(`/${teamPath}/members`, root).toString());
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

    await clickWebUiHumanMemberAction({ page, selector: '[data-smoke="member-role-promote-admin"]', timeoutMs });
    await waitForWebUiHumanMemberDetail({ page, userId: targetUserId, role: 'admin', timeoutMs });
    await waitForWebUiHumanMemberItem({ page, userId: targetUserId, role: 'admin', timeoutMs });

    await clickWebUiHumanMemberAction({ page, selector: '[data-smoke="member-role-demote-member"]', timeoutMs });
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

// #853：等待命中与随后的 click 之间隔着一个 CDP 往返，元素可能正好在这个窗口里消失
// （客户端路由切换让组件重挂载、丢一帧详情就是实例之一）。分开写 waitForFunction + page.click
// 是 check-then-act：wait 成功了，click 才发现元素已经不在，抛的是 `Missing clickable`
// 而不是等待超时——于是失败看起来像「按钮从未出现」，把排查引向「等待条件不对/超时太短」，
// 而真相是「等到了又消失」。把两步合成一个可重试的原子操作：只要 click 是因为元素消失而失败，
// 就回到等待重试，直到超时。其它错误立即上抛，不掩盖真实故障。
async function clickWebUiHumanMemberAction({ page, selector, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastMissingError;
  while (Date.now() < deadline) {
    await page.waitForFunction(
      `
      (() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        return Boolean(button) && !button.disabled;
      })()
      `,
      `human member action "${selector}" to become clickable`,
      deadline - Date.now(),
    );
    try {
      await page.click(selector);
      return;
    } catch (error) {
      const message = String(error?.message ?? '');
      if (!message.includes('Missing clickable')) throw error;
      lastMissingError = error;
    }
  }
  throw lastMissingError ?? new Error(`Timed out clicking human member action "${selector}"`);
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
  const teamPath = session.team.path ?? session.team.id;
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

    await page.navigate(new URL(`/${teamPath}/devices`, root).toString());
    await waitForWebUiDeviceListItem({ page, deviceId: daemon.deviceId, timeoutMs });
    await page.navigate(new URL(`/${teamPath}/devices/${daemon.deviceId}`, root).toString());
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
    await page.waitForFunction(
      `Boolean(document.querySelector('[data-smoke="device-delete-name-input"]'))`,
      'remote device delete name confirmation to render',
      timeoutMs,
    );
    await page.fillInputAsUser('[data-smoke="device-delete-name-input"]', renamedDeviceName);
    await page.waitForFunction(
      `document.querySelector('[data-smoke="device-delete-name-input"]')?.value === ${JSON.stringify(renamedDeviceName)}`,
      'remote device delete confirmation name to update',
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
  const teamPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const teamName = `WebUI Settings ${safeSuffix}`;
  await page.navigate(new URL(`/${teamPath}/settings`, root).toString());
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

  await openWebUiSettingsTab({ page, tab: 'browser', timeoutMs });
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
  await openWebUiSettingsTab({ page, tab: 'browser', timeoutMs });
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

  await openWebUiSettingsTab({ page, tab: 'server', timeoutMs });
  await page.waitForFunction(
    `document.querySelector('[data-smoke="settings-team-name-input"]')?.dataset.teamId === ${JSON.stringify(session.team.id)}`,
    `settings team name input to bind Team ${session.team.id}`,
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
  await openWebUiSettingsTab({ page, tab: 'server', timeoutMs });
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

export async function exerciseWebUiMemoryBusinessSmoke({ page, baseUrl, session, suffix, timeoutMs }) {
  assertSession(session);
  const root = normalizeBaseUrlOrThrow(baseUrl);
  const teamPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-24);
  const content = `WebUI Memory smoke ${safeSuffix}`;
  await page.navigate(new URL(`/${teamPath}/dashboard/memory`, root).toString());
  await waitForWebUiAdminMemoryPage({ page, timeoutMs });
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="memory-governance-panel"]'))`,
    'Memory governance panel to render',
    timeoutMs,
  );
  await page.click('[data-smoke="memory-create-toggle"]');
  await page.setInputValue('[data-smoke="memory-create-content"]', content);
  await page.click('[data-smoke="memory-create-submit"]');
  await page.waitForFunction(
    `document.querySelector('[data-smoke="memory-governance-panel"]')?.textContent.includes(${JSON.stringify(content)})`,
    `Memory governance panel to render "${content}"`,
    timeoutMs,
  );
  await page.reload();
  await page.waitForFunction(
    `document.querySelector('[data-smoke="memory-governance-panel"]')?.textContent.includes(${JSON.stringify(content)})`,
    `Memory governance panel to restore "${content}" after refresh`,
    timeoutMs,
  );
  return { content };
}

async function openWebUiSettingsTab({ page, tab, timeoutMs }) {
  const selector = `[data-smoke="settings-tab-${tab}"]`;
  await page.waitForFunction(
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    `settings ${tab} tab to become clickable`,
    timeoutMs,
  );
  await page.click(selector);
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
  const teamPath = session.team.path ?? session.team.id;
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-32);
  const agentName = `WebUIAgent${safeSuffix.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
  const configuredAgentName = `${agentName}Cfg`;
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

    await page.navigate(new URL(`/${teamPath}/agents`, root).toString());
    await waitForWebUiAgentListItem({ page, agentId, name: agentName, timeoutMs });
    await page.navigate(new URL(`/${teamPath}/agents/${agentId}`, root).toString());
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

    await page.navigate(new URL(`/${teamPath}/agents/metrics`, root).toString());
    await waitForWebUiAgentMetricsPanel({ page, agentId, timeoutMs });
    await page.navigate(new URL(`/${teamPath}/agents/${agentId}`, root).toString());
    await waitForWebUiAgentDetail({ page, agentId, name: configuredAgentName, timeoutMs });
    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-delete-open"]', timeoutMs });
    await page.click('[data-smoke="agent-delete-open"]');
    await waitForWebUiAgentAction({ page, selector: '[data-smoke="agent-delete-dialog"]', timeoutMs });
    await page.click('[data-smoke="agent-delete-confirm"]');
    await waitForWebUiAgentListItemAbsent({ page, agentId, timeoutMs });
    return { agentId, agentName: configuredAgentName, dispatchId, deleted: true };
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
  const teamPath = adminSession.team.path ?? adminSession.team.id;
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
    // Enter System Admin Console via dashboard root (redirects to /dashboard/teams).
    await page.navigate(new URL(`/${teamPath}/dashboard`, root).toString());
    await waitForWebUiAdminDashboard({ page, timeoutMs });
    await waitForWebUiAdminConsoleNav({ page, timeoutMs });
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'teams', timeoutMs });
    await waitForWebUiAdminTeam({ page, teamId: adminSession.team.id, timeoutMs });

    // Middle-nav section switch: users
    await page.click('[data-smoke="admin-tab-users"]');
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'users', timeoutMs });
    await waitForWebUiAdminUser({ page, userId: adminSession.user.id, username: adminSession.user.username, timeoutMs });
    await waitForWebUiAdminUser({ page, userId: initialOwner.session.user.id, username: initialOwner.username, timeoutMs });
    await waitForWebUiAdminUser({ page, userId: targetOwner.session.user.id, username: targetOwner.username, timeoutMs });

    // Middle-nav section switch: devices (+ owner transfer)
    await page.click('[data-smoke="admin-tab-devices"]');
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'devices', timeoutMs });
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
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'devices', timeoutMs });
    await waitForWebUiAdminDevice({
      page,
      deviceId: daemon.deviceId,
      ownerId: targetOwner.session.user.id,
      timeoutMs,
    });

    // Middle-nav section switch: agents
    await page.click('[data-smoke="admin-tab-agents"]');
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'agents', timeoutMs });
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

    // Middle-nav PI section (new IA entry; not settings)
    await page.click('[data-smoke="admin-tab-pi"]');
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'pi', timeoutMs });
    await waitForWebUiAdminPiPage({ page, timeoutMs });

    // Deep-link: /dashboard/pi remains the PI entry after refresh-style navigation
    await page.navigate(new URL(`/${teamPath}/dashboard/pi`, root).toString());
    await waitForWebUiAdminDashboard({ page, timeoutMs });
    await waitForWebUiAdminConsoleNav({ page, timeoutMs });
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'pi', timeoutMs });
    await waitForWebUiAdminPiPage({ page, timeoutMs });

    // Settings is no longer the PI primary entry; legacy ?tab=pi redirects admins to Console
    await page.navigate(new URL(`/${teamPath}/settings`, root).toString());
    await page.waitForFunction(
      `
      (() => {
        return Boolean(document.querySelector('[data-smoke="settings-tab-account"]'))
          && !document.querySelector('[data-smoke="settings-tab-pi"]')
          && !window.location.pathname.includes('/dashboard/pi');
      })()
      `,
      'settings page without PI as a primary tab',
      timeoutMs,
    );
    await page.navigate(new URL(`/${teamPath}/settings?tab=pi`, root).toString());
    await waitForWebUiAdminSectionPath({ page, teamPath, section: 'pi', timeoutMs });
    await waitForWebUiAdminPiPage({ page, timeoutMs });

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

/** System Admin Console middle nav: inventory + PI + Memory + run diagnostics. */
async function waitForWebUiAdminConsoleNav({ page, timeoutMs }) {
  await page.waitForFunction(
    `
    (() => {
      const nav = document.querySelector('[data-smoke="admin-console-nav"]');
      if (!nav) return false;
      return ['teams', 'users', 'devices', 'agents', 'pi', 'memory', 'runs'].every((key) =>
        Boolean(document.querySelector('[data-smoke="admin-tab-' + key + '"]'))
      );
    })()
    `,
    'admin console middle nav with seven sections to render',
    timeoutMs,
  );
}

async function waitForWebUiAdminSectionPath({ page, teamPath, section, timeoutMs }) {
  await page.waitForFunction(
    `window.location.pathname.includes(${JSON.stringify(`/${teamPath}/dashboard/${section}`)})`,
    `admin console section path /dashboard/${section} to be active`,
    timeoutMs,
  );
}

async function waitForWebUiAdminPiPage({ page, timeoutMs }) {
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="admin-pi-page"]')) && Boolean(document.querySelector('[data-smoke="settings-pi-panel"]'))`,
    'admin PI Agent management panel to render at dashboard/pi',
    timeoutMs,
  );
}

async function waitForWebUiAdminMemoryPage({ page, timeoutMs }) {
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="admin-memory-page"]')) && Boolean(document.querySelector('[data-smoke="memory-governance-panel"]'))`,
    'admin Memory management panel to render at dashboard/memory',
    timeoutMs,
  );
}

async function waitForWebUiAdminRunsPage({ page, timeoutMs }) {
  await page.waitForFunction(
    `Boolean(document.querySelector('[data-smoke="admin-runs-page"]')) && Boolean(document.querySelector('[data-smoke="workspace-runs-page"]'))`,
    'admin run diagnostics panel to render at dashboard/runs',
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

async function connectSmokeDaemon({
  baseUrl,
  ioFactory,
  session,
  suffix,
  timeoutMs,
  dispatchResultFactory,
  onDispatchResultAck,
}) {
  const socket = await connectSocket(ioFactory, new URL('/agent', baseUrl).toString(), timeoutMs);
  const dispatchResults = new Map();
  const dispatchResultFor = (dispatchId) => {
    let pending = dispatchResults.get(dispatchId);
    if (!pending) {
      let resolveResult;
      const promise = new Promise((resolve) => {
        resolveResult = resolve;
      });
      pending = { promise, resolve: resolveResult };
      dispatchResults.set(dispatchId, pending);
    }
    return pending;
  };
  socket.on(AGENT_EVENTS.dispatch.request, async (request) => {
    const pending = dispatchResultFor(request.id);
    const result = await dispatchResultFactory?.(request) ?? {
      body: `browser-smoke:${request.prompt}`,
    };
    try {
      const ack = await emitAck(socket, AGENT_EVENTS.dispatch.result, {
        dispatchId: request.id,
        agentId: request.agentId,
        ...result,
      }, timeoutMs);
      onDispatchResultAck?.(ack, request);
      pending.resolve(
        ack?.ok === false
          ? { ok: false, error: new Error(`Smoke daemon dispatch result was rejected: ${formatAck(ack)}`) }
          : { ok: true },
      );
    } catch (error) {
      pending.resolve({ ok: false, error: error instanceof Error ? error : new Error(String(error)) });
    }
  });

  const helloAck = await emitAck(socket, AGENT_EVENTS.device.hello, {
    teamId: session.team.id,
    ownerId: session.user.id,
    machineId: `agentbean-browser-smoke:${suffix}`,
    profileId: 'browser-smoke',
    hostname: 'agentbean-browser-smoke',
    capabilities: { projectDocumentInputSetVersions: [1] },
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

  return {
    socket,
    deviceId,
    runtimeId,
    async waitForDispatchResult(dispatchId) {
      const result = await promiseWithTimeout(
        dispatchResultFor(dispatchId).promise,
        timeoutMs,
        `dispatch result ${dispatchId} to persist`,
      );
      if (!result.ok) {
        throw result.error;
      }
    },
  };
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
    // project:* mutations require an authenticated Socket handshake; auth:register/login on the
    // bootstrap socket cannot retroactively update its handshake credentials.
    socket.disconnect?.();
    const authenticatedSocket = await connectSocket(
      ioFactory,
      new URL('/web', baseUrl).toString(),
      timeoutMs,
      { auth: { token: ack.token } },
    );
    return {
      socket: authenticatedSocket,
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
    throw new Error('Browser artifact row was not rendered');
  }
  if (!renderedArtifact.previewHref || !renderedArtifact.downloadHref) {
    throw new Error('Browser artifact links were not rendered');
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
    throw new Error('Artifact preview fetch failed');
  }
  if (http?.download?.status !== 200 || http.download.body !== content || !http.download.disposition.includes(filename)) {
    throw new Error('Artifact download fetch failed');
  }
  return {
    filename,
    previewBody: http.preview.body,
    downloadBody: http.download.body,
  };
}

export async function exerciseChannelFilesBrowserSmoke({ page, filename, timeoutMs }) {
  await page.click('[data-smoke="channel-files-tab"]');
  // 无项目投影的普通公共频道回落附件文件页；有输出包/集合/画像时才进逻辑产物板。
  // 首轮投影拉取期间会短暂显示 loading，需等其消失后再判定表面，并等到附件行出现。
  await page.waitForFunction(
    `!document.querySelector('[data-smoke="files-project-surface-loading"]')
      && Boolean(document.querySelector('[data-smoke="channel-files-view"]'))
      && !Boolean(document.querySelector('[data-smoke="project-files-board"]'))
      && Array.from(document.querySelectorAll('[data-smoke="channel-file-entry"]'))
        .some((entry) => entry.dataset.filename === ${JSON.stringify(filename)})`,
    'channel attachment files surface to list uploaded file',
    timeoutMs,
  );
  const result = await page.evaluateJson(`
    (() => {
      const filename = ${JSON.stringify(filename)};
      const ordinaryEntryVisible = Array.from(document.querySelectorAll('[data-smoke="channel-file-entry"]'))
        .some((entry) => entry.dataset.filename === filename);
      return {
        filename,
        attachmentSurfaceVisible: Boolean(document.querySelector('[data-smoke="channel-files-view"]')),
        logicalBoardVisible: Boolean(document.querySelector('[data-smoke="project-files-board"]')),
        ordinaryEntryVisible,
      };
    })()
  `);
  // 本 smoke 只上传普通附件、不创建项目阶段/输出包，因此必须落在附件浏览面，
  // 且上传文件应出现在 channel-file-entry 中（而不是被逻辑产物板吞掉）。
  if (!result
    || result.filename !== filename
    || result.attachmentSurfaceVisible !== true
    || result.logicalBoardVisible !== false
    || result.ordinaryEntryVisible !== true) {
    throw new Error('Channel attachment files surface contract failed');
  }
  return result;
}

export async function exerciseWebUiChannelFilesBrowserSmoke({ page, suffix, timeoutMs }) {
  const filename = `webui-channel-files-${suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(-24)}.md`;
  const content = '# WebUI channel file smoke\n';
  const body = `channel file upload ${suffix}`;
  await page.setFileInputFiles('[data-smoke="chat-file-input"]', [{
    name: filename,
    type: 'text/markdown',
    content,
  }]);
  await page.setInputValue('[data-smoke="chat-message-input"]', body);
  await page.waitForFunction(
    'document.querySelector(\'[data-smoke="chat-message-send"]\')?.disabled === false',
    'channel file upload to become sendable',
    timeoutMs,
  );
  await page.click('[data-smoke="chat-message-send"]');
  await waitForWebUiChatMessage({ page, body, timeoutMs });
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('a[title="下载文件"]')).some((link) => link.closest('.group')?.textContent.includes(${JSON.stringify(filename)}))`,
    'uploaded channel attachment download action to render in its message',
    timeoutMs,
  );
  const uploaded = await page.evaluateJson(`
    (async () => {
      const filename = ${JSON.stringify(filename)};
      const downloadLink = Array.from(document.querySelectorAll('a[title="下载文件"]'))
        .find((link) => link.closest('.group')?.textContent.includes(filename));
      if (!downloadLink?.href) return null;
      const downloadResponse = await fetch(downloadLink.href);
      return {
        filename,
        status: downloadResponse.status,
        body: await downloadResponse.text(),
        disposition: downloadResponse.headers.get('content-disposition') || '',
      };
    })()
  `);
  if (uploaded?.filename !== filename
    || uploaded.status !== 200
    || uploaded.body !== content
    || !uploaded.disposition.includes(filename)) {
    throw new Error('Uploaded channel attachment download verification failed');
  }
  const board = await exerciseChannelFilesBrowserSmoke({
    page,
    filename,
    timeoutMs,
  });
  return { ...board, uploadReadable: true };
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
    try {
      return await socket.timeout(timeoutMs).emitWithAck(event, payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${event} ack failed: ${detail}`);
    }
  }
  if (typeof socket.emitWithAck === 'function') {
    try {
      return await socket.emitWithAck(event, payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${event} ack failed: ${detail}`);
    }
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
  const requireFromRoot = createRequire(new URL('../package.json', import.meta.url));
  const { io } = requireFromRoot('socket.io-client');
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
  const summary = await runAgentBeanNextReleaseABrowserGate({
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
