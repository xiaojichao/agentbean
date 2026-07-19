import type { DeviceServiceReasonCode, DeviceServiceState } from './device-service-state.js';

export type DeviceControlCommand = 'status' | 'begin-drain' | 'shutdown';

export interface DeviceControlRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly command: DeviceControlCommand;
  readonly deadlineMs?: number;
}

export type DeviceControlResponse =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: true;
      readonly state: DeviceServiceState;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly reasonCode: DeviceServiceReasonCode | 'CONTROL_INVALID_REQUEST';
    };

export function parseDeviceControlRequest(input: unknown): DeviceControlRequest | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input);
  if (keys.some((key) => !['schemaVersion', 'requestId', 'command', 'deadlineMs'].includes(key))) return null;
  if (input.schemaVersion !== 1) return null;
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)) return null;
  if (input.command !== 'status' && input.command !== 'begin-drain' && input.command !== 'shutdown') return null;
  if (input.command === 'status') {
    if ('deadlineMs' in input) return null;
  } else if (!Number.isSafeInteger(input.deadlineMs) || (input.deadlineMs as number) < 1 || (input.deadlineMs as number) > 300_000) {
    return null;
  }
  return input as unknown as DeviceControlRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
