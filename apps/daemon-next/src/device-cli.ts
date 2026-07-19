import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createDeviceControlClient, type DeviceControlClient } from './device-control-client.js';
import { deviceServicePaths } from './device-service-paths.js';
import { createDeviceServiceStateStore, type DeviceServiceState } from './device-service-state.js';
import {
  createMacOSLaunchAgentAdapter,
  removeMacOSLaunchAgentInstallation,
  writeMacOSLaunchAgentPlist,
  writeMacOSServicePayload,
} from './macos-launch-agent.js';
import type { PlatformServiceAdapter, PlatformServiceStatus } from './device-platform-service.js';
import { runDeviceService } from './device-service-runtime.js';
import { assertDeviceRuntimeOwner, type DeviceRuntimeOwner } from './device-runtime-owner.js';
import {
  cancelDeviceMigration,
  inspectDeviceMigration,
  planDeviceMigration,
  resumeDeviceMigration,
  startDeviceMigration,
  type DeviceMigrationDeps,
  type DeviceMigrationStatus,
} from './device-migration.js';
import { listAuthProfiles } from './auth-store.js';
import { sanitizeProfileId } from './profile-paths.js';
import {
  cleanupLegacyLinuxDeviceService,
  type LegacyLinuxCleanupResult,
} from './legacy-linux-device-service.js';

export type DeviceCliCommand = 'run' | 'connect' | 'install' | 'uninstall' | 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'migrate';
export type DeviceMigrationCommand = 'plan' | 'start' | 'status' | 'resume' | 'cancel';

export interface DeviceConnectInput {
  readonly inviteCode: string;
  readonly serverUrl: string;
  readonly profileId: string;
  readonly baseDir?: string;
}

export const DEVICE_CLI_EXIT = {
  success: 0,
  usage: 2,
  unavailable: 3,
  rejected: 4,
  platform: 5,
  drain: 6,
} as const;

export interface DeviceCliDeps {
  readonly platform?: NodeJS.Platform;
  readonly baseDir?: string;
  readonly home?: string;
  readonly xdgConfigHome?: string;
  readonly executablePath?: string;
  readonly nodeExecutablePath?: string;
  readonly createAdapter?: () => PlatformServiceAdapter;
  readonly controlClient?: DeviceControlClient;
  readonly runService?: () => Promise<void>;
  readonly waitForReady?: (client: DeviceControlClient, timeoutMs: number) => Promise<DeviceServiceState | null>;
  readonly followLog?: (path: string) => Promise<number>;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
  readonly assertRuntimeOwner?: (owner: DeviceRuntimeOwner) => Promise<void>;
  readonly writePayload?: typeof writeMacOSServicePayload;
  readonly writePlist?: typeof writeMacOSLaunchAgentPlist;
  readonly removeInstallation?: typeof removeMacOSLaunchAgentInstallation;
  readonly cleanupLegacyLinuxInstallation?: () => Promise<LegacyLinuxCleanupResult>;
  readonly migrate?: (command: DeviceMigrationCommand) => Promise<DeviceMigrationStatus>;
  readonly migrationDeps?: Pick<DeviceMigrationDeps, 'listLegacy' | 'listUnregisteredLegacyPids' | 'listInstalledLegacyExecutables' | 'isProcessAlive'>;
  readonly connectProfile?: (input: DeviceConnectInput) => Promise<{ profileId: string; teamId: string }>;
}

export async function runDeviceCli(argv: readonly string[], deps: DeviceCliDeps = {}): Promise<number> {
  const parsed = parseDeviceCliArgs(argv);
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  if (!parsed) {
    stderr('用法：agentbean device <connect|run|install|uninstall|status|start|stop|restart|logs|migrate> [选项]');
    return DEVICE_CLI_EXIT.usage;
  }
  const paths = deviceServicePaths(deps.baseDir);
  const client = deps.controlClient ?? createDeviceControlClient(paths.controlSocket);
  if (parsed.command === 'migrate') {
    const migrationCommand = parsed.migrationCommand;
    if (!migrationCommand) return DEVICE_CLI_EXIT.usage;
    try {
      const status = await (deps.migrate
        ?? ((command) => runMigrationCommand(command, deps, client, parsed.deadlineMs)))(migrationCommand);
      if (parsed.json) stdout(JSON.stringify(status));
      else stdout(formatDeviceMigrationStatus(status));
      return DEVICE_CLI_EXIT.success;
    } catch (error) {
      stderr(`Device Service 迁移失败（${stableReason(error instanceof Error ? error.message : String(error))}）。`);
      return DEVICE_CLI_EXIT.rejected;
    }
  }
  if (!isPlatformSupported(deps)) {
    if ((deps.platform ?? process.platform) === 'linux' && parsed.command === 'uninstall') {
      try {
        const result = await (deps.cleanupLegacyLinuxInstallation ?? (() => cleanupLegacyLinuxDeviceService({
          ...(deps.home ? { home: deps.home } : {}),
          ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
          ...(deps.xdgConfigHome ? { xdgConfigHome: deps.xdgConfigHome } : {}),
        })))();
        stdout(result === 'removed'
          ? '已停止并移除遗留 Linux Device Service；用户数据已保留。'
          : '未检测到遗留 Linux Device Service。');
        return DEVICE_CLI_EXIT.success;
      } catch {
        stderr('无法安全移除遗留 Linux Device Service。');
        return DEVICE_CLI_EXIT.platform;
      }
    }
    stderr('当前平台尚未支持 Device Service 系统注册。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (parsed.command === 'connect') {
    const connection = parsed.connection;
    if (!connection) return DEVICE_CLI_EXIT.usage;
    const platformBeforeConnect = await readPlatformStatus(deps);
    if (platformBeforeConnect.queryFailed) {
      stderr('无法读取系统服务管理器中的 Device Service 状态，未消耗设备邀请。');
      return DEVICE_CLI_EXIT.platform;
    }
    try {
      const connectProfile = deps.connectProfile ?? connectProfileWithInvite;
      await connectProfile({
        ...connection,
        ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
      });
      stdout(`Device Profile "${connection.profileId}" 已连接。`);
    } catch (error) {
      stderr(`设备连接失败（${stableReason(error instanceof Error ? error.message : String(error))}）。`);
      return DEVICE_CLI_EXIT.rejected;
    }
    const adapter = createPlatformAdapter(deps);
    const installed = await installService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
    if (installed !== DEVICE_CLI_EXIT.success) {
      stderr('Device Profile 已保存；请修复服务问题后运行 `agentbean device install`。');
      return installed;
    }
    if (platformBeforeConnect.running) {
      const restarted = await restartService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
      if (restarted !== DEVICE_CLI_EXIT.success) {
        stderr('Device Profile 已保存；请运行 `agentbean device restart` 重试加载。');
        return restarted;
      }
    }
    stdout('设备已交接给 Device Service，终端可以关闭。');
    return DEVICE_CLI_EXIT.success;
  }
  if (parsed.command === 'run') {
    try {
      await (deps.runService ?? (() => runDeviceService({ ...(deps.baseDir ? { baseDir: deps.baseDir } : {}) })))();
      return DEVICE_CLI_EXIT.success;
    } catch {
      stderr('Device Service 启动失败。请运行 `agentbean device status` 查看状态。');
      return DEVICE_CLI_EXIT.platform;
    }
  }
  if (parsed.command === 'logs') {
    if (!isPlatformSupported(deps)) return DEVICE_CLI_EXIT.platform;
    if (!parsed.follow) {
      stdout(paths.logFile);
      return DEVICE_CLI_EXIT.success;
    }
    return (deps.followLog ?? followLog)(paths.logFile);
  }
  if (parsed.command === 'status') {
    const current = await readCurrentState(client, paths.stateFile);
    const platformStatus = await readPlatformStatus(deps);
    if (platformStatus.queryFailed && !current.reachable) {
      stderr('无法读取系统服务管理器中的 Device Service 状态。');
      return DEVICE_CLI_EXIT.platform;
    }
    const running = current.reachable || platformStatus.running;
    if (!current.state || current.state.phase === 'stopped' || !running) {
      if (parsed.json) stdout(JSON.stringify({
        schemaVersion: 1,
        installed: platformStatus.installed,
        running: false,
        platformQueryFailed: platformStatus.queryFailed,
        state: current.state,
      }));
      else stdout('Device Service 未运行。');
      return DEVICE_CLI_EXIT.unavailable;
    }
    if (parsed.json) stdout(JSON.stringify({
      schemaVersion: 1,
      installed: platformStatus.installed,
      running: true,
      platformQueryFailed: platformStatus.queryFailed,
      state: current.state,
    }));
    else stdout(formatDeviceServiceState(current.state));
    return current.state.phase === 'failed' || !current.reachable
      ? DEVICE_CLI_EXIT.rejected
      : DEVICE_CLI_EXIT.success;
  }
  const adapter = createPlatformAdapter(deps);
  if (parsed.command === 'install') return installService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'uninstall') return uninstallService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'start') return startService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'stop') return stopService(adapter, client, parsed.deadlineMs, stdout, stderr);
  return restartService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
}

async function restartService(
  adapter: PlatformServiceAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  const stopped = await stopService(adapter, client, deadlineMs, stdout, stderr);
  if (stopped !== DEVICE_CLI_EXIT.success && stopped !== DEVICE_CLI_EXIT.unavailable) return stopped;
  const platformStopped = await waitForPlatformStopped(adapter, deadlineMs);
  if (platformStopped === 'error') {
    stderr('无法确认旧 Device Service 已退出。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (platformStopped === 'timeout') {
    stderr('旧 Device Service 未在截止时间内退出，未启动第二个实例。');
    return DEVICE_CLI_EXIT.drain;
  }
  return startService(adapter, client, deadlineMs, deps, stdout, stderr);
}

async function installService(
  adapter: PlatformServiceAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  try {
    await (deps.assertRuntimeOwner ?? ((owner) => assertDeviceRuntimeOwner(owner, deps.baseDir)))('device-service');
  } catch {
    try {
      await (deps.migrate ?? ((command) => runMigrationCommand(command, deps, client, deadlineMs)))('start');
      await (deps.assertRuntimeOwner ?? ((owner) => assertDeviceRuntimeOwner(owner, deps.baseDir)))('device-service');
    } catch (error) {
      stderr(`Device Service 无法安全接管 Legacy Daemon（${stableReason(error instanceof Error ? error.message : String(error))}）。`);
      return DEVICE_CLI_EXIT.rejected;
    }
  }
  const sourceExecutablePath = deps.executablePath ?? process.argv[1];
  if (!sourceExecutablePath) return DEVICE_CLI_EXIT.platform;
  try {
    const payloadFile = await (deps.writePayload ?? writeMacOSServicePayload)({
      sourceExecutablePath,
      nodeExecutablePath: deps.nodeExecutablePath ?? process.execPath,
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    });
    await writePlatformDefinition(deps, payloadFile);
    const status = await adapter.status();
    if (!status.loaded) {
      const bootstrapped = await adapter.bootstrap();
      if (bootstrapped.exitCode !== 0) throw new Error('PLATFORM_SERVICE_INSTALL_FAILED');
    } else if (!status.running) {
      const started = await adapter.start();
      if (started.exitCode !== 0) throw new Error('PLATFORM_SERVICE_INSTALL_FAILED');
    }
    const state = await (deps.waitForReady ?? waitForReady)(client, deadlineMs);
    if (!state || (state.phase !== 'running' && state.phase !== 'degraded')) {
      stderr('Device Service 安装后未在截止时间内就绪。');
      return DEVICE_CLI_EXIT.drain;
    }
    stdout('Device Service 已安装并启动。');
    return DEVICE_CLI_EXIT.success;
  } catch {
    stderr('Device Service 安装失败。');
    return DEVICE_CLI_EXIT.platform;
  }
}

async function uninstallService(
  adapter: PlatformServiceAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  try {
    const status = await adapter.status();
    if (status.queryFailed && status.installed) throw new Error('PLATFORM_SERVICE_QUERY_FAILED');
    if (status.loaded || status.running) {
      const stopped = await stopService(adapter, client, deadlineMs, stdout, stderr);
      if (stopped !== DEVICE_CLI_EXIT.success && stopped !== DEVICE_CLI_EXIT.unavailable) return stopped;
    }
    if (status.loaded) {
      const removed = await adapter.bootout();
      if (removed.exitCode !== 0) throw new Error('PLATFORM_SERVICE_UNINSTALL_FAILED');
    }
    await removePlatformInstallation(deps);
    stdout('Device Service 已卸载；用户数据已保留。');
    return DEVICE_CLI_EXIT.success;
  } catch {
    stderr('Device Service 卸载失败。');
    return DEVICE_CLI_EXIT.platform;
  }
}

export function formatDeviceServiceState(state: DeviceServiceState): string {
  return [
    `Device Service: ${state.phase}`,
    `Profiles: ${state.profiles.healthy}/${state.profiles.total} healthy`,
    `Active work: ${state.activeWorkCount}`,
    `Outbox pending: ${state.outboxPendingCount}`,
    `Reason: ${state.reasonCode}`,
  ].join('\n');
}

async function startService(
  adapter: PlatformServiceAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  let status: Awaited<ReturnType<PlatformServiceAdapter['status']>>;
  try {
    status = await adapter.status();
  } catch {
    stderr('无法读取系统服务管理器中的 Device Service 状态。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (!status.installed) {
    stderr('Device Service 尚未安装。');
    return DEVICE_CLI_EXIT.unavailable;
  }
  if (status.queryFailed) {
    stderr('无法读取系统服务管理器中的 Device Service 状态。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (status.running) {
    stdout('Device Service 已在运行。');
    return DEVICE_CLI_EXIT.success;
  }
  let started;
  try {
    started = await adapter.start();
  } catch {
    stderr('系统服务管理器无法启动 Device Service。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (started.exitCode !== 0) {
    stderr('系统服务管理器无法启动 Device Service。');
    return DEVICE_CLI_EXIT.platform;
  }
  const state = await (deps.waitForReady ?? waitForReady)(client, deadlineMs);
  if (!state || (state.phase !== 'running' && state.phase !== 'degraded')) {
    stderr('Device Service 未在截止时间内就绪。');
    return DEVICE_CLI_EXIT.drain;
  }
  stdout('Device Service 已启动。');
  return DEVICE_CLI_EXIT.success;
}

async function stopService(
  adapter: PlatformServiceAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  const requestId = randomUUID();
  try {
    const draining = await client.request({ schemaVersion: 1, requestId, command: 'begin-drain', deadlineMs }, deadlineMs);
    if (!draining.ok) return handleStopFailure(adapter, draining.reasonCode, stderr);
    const stopped = await client.request({ schemaVersion: 1, requestId: randomUUID(), command: 'shutdown', deadlineMs }, deadlineMs);
    if (!stopped.ok) return handleStopFailure(adapter, stopped.reasonCode, stderr);
    stdout('Device Service 已停止。');
    return DEVICE_CLI_EXIT.success;
  } catch (error) {
    if (error instanceof Error && error.message === 'SERVICE_DRAIN_TIMEOUT') {
      return forceStop(adapter, 'SERVICE_DRAIN_TIMEOUT', stderr);
    }
    let platformStatus;
    try {
      platformStatus = await adapter.status();
    } catch {
      stderr('无法读取系统服务管理器中的 Device Service 状态。');
      return DEVICE_CLI_EXIT.platform;
    }
    if (platformStatus.queryFailed) {
      stderr('无法读取系统服务管理器中的 Device Service 状态。');
      return DEVICE_CLI_EXIT.platform;
    }
    if (!platformStatus.running) {
      stdout('Device Service 已停止。');
      return DEVICE_CLI_EXIT.unavailable;
    }
    stderr('Device Service 控制端不可用，未执行强制停止。');
    return DEVICE_CLI_EXIT.rejected;
  }
}

function handleStopFailure(
  adapter: PlatformServiceAdapter,
  reasonCode: string,
  stderr: (message: string) => void,
): Promise<number> | number {
  if (reasonCode === 'SERVICE_DRAIN_TIMEOUT') return forceStop(adapter, reasonCode, stderr);
  stderr(`Device Service 拒绝停止请求（${stableReason(reasonCode)}）。`);
  return DEVICE_CLI_EXIT.rejected;
}

async function forceStop(
  adapter: PlatformServiceAdapter,
  reasonCode: string,
  stderr: (message: string) => void,
): Promise<number> {
  let killed;
  try {
    killed = await adapter.kill();
  } catch {
    stderr('Device Service 排空失败，系统服务管理器强制停止也失败。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (killed.exitCode !== 0) {
    stderr('Device Service 排空失败，系统服务管理器强制停止也失败。');
    return DEVICE_CLI_EXIT.platform;
  }
  stderr(`Device Service 未能正常排空（${stableReason(reasonCode)}），已请求系统服务管理器强制停止。`);
  return DEVICE_CLI_EXIT.drain;
}

async function readCurrentState(
  client: DeviceControlClient,
  stateFile: string,
): Promise<{ state: DeviceServiceState | null; reachable: boolean }> {
  try {
    const response = await client.request({ schemaVersion: 1, requestId: randomUUID(), command: 'status' });
    if (response.ok) return { state: response.state, reachable: true };
  } catch {
    // Fall back to the last atomic snapshot when the process is not reachable.
  }
  try {
    return { state: await createDeviceServiceStateStore(stateFile).read(), reachable: false };
  } catch {
    return { state: null, reachable: false };
  }
}

async function waitForReady(client: DeviceControlClient, timeoutMs: number): Promise<DeviceServiceState | null> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    let state: DeviceServiceState | null = null;
    try {
      const response = await client.request({ schemaVersion: 1, requestId: randomUUID(), command: 'status' });
      if (response.ok) state = response.state;
    } catch {
      // The socket may not exist yet while launchd is starting the service.
    }
    if (state && (state.phase === 'running' || state.phase === 'degraded' || state.phase === 'failed')) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForPlatformStopped(
  adapter: PlatformServiceAdapter,
  timeoutMs: number,
): Promise<'stopped' | 'timeout' | 'error'> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      const status = await adapter.status();
      if (status.queryFailed) return 'error';
      if (!status.running) return 'stopped';
    } catch {
      return 'error';
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 'timeout';
}

async function readPlatformStatus(deps: DeviceCliDeps): Promise<PlatformServiceStatus> {
  if (!isPlatformSupported(deps)) return { installed: false, loaded: false, running: false, queryFailed: false };
  try {
    return await createPlatformAdapter(deps).status();
  } catch {
    return { installed: false, loaded: false, running: false, queryFailed: true };
  }
}

function isPlatformSupported(deps: DeviceCliDeps): boolean {
  return (deps.platform ?? process.platform) === 'darwin';
}

function createPlatformAdapter(deps: DeviceCliDeps): PlatformServiceAdapter {
  if (deps.createAdapter) return deps.createAdapter();
  const common = {
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
  };
  return createMacOSLaunchAgentAdapter(common);
}

async function writePlatformDefinition(deps: DeviceCliDeps, executablePath: string): Promise<string> {
  const common = {
    executablePath,
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
  };
  return (deps.writePlist ?? writeMacOSLaunchAgentPlist)(common);
}

async function removePlatformInstallation(deps: DeviceCliDeps): Promise<void> {
  const common = {
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
  };
  if (deps.removeInstallation) return deps.removeInstallation(common);
  return removeMacOSLaunchAgentInstallation(common);
}

async function followLog(path: string): Promise<number> {
  try {
    await access(path);
  } catch {
    return DEVICE_CLI_EXIT.unavailable;
  }
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/tail', ['-n', '100', '-f', path], { stdio: 'inherit' });
    child.once('exit', (code) => resolve(code === 0 ? DEVICE_CLI_EXIT.success : DEVICE_CLI_EXIT.platform));
    child.once('error', () => resolve(DEVICE_CLI_EXIT.platform));
  });
}

function parseDeviceCliArgs(argv: readonly string[]): {
  command: DeviceCliCommand;
  migrationCommand?: DeviceMigrationCommand;
  connection?: { inviteCode: string; serverUrl: string; profileId: string };
  json: boolean;
  follow: boolean;
  deadlineMs: number;
} | null {
  const command = argv[0];
  if (command !== 'connect' && command !== 'run' && command !== 'install' && command !== 'uninstall' && command !== 'status' && command !== 'start'
    && command !== 'stop' && command !== 'restart' && command !== 'logs' && command !== 'migrate') return null;
  let deadlineMs = 30_000;
  let json = false;
  let follow = false;
  let migrationCommand: DeviceMigrationCommand | undefined;
  let inviteCode: string | undefined;
  let serverUrl: string | undefined;
  let profileId: string | undefined;
  let startIndex = 1;
  if (command === 'migrate') {
    const action = argv[1];
    if (action !== 'plan' && action !== 'start' && action !== 'status' && action !== 'resume' && action !== 'cancel') return null;
    migrationCommand = action;
    startIndex = 2;
  }
  for (let index = startIndex; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json' && (command === 'status' || command === 'migrate')) json = true;
    else if (value === '--follow' && command === 'logs') follow = true;
    else if (value === '--invite-code' && command === 'connect') inviteCode = argv[++index];
    else if (value === '--server-url' && command === 'connect') serverUrl = argv[++index];
    else if (value === '--profile-id' && command === 'connect') profileId = argv[++index];
    else if (value === '--deadline-ms') {
      const parsed = Number(argv[++index]);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 300_000) return null;
      deadlineMs = parsed;
    } else return null;
  }
  if (command === 'connect') {
    if (!inviteCode || !serverUrl || !profileId) return null;
    return {
      command,
      connection: { inviteCode, serverUrl: serverUrl.replace(/\/+$/, ''), profileId: sanitizeProfileId(profileId) },
      json,
      follow,
      deadlineMs,
    };
  }
  return { command, ...(migrationCommand ? { migrationCommand } : {}), json, follow, deadlineMs };
}

async function connectProfileWithInvite(input: DeviceConnectInput): Promise<{ profileId: string; teamId: string }> {
  const { connectDeviceProfile } = await import('./cli.js');
  return connectDeviceProfile(input);
}

function stableReason(reasonCode: string): string {
  return /^[A-Z0-9_]{1,80}$/.test(reasonCode) ? reasonCode : 'SERVICE_CONTROL_UNAVAILABLE';
}

async function runMigrationCommand(
  command: DeviceMigrationCommand,
  cliDeps: DeviceCliDeps,
  client: DeviceControlClient,
  deadlineMs: number,
): Promise<DeviceMigrationStatus> {
  const migrationDeps = createMigrationDeps(cliDeps, client, deadlineMs);
  if (command === 'plan') return planDeviceMigration(migrationDeps);
  if (command === 'start') return startDeviceMigration(migrationDeps);
  if (command === 'status') return inspectDeviceMigration(migrationDeps);
  if (command === 'resume') return resumeDeviceMigration(migrationDeps);
  return cancelDeviceMigration(migrationDeps);
}

function createMigrationDeps(
  deps: DeviceCliDeps,
  client: DeviceControlClient,
  deadlineMs: number,
): DeviceMigrationDeps {
  const base = deps.baseDir ? { baseDir: deps.baseDir } : {};
  const adapter = () => createPlatformAdapter(deps);
  const stopMigrationService = async () => {
    try {
      const response = await client.request({
        schemaVersion: 1,
        requestId: randomUUID(),
        command: 'shutdown',
        deadlineMs,
      }, deadlineMs);
      if (response.ok) return;
    } catch {
      // Fall through to the trusted platform adapter when the control endpoint is unavailable.
    }
    if (!isPlatformSupported(deps)) throw new Error('MIGRATION_PLATFORM_UNSUPPORTED');
    const platformAdapter = adapter();
    const status = await platformAdapter.status();
    if (status.queryFailed) throw new Error('MIGRATION_SERVICE_STATUS_FAILED');
    if (!status.running) return;
    const killed = await platformAdapter.kill();
    if (killed.exitCode !== 0) throw new Error('MIGRATION_SERVICE_STOP_FAILED');
  };
  return {
    ...base,
    ...deps.migrationDeps,
    readPlatformSupported: () => isPlatformSupported(deps),
    readSavedProfileCount: () => listAuthProfiles(base).length,
    verifyMigrationService: async () => {
      const state = await readReachableState(client);
      return Boolean(state && (state.phase === 'running' || state.phase === 'degraded') && state.profiles.total === 0);
    },
    prepareMigrationService: async () => {
      if (!isPlatformSupported(deps)) throw new Error('MIGRATION_PLATFORM_UNSUPPORTED');
      if (listAuthProfiles(base).length === 0) throw new Error('SERVICE_NO_PROFILES');
      const sourceExecutablePath = deps.executablePath ?? process.argv[1];
      if (!sourceExecutablePath) throw new Error('MIGRATION_EXECUTABLE_UNAVAILABLE');
      const payloadFile = await (deps.writePayload ?? writeMacOSServicePayload)({
        sourceExecutablePath,
        nodeExecutablePath: deps.nodeExecutablePath ?? process.execPath,
        ...base,
      });
      await writePlatformDefinition(deps, payloadFile);
      const platformAdapter = adapter();
      const status = await platformAdapter.status();
      const result = !status.loaded ? await platformAdapter.bootstrap() : await platformAdapter.start();
      if (result.exitCode !== 0) throw new Error('MIGRATION_SERVICE_START_FAILED');
      const state = await waitForState(client, deadlineMs, (candidate) => candidate.profiles.total === 0);
      if (!state) throw new Error('MIGRATION_SERVICE_NOT_HEALTHY');
    },
    stopMigrationService,
    activateDeviceService: async () => {
      if (!isPlatformSupported(deps)) throw new Error('MIGRATION_PLATFORM_UNSUPPORTED');
      await stopMigrationService();
      const started = await adapter().start();
      if (started.exitCode !== 0) throw new Error('DEVICE_SERVICE_ACTIVATION_FAILED');
      const state = await waitForState(client, deadlineMs, (candidate) => candidate.profiles.total > 0);
      if (!state) throw new Error('DEVICE_SERVICE_ACTIVATION_FAILED');
    },
  };
}

async function readReachableState(client: DeviceControlClient): Promise<DeviceServiceState | null> {
  try {
    const response = await client.request({ schemaVersion: 1, requestId: randomUUID(), command: 'status' });
    return response.ok ? response.state : null;
  } catch {
    return null;
  }
}

async function waitForState(
  client: DeviceControlClient,
  timeoutMs: number,
  predicate: (state: DeviceServiceState) => boolean,
): Promise<DeviceServiceState | null> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    const state = await readReachableState(client);
    if (state && (state.phase === 'running' || state.phase === 'degraded') && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function formatDeviceMigrationStatus(status: DeviceMigrationStatus): string {
  return [
    `Migration: ${status.phase}`,
    `Runtime owner: ${status.owner}`,
    `Legacy runtimes: ${status.health.legacyRuntimeCount}`,
    `Unregistered legacy runtimes: ${status.health.unregisteredLegacyRuntimeCount}`,
    `Installed legacy executables: ${status.health.installedLegacyExecutableCount}`,
    `Platform supported: ${status.health.platformSupported}`,
    `Saved profiles: ${status.health.savedProfileCount}`,
    `Data policy: ${status.health.dataPolicy}`,
  ].join('\n');
}
