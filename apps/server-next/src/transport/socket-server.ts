import type { ServerNextUseCases } from '../application/usecases.js';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import { normalizeAdapterKind } from '../../../../packages/domain/src/index.js';
import {
  registerAgentSocketHandlers,
  registerWebSocketHandlers,
  UnauthenticatedSocketError,
  type AuthenticatedUserIdentity,
  type AuthenticatedUserProvider,
  type SocketLike,
} from './socket-handlers.js';

export interface NamespaceLike {
  on(event: 'connection', handler: (socket: SocketLike) => void): void;
  emit?(event: string, payload: unknown): void;
}

export interface SocketServerLike {
  of(namespace: '/web' | '/agent'): NamespaceLike;
}

export interface ServerNextRealtime {
  emitDispatchStatus(dispatch: unknown): void;
  refreshAgents(teamId: string): Promise<void>;
}

interface ChannelSubscription {
  userId: string;
  teamId: string;
  /** web 连接上报的本机设备 id（透传给 listDevices 等用于 isLocal 判定）。 */
  currentDeviceId?: string | null;
}

type AgentSubscription = ChannelSubscription;
const INTERNAL_SOCKET_ERROR_MESSAGE = 'Internal server error';
const DEVICE_SELECT_DIRECTORY_TIMEOUT_MS = 125_000;

interface WebSocketSubscription {
  socket: SocketLike;
  userId?: string;
  channels?: ChannelSubscription;
  agents?: AgentSubscription;
  devices?: ChannelSubscription;
}

interface DiscoveredAgentReport {
  name: string;
  adapterKind: string;
  category: string;
  command?: string;
  args?: string[];
  cwd?: string;
  discoverySource?: 'runtime' | 'gateway' | 'filesystem';
  gatewayInstanceKey?: string;
}

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): ServerNextRealtime {
  const agentNamespace = server.of('/agent');
  const webSubscribers = new Set<WebSocketSubscription>();
  const agentSocketsByDeviceId = new Map<string, SocketLike>();
  const waitingDeviceInviteSocketsByCode = new Map<string, SocketLike>();
  const waitingDeviceInviteCodeBySocket = new Map<SocketLike, string>();

  // 将 completeDeviceInvite 的结果（credentials）投递给正在等待该 invite code 的 daemon socket。
  // web 手动 complete 与 agent 端 wait 后自动 complete 共用此路径。
  function deliverDeviceInviteCredentials(completeResult: unknown): void {
    const credentials = resultDeviceInviteCredentials(completeResult);
    const inviteCode = resultDeviceInviteCode(completeResult);
    if (!credentials || !inviteCode) {
      return;
    }
    waitingDeviceInviteSocketsByCode.get(inviteCode)?.emit?.(AGENT_EVENTS.deviceInvite.credentials, credentials);
    waitingDeviceInviteSocketsByCode.delete(inviteCode);
    for (const [waitingSocket, code] of waitingDeviceInviteCodeBySocket) {
      if (code === inviteCode) {
        waitingDeviceInviteCodeBySocket.delete(waitingSocket);
      }
    }
  }

  server.of('/web').on('connection', (socket) => {
    const authenticatedUser = createAuthenticatedUserResolver(socket, app);
    const subscriber: WebSocketSubscription = { socket };
    webSubscribers.add(subscriber);
    socket.on('disconnect', async () => {
      webSubscribers.delete(subscriber);
    });
    socket.on(WEB_EVENTS.channel.subscribe, async (payload, ack) => {
      try {
        const input = await readSubscriptionInput(payload, authenticatedUser);
        if (!input) {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid channel subscription payload' });
          return;
        }
        const result = await app.listChannels(input);
        ack?.(result);
        if (result.ok) {
          subscriber.channels = input;
          socket.emit?.(WEB_EVENTS.channel.snapshot, result.channels);
          await emitDmSnapshotForSubscriber(subscriber, app);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error, WEB_EVENTS.channel.subscribe));
      }
    });
    socket.on(WEB_EVENTS.agent.subscribe, async (payload, ack) => {
      try {
        const input = await readSubscriptionInput(payload, authenticatedUser);
        if (!input) {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid agent subscription payload' });
          return;
        }
        const teamAccess = await app.listChannels(input);
        if (!teamAccess.ok) {
          ack?.(teamAccess);
          return;
        }
        const result = await app.listVisibleAgents({ teamId: input.teamId });
        ack?.(result);
        if (result.ok) {
          subscriber.agents = input;
          socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error, WEB_EVENTS.agent.subscribe));
      }
    });
    socket.on(WEB_EVENTS.device.list, async (payload, ack) => {
      try {
        const input = await readSubscriptionInput(payload, authenticatedUser);
        if (!input) {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid device list payload' });
          return;
        }
        const result = await app.listDevices(input);
        ack?.(result);
        if (result.ok) {
          subscriber.devices = input;
          socket.emit?.(WEB_EVENTS.device.snapshot, result.devices);
          await emitStoredDeviceRuntimes(socket, app, input, result.devices);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error, WEB_EVENTS.device.list));
      }
    });
    registerWebSocketHandlers(socket, app, {
      authenticatedUser,
      dispatch(request) {
        if (request.deviceId) {
          agentSocketsByDeviceId.get(request.deviceId)?.emit?.(AGENT_EVENTS.dispatch.request, request);
          return;
        }
        agentNamespace.emit?.(AGENT_EVENTS.dispatch.request, request);
      },
      dispatchCancel(request) {
        if (request.deviceId) {
          agentSocketsByDeviceId.get(request.deviceId)?.emit?.(AGENT_EVENTS.dispatch.cancel, {
            dispatchId: request.id,
            agentId: request.agentId,
          });
          return;
        }
        agentNamespace.emit?.(AGENT_EVENTS.dispatch.cancel, {
          dispatchId: request.id,
          agentId: request.agentId,
        });
      },
      dispatchStatus(dispatch) {
        emitDispatchStatus(webSubscribers, dispatch);
      },
      deviceScan(request) {
        agentSocketsByDeviceId.get(request.deviceId)?.emit?.(AGENT_EVENTS.device.scanRequested, request);
      },
      async deviceSelectDirectory(request) {
        const socket = agentSocketsByDeviceId.get(request.deviceId);
        if (!socket?.emitWithAck) {
          return { ok: false, error: 'DEVICE_OFFLINE' };
        }
        try {
          const ackSocket = socket.timeout?.(DEVICE_SELECT_DIRECTORY_TIMEOUT_MS) ?? socket;
          if (!ackSocket.emitWithAck) {
            return { ok: false, error: 'DEVICE_OFFLINE' };
          }
          const result = await ackSocket.emitWithAck(AGENT_EVENTS.device.selectDirectoryRequested, request);
          return result as { ok: boolean; path?: string; error?: string };
        } catch {
          return { ok: false, error: 'DIRECTORY_PICKER_TIMEOUT' };
        }
      },
      async afterMessageSend(_payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = resultMessageTeamId(result);
        if (!teamId) {
          return;
        }
        await emitChannelMessageSubscribers(webSubscribers, app, teamId, result);
      },
      async afterMessagePin(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = payloadTeamId(payload);
        const channelId = resultPinnedChannelId(result);
        const messageId = resultPinnedMessageId(result);
        const pinned = payloadBoolean(payload, 'on');
        if (!teamId || !channelId || !messageId || pinned === null) {
          return;
        }
        await emitPinnedMessageUpdatedSubscribers(webSubscribers, app, {
          teamId,
          channelId,
          messageId,
          pinned,
        });
      },
      afterDeviceInviteComplete(_payload, result) {
        deliverDeviceInviteCredentials(result);
      },
      async afterDeviceDelete(_payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        // deleteDevice 一次删除整个别名组（resolveDeviceAliasGroup），需对组内每个在线 daemon
        // 都下发 device:removed 并断开，否则未被点中的 alias daemon 会持续运行并在重连时复活。
        const deviceIds = resultDeletedDeviceIds(result);
        for (const deviceId of deviceIds) {
          const agentSocket = agentSocketsByDeviceId.get(deviceId);
          if (!agentSocket) {
            continue;
          }
          // 先下发 device:removed（daemon 收到后关闭重连并退出进程），再从路由表移除并断开 socket。
          // 不能只断开 socket：daemon 的 reconnection 会立刻重连，并通过 device.hello 的 upsertHello
          // 用全新 id 把已删设备复活。device:removed 是让 daemon 真正退出的唯一可靠信号。
          agentSocket.emit?.(AGENT_EVENTS.device.removed, { deviceId });
          agentSocketsByDeviceId.delete(deviceId);
          agentSocket.disconnect?.();
        }
      },
      async afterChannelMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = payloadTeamId(payload);
        if (!teamId) {
          return;
        }
        await refreshChannelSubscribers(webSubscribers, app, teamId);
      },
      async afterAgentMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const agentTeamIds = uniqueStrings([
          payloadTeamId(payload),
          payloadTargetTeamId(payload),
          ...payloadTeamIds(payload, 'affectedTeamIds'),
          ...resultAgentVisibleTeamIds(result),
          resultDispatchTeamId(result),
        ]);
        for (const teamId of agentTeamIds) {
          await refreshAgentSubscribers(webSubscribers, app, teamId);
        }
        for (const teamId of payloadTeamIds(payload, 'channelTeamIds')) {
          await refreshChannelSubscribers(webSubscribers, app, teamId);
        }
      },
      async afterTeamMutation(_payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        await refreshTeamSubscribers(webSubscribers, app);
      },
      async afterTaskMutation(_payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const task = (result as { task?: unknown }).task;
        if (task) {
          emitTaskUpdated(webSubscribers, task);
          await refreshTaskSubscribers(webSubscribers, app, task);
        }
      },
    });
    socket.on(WEB_EVENTS.dm.start, async (payload, ack) => {
      try {
        const userId = await resolveAuthenticatedUserId(authenticatedUser);
        if (!userId) {
          ack?.({ ok: false, error: 'UNAUTHENTICATED', message: 'Invalid session token' });
          return;
        }
        const agentId = (payload as { agentId?: unknown }).agentId;
        if (typeof agentId !== 'string') {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'agentId is required' });
          return;
        }
        const teamId = subscriber.channels?.teamId;
        if (!teamId) {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'No active channel subscription' });
          return;
        }
        const result = await app.startDirectMessage({ userId, teamId, agentId });
        if (result.ok && result.dm) {
          ack?.({ ok: true, dm: toFlatDm(result.dm) });
          await refreshDmSubscribers(webSubscribers, app, teamId);
        } else {
          ack?.(result);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error));
      }
    });
    socket.on(WEB_EVENTS.dm.list, async (_payload, ack) => {
      try {
        const userId = await resolveAuthenticatedUserId(authenticatedUser);
        if (!userId) {
          ack?.({ ok: false, error: 'UNAUTHENTICATED', message: 'Invalid session token' });
          return;
        }
        const teamId = subscriber.channels?.teamId;
        if (!teamId) {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'No active channel subscription' });
          return;
        }
        const result = await app.listDirectMessages({ userId, teamId });
        if (result.ok) {
          ack?.({ ok: true, dms: toFlatDmList(result.dms) });
        } else {
          ack?.(result);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error));
      }
    });
    socket.on(WEB_EVENTS.dm.snapshot, async (payload, ack) => {
      try {
        const userId = await resolveAuthenticatedUserId(authenticatedUser);
        if (!userId) {
          ack?.({ ok: false, error: 'UNAUTHENTICATED', message: 'Invalid session token' });
          return;
        }
        const channelId = (payload as { channelId?: unknown }).channelId;
        const teamId = subscriber.channels?.teamId;
        if (!teamId || typeof channelId !== 'string') {
          ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'channelId and active subscription required' });
          return;
        }
        const result = await app.snapshotDirectMessage({ userId, teamId, channelId });
        if (result.ok && result.dm) {
          ack?.({ ok: true, dm: toFlatDm(result.dm), messages: result.messages });
        } else {
          ack?.(result);
        }
      } catch (error) {
        ack?.(subscriptionErrorAck(error));
      }
    });
  });
  agentNamespace.on('connection', (socket) => {
    let connectedDeviceId: string | undefined;
    let connectedDeviceTeamId: string | undefined;
    socket.on('disconnect', async () => {
      const ownsConnectedDevice = Boolean(
        connectedDeviceId && agentSocketsByDeviceId.get(connectedDeviceId) === socket,
      );
      if (connectedDeviceId && ownsConnectedDevice) {
        agentSocketsByDeviceId.delete(connectedDeviceId);
      }
      const waitingInviteCode = waitingDeviceInviteCodeBySocket.get(socket);
      if (waitingInviteCode) {
        waitingDeviceInviteSocketsByCode.delete(waitingInviteCode);
        waitingDeviceInviteCodeBySocket.delete(socket);
      }
      if (connectedDeviceId && ownsConnectedDevice) {
        const deviceId = connectedDeviceId;
        const teamId = connectedDeviceTeamId;
        try {
          const result = await app.markDeviceOffline({ deviceId, timestamp: Date.now() });
          if (result.ok && teamId) {
            await refreshDeviceSubscribers(webSubscribers, app, teamId);
            for (const affectedTeamId of result.affectedTeamIds) {
              await refreshAgentSubscribers(webSubscribers, app, affectedTeamId);
            }
          }
        } catch (error) {
          console.warn('[socket] markDeviceOffline failed (non-blocking):', error);
        }
      }
    });
    registerAgentSocketHandlers(socket, app, {
      async afterDeviceInviteWait(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const code = payloadDeviceInviteCode(payload) ?? resultDeviceInviteCode(result);
        if (!code) {
          return;
        }
        const previousCode = waitingDeviceInviteCodeBySocket.get(socket);
        if (previousCode) {
          waitingDeviceInviteSocketsByCode.delete(previousCode);
        }
        waitingDeviceInviteSocketsByCode.set(code, socket);
        waitingDeviceInviteCodeBySocket.set(socket, code);
        // 自动完成邀请：invite code 是 owner 主动创建的授权凭证，daemon wait 时即用
        // invite.createdBy（owner）自动 approve，无需 web 端手动 emit device-invite:complete。
        const createdBy = resultDeviceInviteCreatedBy(result);
        if (!createdBy) {
          return;
        }
        const completeResult = await app.completeDeviceInvite({ code, userId: createdBy });
        if (!isSuccessAck(completeResult)) {
          return;
        }
        deliverDeviceInviteCredentials(completeResult);
      },
      async afterDeviceMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const deviceId = resultDeviceId(result);
        if (deviceId) {
          if (
            connectedDeviceId &&
            connectedDeviceId !== deviceId &&
            agentSocketsByDeviceId.get(connectedDeviceId) === socket
          ) {
            agentSocketsByDeviceId.delete(connectedDeviceId);
          }
          connectedDeviceId = deviceId;
          agentSocketsByDeviceId.set(deviceId, socket);
        }
        const teamId = payloadTeamId(payload) ?? resultDeviceTeamId(result);
        if (!teamId) {
          return;
        }
        connectedDeviceTeamId = teamId;
        await refreshDeviceSubscribers(webSubscribers, app, teamId);
        for (const affectedTeamId of payloadTeamIds(result, 'affectedTeamIds')) {
          await refreshAgentSubscribers(webSubscribers, app, affectedTeamId);
        }
        for (const channelTeamId of payloadTeamIds(result, 'channelTeamIds')) {
          await refreshChannelSubscribers(webSubscribers, app, channelTeamId);
        }
        emitDeviceRuntimes(webSubscribers, teamId, result);
      },
      async afterAgentMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = payloadTeamId(payload) ?? resultDispatchTeamId(result);
        if (!teamId) {
          return;
        }
        emitDispatchStatus(webSubscribers, resultDispatch(result));
        await emitChannelMessageSubscribers(webSubscribers, app, teamId, result);
        const task = (result as { task?: unknown }).task;
        if (task) {
          emitTaskUpdated(webSubscribers, task);
          await refreshTaskSubscribers(webSubscribers, app, task);
        }
        const refreshTeamIds = uniqueStrings([teamId, payloadTargetTeamId(payload), ...resultAgentVisibleTeamIds(result)]);
        for (const refreshTeamId of refreshTeamIds) {
          await refreshAgentSubscribers(webSubscribers, app, refreshTeamId);
        }
        await emitDiscoveredAgents(webSubscribers, app, payload);
      },
      // hello 首推 scanRequested：复用 web 端的下发通道（按 deviceId emit 给对应 device socket）
      deviceScan(request) {
        agentSocketsByDeviceId.get(request.deviceId)?.emit?.(AGENT_EVENTS.device.scanRequested, request);
      },
    });
  });
  return {
    emitDispatchStatus(dispatch) {
      emitDispatchStatus(webSubscribers, dispatch);
    },
    async refreshAgents(teamId) {
      await refreshAgentSubscribers(webSubscribers, app, teamId);
    },
  };
}

async function refreshChannelSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) {
      continue;
    }
    const result = await app.listChannels(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.snapshot, result.channels);
    }
    await emitDmSnapshotForSubscriber(subscriber, app);
  }
}

async function refreshAgentSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.agents?.teamId !== teamId) {
      continue;
    }
    const teamAccess = await app.listChannels(subscriber.agents);
    if (!teamAccess.ok) {
      subscriber.agents = undefined;
      continue;
    }
    const result = await app.listVisibleAgents({ teamId: subscriber.agents.teamId });
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
      for (const agent of result.agents) {
        subscriber.socket.emit?.(WEB_EVENTS.agent.status, agent);
      }
    }
  }
}

async function refreshTeamSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
): Promise<void> {
  for (const subscriber of subscribers) {
    try {
      const userId = await resolveSubscriberUserId(subscriber, app);
      if (!userId) {
        continue;
      }
      const result = await app.listTeams({ userId });
      if (result.ok) {
        subscriber.socket.emit?.(WEB_EVENTS.team.snapshot, result.teams);
      }
    } catch (error) {
      console.warn('[socket] team snapshot push failed (non-blocking):', error);
    }
  }
}

async function resolveSubscriberUserId(
  subscriber: WebSocketSubscription,
  app: ServerNextUseCases,
): Promise<string | null> {
  if (subscriber.userId) {
    return subscriber.userId;
  }
  const authToken = socketAuthToken(subscriber.socket);
  if (!authToken.token) {
    return null;
  }
  const result = await app.whoami({ token: authToken.token });
  if (!result.ok) {
    return null;
  }
  subscriber.userId = result.user.id;
  return subscriber.userId;
}

function emitTaskUpdated(subscribers: Set<WebSocketSubscription>, task: unknown): void {
  const teamId = taskTeamId(task);
  if (!teamId) {
    return;
  }
  for (const subscriber of subscribers) {
    if (!subscriberBelongsToTeam(subscriber, teamId)) {
      continue;
    }
    subscriber.socket.emit?.(WEB_EVENTS.task.updated, task);
  }
}

async function refreshTaskSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  task: unknown,
): Promise<void> {
  const teamId = taskTeamId(task);
  if (!teamId) {
    return;
  }
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) {
      continue;
    }
    const result = await app.listTasks(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.task.snapshot, result.tasks);
    }
  }
}

async function emitChannelMessageSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
  result: unknown,
): Promise<void> {
  const message = resultMessage(result);
  if (!message) {
    return;
  }
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) {
      continue;
    }
    const channels = await app.listChannels(subscriber.channels);
    if (channels.ok && channels.channels.some((channel) => channel.id === message.channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.message, message);
      continue;
    }
    // Not found in regular channels — check DM membership
    const dms = await app.listDirectMessages(subscriber.channels);
    if (dms.ok && dms.dms.some((dm) => dm.channel.id === message.channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.message, message);
    }
  }
}

async function emitPinnedMessageUpdatedSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  update: { teamId: string; channelId: string; messageId: string; pinned: boolean },
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== update.teamId) {
      continue;
    }
    const channels = await app.listChannels(subscriber.channels);
    if (channels.ok && channels.channels.some((channel) => channel.id === update.channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.message.pinnedUpdated, update);
      continue;
    }
    const dms = await app.listDirectMessages(subscriber.channels);
    if (dms.ok && dms.dms.some((dm) => dm.channel.id === update.channelId)) {
      subscriber.socket.emit?.(WEB_EVENTS.message.pinnedUpdated, update);
    }
  }
}

async function asChannelSubscription(
  payload: unknown,
  authenticatedUser?: () => Promise<AuthenticatedUserIdentity>,
): Promise<ChannelSubscription | null> {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown };
  const auth = await authenticatedUser?.();
  if (auth?.hasToken && !auth.userId) {
    throw new UnauthenticatedSocketError();
  }
  // teamId 缺省时回退到 session 当前团队（与 withAuthenticatedUserId 的 currentTeamFromSession 一致），
  // 这样 web 端 device.list({}) 也能解析出订阅（用于 isLocal 透传等）。
  const teamId = typeof candidate.teamId === 'string'
    ? candidate.teamId
    : auth?.currentTeamId ?? null;
  if (!teamId) {
    return null;
  }
  const userId = auth?.userId ?? (typeof candidate.userId === 'string' ? candidate.userId : null);
  if (!userId) {
    return null;
  }
  return { userId, teamId, currentDeviceId: auth?.currentDeviceId ?? null };
}

async function readSubscriptionInput(
  payload: unknown,
  authenticatedUser: () => Promise<AuthenticatedUserIdentity>,
): Promise<ChannelSubscription | null> {
  return asChannelSubscription(payload, authenticatedUser);
}

function subscriptionErrorAck(error: unknown, event?: string): { ok: false; error: string; message: string } {
  if (error instanceof UnauthenticatedSocketError) {
    return { ok: false, error: 'UNAUTHENTICATED', message: 'Invalid session token' };
  }
  console.error(
    `[server-next] subscription handler${event ? ` "${event}"` : ''} threw:`,
    error instanceof Error ? error.stack ?? error.message : error,
  );
  return {
    ok: false,
    error: 'INTERNAL_ERROR',
    message: INTERNAL_SOCKET_ERROR_MESSAGE,
  };
}

function createAuthenticatedUserResolver(
  socket: SocketLike,
  app: ServerNextUseCases,
): AuthenticatedUserProvider {
  let cached: AuthenticatedUserIdentity | undefined;
  const resolve = (async () => {
    if (cached) {
      return cached;
    }
    const currentDeviceId = socketCurrentDeviceId(socket);
    const authToken = socketAuthToken(socket);
    if (!authToken.hasToken) {
      cached = { hasToken: false, userId: null, currentTeamId: null, currentDeviceId };
      return cached;
    }
    if (!authToken.token) {
      cached = { hasToken: true, userId: null, currentTeamId: null, currentDeviceId };
      return cached;
    }
    const result = await app.whoami({ token: authToken.token });
    cached = {
      hasToken: true,
      userId: result.ok ? result.user.id : null,
      currentTeamId: result.ok ? (result.currentTeam?.id ?? null) : null,
      currentDeviceId,
    };
    return cached;
  }) as AuthenticatedUserProvider;
  resolve.setCurrentTeamId = (teamId) => {
    if (!cached || !cached.hasToken || !cached.userId) {
      return;
    }
    cached = { ...cached, currentTeamId: teamId };
  };
  return resolve;
}

function socketAuthToken(socket: SocketLike): { hasToken: boolean; token: string | null } {
  const auth = (socket as { handshake?: { auth?: Record<string, unknown> } }).handshake?.auth;
  if (!auth || !Object.prototype.hasOwnProperty.call(auth, 'token')) {
    return { hasToken: false, token: null };
  }
  return {
    hasToken: true,
    token: typeof auth.token === 'string' && auth.token.length > 0 ? auth.token : null,
  };
}

// web 端 socket.ts 在 auth 里上报本机设备 id（getStoredDeviceId）；这是 isLocal 判定的相对锚点。
function socketCurrentDeviceId(socket: SocketLike): string | null {
  const auth = (socket as { handshake?: { auth?: Record<string, unknown> } }).handshake?.auth;
  const value = auth?.currentDeviceId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function refreshDeviceSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.devices?.teamId !== teamId) {
      continue;
    }
    const result = await app.listDevices(subscriber.devices);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.device.snapshot, result.devices);
      for (const device of result.devices) {
        subscriber.socket.emit?.(WEB_EVENTS.device.status, device);
      }
    }
  }
}

function emitDeviceRuntimes(subscribers: Set<WebSocketSubscription>, teamId: string, result: unknown): void {
  const runtimesPayload = resultRuntimesPayload(result);
  if (!runtimesPayload) {
    return;
  }
  for (const subscriber of subscribers) {
    if (subscriber.devices?.teamId === teamId) {
      subscriber.socket.emit?.(WEB_EVENTS.device.runtimes, runtimesPayload);
    }
  }
}

async function emitDiscoveredAgents(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  payload: unknown,
): Promise<void> {
  const teamId = payloadTeamId(payload);
  const deviceId = payloadDeviceId(payload);
  const agents = payloadDiscoveredAgents(payload);
  if (!teamId || !deviceId || agents.length === 0) {
    return;
  }

  for (const subscriber of subscribers) {
    if (subscriber.devices?.teamId !== teamId) {
      continue;
    }
    const result = await app.getDevice({ userId: subscriber.devices.userId, deviceId });
    if (!result.ok) {
      continue;
    }
    const runtimes = result.device.runtimes ?? [];
    const runtimesByAdapter = new Map(
      runtimes.map((runtime) => [normalizeAdapterKind(runtime.adapterKind), runtime]),
    );
    subscriber.socket.emit?.(WEB_EVENTS.agent.discovered, {
      runtimes,
      agents: agents.map((agent) => {
        const adapterKind = normalizeAdapterKind(agent.adapterKind);
        const runtime = runtimesByAdapter.get(adapterKind);
        return {
          name: agent.name,
          adapterKind,
          category: agent.category,
          source: discoveredAgentSource(agent, runtime),
          command: agent.command ?? runtime?.command ?? '',
          args: agent.args,
          cwd: agent.cwd ?? runtime?.cwd,
        };
      }),
    });
  }
}

function emitDispatchStatus(subscribers: Set<WebSocketSubscription>, dispatch: unknown): void {
  const teamId = dispatchTeamId(dispatch);
  if (!teamId) {
    return;
  }
  for (const subscriber of subscribers) {
    if (!subscriberBelongsToTeam(subscriber, teamId)) {
      continue;
    }
    subscriber.socket.emit?.(WEB_EVENTS.message.dispatchStatus, dispatch);
  }
}

function subscriberBelongsToTeam(subscriber: WebSocketSubscription, teamId: string): boolean {
  return subscriber.channels?.teamId === teamId || subscriber.agents?.teamId === teamId || subscriber.devices?.teamId === teamId;
}

async function emitStoredDeviceRuntimes(
  socket: SocketLike,
  app: ServerNextUseCases,
  subscription: ChannelSubscription,
  devices: Array<{ id: string }>,
): Promise<void> {
  for (const device of devices) {
    const result = await app.getDevice({ userId: subscription.userId, deviceId: device.id });
    if (result.ok && result.device.runtimes.length > 0) {
      socket.emit?.(WEB_EVENTS.device.runtimes, {
        deviceId: device.id,
        runtimes: result.device.runtimes,
      });
    }
  }
}

function isSuccessAck(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}

function payloadTeamId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const teamId = (payload as { teamId?: unknown }).teamId;
  return typeof teamId === 'string' ? teamId : null;
}

function payloadBoolean(payload: unknown, key: string): boolean | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : null;
}

function payloadTargetTeamId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const teamId = (payload as { targetTeamId?: unknown }).targetTeamId;
  return typeof teamId === 'string' ? teamId : null;
}

function payloadDeviceId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const deviceId = (payload as { deviceId?: unknown }).deviceId;
  return typeof deviceId === 'string' ? deviceId : null;
}

function payloadTeamIds(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter((teamId): teamId is string => typeof teamId === 'string'));
}

function payloadDiscoveredAgents(payload: unknown): DiscoveredAgentReport[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const agents = (payload as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) {
    return [];
  }
  return agents.flatMap((agent) => {
    if (!agent || typeof agent !== 'object') {
      return [];
    }
    const candidate = agent as {
      name?: unknown;
      adapterKind?: unknown;
      category?: unknown;
      command?: unknown;
      args?: unknown;
      cwd?: unknown;
      discoverySource?: unknown;
      gatewayInstanceKey?: unknown;
    };
    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.adapterKind !== 'string' ||
      typeof candidate.category !== 'string'
    ) {
      return [];
    }
    return [{
      name: candidate.name,
      adapterKind: candidate.adapterKind,
      category: candidate.category,
      command: typeof candidate.command === 'string' ? candidate.command : undefined,
      args: Array.isArray(candidate.args) ? candidate.args.map(String) : undefined,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : undefined,
      discoverySource: readDiscoverySource(candidate.discoverySource),
      gatewayInstanceKey:
        typeof candidate.gatewayInstanceKey === 'string' ? candidate.gatewayInstanceKey : undefined,
    }];
  });
}

function readDiscoverySource(value: unknown): DiscoveredAgentReport['discoverySource'] {
  return value === 'runtime' || value === 'gateway' || value === 'filesystem' ? value : undefined;
}

function discoveredAgentSource(
  agent: DiscoveredAgentReport,
  runtime?: { command?: string; cwd?: string },
): 'runtime' | 'gateway' | 'filesystem' {
  if (agent.discoverySource) {
    return agent.discoverySource;
  }
  if (agent.gatewayInstanceKey) {
    return 'gateway';
  }
  if (!agent.command && !agent.cwd && !agent.args && runtime) {
    return 'runtime';
  }
  return 'filesystem';
}

function resultAgentVisibleTeamIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const agent = (result as { agent?: { visibleTeamIds?: unknown } }).agent;
  if (!agent || !Array.isArray(agent.visibleTeamIds)) {
    return [];
  }
  return uniqueStrings(agent.visibleTeamIds.filter((teamId): teamId is string => typeof teamId === 'string'));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

function payloadDeviceInviteCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const code = (payload as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function resultDeviceInviteCode(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const invite = (result as { invite?: { code?: unknown } }).invite;
  return typeof invite?.code === 'string' ? invite.code : null;
}

function resultDeviceInviteCredentials(result: unknown): unknown | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  return (result as { credentials?: unknown }).credentials ?? null;
}

function resultDeviceInviteCreatedBy(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const invite = (result as { invite?: { createdBy?: unknown } }).invite;
  return typeof invite?.createdBy === 'string' ? invite.createdBy : null;
}

function resultDispatchTeamId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const dispatch = (result as { dispatch?: { teamId?: unknown } }).dispatch;
  return typeof dispatch?.teamId === 'string' ? dispatch.teamId : null;
}

function resultDispatch(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    return null;
  }
  return (result as { dispatch?: unknown }).dispatch ?? null;
}

function dispatchTeamId(dispatch: unknown): string | null {
  if (!dispatch || typeof dispatch !== 'object') {
    return null;
  }
  const teamId = (dispatch as { teamId?: unknown }).teamId;
  return typeof teamId === 'string' ? teamId : null;
}

function resultMessage(result: unknown): { channelId: string; teamId?: string } | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const message = (result as { message?: { channelId?: unknown } }).message;
  return typeof message?.channelId === 'string' ? message as { channelId: string; teamId?: string } : null;
}

function resultMessageTeamId(result: unknown): string | null {
  const message = resultMessage(result);
  return typeof message?.teamId === 'string' ? message.teamId : null;
}

function resultPinnedMessageId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const messageId = (result as { messageId?: unknown }).messageId;
  return typeof messageId === 'string' ? messageId : null;
}

function resultPinnedChannelId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const channelId = (result as { channelId?: unknown }).channelId;
  return typeof channelId === 'string' ? channelId : null;
}

function taskTeamId(task: unknown): string | null {
  if (!task || typeof task !== 'object') {
    return null;
  }
  const teamId = (task as { teamId?: unknown }).teamId;
  return typeof teamId === 'string' ? teamId : null;
}

function resultDeviceTeamId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const device = (result as { device?: { teamId?: unknown } }).device;
  return typeof device?.teamId === 'string' ? device.teamId : null;
}

function resultDeviceId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const device = (result as { device?: { id?: unknown } }).device;
  return typeof device?.id === 'string' ? device.id : null;
}

/**
 * 取 deleteDevice 结果中被删除的全部设备 id（别名组删除会一次删多条记录）。
 * 兼容仅有单个 device 字段的旧结果：回退为 [device.id]。
 */
function resultDeletedDeviceIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const ids = (result as { deletedDeviceIds?: unknown }).deletedDeviceIds;
  if (Array.isArray(ids)) {
    return ids.filter((id): id is string => typeof id === 'string');
  }
  const single = resultDeviceId(result);
  return single ? [single] : [];
}

function resultRuntimesPayload(result: unknown): { deviceId: string; runtimes: unknown[] } | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = result as { runtimes?: unknown };
  if (!Array.isArray(candidate.runtimes) || candidate.runtimes.length === 0) {
    return null;
  }
  const firstRuntime = candidate.runtimes[0] as { deviceId?: unknown };
  if (typeof firstRuntime.deviceId !== 'string') {
    return null;
  }
  return {
    deviceId: firstRuntime.deviceId,
    runtimes: candidate.runtimes,
  };
}

async function resolveAuthenticatedUserId(
  authenticatedUser: () => Promise<AuthenticatedUserIdentity>,
): Promise<string | null> {
  const auth = await authenticatedUser();
  if (!auth.hasToken) {
    return null;
  }
  if (!auth.userId) {
    throw new UnauthenticatedSocketError();
  }
  return auth.userId;
}

interface FlatDmChannel {
  id: string;
  name: string;
  dmTargetId: string;
  createdAt: number;
}

function toFlatDm(dm: { channel: { id: string; name: string; dmTargetAgentId?: string; createdAt: number } }): FlatDmChannel {
  return {
    id: dm.channel.id,
    name: dm.channel.name,
    dmTargetId: dm.channel.dmTargetAgentId ?? '',
    createdAt: dm.channel.createdAt,
  };
}

function toFlatDmList(dms: Array<{ channel: { id: string; name: string; dmTargetAgentId?: string; createdAt: number } }>): FlatDmChannel[] {
  return dms.map(toFlatDm);
}

async function refreshDmSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) {
      continue;
    }
    const result = await app.listDirectMessages(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.dm.snapshot, toFlatDmList(result.dms));
    }
  }
}

async function emitDmSnapshotForSubscriber(
  subscriber: WebSocketSubscription,
  app: ServerNextUseCases,
): Promise<void> {
  if (!subscriber.channels) {
    return;
  }
  try {
    const result = await app.listDirectMessages(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.dm.snapshot, toFlatDmList(result.dms));
    }
  } catch (error) {
    console.warn('[socket] DM snapshot push failed (non-blocking):', error);
  }
}
