import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMacOSLaunchAgentAdapter,
  macOSLaunchAgentPaths,
  removeMacOSLaunchAgentInstallation,
} from './macos-launch-agent.js';
import type { PlatformCommandResult, PlatformServiceStatus } from './device-platform-service.js';

const CANONICAL_PACKAGE = '@agentbean/daemon';
const CANONICAL_REGISTRY = 'https://registry.npmjs.org/';
/** Device Service install/ready wait after package swap. */
export const SERVICE_INSTALL_DEADLINE_MS = 90_000;
/** Max wait for launchd bootout before package mutation. */
const SERVICE_QUIESCE_DEADLINE_MS = 30_000;
const PACKAGE_IMPORT_VERIFY_TIMEOUT_MS = 30_000;
const ERROR_LOG_SUMMARY_MAX_CHARS = 800;

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

export interface PackageInstallResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface UpdateCliDeps {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly baseDir?: string;
  readonly currentPackage?: InstalledAgentBeanPackage;
  readonly runNpm?: (argv: readonly string[]) => Promise<PlatformCommandResult>;
  readonly runAgentBean?: (executable: string, argv: readonly string[]) => Promise<PlatformCommandResult>;
  readonly getDeviceServiceStatus?: () => Promise<PlatformServiceStatus>;
  /**
   * Fully fence Device Service before mutating the global package:
   * bootout launchd job (if loaded) and remove plist/payload so KeepAlive cannot
   * restart mid-install against a half-written node_modules tree.
   */
  readonly fenceDeviceService?: () => Promise<boolean>;
  /** @deprecated Prefer fenceDeviceService; kept as alias for tests. */
  readonly quiesceDeviceService?: () => Promise<boolean>;
  readonly verifyInstalledPackage?: (input: {
    globalPrefix: string;
    version: string;
  }) => Promise<PackageInstallResult>;
  readonly readServiceErrorSummary?: () => Promise<string>;
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
  const prefixResult = await safeRun(runNpm, ['prefix', '--global']);
  const globalPrefix = prefixResult.exitCode === 0 ? prefixResult.stdout.trim() : '';
  if (!isAbsolute(globalPrefix)) {
    stderr('无法定位 npm global prefix（UPDATE_INSTALL_SOURCE_UNAVAILABLE）。');
    return UPDATE_CLI_EXIT.rejected;
  }
  const agentBeanExecutable = join(globalPrefix, 'bin', 'agentbean');
  const latestResult = await safeRun(runNpm, [
    'view', `${CANONICAL_PACKAGE}@latest`, 'version', '--json', `--registry=${CANONICAL_REGISTRY}`,
  ]);
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

  const servicePathsInput = {
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
  };
  let serviceStatus: PlatformServiceStatus;
  try {
    serviceStatus = await (deps.getDeviceServiceStatus ?? (() => createMacOSLaunchAgentAdapter(servicePathsInput).status()))();
  } catch {
    stderr('无法确认 Device Service 安装状态（UPDATE_PREFLIGHT_FAILED）。');
    return UPDATE_CLI_EXIT.rejected;
  }

  const fence = deps.fenceDeviceService
    ?? deps.quiesceDeviceService
    ?? (() => fenceDeviceServiceForPackageSwap(servicePathsInput));
  const wasServiceInstalled = serviceStatus.installed || serviceStatus.loaded;
  if (wasServiceInstalled) {
    const fenced = await safeBoolean(fence);
    if (!fenced) {
      stderr('Device Service 无法在更新前安全停止（UPDATE_SERVICE_STOP_FAILED）。');
      return UPDATE_CLI_EXIT.rejected;
    }
  }

  const runAgentBean = deps.runAgentBean ?? runAgentBeanCommand;
  const verify = deps.verifyInstalledPackage
    ?? ((input: { globalPrefix: string; version: string }) => verifyInstalledPackage(input));
  const installed = await installExactVersion(runNpm, latest, globalPrefix, verify);
  if (!installed.ok) {
    // Re-fence before rollback npm: a partial device start may have re-bootstrapped KeepAlive.
    if (wasServiceInstalled) await safeBoolean(fence);
    const rolledBack = await installExactVersion(runNpm, current.version, globalPrefix, verify);
    if (!rolledBack.ok) {
      stderr(
        'AgentBean 更新安装验证失败且自动回滚失败（UPDATE_RECOVERY_REQUIRED）。'
        + formatDetail(installed.detail),
      );
      return UPDATE_CLI_EXIT.rejected;
    }
    if (!wasServiceInstalled) {
      stderr(
        `AgentBean 更新安装验证失败，已恢复 ${current.version}（UPDATE_INSTALL_FAILED）；未使用 sudo。`
        + formatDetail(installed.detail),
      );
      return UPDATE_CLI_EXIT.rejected;
    }
    const restored = await safeRunAgentBean(runAgentBean, agentBeanExecutable, [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    stderr(restored.exitCode === 0
      ? `AgentBean 更新安装验证失败，已恢复 ${current.version} 并恢复 Device Service（UPDATE_INSTALL_FAILED）。`
        + formatDetail(installed.detail)
      : 'AgentBean 更新安装验证失败且自动回滚失败（UPDATE_RECOVERY_REQUIRED）。'
        + formatDetail(installed.detail)
        + await formatErrorLogSuffix(deps, servicePathsInput));
    return UPDATE_CLI_EXIT.rejected;
  }
  if (!wasServiceInstalled) {
    stdout(`AgentBean 已更新到 ${latest}；Device Service 尚未安装，无需重启。`);
    return UPDATE_CLI_EXIT.success;
  }

  const prepared = await safeRunAgentBean(runAgentBean, agentBeanExecutable, [
    'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
  ]);
  if (prepared.exitCode === 0) {
    stdout(`AgentBean 已更新到 ${latest}，Device Service 已安全${serviceStatus.loaded ? '重启' : '启动'}。`);
    return UPDATE_CLI_EXIT.success;
  }

  const startDetail = [prepared.stderr, prepared.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
  const errorLog = await (deps.readServiceErrorSummary
    ? deps.readServiceErrorSummary()
    : readServiceErrorSummary(servicePathsInput));
  const reasonSummary = [startDetail, errorLog].filter(Boolean).join('\n').slice(0, ERROR_LOG_SUMMARY_MAX_CHARS);

  // Fence again so rollback npm install cannot race KeepAlive crash-loops.
  const fencedForRollback = await safeBoolean(fence);
  const rolledBack = await installExactVersion(runNpm, current.version, globalPrefix, verify);
  if (!rolledBack.ok) {
    stderr(
      `新版本 ${latest} 未能就绪，自动回滚失败（UPDATE_RECOVERY_REQUIRED）。`
      + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : '')
      + formatDetail(rolledBack.detail)
      + `\n可手动恢复：npm install -g ${CANONICAL_PACKAGE}@${current.version} && agentbean device install`,
    );
    return UPDATE_CLI_EXIT.rejected;
  }
  const restored = await safeRunAgentBean(runAgentBean, agentBeanExecutable, [
    'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
  ]);
  if (restored.exitCode === 0) {
    stderr(
      `新版本 ${latest} 未能就绪，已回滚到 ${current.version} 并恢复 Device Service。`
      + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : ''),
    );
    return UPDATE_CLI_EXIT.rejected;
  }
  stderr(
    (fencedForRollback
      ? `新版本 ${latest} 未能就绪，自动回滚失败（UPDATE_RECOVERY_REQUIRED）。`
      : `新版本 ${latest} 未能就绪，Device Service 无法安全停止且自动恢复失败（UPDATE_RECOVERY_REQUIRED）。`)
    + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : '')
    + `\n可手动恢复：npm install -g ${CANONICAL_PACKAGE}@${current.version} && agentbean device install`,
  );
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

export async function verifyInstalledPackage(input: {
  readonly globalPrefix: string;
  readonly version: string;
}): Promise<PackageInstallResult> {
  const packageRoot = join(input.globalPrefix, 'lib', 'node_modules', CANONICAL_PACKAGE);
  const packageJsonPath = join(packageRoot, 'package.json');
  const entryPath = join(packageRoot, 'dist', 'apps', 'daemon-next', 'src', 'index.js');
  const binPath = join(packageRoot, 'dist', 'apps', 'daemon-next', 'src', 'bin.js');
  try {
    await access(packageJsonPath);
    await access(entryPath);
    await access(binPath);
  } catch {
    return {
      ok: false,
      detail: `安装包缺少入口文件（期望 ${binPath}）。`,
    };
  }
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    if (parsed.version !== input.version) {
      return {
        ok: false,
        detail: `package.json 版本为 ${String(parsed.version)}，期望 ${input.version}。`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      detail: `无法读取 package.json：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Import the library entry (not bin.js) so verification does not start CLI/service side effects.
  // This catches incomplete nested deps (e.g. typebox / pi-coding-agent) that npm list cannot see.
  const importCheck = await runCommand(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(entryPath).href)});`,
  ], PACKAGE_IMPORT_VERIFY_TIMEOUT_MS);
  if (importCheck.exitCode !== 0) {
    const message = [importCheck.stderr, importCheck.stdout].map((part) => part.trim()).filter(Boolean).join('\n');
    return {
      ok: false,
      detail: `安装包模块无法加载：${message.slice(0, 500) || `exit ${importCheck.exitCode}`}`,
    };
  }
  return { ok: true };
}

async function installExactVersion(
  runNpm: (argv: readonly string[]) => Promise<PlatformCommandResult>,
  version: string,
  globalPrefix: string,
  verify: (input: { globalPrefix: string; version: string }) => Promise<PackageInstallResult>,
): Promise<PackageInstallResult> {
  // Do NOT pass --ignore-scripts: nested runtime deps can end up incomplete when scripts are
  // skipped, then Device Service fails to start (ERR_MODULE_NOT_FOUND) and update recovery fails.
  const install = await safeRun(runNpm, [
    'install', '--global', '--no-audit', '--no-fund',
    `--registry=${CANONICAL_REGISTRY}`, `${CANONICAL_PACKAGE}@${version}`,
  ]);
  if (install.exitCode !== 0) {
    const message = [install.stderr, install.stdout].map((part) => part.trim()).filter(Boolean).join('\n');
    return { ok: false, detail: message.slice(0, 500) || `npm install 失败（exit ${install.exitCode}）` };
  }
  const listed = await safeRun(runNpm, ['list', '--global', CANONICAL_PACKAGE, '--depth=0', '--json']);
  if (listed.exitCode !== 0) {
    return { ok: false, detail: 'npm list 无法确认全局安装版本。' };
  }
  try {
    const parsed = JSON.parse(listed.stdout) as { dependencies?: Record<string, { version?: unknown }> };
    if (parsed.dependencies?.[CANONICAL_PACKAGE]?.version !== version) {
      return {
        ok: false,
        detail: `npm list 报告版本 ${String(parsed.dependencies?.[CANONICAL_PACKAGE]?.version)}，期望 ${version}。`,
      };
    }
  } catch {
    return { ok: false, detail: 'npm list 输出无法解析。' };
  }
  return verify({ globalPrefix, version });
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

async function runAgentBeanCommand(
  executable: string,
  argv: readonly string[],
): Promise<PlatformCommandResult> {
  return runCommand(executable, argv);
}

async function runCommand(
  executable: string,
  argv: readonly string[],
  timeoutMs?: number,
): Promise<PlatformCommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      [...argv],
      {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' as const } : {}),
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error && typeof error.code === 'number'
          ? error.code
          : error && 'killed' in error && error.killed
            ? 124
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
    // Ensure the promise settles if execFile callback is delayed after kill.
    if (timeoutMs) {
      child.on('error', () => {
        // callback above also fires; no-op
      });
    }
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

async function safeRunAgentBean(
  run: (executable: string, argv: readonly string[]) => Promise<PlatformCommandResult>,
  executable: string,
  argv: readonly string[],
): Promise<PlatformCommandResult> {
  try {
    return await run(executable, argv);
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function safeBoolean(run: () => Promise<boolean>): Promise<boolean> {
  try {
    return await run();
  } catch {
    return false;
  }
}

/**
 * Stop launchd ownership of Device Service and remove plist/payload before npm mutates
 * global node_modules. Without removing the LaunchAgent, KeepAlive can restart the process
 * mid-install and produce ERR_MODULE_NOT_FOUND + UPDATE_RECOVERY_REQUIRED.
 */
export async function fenceDeviceServiceForPackageSwap(input: {
  home?: string;
  baseDir?: string;
}): Promise<boolean> {
  const adapter = createMacOSLaunchAgentAdapter(input);
  const initial = await adapter.status();
  if (initial.loaded) {
    let removed = await adapter.bootout();
    if (removed.exitCode !== 0) {
      await adapter.kill().catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
      removed = await adapter.bootout();
      if (removed.exitCode !== 0) return false;
    }
  }
  const deadlineAt = Date.now() + SERVICE_QUIESCE_DEADLINE_MS;
  while (Date.now() < deadlineAt) {
    const status = await adapter.status();
    if (!status.loaded && !status.running) {
      if (initial.installed || status.installed) {
        await removeMacOSLaunchAgentInstallation(input);
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function readServiceErrorSummary(input: {
  home?: string;
  baseDir?: string;
} = {}): Promise<string> {
  const paths = macOSLaunchAgentPaths(input);
  try {
    const text = await readFile(paths.errorLogFile, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const interesting = lines.filter((line) => /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|Error \[|启动失败|MODULE_NOT_FOUND/i.test(line));
    const selected = (interesting.length > 0 ? interesting : lines).slice(-12);
    return selected.join('\n').slice(0, ERROR_LOG_SUMMARY_MAX_CHARS);
  } catch {
    return '';
  }
}

function formatDetail(detail: string | undefined): string {
  return detail ? `\n原因摘要：\n${detail.slice(0, ERROR_LOG_SUMMARY_MAX_CHARS)}` : '';
}

async function formatErrorLogSuffix(
  deps: UpdateCliDeps,
  servicePathsInput: { home?: string; baseDir?: string },
): Promise<string> {
  const summary = await (deps.readServiceErrorSummary
    ? deps.readServiceErrorSummary()
    : readServiceErrorSummary(servicePathsInput));
  return summary ? `\n服务日志摘要：\n${summary}` : '';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
