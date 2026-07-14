import { hostname as readHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_EVENTS, type DeviceInviteCredentialsDto } from '../../../packages/contracts/src/index.js';
import { createBuiltinScanProvider } from './scanner.js';
import { loadScanCache, saveScanCache } from './scan-cache.js';
import { collectSystemInfo, readDaemonVersion, readPiManagementRuntimeVersion } from './system-info.js';
import { createCommandExecutor } from './executor.js';
import { createDaemonProtocolClient, createHttpEnvResolver, createTaskClaimProtocolClient, type DaemonDeviceConfig, type DaemonProtocolSocket, type DaemonScanSnapshot } from './index.js';
import { loadYamlConfig } from './config.js';
import { clearAuth, listAuthProfiles, loadAuth, renameAuthProfile, saveAuth, type AuthData, type AuthProfile } from './auth-store.js';
import { sanitizeProfileId } from './profile-paths.js';
import { loadOrCreateMachineId } from './machine-id.js';
import { createDeviceServiceCore, type DeviceServiceComponent } from './device-service-core.js';
import { createEnvironmentManagementCredentialProvider } from './management-credential-provider.js';
import { createManagementDurableOutbox } from './management-durable-outbox.js';
import { createManagementModelAdapter } from './management-model-adapter.js';
import { createManagementWorkerProtocol, type ManagementWorkerProtocolSocket } from './management-worker-protocol.js';
import { createPiManagerWorkerHost } from './pi-manager-worker-host.js';

let globalErrorGuardsInstalled = false;
function installGlobalErrorGuards(): void {
  if (globalErrorGuardsInstalled) return;
  globalErrorGuardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    if (isSocketDisconnectError(reason)) {
      console.warn(`daemon unhandledRejection (suppressed): ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
  process.on('uncaughtException', (error) => {
    console.error(`daemon uncaughtException: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    process.exit(1);
  });
}

function isSocketDisconnectError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes('socket has been disconnected') || message.includes('Socket disconnected');
}

type CliStatusReporter = (message: string) => void;
type PiManagementRuntimeModule = typeof import('@agentbean/pi-management-runtime');
const PI_MANAGEMENT_RUNTIME_PACKAGE = '@agentbean/pi-management-runtime';

export interface SocketIoClientLike {
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
  serverUrlExplicit?: boolean;
  /**
   * When true, runDaemonNextCli enumerates every saved auth profile via
   * listAuthProfiles() and starts one daemon instance per profile
   * concurrently (each with allProfiles cleared and profileId overridden).
   * The all-profiles branch runs BEFORE connectSocketIoClient so it never
   * opens a socket itself; each recursion opens its own.
   */
  allProfiles?: boolean;
  listProfiles?: boolean;
  clearProfileId?: string;
  renameProfileFrom?: string;
  renameProfileTo?: string;
}

export interface DaemonNextCliDeps {
  connectSocket?: (serverUrl: string) => Promise<SocketIoClientLike>;
  listAuthProfiles?: typeof listAuthProfiles;
  loadAuth?: typeof loadAuth;
  saveAuth?: typeof saveAuth;
  clearAuth?: typeof clearAuth;
  renameAuthProfile?: typeof renameAuthProfile;
  loadScanCache?: typeof loadScanCache;
  saveScanCache?: typeof saveScanCache;
  createScanProvider?: typeof createBuiltinScanProvider;
  createProtocolClient?: typeof createDaemonProtocolClient;
  createExecutor?: typeof createCommandExecutor;
  collectSystemInfo?: typeof collectSystemInfo;
  readDaemonVersion?: typeof readDaemonVersion;
  readPiManagementRuntimeVersion?: typeof readPiManagementRuntimeVersion;
  createEnvResolver?: typeof createHttpEnvResolver;
  runDaemon?: (config: DaemonNextCliConfig, deps: DaemonNextCliDeps) => Promise<void>;
  createManagementWorkerHost?: (input: {
    socket: ManagementWorkerProtocolSocket;
    profileId: string;
    runtimeVersion: string;
  }) => Promise<DeviceServiceComponent>;
  /** 进程退出钩子（测试可注入）；默认 process.exit。用于 daemon 被告知设备删除后退出。 */
  exit?: (code: number) => void;
}

/**
 * Boolean (value-less) CLI flags. parseArgs treats every other `--flag` as
 * `--flag value`, so these must be recognised and not consume the next arg.
 */
const BOOLEAN_FLAGS = new Set(['all-profiles', 'list-profiles']);

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
  const serverUrl = args['server-url'] ?? env.AGENTBEAN_NEXT_SERVER_URL ?? yamlString('serverUrl');
  const clearProfileId = args['clear-profile'] ? sanitizeProfileId(args['clear-profile']) : undefined;
  const renameProfileFrom = args['rename-profile'] ? sanitizeProfileId(args['rename-profile']) : undefined;
  const renameProfileTo = args['to-profile'] ? sanitizeProfileId(args['to-profile']) : undefined;
  // NOTE: credential sufficiency is validated at run time inside runDaemonNextCli
  // (see resolveDeviceCredentials) so that "start with only saved auth" works:
  // neither --invite-code nor --team-id/--owner-id is required when a profile
  // has been persisted previously.
  return {
    serverUrl: trimTrailingSlash(
      serverUrl ?? 'http://127.0.0.1:4000',
    ),
    ...(teamId ? { teamId } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    machineId: args['machine-id'] ?? env.AGENTBEAN_NEXT_MACHINE_ID ?? yamlString('machineId'),
    profileId: sanitizeProfileId(args['profile-id'] ?? env.AGENTBEAN_NEXT_PROFILE_ID ?? yamlString('profileId') ?? 'default'),
    hostname: args.hostname ?? env.AGENTBEAN_NEXT_HOSTNAME ?? yamlString('hostname') ?? input.hostname ?? readHostname(),
    fallbackPrefix:
      args['fallback-prefix'] ?? env.AGENTBEAN_NEXT_FALLBACK_PREFIX ?? yamlString('fallbackPrefix') ?? 'daemon-next:',
    ...(configPath ? { configPath } : {}),
    ...(serverUrl ? { serverUrlExplicit: true } : {}),
    ...(booleanFlags['all-profiles'] ? { allProfiles: true } : {}),
    ...(booleanFlags['list-profiles'] ? { listProfiles: true } : {}),
    ...(clearProfileId ? { clearProfileId } : {}),
    ...(renameProfileFrom ? { renameProfileFrom } : {}),
    ...(renameProfileTo ? { renameProfileTo } : {}),
  };
}

export function resolveDaemonServerUrl(config: DaemonNextCliConfig, saved: AuthData | null): string {
  return saved && !config.serverUrlExplicit ? trimTrailingSlash(saved.serverUrl) : config.serverUrl;
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
  const { inviteCode: _inviteCode, ...configWithoutInvite } = config;
  return profiles.map((profile) => ({
    ...configWithoutInvite,
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
    serverUrlExplicit: Boolean(profile.serverUrl) || config.serverUrlExplicit,
    allProfiles: false,
  }));
}

export function createSocketIoDaemonSocket(socket: SocketIoClientLike): DaemonProtocolSocket {
  const handlerMap = new WeakMap<(payload: unknown, ack?: (result: unknown) => void) => Promise<void>, (...args: unknown[]) => void>();
  return {
    get connected() { return socket.connected; },
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
    onDisconnect(handler) {
      socket.on('disconnect', () => {
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

  if (!configTeamId) {
    return {
      ok: false,
      error: 'AGENTBEAN_NEXT_TEAM_ID or --team-id is required',
    };
  }

  if (!configOwnerId) {
    return {
      ok: false,
      error: 'AGENTBEAN_NEXT_OWNER_ID or --owner-id is required',
    };
  }

  return {
    ok: false,
    error:
      'Daemon requires --invite-code, or (--team-id and --owner-id), or a previously saved auth profile (initialize with --invite-code first).',
  };
}

export async function runDaemonNextCli(
  config: DaemonNextCliConfig = parseDaemonNextCliConfig(),
  deps: DaemonNextCliDeps = {},
): Promise<void> {
  installGlobalErrorGuards();
  const connectSocket = deps.connectSocket ?? connectSocketIoClient;
  const listAuthProfilesFn = deps.listAuthProfiles ?? listAuthProfiles;
  const loadAuthFn = deps.loadAuth ?? loadAuth;
  const saveAuthFn = deps.saveAuth ?? saveAuth;
  const clearAuthFn = deps.clearAuth ?? clearAuth;
  const renameAuthProfileFn = deps.renameAuthProfile ?? renameAuthProfile;
  const loadScanCacheFn = deps.loadScanCache ?? loadScanCache;
  const saveScanCacheFn = deps.saveScanCache ?? saveScanCache;
  const createScanProviderFn = deps.createScanProvider ?? createBuiltinScanProvider;
  const createProtocolClient = deps.createProtocolClient ?? createDaemonProtocolClient;
  const createExecutor = deps.createExecutor ?? createCommandExecutor;
  const collectSystemInfoFn = deps.collectSystemInfo ?? collectSystemInfo;
  const readDaemonVersionFn = deps.readDaemonVersion ?? readDaemonVersion;
  const readPiManagementRuntimeVersionFn = deps.readPiManagementRuntimeVersion ?? readPiManagementRuntimeVersion;
  const createEnvResolver = deps.createEnvResolver ?? createHttpEnvResolver;
  const runDaemon = deps.runDaemon ?? runDaemonNextCli;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const createManagementWorkerHost = deps.createManagementWorkerHost ?? createDefaultManagementWorkerHost;

  if (config.listProfiles) {
    const profiles = listAuthProfilesFn();
    if (profiles.length === 0) {
      console.log('No saved AgentBean team profiles.');
      return;
    }
    console.log('Saved AgentBean team profiles:');
    for (const profile of profiles) {
      console.log(`- ${profile.profileId} team=${profile.teamId} server=${profile.serverUrl}`);
    }
    return;
  }

  if (config.clearProfileId) {
    clearAuthFn({ profileId: config.clearProfileId });
    console.log(`Cleared AgentBean profile "${config.clearProfileId}".`);
    return;
  }

  if (config.renameProfileFrom || config.renameProfileTo) {
    if (!config.renameProfileFrom || !config.renameProfileTo) {
      throw new Error('Both --rename-profile <from> and --to-profile <to> are required.');
    }
    const result = renameAuthProfileFn({
      fromProfileId: config.renameProfileFrom,
      toProfileId: config.renameProfileTo,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    console.log(`Renamed AgentBean profile "${config.renameProfileFrom}" to "${result.profileId}".`);
    return;
  }

  // --all-profiles branch runs BEFORE connectSocketIoClient: it never opens a
  // socket itself, it just fans out one runDaemonNextCli recursion per saved
  // profile. Each recursion clears allProfiles and overrides profileId, then
  // takes the normal single-profile path (including its own loadAuth(profileId)
  // for token injection — Decision 1 in the Task 5 plan). The repeated
  // createBuiltinScanProvider() per recursion is accepted (Decision 2).
  if (config.allProfiles) {
    const profiles = listAuthProfilesFn();
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
        runDaemon(subConfig, deps).catch((error) => {
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

  const saved = config.inviteCode ? null : loadAuthFn({ profileId: config.profileId });
  const serverUrl = resolveDaemonServerUrl(config, saved);
  const machineId = config.machineId ?? loadOrCreateMachineId();
  const reportInviteStatus: CliStatusReporter | undefined = config.inviteCode
    ? (message) => console.log(message)
    : undefined;
  if (config.inviteCode) {
    console.log(`Connecting to AgentBean at ${serverUrl}...`);
  }
  let resolved: ResolveDeviceCredentialsResult | undefined;
  if (!config.inviteCode) {
    resolved = resolveDeviceCredentials({
      saved,
      configTeamId: config.teamId,
      configOwnerId: config.ownerId,
      profileId: config.profileId,
      serverUrl,
    });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
  }

  const socket = await connectSocket(serverUrl);
  const protocolSocket = createSocketIoDaemonSocket(socket);
  const cached = loadScanCacheFn(config.profileId);
  if (cached) {
    console.log(`Using cached AgentBean device scan for profile "${config.profileId}".`);
  } else {
    console.log('Scanning local AgentBean device capabilities...');
  }
  const snapshot = cached ?? await createScanProviderFn()();
  reportScanSnapshot(snapshot, { cached: Boolean(cached) });
  if (!cached) {
    saveScanCacheFn(snapshot, config.profileId);
  }

  // Invite handshake runs first (network), then we hand off to the pure
  // resolveDeviceCredentials helper for the invite/saved/config decision.
  const inviteCredentials = config.inviteCode
    ? await waitForDeviceInviteCredentials(protocolSocket, {
      code: config.inviteCode,
      machineId,
      profileId: config.profileId,
      hostname: config.hostname,
      serverUrl,
    }, { ...(reportInviteStatus ? { onStatus: reportInviteStatus } : {}) })
    : undefined;
  if (config.inviteCode) {
    console.log('Registration complete! Starting daemon...');
  }

  resolved ??= resolveDeviceCredentials({
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
    serverUrl,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }

  // Persist best-effort on the invite path (saveAuth never throws). profileId
  // is config.profileId for BOTH save and load (Decision 1), so the next start
  // with the same (or absent) --profile-id finds this profile. persistProfileId
  // is always set alongside persist (see resolveDeviceCredentials invariant).
  if (resolved.persist) {
    saveAuthFn(resolved.persist, { profileId: resolved.persistProfileId });
  }

  const { teamId, ownerId, token } = resolved;
  const daemonVersion = readDaemonVersionFn();
  const device: DaemonDeviceConfig & { token?: string } = {
    teamId,
    ownerId,
    ...(token ? { token } : {}),
    machineId,
    profileId: config.profileId,
    hostname: config.hostname,
    daemonVersion,
    systemInfo: { ...collectSystemInfoFn(), daemonVersion },
  };
  const dispatchClient = createProtocolClient({
    serverUrl,
    socket: protocolSocket,
    executor: createExecutor({ fallbackPrefix: config.fallbackPrefix }),
    device,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    scan: createScanProviderFn(),
    onScanChanged: (fresh) => {
      reportScanSnapshot(fresh, { updated: true });
      saveScanCacheFn(fresh, config.profileId);
    },
    onCredentialsChanged: (credentials) => {
      saveAuthFn({
        token: credentials.token,
        serverUrl,
        teamId: credentials.teamId ?? teamId,
        ownerId: credentials.ownerId ?? ownerId,
      }, { profileId: config.profileId });
    },
    onDeviceRemoved: () => {
      // 设备已被服务端删除：关闭重连并退出进程，避免持续重连把已删设备 upsert 复活。
      console.log('Device removed by server; shutting down daemon.');
      socket.disconnect();
      exit(0);
    },
    envResolver: async (envRef) => {
      if (!device.token) {
        throw new Error('Custom agent env resolver is not configured');
      }
      return createEnvResolver({ serverUrl, token: device.token })(envRef);
    },
  });
  const managementWorkerHost = await createManagementWorkerHost({
    socket: protocolSocket,
    profileId: config.profileId,
    runtimeVersion: readPiManagementRuntimeVersionFn(),
  });
  const taskClaimClient = createTaskClaimProtocolClient({
    socket: protocolSocket,
    getDeviceId: () => dispatchClient.deviceId,
  });
  await createDeviceServiceCore({ dispatchClient, taskClaimClient, managementWorkerHost }).start();
  if (config.inviteCode) {
    console.log(`AgentBean daemon connected for profile "${config.profileId}".`);
  }
}

async function createDefaultManagementWorkerHost(input: {
  socket: ManagementWorkerProtocolSocket;
  profileId: string;
  runtimeVersion: string;
}): Promise<DeviceServiceComponent> {
  const outbox = await createManagementDurableOutbox({ profileId: input.profileId });
  const credentialProvider = createEnvironmentManagementCredentialProvider();
  const protocol = createManagementWorkerProtocol({
    socket: input.socket,
    workerInstanceId: randomUUID(),
    profileId: input.profileId,
    runtimeVersion: input.runtimeVersion,
  });
  return createPiManagerWorkerHost({
    profileId: input.profileId,
    runtimeVersion: input.runtimeVersion,
    protocol,
    credentialProvider,
    outbox,
    createRuntimeFactory: async ({ credential, toolExecutor }) => {
      // daemon tests run before workspace package builds, so Vite must not resolve this
      // published-package boundary eagerly. Production Node resolves the exact dependency
      // only after a usable local model credential makes the runtime necessary.
      const { createManagementRuntimeFactory } = await import(
        /* @vite-ignore */ PI_MANAGEMENT_RUNTIME_PACKAGE
      ) as PiManagementRuntimeModule;
      return createManagementRuntimeFactory({
        model: createManagementModelAdapter({ credential }),
        toolExecutor,
      });
    },
  });
}

export function formatScanSnapshot(
  snapshot: DaemonScanSnapshot,
  options: { cached?: boolean; updated?: boolean } = {},
): string[] {
  const installedRuntimeCount = snapshot.runtimes.filter(isRuntimeAvailable).length;
  const lines = [
    `${options.updated ? 'Updated' : options.cached ? 'Cached' : 'Initial'} scan: ${installedRuntimeCount}/${snapshot.runtimes.length} coding runtimes available, ${snapshot.agents.length} agents discovered.`,
    'Coding runtimes:',
  ];

  if (snapshot.runtimes.length === 0) {
    lines.push('  - none');
  } else {
    for (const runtime of snapshot.runtimes) {
      const status = isRuntimeAvailable(runtime) ? 'installed' : 'missing';
      lines.push(`  - ${runtime.name} [${status}] ${runtime.adapterKind}${runtime.command ? ` -> ${runtime.command}` : ''}`);
    }
  }

  lines.push('Agents discovered:');
  if (snapshot.agents.length === 0) {
    lines.push('  - none');
  } else {
    for (const agent of snapshot.agents) {
      const command = formatAgentCommand(agent.command, agent.args);
      const cwd = agent.cwd ? ` cwd=${agent.cwd}` : '';
      lines.push(`  - ${agent.name} [${describeAgentSource(agent)}] ${agent.adapterKind}${command ? ` -> ${command}` : ''}${cwd}`);
    }
  }

  return lines;
}

function reportScanSnapshot(snapshot: DaemonScanSnapshot, options: { cached?: boolean; updated?: boolean } = {}): void {
  console.log(formatScanSnapshot(snapshot, options).join('\n'));
}

function isRuntimeAvailable(runtime: DaemonScanSnapshot['runtimes'][number]): boolean {
  return runtime.installed ?? Boolean(runtime.command);
}

function describeAgentSource(agent: DaemonScanSnapshot['agents'][number]): string {
  if (agent.discoverySource === 'runtime') {
    return 'coding runtime';
  }
  if (agent.discoverySource === 'gateway') {
    return 'AgentOS gateway';
  }
  if (agent.discoverySource === 'filesystem') {
    return 'local definition';
  }
  return agent.category;
}

function formatAgentCommand(command?: string, args?: string[]): string {
  if (!command) {
    return '';
  }
  return [command, ...(args ?? [])].join(' ');
}

export async function waitForDeviceInviteCredentials(
  socket: DaemonProtocolSocket,
  input: { code: string; machineId?: string; profileId?: string; hostname?: string; serverUrl?: string },
  options: { timeoutMs?: number; onStatus?: CliStatusReporter } = {},
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
  options.onStatus?.('Connected. Waiting for device invite approval...');
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
    new URL('../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
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
  throw new Error('socket.io-client is not installed; run npm ci at the repository root');
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
