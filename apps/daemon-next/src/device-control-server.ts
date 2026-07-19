import { chmod, lstat, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  parseDeviceControlRequest,
  type DeviceControlRequest,
  type DeviceControlResponse,
} from './device-control-protocol.js';
import { ensurePrivateDeviceServiceDirectory } from './device-service-filesystem.js';

const MAX_REQUEST_BYTES = 16 * 1024;

export interface DeviceControlHandler {
  handle(request: DeviceControlRequest): Promise<DeviceControlResponse>;
}

export interface DeviceControlServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDeviceControlServer(
  socketPath: string,
  handler: DeviceControlHandler,
): DeviceControlServer {
  let server: Server | undefined;
  const connections = new Set<Socket>();
  const shutdownResponses = new Set<Socket>();

  return {
    async start() {
      if (server) return;
      await ensurePrivateDeviceServiceDirectory(dirname(socketPath));
      await removeStaleSocket(socketPath);
      const nextServer = createServer((socket) => {
        connections.add(socket);
        socket.setTimeout(5_000, () => socket.destroy());
        socket.once('close', () => {
          connections.delete(socket);
          shutdownResponses.delete(socket);
        });
        handleConnection(socket, handler, (request) => {
          socket.setTimeout(0);
          if (request.command === 'shutdown') shutdownResponses.add(socket);
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            nextServer.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            nextServer.off('error', onError);
            resolve();
          };
          nextServer.once('error', onError);
          nextServer.once('listening', onListening);
          nextServer.listen(socketPath);
        });
        await chmod(socketPath, 0o600);
        server = nextServer;
      } catch (error) {
        nextServer.close();
        throw error;
      }
    },
    async stop() {
      const current = server;
      if (!current) return;
      server = undefined;
      // Do not wait for active control connections here: shutdown can be
      // requested by the connection that still needs to receive our response.
      current.close(() => undefined);
      await rm(socketPath, { force: true });
      for (const connection of connections) {
        if (!shutdownResponses.has(connection)) connection.destroy();
      }
    },
  };
}

function handleConnection(
  socket: Socket,
  handler: DeviceControlHandler,
  onRequest: (request: DeviceControlRequest) => void,
): void {
  socket.setEncoding('utf8');
  let buffer = '';
  let handled = false;

  const reject = (requestId = 'invalid') => {
    sendResponse(socket, {
      schemaVersion: 1,
      requestId,
      ok: false,
      reasonCode: 'CONTROL_INVALID_REQUEST',
    });
  };

  socket.on('data', (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      handled = true;
      reject();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    if (buffer.slice(newline + 1).trim().length > 0) {
      reject();
      return;
    }
    const line = buffer.slice(0, newline);
    void parseAndHandle(line, socket, handler, reject, onRequest);
  });
  socket.on('end', () => {
    if (!handled) reject();
  });
  socket.on('error', () => {
    socket.destroy();
  });
}

async function parseAndHandle(
  line: string,
  socket: Socket,
  handler: DeviceControlHandler,
  reject: (requestId?: string) => void,
  onRequest: (request: DeviceControlRequest) => void,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    reject();
    return;
  }
  const request = parseDeviceControlRequest(parsed);
  if (!request) {
    reject();
    return;
  }
  onRequest(request);
  try {
    sendResponse(socket, await handler.handle(request));
  } catch {
    sendResponse(socket, {
      schemaVersion: 1,
      requestId: request.requestId,
      ok: false,
      reasonCode: 'SERVICE_CONTROL_UNAVAILABLE',
    });
  }
}

function sendResponse(socket: Socket, response: DeviceControlResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) throw new Error('SERVICE_CONTROL_PATH_UNSAFE');
    await rm(socketPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
