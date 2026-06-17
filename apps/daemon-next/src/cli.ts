import { hostname as readHostname } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_EVENTS, type DeviceInviteCredentialsDto } from '../../../packages/contracts/src/index.js';
import { createBuiltinScanProvider } from './scanner.js';
import { createCommandExecutor } from './executor.js';
import { createDaemonProtocolClient, createHttpEnvResolver, type DaemonDeviceConfig, type DaemonProtocolSocket } from './index.js';

interface SocketIoClientLike {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface DaemonNextCliConfig {
  serverUrl: string;
  teamId?: string;
  ownerId?: string;
  inviteCode?: string;
  machineId?: string;
  profileId: string;
  hostname: string;
  fallbackPrefix: string;
}

export interface ParseDaemonNextCliConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  hostname?: string;
}

export function parseDaemonNextCliConfig(input: ParseDaemonNextCliConfigInput = {}): DaemonNextCliConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const args = parseArgs(argv);
  const teamId = args['team-id'] ?? env.AGENTBEAN_NEXT_TEAM_ID;
  const ownerId = args['owner-id'] ?? env.AGENTBEAN_NEXT_OWNER_ID;
  const inviteCode = args['invite-code'] ?? env.AGENTBEAN_NEXT_INVITE_CODE;
  if (!inviteCode && !teamId) {
    throw new Error('AGENTBEAN_NEXT_TEAM_ID or --team-id is required');
  }
  if (!inviteCode && !ownerId) {
    throw new Error('AGENTBEAN_NEXT_OWNER_ID or --owner-id is required');
  }
  return {
    serverUrl: trimTrailingSlash(args['server-url'] ?? env.AGENTBEAN_NEXT_SERVER_URL ?? 'http://127.0.0.1:4000'),
    ...(teamId ? { teamId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    machineId: args['machine-id'] ?? env.AGENTBEAN_NEXT_MACHINE_ID,
    profileId: args['profile-id'] ?? env.AGENTBEAN_NEXT_PROFILE_ID ?? 'default',
    hostname: args.hostname ?? env.AGENTBEAN_NEXT_HOSTNAME ?? input.hostname ?? readHostname(),
    fallbackPrefix: args['fallback-prefix'] ?? env.AGENTBEAN_NEXT_FALLBACK_PREFIX ?? 'daemon-next:',
  };
}

export function createSocketIoDaemonSocket(socket: SocketIoClientLike): DaemonProtocolSocket {
  const handlerMap = new WeakMap<(payload: unknown) => Promise<void>, (...args: unknown[]) => void>();
  return {
    emitWithAck(event, payload) {
      return socket.emitWithAck(event, payload);
    },
    on(event, handler) {
      const runtimeHandler = (payload: unknown) => {
        void handler(payload);
      };
      handlerMap.set(handler, runtimeHandler);
      socket.on(event, runtimeHandler);
    },
    off(event, handler) {
      const runtimeHandler = handlerMap.get(handler);
      if (runtimeHandler) {
        socket.off?.(event, runtimeHandler);
        handlerMap.delete(handler);
      }
    },
    onReconnect(handler) {
      let hasConnected = socket.connected;
      socket.on('connect', () => {
        if (!hasConnected) {
          hasConnected = true;
          return;
        }
        void handler();
      });
    },
  };
}

export async function runDaemonNextCli(config: DaemonNextCliConfig = parseDaemonNextCliConfig()): Promise<void> {
  const socket = await connectSocketIoClient(config.serverUrl);
  const protocolSocket = createSocketIoDaemonSocket(socket);
  const snapshot = await createBuiltinScanProvider()();
  const credentials = config.inviteCode
    ? await waitForDeviceInviteCredentials(protocolSocket, {
      code: config.inviteCode,
      machineId: config.machineId,
      profileId: config.profileId,
      hostname: config.hostname,
    })
    : null;
  const teamId = credentials?.teamId ?? config.teamId;
  const ownerId = credentials?.ownerId ?? config.ownerId;
  if (!teamId || !ownerId) {
    throw new Error('Device credentials did not include teamId and ownerId');
  }
  const device: DaemonDeviceConfig & { token?: string } = {
    teamId,
    ownerId,
    ...(credentials?.token ? { token: credentials.token } : {}),
    machineId: config.machineId,
    profileId: config.profileId,
    hostname: config.hostname,
  };
  await createDaemonProtocolClient({
    socket: protocolSocket,
    executor: createCommandExecutor({ fallbackPrefix: config.fallbackPrefix }),
    device,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    scan: createBuiltinScanProvider(),
    envResolver: device.token
      ? createHttpEnvResolver({ serverUrl: config.serverUrl, token: device.token })
      : undefined,
  }).start();
}

export async function waitForDeviceInviteCredentials(
  socket: DaemonProtocolSocket,
  input: { code: string; machineId?: string; profileId?: string; hostname?: string },
  options: { timeoutMs?: number } = {},
): Promise<DeviceInviteCredentialsDto> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanup = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const credentials = new Promise<DeviceInviteCredentialsDto>((resolve, reject) => {
    cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      socket.off?.(AGENT_EVENTS.deviceInvite.credentials, onCredentials);
      socket.off?.('disconnect', onDisconnect);
    };
    const onCredentials = async (payload: unknown) => {
      cleanup();
      resolve(payload as DeviceInviteCredentialsDto);
    };
    const onDisconnect = async () => {
      cleanup();
      reject(new Error('Socket disconnected while waiting for invite credentials'));
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for invite credentials'));
    }, timeoutMs);
    socket.on(AGENT_EVENTS.deviceInvite.credentials, onCredentials);
    socket.on('disconnect', onDisconnect);
  });
  const ack = await socket.emitWithAck(AGENT_EVENTS.deviceInvite.wait, input);
  if (isFailureAck(ack)) {
    cleanup();
    throw new Error(ack.message ?? ack.error);
  }
  return credentials;
}

async function connectSocketIoClient(serverUrl: string): Promise<SocketIoClientLike> {
  const { io } = loadSocketIoClient();
  const socket = io(`${trimTrailingSlash(serverUrl)}/agent`, {
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    transports: ['websocket', 'polling'],
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
    socket.connect();
  });
  return socket;
}

function loadSocketIoClient(): { io(url: string, options?: Record<string, unknown>): SocketIoClientLike } {
  const requireUrls = [
    new URL('../../../../package.json', import.meta.url),
    new URL('../../../../../server/package.json', import.meta.url),
    new URL('../../server/package.json', import.meta.url),
    new URL('../package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server/package.json')),
    pathToFileURL(join(process.cwd(), 'apps/daemon-next/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      return createRequire(requireUrl)('socket.io-client') as {
        io(url: string, options?: Record<string, unknown>): SocketIoClientLike;
      };
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('socket.io-client is not installed; run npm ci in apps/server or provide a workspace install');
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isFailureAck(ack: unknown): ack is { ok: false; error: string; message?: string } {
  return Boolean(
    ack &&
    typeof ack === 'object' &&
    (ack as { ok?: unknown }).ok === false &&
    typeof (ack as { error?: unknown }).error === 'string',
  );
}
