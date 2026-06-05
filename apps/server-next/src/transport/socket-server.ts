import type { ServerNextUseCases } from '../application/usecases';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../../packages/contracts/src/index';
import { registerAgentSocketHandlers, registerWebSocketHandlers, type SocketLike } from './socket-handlers';

export interface NamespaceLike {
  on(event: 'connection', handler: (socket: SocketLike) => void): void;
  emit?(event: string, payload: unknown): void;
}

export interface SocketServerLike {
  of(namespace: '/web' | '/agent'): NamespaceLike;
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

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): void {
  const agentNamespace = server.of('/agent');
  const webSubscribers = new Set<WebSocketSubscription>();
  const agentSocketsByDeviceId = new Map<string, SocketLike>();

  server.of('/web').on('connection', (socket) => {
    const subscriber: WebSocketSubscription = { socket };
    webSubscribers.add(subscriber);
    socket.on('disconnect', async () => {
      webSubscribers.delete(subscriber);
    });
    socket.on(WEB_EVENTS.channel.subscribe, async (payload, ack) => {
      const input = asChannelSubscription(payload);
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
    });
    socket.on(WEB_EVENTS.agent.subscribe, async (payload, ack) => {
      const input = asAgentSubscription(payload);
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
    });
    socket.on(WEB_EVENTS.device.list, async (payload, ack) => {
      const input = asDeviceSubscription(payload);
      if (!input) {
        ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid device list payload' });
        return;
      }
      const result = await app.listDevices(input);
      ack?.(result);
      if (result.ok) {
        subscriber.devices = input;
        socket.emit?.(WEB_EVENTS.device.snapshot, result.devices);
      }
    });
    registerWebSocketHandlers(socket, app, {
      dispatch(request) {
        agentNamespace.emit?.(AGENT_EVENTS.dispatch.request, request);
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
        await refreshAgentSubscribers(webSubscribers, app, teamId);
      },
    });
  });
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
    const result = await app.listVisibleAgents({ teamId: subscriber.agents.teamId });
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
    }
  }
}

function asChannelSubscription(payload: unknown): ChannelSubscription | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown };
  if (typeof candidate.userId !== 'string' || typeof candidate.teamId !== 'string') {
    return null;
  }
  return { userId: candidate.userId, teamId: candidate.teamId };
}

const asAgentSubscription = asChannelSubscription;
const asDeviceSubscription = asChannelSubscription;

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
