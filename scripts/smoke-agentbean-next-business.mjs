#!/usr/bin/env node

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB_EVENTS = {
  auth: { register: 'auth:register', login: 'auth:login' },
  device: { list: 'device:list' },
  agent: { subscribe: 'agents:subscribe', create: 'agent:create' },
  channel: { subscribe: 'channels:subscribe', message: 'channel:message' },
  message: { send: 'message:send' },
};

const AGENT_EVENTS = {
  device: { hello: 'device:hello', runtimes: 'device:runtimes' },
  dispatch: { request: 'dispatch:request', result: 'dispatch:result' },
};

export async function runAgentBeanNextBusinessSmoke({
  baseUrl,
  ioFactory = loadSocketIoClient(),
  timeoutMs = 30_000,
  suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return summarizeBusinessSmoke([
      check(
        'business-url-present',
        false,
        'AgentBean Next business smoke needs --url or AGENTBEAN_NEXT_ENTRY_URL',
      ),
    ]);
  }

  const checks = [check('business-url-present', true, 'AgentBean Next business smoke target URL is configured')];
  const sockets = [];
  const pendingAgentResultsByDispatchId = new Map();

  try {
    const webSocket = await connectSocket(ioFactory, new URL('/web', normalizedBaseUrl).toString(), timeoutMs);
    const agentSocket = await connectSocket(ioFactory, new URL('/agent', normalizedBaseUrl).toString(), timeoutMs);
    sockets.push(webSocket, agentSocket);
    checks.push(check('business-sockets-connected', true, 'Web and daemon sockets must connect'));

    const session = await createSmokeSession(webSocket, suffix, timeoutMs);
    checks.push(
      check(
        'business-register-login',
        session.ok,
        session.ok
          ? 'Smoke user must register or login and receive current team plus default channel'
          : session.message,
      ),
    );
    if (!session.ok) {
      return summarizeBusinessSmoke(checks);
    }

    const userId = session.user.id;
    const teamId = session.currentTeam.id;
    const channelId = session.defaultChannel.id;

    await emitAck(webSocket, WEB_EVENTS.channel.subscribe, { userId, teamId }, timeoutMs);
    await emitAck(webSocket, WEB_EVENTS.agent.subscribe, { userId, teamId }, timeoutMs);
    await emitAck(webSocket, WEB_EVENTS.device.list, { userId, teamId }, timeoutMs);

    agentSocket.on(AGENT_EVENTS.dispatch.request, (request) => {
      const resultAck = emitAck(agentSocket, AGENT_EVENTS.dispatch.result, {
        dispatchId: request.id,
        agentId: request.agentId,
        body: `business-smoke:${request.prompt}`,
      }, timeoutMs);
      pendingAgentResultsByDispatchId.set(request.id, resultAck);
    });

    const deviceAck = await emitAck(agentSocket, AGENT_EVENTS.device.hello, {
      teamId,
      ownerId: userId,
      machineId: `agentbean-business-smoke:${suffix}`,
      profileId: 'business-smoke',
      hostname: 'agentbean-business-smoke',
    }, timeoutMs);
    const deviceId = readNestedString(deviceAck, ['device', 'id']);
    checks.push(
      check(
        'business-daemon-hello',
        Boolean(deviceId),
        deviceId
          ? 'Daemon socket must announce an online device in the smoke team'
          : `Daemon hello did not return a device id: ${formatAck(deviceAck)}`,
      ),
    );
    if (!deviceId) {
      return summarizeBusinessSmoke(checks);
    }

    const runtimesAck = await emitAck(agentSocket, AGENT_EVENTS.device.runtimes, {
      teamId,
      deviceId,
      runtimes: [{
        adapterKind: 'codex',
        name: 'Codex CLI',
        command: 'agentbean-business-smoke',
        installed: true,
      }],
    }, timeoutMs);
    const runtimeId = Array.isArray(runtimesAck?.runtimes) ? runtimesAck.runtimes[0]?.id : undefined;
    checks.push(
      check(
        'business-runtime-report',
        typeof runtimeId === 'string',
        typeof runtimeId === 'string'
          ? 'Daemon socket must report a runtime that can host a custom agent'
          : `Runtime report did not return a runtime id: ${formatAck(runtimesAck)}`,
      ),
    );
    if (typeof runtimeId !== 'string') {
      return summarizeBusinessSmoke(checks);
    }

    const agentName = `SmokeCodex${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
    const agentAck = await emitAck(webSocket, WEB_EVENTS.agent.create, {
      userId,
      teamId,
      deviceId,
      runtimeId,
      name: agentName,
      env: { AGENTBEAN_BUSINESS_SMOKE: '1' },
    }, timeoutMs);
    const agentId = readNestedString(agentAck, ['agent', 'id']);
    checks.push(
      check(
        'business-custom-agent-create',
        Boolean(agentId),
        agentId
          ? 'Web socket must create a custom agent on the daemon runtime'
          : `Custom agent create did not return an agent id: ${formatAck(agentAck)}`,
      ),
    );
    if (!agentId) {
      return summarizeBusinessSmoke(checks);
    }

    const expectedReply = `business-smoke:@${agentName} hello`;
    const replyPromise = waitForChannelMessage(webSocket, {
      channelId,
      body: expectedReply,
      timeoutMs,
    });
    const sendAck = await emitAck(webSocket, WEB_EVENTS.message.send, {
      userId,
      teamId,
      channelId,
      body: `@${agentName} hello`,
    }, timeoutMs);
    const dispatchId = Array.isArray(sendAck?.dispatches) ? sendAck.dispatches[0]?.id : undefined;
    checks.push(
      check(
        'business-message-dispatch',
        typeof dispatchId === 'string',
        typeof dispatchId === 'string'
          ? 'Message send must create a dispatch for the custom agent'
          : `Message send did not return a dispatch id: ${formatAck(sendAck)}`,
      ),
    );
    if (typeof dispatchId !== 'string') {
      return summarizeBusinessSmoke(checks);
    }

    await waitForDispatchResultAck(pendingAgentResultsByDispatchId, dispatchId, timeoutMs);
    const reply = await replyPromise;
    checks.push(
      check(
        'business-agent-reply-visible',
        reply.ok,
        reply.ok
          ? 'Agent reply must be visible on the subscribed web channel'
          : reply.message,
      ),
    );

    return summarizeBusinessSmoke(checks);
  } catch (error) {
    checks.push(check('business-smoke-runtime-error', false, error instanceof Error ? error.message : String(error)));
    return summarizeBusinessSmoke(checks);
  } finally {
    for (const socket of sockets.reverse()) {
      socket.disconnect?.();
    }
  }
}

export function summarizeBusinessSmoke(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

function loadSocketIoClient() {
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { io } = requireFromServer('socket.io-client');
  return io;
}

function normalizeBaseUrl(input) {
  if (!input) {
    return undefined;
  }
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function createSmokeSession(webSocket, suffix, timeoutMs) {
  const username = `smoke-${suffix}`;
  const password = `secret-${suffix}`;
  const teamName = `AgentBean Smoke ${suffix}`;
  const registerAck = await emitAck(webSocket, WEB_EVENTS.auth.register, { username, password, teamName }, timeoutMs);
  const ack = registerAck?.ok
    ? registerAck
    : registerAck?.error === 'CONFLICT'
      ? await emitAck(webSocket, WEB_EVENTS.auth.login, { username, password }, timeoutMs)
      : registerAck;

  if (
    ack?.ok === true &&
    typeof ack.user?.id === 'string' &&
    typeof ack.currentTeam?.id === 'string' &&
    typeof ack.defaultChannel?.id === 'string'
  ) {
    return {
      ok: true,
      user: ack.user,
      currentTeam: ack.currentTeam,
      defaultChannel: ack.defaultChannel,
    };
  }
  return {
    ok: false,
    message: `Smoke session did not return user, current team, and default channel: ${formatAck(ack)}`,
  };
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

async function waitForChannelMessage(socket, { channelId, body, timeoutMs }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, message: `Timed out waiting for agent reply ${body}` });
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off?.(WEB_EVENTS.channel.message, onMessage);
    };
    const onMessage = (message) => {
      if (message?.channelId === channelId && message?.body === body) {
        cleanup();
        resolve({ ok: true, message });
      }
    };
    socket.on(WEB_EVENTS.channel.message, onMessage);
  });
}

async function waitForDispatchResultAck(pendingAgentResultsByDispatchId, dispatchId, timeoutMs) {
  const startedAt = Date.now();
  while (!pendingAgentResultsByDispatchId.has(dispatchId)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for dispatch result ack ${dispatchId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await pendingAgentResultsByDispatchId.get(dispatchId);
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

function parseArgs(argv) {
  const urlIndex = argv.indexOf('--url');
  const timeoutIndex = argv.indexOf('--timeout-ms');
  return {
    json: argv.includes('--json'),
    url: urlIndex >= 0 ? argv[urlIndex + 1] : undefined,
    timeoutMs: timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : undefined,
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next business smoke passed (${summary.total}/${summary.total}).`
      : `AgentBean Next business smoke failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args.url ?? process.env.AGENTBEAN_NEXT_ENTRY_URL;
  const summary = await runAgentBeanNextBusinessSmoke({
    baseUrl,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined,
  });
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
