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
  channels?: ChannelSubscription;
  agents?: AgentSubscription;
  devices?: ChannelSubscription;
}

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): ServerNextRealtime {
  const agentNamespace = server.of('/agent');
  const webSubscribers = new Set<WebSocketSubscription>();
  const agentSocketsByDeviceId = new Map<string, SocketLike>();

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
        const teamId = payloadTeamId(payload);
        if (!teamId) {
          return;
        }
        await refreshAgentSubscribers(webSubscribers, app, teamId);
      },
    });
  });
  agentNamespace.on('connection', (socket) => {
    let connectedDeviceId: string | undefined;
    socket.on('disconnect', async () => {
      if (connectedDeviceId && agentSocketsByDeviceId.get(connectedDeviceId) === socket) {
        agentSocketsByDeviceId.delete(connectedDeviceId);
      }
    });
    registerAgentSocketHandlers(socket, app, {
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
        await refreshAgentSubscribers(webSubscribers, app, teamId);
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

function resultMessage(result: unknown): { channelId: string } | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const message = (result as { message?: { channelId?: unknown } }).message;
  return typeof message?.channelId === 'string' ? message as { channelId: string } : null;
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
