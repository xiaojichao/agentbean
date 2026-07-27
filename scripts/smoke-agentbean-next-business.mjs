#!/usr/bin/env node

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB_EVENTS = {
  auth: { register: 'auth:register', login: 'auth:login', deleteAccount: 'auth:delete-account' },
  device: { list: 'device:list', delete: 'device:delete' },
  agent: { subscribe: 'agents:subscribe', create: 'agent:create', delete: 'agent:delete' },
  team: { delete: 'team:delete' },
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
  /** @type {{ userId?: string, teamId?: string, deviceId?: string, agentId?: string, webSocket?: any }} */
  const created = {};
  /** @type {ReturnType<typeof summarizeBusinessSmoke> | undefined} */
  let summary;

  try {
    const webSocket = await connectSocket(ioFactory, new URL('/web', normalizedBaseUrl).toString(), timeoutMs);
    const agentSocket = await connectSocket(ioFactory, new URL('/agent', normalizedBaseUrl).toString(), timeoutMs);
    sockets.push(webSocket, agentSocket);
    created.webSocket = webSocket;
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
      summary = summarizeBusinessSmoke(checks);
    } else {
      const userId = session.user.id;
      const teamId = session.currentTeam.id;
      const channelId = session.defaultChannel.id;
      created.userId = userId;
      created.teamId = teamId;

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
        summary = summarizeBusinessSmoke(checks);
      } else {
        created.deviceId = deviceId;

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
          summary = summarizeBusinessSmoke(checks);
        } else {
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
            summary = summarizeBusinessSmoke(checks);
          } else {
            created.agentId = agentId;

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
              summary = summarizeBusinessSmoke(checks);
            } else {
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
              summary = summarizeBusinessSmoke(checks);
            }
          }
        }
      }
    }
  } catch (error) {
    checks.push(check('business-smoke-runtime-error', false, error instanceof Error ? error.message : String(error)));
    summary = summarizeBusinessSmoke(checks);
  } finally {
    // 无论成功/失败，尽量清掉本轮创建的用户/团队/设备/Agent，避免污染产品库。
    if (created.webSocket && created.userId) {
      const teardown = await teardownSmokeResources(created, timeoutMs);
      const baseChecks = summary?.checks ?? checks;
      summary = summarizeBusinessSmoke([...baseChecks, teardown]);
    } else if (!summary) {
      summary = summarizeBusinessSmoke(checks);
    }
    for (const socket of sockets.reverse()) {
      socket.disconnect?.();
    }
  }

  return summary;
}

/**
 * 删除本轮 smoke 创建的资源：device → agent → team → account。
 * team:delete 会级联清 primary_team 上的 agent；device:delete 也会 soft-delete 设备上 agent。
 * 顺序仍按防御式执行，保证失败路径尽量回收。
 */
export async function teardownSmokeResources(created, timeoutMs = 30_000) {
  const webSocket = created.webSocket;
  const userId = created.userId;
  if (!webSocket || !userId) {
    return check('business-smoke-teardown', false, 'No smoke session available for teardown');
  }

  const steps = [];
  try {
    if (created.deviceId) {
      const deviceAck = await emitAck(
        webSocket,
        WEB_EVENTS.device.delete,
        { userId, deviceId: created.deviceId },
        timeoutMs,
      );
      steps.push(`device:${deviceAck?.ok === true ? 'ok' : formatAck(deviceAck)}`);
    }
    if (created.agentId && created.teamId) {
      const agentAck = await emitAck(
        webSocket,
        WEB_EVENTS.agent.delete,
        { userId, teamId: created.teamId, agentId: created.agentId },
        timeoutMs,
      );
      // device delete 可能已 soft-delete agent；NOT_FOUND 也视为可接受
      const agentOk = agentAck?.ok === true
        || agentAck?.error === 'NOT_FOUND'
        || /not found/i.test(String(agentAck?.message ?? ''));
      steps.push(`agent:${agentOk ? 'ok' : formatAck(agentAck)}`);
      if (!agentOk && agentAck?.ok === false) {
        // non-fatal if already gone
      }
    }
    if (created.teamId) {
      const teamAck = await emitAck(
        webSocket,
        WEB_EVENTS.team.delete,
        { userId, teamId: created.teamId },
        timeoutMs,
      );
      steps.push(`team:${teamAck?.ok === true ? 'ok' : formatAck(teamAck)}`);
      if (teamAck?.ok !== true) {
        return check(
          'business-smoke-teardown',
          false,
          `Failed to delete smoke team during teardown (${steps.join('; ')})`,
        );
      }
    }
    const accountAck = await emitAck(
      webSocket,
      WEB_EVENTS.auth.deleteAccount,
      { userId },
      timeoutMs,
    );
    steps.push(`account:${accountAck?.ok === true ? 'ok' : formatAck(accountAck)}`);
    if (accountAck?.ok !== true) {
      return check(
        'business-smoke-teardown',
        false,
        `Failed to delete smoke account during teardown (${steps.join('; ')})`,
      );
    }
    return check(
      'business-smoke-teardown',
      true,
      `Smoke resources removed after run (${steps.join('; ')})`,
    );
  } catch (error) {
    return check(
      'business-smoke-teardown',
      false,
      `Teardown threw: ${error instanceof Error ? error.message : String(error)} (${steps.join('; ')})`,
    );
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
  const requireFromRoot = createRequire(new URL('../package.json', import.meta.url));
  const { io } = requireFromRoot('socket.io-client');
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
