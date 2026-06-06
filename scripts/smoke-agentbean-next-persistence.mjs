#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WEB_EVENTS = {
  auth: { register: 'auth:register', whoami: 'auth:whoami' },
  channel: { join: 'channel:join' },
  message: { send: 'message:send' },
};

export async function runAgentBeanNextPersistenceSmoke({
  dataDir,
  keepData = false,
  ioFactory = loadSocketIoClient(),
  serverFactory,
  timeoutMs = 10_000,
  suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  const checks = [];
  const sockets = [];
  let firstServer;
  let secondServer;
  let shouldRemoveDataDir = false;
  let smokeDataDir = dataDir;

  try {
    if (!smokeDataDir) {
      smokeDataDir = await mkdtemp(join(tmpdir(), 'agentbean-next-persistence-'));
      shouldRemoveDataDir = !keepData;
    }
    checks.push(check('persistence-data-dir-ready', true, `SQLite data dir is ready: ${smokeDataDir}`));

    const startServer = serverFactory ?? await loadServerNextDevServerFactory();
    firstServer = await startSqliteServer(startServer, smokeDataDir);
    const firstWeb = await connectSocket(ioFactory, new URL('/web', firstServer.baseUrl).toString(), timeoutMs);
    sockets.push(firstWeb);

    const username = `persistence-${suffix}`;
    const body = `SQLite restart persistence smoke ${suffix}`;
    const registerAck = await emitAck(firstWeb, WEB_EVENTS.auth.register, {
      username,
      password: `secret-${suffix}`,
      teamName: `AgentBean Persistence ${suffix}`,
    }, timeoutMs);
    const session = readSession(registerAck);
    checks.push(
      check(
        'persistence-first-session-created',
        Boolean(session),
        session
          ? 'First server start must create user, team, default channel, and token'
          : `Register did not return a complete session: ${formatAck(registerAck)}`,
      ),
    );
    if (!session) {
      return summarizePersistenceSmoke(checks);
    }

    const sendAck = await emitAck(firstWeb, WEB_EVENTS.message.send, {
      userId: session.user.id,
      teamId: session.currentTeam.id,
      channelId: session.defaultChannel.id,
      body,
    }, timeoutMs);
    const sentBody = readNestedString(sendAck, ['message', 'body']);
    checks.push(
      check(
        'persistence-message-sent',
        sentBody === body,
        sentBody === body
          ? 'First server start must persist a channel message'
          : `Message send did not return the expected body: ${formatAck(sendAck)}`,
      ),
    );
    if (sentBody !== body) {
      return summarizePersistenceSmoke(checks);
    }

    firstWeb.disconnect?.();
    await firstServer.close();
    firstServer = undefined;
    checks.push(check('persistence-server-restarted', true, 'First server closed before second server start'));

    secondServer = await startSqliteServer(startServer, smokeDataDir);
    const secondWeb = await connectSocket(ioFactory, new URL('/web', secondServer.baseUrl).toString(), timeoutMs);
    sockets.push(secondWeb);

    const whoamiAck = await emitAck(secondWeb, WEB_EVENTS.auth.whoami, { token: session.token }, timeoutMs);
    const restoredUserId = readNestedString(whoamiAck, ['user', 'id']);
    const restoredTeamId = readNestedString(whoamiAck, ['currentTeam', 'id']);
    checks.push(
      check(
        'persistence-session-restored',
        restoredUserId === session.user.id && restoredTeamId === session.currentTeam.id,
        restoredUserId === session.user.id && restoredTeamId === session.currentTeam.id
          ? 'Second server start must restore token session and current team'
          : `Whoami did not restore the original session: ${formatAck(whoamiAck)}`,
      ),
    );

    const joinAck = await emitAck(secondWeb, WEB_EVENTS.channel.join, {
      userId: session.user.id,
      teamId: session.currentTeam.id,
      channelId: session.defaultChannel.id,
      limit: 50,
    }, timeoutMs);
    const restoredChannelId = readNestedString(joinAck, ['channel', 'id']);
    const restoredMessage = Array.isArray(joinAck?.messages)
      ? joinAck.messages.find((message) => message?.body === body)
      : undefined;
    checks.push(
      check(
        'persistence-channel-history-restored',
        restoredChannelId === session.defaultChannel.id && Boolean(restoredMessage),
        restoredChannelId === session.defaultChannel.id && Boolean(restoredMessage)
          ? 'Second server start must restore channel metadata and message history'
          : `Channel join did not restore the original channel history: ${formatAck(joinAck)}`,
      ),
    );

    return summarizePersistenceSmoke(checks);
  } catch (error) {
    checks.push(check('persistence-smoke-runtime-error', false, error instanceof Error ? error.message : String(error)));
    return summarizePersistenceSmoke(checks);
  } finally {
    for (const socket of sockets.reverse()) {
      socket.disconnect?.();
    }
    if (secondServer) {
      await secondServer.close();
    }
    if (firstServer) {
      await firstServer.close();
    }
    if (shouldRemoveDataDir && smokeDataDir) {
      await rm(smokeDataDir, { recursive: true, force: true });
    }
  }
}

export function summarizePersistenceSmoke(checks) {
  const failed = checks.filter((candidate) => !candidate.ok);
  return {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    checks,
  };
}

async function loadServerNextDevServerFactory() {
  try {
    const module = await import('../apps/server-next/dist/apps/server-next/src/dev-server.js');
    return module.startServerNextDevServer;
  } catch (error) {
    throw new Error(
      `server-next build output is unavailable; run npm run build:server-next before this smoke (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function startSqliteServer(startServer, dataDir) {
  return startServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      storage: 'sqlite',
      dataDir,
      sessionSecret: 'agentbean-next-persistence-smoke-secret',
    },
  });
}

function loadSocketIoClient() {
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { io } = requireFromServer('socket.io-client');
  return io;
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

function readSession(ack) {
  if (
    ack?.ok === true &&
    typeof ack.token === 'string' &&
    typeof ack.user?.id === 'string' &&
    typeof ack.currentTeam?.id === 'string' &&
    typeof ack.defaultChannel?.id === 'string'
  ) {
    return {
      token: ack.token,
      user: ack.user,
      currentTeam: ack.currentTeam,
      defaultChannel: ack.defaultChannel,
    };
  }
  return undefined;
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
  const dataDirIndex = argv.indexOf('--data-dir');
  const timeoutIndex = argv.indexOf('--timeout-ms');
  return {
    dataDir: dataDirIndex >= 0 ? argv[dataDirIndex + 1] : undefined,
    keepData: argv.includes('--keep-data'),
    json: argv.includes('--json'),
    timeoutMs: timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : undefined,
  };
}

function formatText(summary) {
  const lines = [
    summary.ok
      ? `AgentBean Next persistence smoke passed (${summary.total}/${summary.total}).`
      : `AgentBean Next persistence smoke failed (${summary.failed}/${summary.total}).`,
  ];
  for (const checkResult of summary.checks) {
    lines.push(`${checkResult.ok ? 'PASS' : 'FAIL'} ${checkResult.id}: ${checkResult.message}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runAgentBeanNextPersistenceSmoke({
    dataDir: args.dataDir,
    keepData: args.keepData,
    timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined,
  });
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatText(summary));
  process.exitCode = summary.ok ? 0 : 1;
}
