import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macOSLaunchAgentPaths } from './macos-launch-agent.js';
import type { PlatformCommandResult } from './device-platform-service.js';

const CANONICAL_PACKAGE = '@agentbean/daemon';

export const UPDATE_CLI_EXIT = {
  success: 0,
  usage: 2,
  rejected: 4,
  platform: 5,
} as const;

export interface InstalledAgentBeanPackage {
  readonly name: string;
  readonly version: string;
}

export interface UpdateCliDeps {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly baseDir?: string;
  readonly currentPackage?: InstalledAgentBeanPackage;
  readonly runNpm?: (argv: readonly string[]) => Promise<PlatformCommandResult>;
  readonly runAgentBean?: (argv: readonly string[]) => Promise<PlatformCommandResult>;
  readonly isDeviceServiceInstalled?: () => Promise<boolean>;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

export async function runUpdateCli(argv: readonly string[], deps: UpdateCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  if (argv.length > 0) {
    stderr('用法：agentbean update');
    return UPDATE_CLI_EXIT.usage;
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    stderr('当前平台尚未支持 AgentBean 自更新。');
    return UPDATE_CLI_EXIT.platform;
  }

  let current: InstalledAgentBeanPackage;
  try {
    current = deps.currentPackage ?? await readInstalledAgentBeanPackage();
  } catch {
    stderr('无法识别当前 AgentBean 安装来源（UPDATE_INSTALL_SOURCE_UNAVAILABLE）。');
    return UPDATE_CLI_EXIT.rejected;
  }
  if (current.name !== CANONICAL_PACKAGE || !isStableVersion(current.version)) {
    stderr('当前安装来源不支持自更新；请先安装 canonical @agentbean/daemon。');
    return UPDATE_CLI_EXIT.rejected;
  }
  const runNpm = deps.runNpm ?? runNpmCommand;
  const latestResult = await safeRun(runNpm, ['view', `${CANONICAL_PACKAGE}@latest`, 'version', '--json']);
  const latest = latestResult.exitCode === 0 ? parseNpmVersion(latestResult.stdout) : undefined;
  if (!latest) {
    stderr('AgentBean 更新检查失败（UPDATE_CHECK_FAILED）。');
    return UPDATE_CLI_EXIT.rejected;
  }
  if (compareStableVersions(current.version, latest) >= 0) {
    stdout(current.version === latest
      ? `AgentBean 已是最新版本（${current.version}）。`
      : `当前 AgentBean ${current.version} 高于 stable ${latest}，未执行降级。`);
    return UPDATE_CLI_EXIT.success;
  }

  let serviceInstalled: boolean;
  try {
    serviceInstalled = await (deps.isDeviceServiceInstalled ?? (() => fileExists(macOSLaunchAgentPaths({
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    }).plistFile)))();
  } catch {
    stderr('无法确认 Device Service 安装状态（UPDATE_PREFLIGHT_FAILED）。');
    return UPDATE_CLI_EXIT.rejected;
  }

  const installed = await installExactVersion(runNpm, latest);
  if (!installed) {
    stderr('AgentBean 更新安装失败（UPDATE_INSTALL_FAILED）；未使用 sudo。');
    return UPDATE_CLI_EXIT.rejected;
  }
  if (!serviceInstalled) {
    stdout(`AgentBean 已更新到 ${latest}；Device Service 尚未安装，无需重启。`);
    return UPDATE_CLI_EXIT.success;
  }

  const runAgentBean = deps.runAgentBean ?? runAgentBeanCommand;
  const restarted = await safeRun(runAgentBean, ['device', 'restart', '--deadline-ms', '30000']);
  if (restarted.exitCode === 0) {
    stdout(`AgentBean 已更新到 ${latest}，Device Service 已安全重启。`);
    return UPDATE_CLI_EXIT.success;
  }

  const rolledBack = await installExactVersion(runNpm, current.version);
  const restored = rolledBack
    ? await safeRun(runAgentBean, ['device', 'restart', '--deadline-ms', '30000'])
    : undefined;
  if (rolledBack && restored?.exitCode === 0) {
    stderr(`新版本 ${latest} 未能就绪，已回滚到 ${current.version} 并恢复 Device Service。`);
    return UPDATE_CLI_EXIT.rejected;
  }
  stderr(`新版本 ${latest} 未能就绪，自动回滚失败（UPDATE_RECOVERY_REQUIRED）。`);
  return UPDATE_CLI_EXIT.rejected;
}

export async function readInstalledAgentBeanPackage(
  start = dirname(fileURLToPath(import.meta.url)),
): Promise<InstalledAgentBeanPackage> {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if ((parsed.name === CANONICAL_PACKAGE || parsed.name === '@agentbean/daemon-next')
        && typeof parsed.version === 'string') {
        return { name: parsed.name, version: parsed.version };
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('UPDATE_INSTALL_SOURCE_UNAVAILABLE');
}

async function installExactVersion(
  runNpm: (argv: readonly string[]) => Promise<PlatformCommandResult>,
  version: string,
): Promise<boolean> {
  const install = await safeRun(runNpm, [
    'install', '--global', '--no-audit', '--no-fund', `${CANONICAL_PACKAGE}@${version}`,
  ]);
  if (install.exitCode !== 0) return false;
  const listed = await safeRun(runNpm, ['list', '--global', CANONICAL_PACKAGE, '--depth=0', '--json']);
  if (listed.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(listed.stdout) as { dependencies?: Record<string, { version?: unknown }> };
    return parsed.dependencies?.[CANONICAL_PACKAGE]?.version === version;
  } catch {
    return false;
  }
}

function parseNpmVersion(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'string' && isStableVersion(parsed) ? parsed : undefined;
  } catch {
    const value = stdout.trim();
    return isStableVersion(value) ? value : undefined;
  }
}

function isStableVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function runNpmCommand(argv: readonly string[]): Promise<PlatformCommandResult> {
  return runCommand('npm', argv);
}

async function runAgentBeanCommand(argv: readonly string[]): Promise<PlatformCommandResult> {
  return runCommand('agentbean', argv);
}

async function runCommand(executable: string, argv: readonly string[]): Promise<PlatformCommandResult> {
  return new Promise((resolve) => {
    execFile(executable, [...argv], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function safeRun(
  run: (argv: readonly string[]) => Promise<PlatformCommandResult>,
  argv: readonly string[],
): Promise<PlatformCommandResult> {
  try {
    return await run(argv);
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
