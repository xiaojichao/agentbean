import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { hostname as readHostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  WEB_EVENTS,
  type Ack,
  type ChannelDto,
  type TeamDto,
  type UserDto,
} from '../../../packages/contracts/src/index.js';
import {
  createBuiltinScanProvider,
  createCommandExecutor,
  createDaemonProtocolClient,
  type DaemonProtocolSocket,
  type DispatchRequestPayload,
} from '../../daemon-next/src/index.js';
import {
  parseServerNextDevConfig,
  startServerNextDevServer,
} from './dev-server.js';

export interface AgentBeanNextPreviewConfig {
  host: string;
  port: number;
  dataDir: string;
  sessionSecret: string;
  username: string;
  password: string;
  teamName: string;
  machineId?: string;
  profileId: string;
  hostname: string;
  fallbackPrefix: string;
}

export interface ParseAgentBeanNextPreviewConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  hostname?: string;
}

export interface PreviewSocketLike {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface PreviewSession {
  user: UserDto;
  currentTeam: TeamDto;
  defaultChannel?: ChannelDto;
}

export interface AgentBeanNextPreviewHandle {
  baseUrl: string;
  user: UserDto;
  currentTeam: TeamDto;
  close(): Promise<void>;
}

type SocketIoClientFactory = (url: string, options?: Record<string, unknown>) => PreviewSocketLike;
type PreviewExecutor = (request: DispatchRequestPayload) => Promise<string>;

export interface StartAgentBeanNextPreviewInput {
  config?: AgentBeanNextPreviewConfig;
  io?: SocketIoClientFactory;
  executor?: PreviewExecutor;
}

export function parseAgentBeanNextPreviewConfig(
  input: ParseAgentBeanNextPreviewConfigInput = {},
): AgentBeanNextPreviewConfig {
  const env = input.env ?? process.env;
  const serverConfig = parseServerNextDevConfig({
    argv: input.argv,
    env: {
      ...env,
      AGENTBEAN_NEXT_STORAGE: 'sqlite',
    },
  });
  const hostname = env.AGENTBEAN_NEXT_HOSTNAME ?? input.hostname ?? readHostname();
  return {
    host: serverConfig.host,
    port: serverConfig.port,
    dataDir: serverConfig.dataDir,
    sessionSecret: serverConfig.sessionSecret,
    username: env.AGENTBEAN_NEXT_PREVIEW_USERNAME ?? 'shaw',
    password: env.AGENTBEAN_NEXT_PREVIEW_PASSWORD ?? 'secret',
    teamName: env.AGENTBEAN_NEXT_PREVIEW_TEAM ?? 'AgentBean',
    machineId: env.AGENTBEAN_NEXT_MACHINE_ID ?? `agentbean-next-preview:${hostname}`,
    profileId: env.AGENTBEAN_NEXT_PROFILE_ID ?? 'agentbean-next-preview',
    hostname,
    fallbackPrefix: env.AGENTBEAN_NEXT_FALLBACK_PREFIX ?? 'daemon-next:',
  };
}

export async function startAgentBeanNextPreview(
  input: StartAgentBeanNextPreviewInput = {},
): Promise<AgentBeanNextPreviewHandle> {
  const config = input.config ?? parseAgentBeanNextPreviewConfig();
  const io = input.io ?? loadSocketIoClient();
  const server = await startServerNextDevServer({
    config: {
      host: config.host,
      port: config.port,
      storage: 'sqlite',
      dataDir: config.dataDir,
      sessionSecret: config.sessionSecret,
    },
  });
  const sockets: PreviewSocketLike[] = [];

  try {
    const webSocket = await connectPreviewSocket(io, `${server.baseUrl}/web`);
    sockets.push(webSocket);
    const session = await authenticatePreviewWebSession(webSocket, config);

    const agentSocket = await connectPreviewSocket(io, `${server.baseUrl}/agent`);
    sockets.push(agentSocket);
    const scan = createBuiltinScanProvider();
    const snapshot = await scan();
    await createDaemonProtocolClient({
      serverUrl: server.baseUrl,
      socket: createDaemonSocket(agentSocket),
      executor: input.executor ?? createCommandExecutor({ fallbackPrefix: config.fallbackPrefix }),
      device: {
        teamId: session.currentTeam.id,
        ownerId: session.user.id,
        machineId: config.machineId,
        profileId: config.profileId,
        hostname: config.hostname,
      },
      runtimes: snapshot.runtimes,
      agents: snapshot.agents,
      scan,
    }).start();

    return {
      baseUrl: server.baseUrl,
      user: session.user,
      currentTeam: session.currentTeam,
      async close() {
        for (const socket of sockets.splice(0).reverse()) {
          socket.disconnect();
        }
        await server.close();
      },
    };
  } catch (error) {
    for (const socket of sockets.splice(0).reverse()) {
      socket.disconnect();
    }
    await server.close();
    throw error;
  }
}

export async function runAgentBeanNextPreview(
  config = parseAgentBeanNextPreviewConfig(),
): Promise<AgentBeanNextPreviewHandle> {
  const handle = await startAgentBeanNextPreview({ config });
  console.log(`AgentBean Next full preview listening at ${handle.baseUrl}`);
  console.log(`Preview user: ${handle.user.username}`);
  console.log(`Preview team: ${handle.currentTeam.name}`);
  console.log(`SQLite data dir: ${config.dataDir}`);
  if (process.env.AGENTBEAN_NEXT_OPEN_BROWSER === '1') {
    openPreviewUrl(handle.baseUrl);
  }
  return handle;
}

export async function authenticatePreviewWebSession(
  socket: Pick<PreviewSocketLike, 'emitWithAck'>,
  config: Pick<AgentBeanNextPreviewConfig, 'username' | 'password' | 'teamName'>,
): Promise<PreviewSession> {
  const registerAck = await emitAck<PreviewSession>(socket, WEB_EVENTS.auth.register, {
    username: config.username,
    password: config.password,
    teamName: config.teamName,
  });
  if (registerAck.ok) {
    return registerAck;
  }
  if (registerAck.error !== 'CONFLICT') {
    throw new Error(registerAck.message ?? `Preview registration failed: ${registerAck.error}`);
  }

  const loginAck = await emitAck<PreviewSession>(socket, WEB_EVENTS.auth.login, {
    username: config.username,
    password: config.password,
  });
  if (!loginAck.ok) {
    throw new Error(loginAck.message ?? `Preview login failed: ${loginAck.error}`);
  }
  return loginAck;
}

function createDaemonSocket(socket: PreviewSocketLike): DaemonProtocolSocket {
  return {
    emitWithAck(event, payload) {
      return socket.emitWithAck(event, payload);
    },
    on(event, handler) {
      socket.on(event, (payload) => {
        void handler(payload);
      });
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

async function connectPreviewSocket(io: SocketIoClientFactory, url: string): Promise<PreviewSocketLike> {
  const socket = io(url, {
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

async function emitAck<T extends object>(
  socket: Pick<PreviewSocketLike, 'emitWithAck'>,
  event: string,
  payload: unknown,
): Promise<Ack<T>> {
  return await socket.emitWithAck(event, payload) as Ack<T>;
}

function loadSocketIoClient(): SocketIoClientFactory {
  const requireUrls = [
    new URL('../../../../../server/package.json', import.meta.url),
    new URL('../../server/package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const { io } = createRequire(requireUrl)('socket.io-client') as { io: SocketIoClientFactory };
      return io;
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('socket.io-client is not installed; run npm ci in apps/server or provide a workspace install');
}

function openPreviewUrl(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(opener, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
