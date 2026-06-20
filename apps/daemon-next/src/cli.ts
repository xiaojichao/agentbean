import { hostname as readHostname } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_EVENTS, type DeviceInviteCredentialsDto } from '../../../packages/contracts/src/index.js';
import { createBuiltinScanProvider } from './scanner.js';
import { loadScanCache, saveScanCache } from './scan-cache.js';
import { collectSystemInfo, readDaemonVersion } from './system-info.js';
import { createCommandExecutor } from './executor.js';
import { createDaemonProtocolClient, createHttpEnvResolver, type DaemonDeviceConfig, type DaemonProtocolSocket } from './index.js';
import { loadYamlConfig } from './config.js';
import { listAuthProfiles, loadAuth, saveAuth, type AuthData, type AuthProfile } from './auth-store.js';

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
  configPath?: string;
  /**
   * When true, runDaemonNextCli enumerates every saved auth profile via
   * listAuthProfiles() and starts one daemon instance per profile
   * concurrently (each with allProfiles cleared and profileId overridden).
   * The all-profiles branch runs BEFORE connectSocketIoClient so it never
   * opens a socket itself; each recursion opens its own.
   */
  allProfiles?: boolean;
}

/**
 * Boolean (value-less) CLI flags. parseArgs treats every other `--flag` as
 * `--flag value`, so these must be recognised and not consume the next arg.
 */
const BOOLEAN_FLAGS = new Set(['all-profiles']);

export interface ParseDaemonNextCliConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  configPath?: string;
}

export function parseDaemonNextCliConfig(input: ParseDaemonNextCliConfigInput = {}): DaemonNextCliConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const { args, booleanFlags } = parseArgs(argv);
  // Resolve the YAML config path. A missing or corrupt file returns null from
  // loadYamlConfig, in which case yaml is treated as "no config" and we fall
  // through to env / built-in default — matching the config.ts contract.
  const configPath = input.configPath ?? args['config-path'] ?? env.AGENTBEAN_NEXT_CONFIG_PATH;
  const yaml = configPath ? loadYamlConfig(configPath) : null;
  const yamlString = (key: string): string | undefined =>
    typeof yaml?.[key] === 'string' ? (yaml[key] as string) : undefined;
  // Merge sources per field with priority CLI > env > yaml > default. Validation
  // runs against the merged values so a YAML-only teamId/ownerId is accepted.
  const teamId = args['team-id'] ?? env.AGENTBEAN_NEXT_TEAM_ID ?? yamlString('teamId');
  const ownerId = args['owner-id'] ?? env.AGENTBEAN_NEXT_OWNER_ID ?? yamlString('ownerId');
  const inviteCode = args['invite-code'] ?? env.AGENTBEAN_NEXT_INVITE_CODE ?? yamlString('inviteCode');
  // NOTE: credential sufficiency is validated at run time inside runDaemonNextCli
  // (see resolveDeviceCredentials) so that "start with only saved auth" works:
  // neither --invite-code nor --team-id/--owner-id is required when a profile
  // has been persisted previously.
  return {
    serverUrl: trimTrailingSlash(
      args['server-url'] ?? env.AGENTBEAN_NEXT_SERVER_URL ?? yamlString('serverUrl') ?? 'http://127.0.0.1:4000',
    ),
    ...(teamId ? { teamId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    machineId: args['machine-id'] ?? env.AGENTBEAN_NEXT_MACHINE_ID ?? yamlString('machineId'),
    profileId: args['profile-id'] ?? env.AGENTBEAN_NEXT_PROFILE_ID ?? yamlString('profileId') ?? 'default',
    hostname: args.hostname ?? env.AGENTBEAN_NEXT_HOSTNAME ?? yamlString('hostname') ?? input.hostname ?? readHostname(),
    fallbackPrefix:
      args['fallback-prefix'] ?? env.AGENTBEAN_NEXT_FALLBACK_PREFIX ?? yamlString('fallbackPrefix') ?? 'daemon-next:',
    ...(configPath ? { configPath } : {}),
    ...(booleanFlags['all-profiles'] ? { allProfiles: true } : {}),
  };
}

/**
 * Pure expansion of `--all-profiles` into one DaemonNextCliConfig per saved
 * profile. Each sub-config inherits the parent config, overrides `profileId`
 * with the profile's, and clears `allProfiles` so the recursion does not
 * re-expand. The empty case is the caller's responsibility (runDaemonNextCli
 * exits with a clear error before reaching here) — this function returns an
 * empty array when given no profiles, which keeps it total and trivially
 * unit-testable without mocking the auth store.
 *
 * Extracted so the orchestration logic is testable in isolation: the actual
 * runDaemonNextCli wiring cannot be exercised end-to-end in Vitest (see the
 * socket-seam NOTE in cli.test.ts), but this helper covers the core decision.
 */
export function expandAllProfiles(config: DaemonNextCliConfig, profiles: AuthProfile[]): DaemonNextCliConfig[] {
  return profiles.map((profile) => ({
    ...config,
    profileId: profile.profileId,
    // Each saved profile carries its own serverUrl (the server that invited
    // it). Override the parent config.serverUrl so every recursive daemon
    // connects to the profile's own server — otherwise cross-server profiles
    // (team A invited from server X, team B from server Y) would all try to
    // reach the parent's serverUrl and fail. Fall back to config.serverUrl
    // when the profile somehow has no serverUrl (defensive; listAuthProfiles
    // always returns one). trimTrailingSlash mirrors the parse path so a
    // trailing slash in the saved file does not produce a double-slash URL.
    serverUrl: profile.serverUrl ? trimTrailingSlash(profile.serverUrl) : config.serverUrl,
    allProfiles: false,
  }));
}

export function createSocketIoDaemonSocket(socket: SocketIoClientLike): DaemonProtocolSocket {
  const handlerMap = new WeakMap<(payload: unknown, ack?: (result: unknown) => void) => Promise<void>, (...args: unknown[]) => void>();
  return {
    emitWithAck(event, payload) {
      return socket.emitWithAck(event, payload);
    },
    on(event, handler) {
      const runtimeHandler = (payload: unknown, ackLike?: unknown) => {
        const ack = typeof ackLike === 'function' ? ackLike as (result: unknown) => void : undefined;
        void handler(payload, ack);
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

/**
 * Pure credential-resolution decision for a single profile.
 *
 * Inputs are the merged CLI/env/YAML config, the credentials produced by the
 * invite network call (only present on the invite path, once they've arrived),
 * and whatever `loadAuth` returned for this profile (null when nothing is
 * persisted). The function never reads the filesystem and never throws; it
 * returns a descriptor telling the caller exactly what device identity to use
 * and what (if anything) to persist, or signals that resolution failed so the
 * caller can throw a clear error.
 *
 * Extracting this as a pure function keeps the invite/saved/config decision
 * unit-testable without mocking the network or the auth store.
 *
 * profileId is used for BOTH save and load so a profile invited with no
 * --profile-id (stored under 'default') is found on the next start with no
 * --profile-id (loaded from 'default'). Do NOT slugify(teamId) — that would
 * make save/load target different files and never match.
 */
/**
 * Successful credential resolution. `persist` and `persistProfileId` are
 * bundled via the intersection below: when `persist` is present,
 * `persistProfileId` is guaranteed present too (TS-enforced). This lets the
 * saveAuth call site in runDaemonNextCli use `resolved.persistProfileId`
 * directly, with no `?? config.profileId` fallback.
 */
export type ResolvedCredentials = {
  teamId: string;
  ownerId: string;
  token?: string;
} & (
  | { persist?: undefined; persistProfileId?: undefined }
  | { persist: AuthData; persistProfileId: string }
);

export interface ResolveDeviceCredentialsFailure {
  ok: false;
  error: string;
}

export type ResolveDeviceCredentialsResult =
  | ({ ok: true } & ResolvedCredentials)
  | ResolveDeviceCredentialsFailure;

export interface ResolveDeviceCredentialsInput {
  inviteCode?: string;
  /** Invite-path network credentials; only meaningful when inviteCode is set. */
  inviteCredentials?: { teamId: string; ownerId: string; token: string };
  /** Result of loadAuth for this profile, or null. */
  saved: AuthData | null;
  /** Fallback teamId/ownerId from config (CLI/env/YAML). */
  configTeamId?: string;
  configOwnerId?: string;
  /** Always defined (parse defaults to 'default'). */
  profileId: string;
  serverUrl: string;
}

export function resolveDeviceCredentials(
  input: ResolveDeviceCredentialsInput,
): ResolveDeviceCredentialsResult {
  const { inviteCode, inviteCredentials, saved, configTeamId, configOwnerId, profileId, serverUrl } = input;

  if (inviteCode) {
    if (!inviteCredentials) {
      // The caller should only invoke us once the network handshake has produced
      // credentials; if it didn't, surface a clear error rather than persisting
      // an incomplete profile.
      return {
        ok: false,
        error: 'Invite mode selected but no invite credentials were supplied to resolveDeviceCredentials.',
      };
    }
    const { teamId, ownerId, token } = inviteCredentials;
    return {
      ok: true,
      teamId,
      ownerId,
      token,
      persist: { token, serverUrl, teamId, ownerId },
      persistProfileId: profileId,
    };
  }

  if (saved) {
    // Intentional auto-load semantics: a saved profile takes precedence over
    // --team-id/--owner-id so a daemon restart auto-resumes the saved team
    // rather than silently switching teams. Explicit --team-id/--owner-id are
    // ignored here on purpose; to switch teams, clear the profile (or use a
    // different --profile-id). See resolveDeviceCredentials docstring.
    return { ok: true, teamId: saved.teamId, ownerId: saved.ownerId, token: saved.token };
  }

  if (configTeamId && configOwnerId) {
    return { ok: true, teamId: configTeamId, ownerId: configOwnerId };
  }

  return {
    ok: false,
    error:
      'Daemon requires --invite-code, or (--team-id and --owner-id), or a previously saved auth profile (initialize with --invite-code first).',
  };
}

export async function runDaemonNextCli(config: DaemonNextCliConfig = parseDaemonNextCliConfig()): Promise<void> {
  // --all-profiles branch runs BEFORE connectSocketIoClient: it never opens a
  // socket itself, it just fans out one runDaemonNextCli recursion per saved
  // profile. Each recursion clears allProfiles and overrides profileId, then
  // takes the normal single-profile path (including its own loadAuth(profileId)
  // for token injection — Decision 1 in the Task 5 plan). The repeated
  // createBuiltinScanProvider() per recursion is accepted (Decision 2).
  if (config.allProfiles) {
    const profiles = listAuthProfiles();
    if (profiles.length === 0) {
      // Throw (don't process.exit) so bin.ts's top-level .catch handles this
      // uniformly with every other failure path in runDaemonNextCli. The thrown
      // error surfaces via that handler and makes the empty-list path testable
      // without mocking process.exit.
      throw new Error('No saved AgentBean team profiles found. Initialize one first with --invite-code.');
    }
    // allSettled + per-profile catch so one bad profile cannot tear down the
    // fleet: a sibling connect failure is logged and recorded as 'rejected'
    // without killing other in-flight daemons (spec error-handling table:
    // "某 profile 连接失败 → 独立 catch，不拖垮其他").
    const subConfigs = expandAllProfiles(config, profiles);
    const results = await Promise.allSettled(
      subConfigs.map((subConfig) =>
        runDaemonNextCli(subConfig).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[all-profiles] profile ${subConfig.profileId} failed to start: ${message}`);
          throw error; // re-throw so allSettled records it as 'rejected'
        }),
      ),
    );
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    if (failedCount === results.length) {
      // Every profile failed — nothing is running. Exit non-zero so a
      // supervisor (systemd/pm2) restarts.
      process.exitCode = 1;
    }
    // Otherwise at least one profile's daemon is up; keep the process alive.
    return;
  }

  const socket = await connectSocketIoClient(config.serverUrl);
  const protocolSocket = createSocketIoDaemonSocket(socket);
  const cached = loadScanCache(config.profileId);
  const snapshot = cached ?? await createBuiltinScanProvider()();
  if (!cached) {
    saveScanCache(snapshot, config.profileId);
  }

  // Invite handshake runs first (network), then we hand off to the pure
  // resolveDeviceCredentials helper for the invite/saved/config decision.
  const inviteCredentials = config.inviteCode
    ? await waitForDeviceInviteCredentials(protocolSocket, {
      code: config.inviteCode,
      machineId: config.machineId,
      profileId: config.profileId,
      hostname: config.hostname,
      serverUrl: config.serverUrl,
    })
    : undefined;
  const saved = config.inviteCode ? null : loadAuth({ profileId: config.profileId });

  const resolved = resolveDeviceCredentials({
    inviteCode: config.inviteCode,
    inviteCredentials: inviteCredentials
      ? {
        teamId: inviteCredentials.teamId,
        ownerId: inviteCredentials.ownerId,
        token: inviteCredentials.token,
      }
      : undefined,
    saved,
    configTeamId: config.teamId,
    configOwnerId: config.ownerId,
    profileId: config.profileId,
    serverUrl: config.serverUrl,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  // Persist best-effort on the invite path (saveAuth never throws). profileId
  // is config.profileId for BOTH save and load (Decision 1), so the next start
  // with the same (or absent) --profile-id finds this profile. persistProfileId
  // is always set alongside persist (see resolveDeviceCredentials invariant).
  if (resolved.persist) {
    saveAuth(resolved.persist, { profileId: resolved.persistProfileId });
  }

  const { teamId, ownerId, token } = resolved;
  const device: DaemonDeviceConfig & { token?: string } = {
    teamId,
    ownerId,
    ...(token ? { token } : {}),
    machineId: config.machineId,
    profileId: config.profileId,
    hostname: config.hostname,
    daemonVersion: readDaemonVersion(),
    systemInfo: { ...collectSystemInfo(), daemonVersion: readDaemonVersion() },
  };
  await createDaemonProtocolClient({
    serverUrl: config.serverUrl,
    socket: protocolSocket,
    executor: createCommandExecutor({ fallbackPrefix: config.fallbackPrefix }),
    device,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    scan: createBuiltinScanProvider(),
    onScanChanged: (fresh) => saveScanCache(fresh, config.profileId),
    envResolver: async (envRef) => {
      if (!device.token) {
        throw new Error('Custom agent env resolver is not configured');
      }
      return createHttpEnvResolver({ serverUrl: config.serverUrl, token: device.token })(envRef);
    },
  }).start();
}

export async function waitForDeviceInviteCredentials(
  socket: DaemonProtocolSocket,
  input: { code: string; machineId?: string; profileId?: string; hostname?: string; serverUrl?: string },
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

function parseArgs(argv: string[]): { args: Record<string, string>; booleanFlags: Record<string, true> } {
  const args: Record<string, string> = {};
  const booleanFlags: Record<string, true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      booleanFlags[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return { args, booleanFlags };
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
