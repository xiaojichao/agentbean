import { createConnection } from 'node:net';
import type { DeviceControlRequest, DeviceControlResponse } from './device-control-protocol.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeviceControlClient {
  request(request: DeviceControlRequest, timeoutMs?: number): Promise<DeviceControlResponse>;
}

export function createDeviceControlClient(socketPath: string): DeviceControlClient {
  return {
    request(request, timeoutMs = request.deadlineMs ?? 5_000) {
      return requestDeviceControl(socketPath, request, timeoutMs);
    },
  };
}

async function requestDeviceControl(
  socketPath: string,
  request: DeviceControlRequest,
  timeoutMs: number,
): Promise<DeviceControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    let settled = false;
    const finish = (error?: Error, value?: DeviceControlResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('SERVICE_CONTROL_UNAVAILABLE'));
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error('SERVICE_DRAIN_TIMEOUT')));
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(new Error('SERVICE_CONTROL_UNAVAILABLE'));
      }
    });
    socket.once('end', () => {
      try {
        finish(undefined, JSON.parse(response) as DeviceControlResponse);
      } catch {
        finish(new Error('SERVICE_CONTROL_UNAVAILABLE'));
      }
    });
    socket.once('error', () => finish(new Error('SERVICE_CONTROL_UNAVAILABLE')));
  });
}
