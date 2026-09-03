import { WEB_EVENTS } from '../../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';
import type { SocketLike } from './socket-handlers.js';

export interface DeviceProjectionSubscription {
  readonly userId: string;
  readonly teamId: string;
  readonly currentDeviceId?: string | null;
}

export interface DeviceSocketSubscriber {
  readonly socket: SocketLike;
  devices?: DeviceProjectionSubscription;
}

export interface DeviceSocketProjectionPort extends Pick<
  ServerNextUseCases,
  'listDevices' | 'getDevice'
> {}

export interface DeviceSocketProjectionOptions {
  readonly refreshAgents?: (teamId: string) => Promise<void>;
  readonly refreshChannels?: (teamId: string) => Promise<void>;
  readonly onAgentAvailabilityChanged?: (teamId: string) => Promise<void>;
}

export interface DeviceSocketProjection {
  subscribe(
    subscriber: DeviceSocketSubscriber,
    subscription: DeviceProjectionSubscription,
    devices: readonly { readonly id: string }[],
  ): Promise<void>;
  handleMutation(payload: unknown, result: unknown): Promise<void>;
  refresh(teamId: string): Promise<void>;
}

/** Device mutation 与订阅 refresh 的唯一 Socket snapshot/status/runtime 投影 owner。 */
export function createDeviceSocketProjection(
  subscribers: Iterable<DeviceSocketSubscriber>,
  port: DeviceSocketProjectionPort,
  options: DeviceSocketProjectionOptions = {},
): DeviceSocketProjection {
  const refresh = (teamId: string) => refreshDeviceSubscribers(subscribers, port, teamId);

  return {
    async subscribe(subscriber, subscription, devices) {
      subscriber.devices = subscription;
      subscriber.socket.emit?.(WEB_EVENTS.device.snapshot, devices);
      await emitStoredDeviceRuntimes(subscriber.socket, port, subscription, devices);
    },

    async handleMutation(payload, result) {
      if (!isSuccessAck(result)) return;
      const teamId = objectString(payload, 'teamId') ?? resultDeviceTeamId(result);
      if (!teamId) return;

      await refresh(teamId);
      for (const affectedTeamId of uniqueStrings(objectStringArray(result, 'affectedTeamIds'))) {
        await options.refreshAgents?.(affectedTeamId);
      }
      for (const channelTeamId of uniqueStrings(objectStringArray(result, 'channelTeamIds'))) {
        await options.refreshChannels?.(channelTeamId);
      }
      emitMutationRuntimes(subscribers, teamId, result);
      await options.onAgentAvailabilityChanged?.(teamId).catch(() => undefined);
    },

    refresh,
  };
}

async function refreshDeviceSubscribers(
  subscribers: Iterable<DeviceSocketSubscriber>,
  port: DeviceSocketProjectionPort,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    const subscription = subscriber.devices;
    if (subscription?.teamId !== teamId) continue;
    const result = await port.listDevices(subscription);
    if (!result.ok) continue;
    subscriber.socket.emit?.(WEB_EVENTS.device.snapshot, result.devices);
    for (const device of result.devices) {
      subscriber.socket.emit?.(WEB_EVENTS.device.status, device);
    }
  }
}

async function emitStoredDeviceRuntimes(
  socket: SocketLike,
  port: DeviceSocketProjectionPort,
  subscription: DeviceProjectionSubscription,
  devices: readonly { readonly id: string }[],
): Promise<void> {
  for (const device of devices) {
    const result = await port.getDevice({ userId: subscription.userId, deviceId: device.id });
    if (result.ok && result.device.runtimes.length > 0) {
      socket.emit?.(WEB_EVENTS.device.runtimes, {
        deviceId: device.id,
        runtimes: result.device.runtimes,
      });
    }
  }
}

function emitMutationRuntimes(
  subscribers: Iterable<DeviceSocketSubscriber>,
  teamId: string,
  result: unknown,
): void {
  const runtimesPayload = resultRuntimesPayload(result);
  if (!runtimesPayload) return;
  for (const subscriber of subscribers) {
    if (subscriber.devices?.teamId === teamId) {
      subscriber.socket.emit?.(WEB_EVENTS.device.runtimes, runtimesPayload);
    }
  }
}

function resultRuntimesPayload(result: unknown): { readonly deviceId: string; readonly runtimes: unknown[] } | null {
  if (!result || typeof result !== 'object') return null;
  const runtimes = (result as { runtimes?: unknown }).runtimes;
  if (!Array.isArray(runtimes) || runtimes.length === 0) return null;
  const deviceId = objectString(runtimes[0], 'deviceId');
  return deviceId ? { deviceId, runtimes } : null;
}

function resultDeviceTeamId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  return objectString((result as { device?: unknown }).device, 'teamId');
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : null;
}

function objectStringArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )));
}

function isSuccessAck(result: unknown): result is { readonly ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}
