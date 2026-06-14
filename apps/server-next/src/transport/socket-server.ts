import type { ServerNextUseCases } from '../application/usecases.js';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import {
  registerAgentSocketHandlers,
  registerWebSocketHandlers,
  UnauthenticatedSocketError,
  type AuthenticatedUserIdentity,
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
}

interface ChannelSubscription {
  userId: string;
  teamId: string;
}

type AgentSubscription = ChannelSubscription;

interface WebSocketSubscription {
  socket: SocketLike;
  userId?: string;
  channels?: ChannelSubscription;
  agents?: AgentSubscription;
  devices?: ChannelSubscription;
}

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): ServerNextRealtime {
  const agentNamespace = server.of('/agent');
  const webSubscribers = new Set<WebSocketSubscription>();
  const agentSocketsByDeviceId = new Map<string, SocketLike>();
  const waitingDeviceInviteSocketsByCode = new Map<string, SocketLike>();
  const waitingDeviceInviteCodeBySocket = new Map<SocketLike, string>();

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
        ack?.(subscriptionErrorAck(error));
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
        ack?.(subscriptionErrorAck(error));
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
        ack?.(subscriptionErrorAck(error));
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
      afterDeviceInviteComplete(_payload, result) {
        const credentials = resultDeviceInviteCredentials(result);
        const inviteCode = resultDeviceInviteCode(result);
        if (!credentials || !inviteCode) {
          return;
        }
        waitingDeviceInviteSocketsByCode.get(inviteCode)?.emit?.(AGENT_EVENTS.deviceInvite.credentials, credentials);
        waitingDeviceInviteSocketsByCode.delete(inviteCode);
        for (const [socket, code] of waitingDeviceInviteCodeBySocket) {
          if (code === inviteCode) {
            waitingDeviceInviteCodeBySocket.delete(socket);
          }
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
    socket.on('disconnect', async () => {
      if (connectedDeviceId && agentSocketsByDeviceId.get(connectedDeviceId) === socket) {
        agentSocketsByDeviceId.delete(connectedDeviceId);
      }
      const waitingInviteCode = waitingDeviceInviteCodeBySocket.get(socket);
      if (waitingInviteCode) {
        waitingDeviceInviteSocketsByCode.delete(waitingInviteCode);
        waitingDeviceInviteCodeBySocket.delete(socket);
      }
    });
    registerAgentSocketHandlers(socket, app, {
      afterDeviceInviteWait(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const code = payloadDeviceInviteCode(payload) ?? resultDeviceInviteCode(result);
        if (code) {
          const previousCode = waitingDeviceInviteCodeBySocket.get(socket);
          if (previousCode) {
            waitingDeviceInviteSocketsByCode.delete(previousCode);
          }
          waitingDeviceInviteSocketsByCode.set(code, socket);
          waitingDeviceInviteCodeBySocket.set(socket, code);
        }
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
        await refreshDeviceSubscribers(webSubscribers, app, teamId);
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
        const refreshTeamIds = uniqueStrings([teamId, payloadTargetTeamId(payload), ...resultAgentVisibleTeamIds(result)]);
        for (const refreshTeamId of refreshTeamIds) {
          await refreshAgentSubscribers(webSubscribers, app, refreshTeamId);
        }
      },
    });
  });
  return {
    emitDispatchStatus(dispatch) {
      emitDispatchStatus(webSubscribers, dispatch);
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
  for (const subscriber of subscribers) {
    subscriber.socket.emit?.(WEB_EVENTS.task.updated, task);
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

async function asChannelSubscription(
  payload: unknown,
  authenticatedUser?: () => Promise<AuthenticatedUserIdentity>,
): Promise<ChannelSubscription | null> {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown };
  if (typeof candidate.teamId !== 'string') {
    return null;
  }
  const auth = await authenticatedUser?.();
  if (auth?.hasToken && !auth.userId) {
    throw new UnauthenticatedSocketError();
  }
  const userId = auth?.userId ?? (typeof candidate.userId === 'string' ? candidate.userId : null);
  if (!userId) {
    return null;
  }
  return { userId, teamId: candidate.teamId };
}

async function readSubscriptionInput(
  payload: unknown,
  authenticatedUser: () => Promise<AuthenticatedUserIdentity>,
): Promise<ChannelSubscription | null> {
  return asChannelSubscription(payload, authenticatedUser);
}

function subscriptionErrorAck(error: unknown): { ok: false; error: string; message: string } {
  if (error instanceof UnauthenticatedSocketError) {
    return { ok: false, error: 'UNAUTHENTICATED', message: 'Invalid session token' };
  }
  return {
    ok: false,
    error: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unhandled socket handler error',
  };
}

function createAuthenticatedUserResolver(
  socket: SocketLike,
  app: ServerNextUseCases,
): () => Promise<AuthenticatedUserIdentity> {
  let cached: AuthenticatedUserIdentity | undefined;
  return async () => {
    if (cached) {
      return cached;
    }
    const authToken = socketAuthToken(socket);
    if (!authToken.hasToken) {
      cached = { hasToken: false, userId: null };
      return cached;
    }
    if (!authToken.token) {
      cached = { hasToken: true, userId: null };
      return cached;
    }
    const result = await app.whoami({ token: authToken.token });
    cached = { hasToken: true, userId: result.ok ? result.user.id : null };
    return cached;
  };
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

function payloadTargetTeamId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const teamId = (payload as { targetTeamId?: unknown }).targetTeamId;
  return typeof teamId === 'string' ? teamId : null;
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
