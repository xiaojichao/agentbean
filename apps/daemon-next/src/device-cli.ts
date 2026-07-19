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
  type MacOSLaunchAgentAdapter,
} from './macos-launch-agent.js';
import { runDeviceService } from './device-service-runtime.js';
import { assertDeviceRuntimeOwner, type DeviceRuntimeOwner } from './device-runtime-owner.js';

export type DeviceCliCommand = 'run' | 'install' | 'uninstall' | 'status' | 'start' | 'stop' | 'restart' | 'logs';

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
  readonly executablePath?: string;
  readonly nodeExecutablePath?: string;
  readonly createAdapter?: () => MacOSLaunchAgentAdapter;
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
}

export async function runDeviceCli(argv: readonly string[], deps: DeviceCliDeps = {}): Promise<number> {
  const parsed = parseDeviceCliArgs(argv);
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  if (!parsed) {
    stderr('用法：agentbean device <run|install|uninstall|status|start|stop|restart|logs> [--json] [--follow] [--deadline-ms N]');
    return DEVICE_CLI_EXIT.usage;
  }
  const paths = deviceServicePaths(deps.baseDir);
  const client = deps.controlClient ?? createDeviceControlClient(paths.controlSocket);
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
    if (!parsed.follow) {
      stdout(paths.logFile);
      return DEVICE_CLI_EXIT.success;
    }
    return (deps.followLog ?? followLog)(paths.logFile);
  }
  if (parsed.command === 'status') {
    const current = await readCurrentState(client, paths.stateFile);
    const platformStatus = await readPlatformStatus(deps);
    const running = current.reachable || platformStatus.running;
    if (!current.state || current.state.phase === 'stopped' || !running) {
      if (parsed.json) stdout(JSON.stringify({
        schemaVersion: 1,
        installed: platformStatus.installed,
        running: false,
        state: current.state,
      }));
      else stdout('Device Service 未运行。');
      return DEVICE_CLI_EXIT.unavailable;
    }
    if (parsed.json) stdout(JSON.stringify({
      schemaVersion: 1,
      installed: platformStatus.installed,
      running: true,
      state: current.state,
    }));
    else stdout(formatDeviceServiceState(current.state));
    return current.state.phase === 'failed' || !current.reachable
      ? DEVICE_CLI_EXIT.rejected
      : DEVICE_CLI_EXIT.success;
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    stderr('当前平台尚未支持 Device Service 系统注册。');
    return DEVICE_CLI_EXIT.platform;
  }
  const adapter = deps.createAdapter?.() ?? createMacOSLaunchAgentAdapter({
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
  });
  if (parsed.command === 'install') return installService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'uninstall') return uninstallService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'start') return startService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
  if (parsed.command === 'stop') return stopService(adapter, client, parsed.deadlineMs, stdout, stderr);
  const stopped = await stopService(adapter, client, parsed.deadlineMs, stdout, stderr);
  if (stopped !== DEVICE_CLI_EXIT.success && stopped !== DEVICE_CLI_EXIT.unavailable) return stopped;
  return startService(adapter, client, parsed.deadlineMs, deps, stdout, stderr);
}

async function installService(
  adapter: MacOSLaunchAgentAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  try {
    await (deps.assertRuntimeOwner ?? ((owner) => assertDeviceRuntimeOwner(owner, deps.baseDir)))('device-service');
  } catch {
    stderr('Device Service 尚未完成 Legacy Daemon 所有权迁移。');
    return DEVICE_CLI_EXIT.rejected;
  }
  const sourceExecutablePath = deps.executablePath ?? process.argv[1];
  if (!sourceExecutablePath) return DEVICE_CLI_EXIT.platform;
  try {
    const payloadFile = await (deps.writePayload ?? writeMacOSServicePayload)({
      sourceExecutablePath,
      nodeExecutablePath: deps.nodeExecutablePath ?? process.execPath,
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    });
    await (deps.writePlist ?? writeMacOSLaunchAgentPlist)({
      executablePath: payloadFile,
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    });
    const status = await adapter.status();
    if (!status.loaded) {
      const bootstrapped = await adapter.bootstrap();
      if (bootstrapped.exitCode !== 0) throw new Error('LAUNCH_AGENT_INSTALL_FAILED');
    } else if (!status.running) {
      const started = await adapter.start();
      if (started.exitCode !== 0) throw new Error('LAUNCH_AGENT_INSTALL_FAILED');
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
  adapter: MacOSLaunchAgentAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  try {
    const status = await adapter.status();
    if (status.loaded || status.running) {
      const stopped = await stopService(adapter, client, deadlineMs, stdout, stderr);
      if (stopped !== DEVICE_CLI_EXIT.success && stopped !== DEVICE_CLI_EXIT.unavailable) return stopped;
    }
    if (status.loaded) {
      const removed = await adapter.bootout();
      if (removed.exitCode !== 0) throw new Error('LAUNCH_AGENT_UNINSTALL_FAILED');
    }
    await (deps.removeInstallation ?? removeMacOSLaunchAgentInstallation)({
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    });
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
  adapter: MacOSLaunchAgentAdapter,
  client: DeviceControlClient,
  deadlineMs: number,
  deps: DeviceCliDeps,
  stdout: (message: string) => void,
  stderr: (message: string) => void,
): Promise<number> {
  let status: Awaited<ReturnType<MacOSLaunchAgentAdapter['status']>>;
  try {
    status = await adapter.status();
  } catch {
    stderr('无法读取 launchd Device Service 状态。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (!status.installed) {
    stderr('Device Service 尚未安装。');
    return DEVICE_CLI_EXIT.unavailable;
  }
  if (status.running) {
    stdout('Device Service 已在运行。');
    return DEVICE_CLI_EXIT.success;
  }
  let started;
  try {
    started = await adapter.start();
  } catch {
    stderr('launchd 无法启动 Device Service。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (started.exitCode !== 0) {
    stderr('launchd 无法启动 Device Service。');
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
  adapter: MacOSLaunchAgentAdapter,
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
      stderr('无法读取 launchd Device Service 状态。');
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
  adapter: MacOSLaunchAgentAdapter,
  reasonCode: string,
  stderr: (message: string) => void,
): Promise<number> | number {
  if (reasonCode === 'SERVICE_DRAIN_TIMEOUT') return forceStop(adapter, reasonCode, stderr);
  stderr(`Device Service 拒绝停止请求（${stableReason(reasonCode)}）。`);
  return DEVICE_CLI_EXIT.rejected;
}

async function forceStop(
  adapter: MacOSLaunchAgentAdapter,
  reasonCode: string,
  stderr: (message: string) => void,
): Promise<number> {
  let killed;
  try {
    killed = await adapter.kill();
  } catch {
    stderr('Device Service 排空失败，launchd 强制停止也失败。');
    return DEVICE_CLI_EXIT.platform;
  }
  if (killed.exitCode !== 0) {
    stderr('Device Service 排空失败，launchd 强制停止也失败。');
    return DEVICE_CLI_EXIT.platform;
  }
  stderr(`Device Service 未能正常排空（${stableReason(reasonCode)}），已请求 launchd 强制停止。`);
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

async function readPlatformStatus(deps: DeviceCliDeps): Promise<{ installed: boolean; running: boolean }> {
  if ((deps.platform ?? process.platform) !== 'darwin') return { installed: false, running: false };
  try {
    return await (deps.createAdapter?.() ?? createMacOSLaunchAgentAdapter({
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    })).status();
  } catch {
    return { installed: false, running: false };
  }
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
  json: boolean;
  follow: boolean;
  deadlineMs: number;
} | null {
  const command = argv[0];
  if (command !== 'run' && command !== 'install' && command !== 'uninstall' && command !== 'status' && command !== 'start'
    && command !== 'stop' && command !== 'restart' && command !== 'logs') return null;
  let deadlineMs = 30_000;
  let json = false;
  let follow = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json' && command === 'status') json = true;
    else if (value === '--follow' && command === 'logs') follow = true;
    else if (value === '--deadline-ms') {
      const parsed = Number(argv[++index]);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 300_000) return null;
      deadlineMs = parsed;
    } else return null;
  }
  return { command, json, follow, deadlineMs };
}

function stableReason(reasonCode: string): string {
  return /^[A-Z0-9_]{1,80}$/.test(reasonCode) ? reasonCode : 'SERVICE_CONTROL_UNAVAILABLE';
}
