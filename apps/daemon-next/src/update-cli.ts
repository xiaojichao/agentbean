import { execFile } from 'node:child_process';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createMacOSLaunchAgentAdapter,
  macOSLaunchAgentPaths,
  removeMacOSLaunchAgentInstallation,
} from './macos-launch-agent.js';
import type { PlatformCommandResult, PlatformServiceStatus } from './device-platform-service.js';
import { deviceServicePaths } from './device-service-paths.js';
import { createDeviceServiceStateStore } from './device-service-state.js';
import { createUpdateProgress, type UpdateProgress } from './update-progress.js';

const CANONICAL_PACKAGE = '@agentbean/daemon';
const CANONICAL_REGISTRY = 'https://registry.npmjs.org/';
/** Device Service install/ready wait after package swap. */
export const SERVICE_INSTALL_DEADLINE_MS = 90_000;
/** Max wait for launchd bootout before package mutation. */
const SERVICE_QUIESCE_DEADLINE_MS = 30_000;
const PACKAGE_IMPORT_VERIFY_TIMEOUT_MS = 30_000;
const ERROR_LOG_SUMMARY_MAX_CHARS = 800;
/** 更新锁超过该时长视为陈旧，允许接管（防止异常退出残留锁阻塞更新）。 */
export const UPDATE_LOCK_STALE_MS = 10 * 60_000;
/** 换包前将当前全局安装整体移出 node_modules 的备份目录名。 */
export const PACKAGE_SNAPSHOT_DIR_NAME = 'agentbean-daemon-update-backup';
/** Device Service 启动未就绪时的额外重试次数（启动期服务端连接闪断时先重试再回滚）。 */
export const SERVICE_START_RETRY_ATTEMPTS = 2;

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
  /** 更新锁文件路径；默认 <AgentBean home>/service/update.lock。 */
  readonly lockFilePath?: string;
  readonly acquireUpdateLock?: (lockFilePath: string) => Promise<boolean>;
  readonly releaseUpdateLock?: (lockFilePath: string) => Promise<void>;
  /** 换包前把当前全局安装 mv 到备份目录，失败则中止更新。 */
  readonly snapshotInstalledPackage?: (input: {
    packageRoot: string;
    backupRoot: string;
  }) => Promise<boolean>;
  /** 回滚：删除半安装的新目录并把备份 mv 回原位（不依赖 npm/网络）。 */
  readonly restorePackageSnapshot?: (input: {
    packageRoot: string;
    backupRoot: string;
  }) => Promise<boolean>;
  /** 更新成功并确认服务就绪后清理备份目录。 */
  readonly discardPackageSnapshot?: (backupRoot: string) => Promise<void>;
  /** 运行级健康确认：Device Service 必须报告新版本且处于 running/degraded。 */
  readonly confirmServiceReady?: (expectedVersion: string) => Promise<boolean>;
  /** Progress bar + task text; tests inject a recorder. Default is TTY-aware terminal UI. */
  readonly createProgress?: () => UpdateProgress;
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
  const packageRoot = join(globalPrefix, 'lib', 'node_modules', CANONICAL_PACKAGE);
  const backupRoot = join(globalPrefix, 'lib', PACKAGE_SNAPSHOT_DIR_NAME);
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

  // 并发防护：同一时间只允许一个 agentbean update（防止两个 npm 同时 reify 全局包，
  // 这是 typebox 等嵌套依赖被删成残树、Device Service ERR_MODULE_NOT_FOUND 的直接成因）。
  const lockFilePath = deps.lockFilePath
    ?? join(deviceServicePaths(deps.baseDir).root, 'update.lock');
  const acquireLock = deps.acquireUpdateLock ?? acquireUpdateLockFile;
  const releaseLock = deps.releaseUpdateLock ?? releaseUpdateLockFile;
  const locked = await safeBoolean(() => acquireLock(lockFilePath));
  if (!locked) {
    stderr('另一个 AgentBean 更新正在进行（UPDATE_LOCKED）；请稍后重试。');
    return UPDATE_CLI_EXIT.rejected;
  }
  try {
    return await executeUpdate({
      deps, stderr, stdout, runNpm, agentBeanExecutable, packageRoot, backupRoot,
      current, latest, globalPrefix,
    });
  } finally {
    await safeBoolean(async () => {
      await releaseLock(lockFilePath);
      return true;
    });
  }
}

interface ExecuteUpdateInput {
  readonly deps: UpdateCliDeps;
  readonly stderr: (message: string) => void;
  readonly stdout: (message: string) => void;
  readonly runNpm: (argv: readonly string[]) => Promise<PlatformCommandResult>;
  readonly agentBeanExecutable: string;
  readonly packageRoot: string;
  readonly backupRoot: string;
  readonly current: InstalledAgentBeanPackage;
  readonly latest: string;
  readonly globalPrefix: string;
}

async function executeUpdate(input: ExecuteUpdateInput): Promise<number> {
  const { deps, stderr, stdout, runNpm, agentBeanExecutable, packageRoot, backupRoot, current, latest, globalPrefix } = input;
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
  const progress = (deps.createProgress ?? (() => createUpdateProgress({
    stdout,
    stderr,
    // Live bar only on an interactive terminal with default console streams.
    // Custom stdout/stderr (tests, pipes) get plain sequential task lines.
    isTTY: deps.stdout === undefined && deps.stderr === undefined && Boolean(process.stderr.isTTY),
  })))();
  // With service: fence → snapshot → install → start/confirm service → cleanup
  // Without service: snapshot → install → cleanup
  const totalSteps = wasServiceInstalled ? 5 : 3;
  progress.begin(totalSteps, `AgentBean 更新 ${current.version} → ${latest}`);

  if (wasServiceInstalled) {
    progress.step('停止 Device Service');
    progress.detail('正在安全停止并卸载 LaunchAgent，避免换包时半写依赖被加载…');
    const fenced = await safeBoolean(fence);
    if (!fenced) {
      progress.fail('Device Service 无法在更新前安全停止（UPDATE_SERVICE_STOP_FAILED）。');
      return UPDATE_CLI_EXIT.rejected;
    }
  }

  const runAgentBean = deps.runAgentBean ?? runAgentBeanCommand;
  const verify = deps.verifyInstalledPackage
    ?? ((verifyInput: { globalPrefix: string; version: string }) => verifyInstalledPackage(verifyInput));
  const snapshot = deps.snapshotInstalledPackage ?? snapshotInstalledPackage;
  const restoreSnapshot = deps.restorePackageSnapshot ?? restorePackageSnapshot;
  const discardSnapshot = deps.discardPackageSnapshot ?? discardPackageSnapshot;
  const confirmServiceReady = deps.confirmServiceReady
    ?? ((expectedVersion: string) => confirmDeviceServiceVersion({
      expectedVersion,
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
    }));

  // 换包前把当前全局安装整体移出 node_modules：回滚只做 mv/rm，
  // 不依赖 npm/网络，也不会在 crash-loop 的 Device Service 上重跑 npm reify。
  progress.step('备份当前安装');
  progress.detail(`快照 → ${backupRoot}`);
  const snapshotted = await safeBoolean(() => snapshot({ packageRoot, backupRoot }));
  if (!snapshotted) {
    progress.fail('无法备份当前 AgentBean 安装（UPDATE_SNAPSHOT_FAILED）；未执行更新。');
    return UPDATE_CLI_EXIT.rejected;
  }

  progress.step(`安装 @agentbean/daemon@${latest}`);
  progress.detail('npm install + 模块导入验证（可能需要一到两分钟）…');
  const installed = await installExactVersion(runNpm, latest, globalPrefix, verify);
  if (!installed.ok) {
    progress.detail('安装验证失败，正在从快照回滚…');
    // 安装验证失败：直接从快照恢复旧版本。
    if (wasServiceInstalled) {
      progress.detail('再次停止 Device Service…');
      await safeBoolean(fence);
    }
    const snapshotRestored = await safeBoolean(() => restoreSnapshot({ packageRoot, backupRoot }));
    if (!snapshotRestored) {
      progress.fail(
        'AgentBean 更新安装验证失败且自动回滚失败（UPDATE_RECOVERY_REQUIRED）。'
        + formatDetail(installed.detail)
        + `\n可手动恢复：${formatManualRecovery(backupRoot, current.version)}`,
      );
      return UPDATE_CLI_EXIT.rejected;
    }
    if (!wasServiceInstalled) {
      progress.fail(
        `AgentBean 更新安装验证失败，已恢复 ${current.version}（UPDATE_INSTALL_FAILED）。`
        + formatDetail(installed.detail),
      );
      return UPDATE_CLI_EXIT.rejected;
    }
    progress.detail(`恢复 Device Service（${current.version}）…`);
    const serviceRestored = await prepareDeviceServiceWithRetry(
      runAgentBean, agentBeanExecutable,
      ['device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS)],
      confirmServiceReady, current.version, progress,
    );
    progress.fail(serviceRestored.confirmed
      ? `AgentBean 更新安装验证失败，已恢复 ${current.version} 并恢复 Device Service（UPDATE_INSTALL_FAILED）。`
        + formatDetail(installed.detail)
      : 'AgentBean 更新安装验证失败且自动回滚失败（UPDATE_RECOVERY_REQUIRED）。'
        + formatDetail(installed.detail)
        + await formatErrorLogSuffix(deps, servicePathsInput));
    return UPDATE_CLI_EXIT.rejected;
  }
  if (!wasServiceInstalled) {
    progress.step('清理备份');
    await safeBoolean(async () => {
      await discardSnapshot(backupRoot);
      return true;
    });
    progress.done(`AgentBean 已更新到 ${latest}；Device Service 尚未安装，无需重启。`);
    return UPDATE_CLI_EXIT.success;
  }

  // 运行级健康确认：service run 报告就绪还不够，还要确认运行中的版本与目标一致。
  // 启动期服务端连接闪断（required announce 抛错）会让首次 install 未就绪；
  // 先重试 device restart（等价手动 install && restart 的恢复路径），而不是立刻回滚。
  progress.step('启动 Device Service');
  progress.detail(`安装并确认版本 ${latest}…`);
  const prepared = await prepareDeviceServiceWithRetry(
    runAgentBean, agentBeanExecutable,
    ['device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS)],
    confirmServiceReady, latest, progress,
  );
  if (prepared.confirmed) {
    progress.step('清理备份');
    await safeBoolean(async () => {
      await discardSnapshot(backupRoot);
      return true;
    });
    progress.done(`AgentBean 已更新到 ${latest}，Device Service 已安全${serviceStatus.loaded ? '重启' : '启动'}。`);
    return UPDATE_CLI_EXIT.success;
  }

  const startDetail = [prepared.firstAttempt.stderr, prepared.firstAttempt.stdout]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
  const errorLog = await (deps.readServiceErrorSummary
    ? deps.readServiceErrorSummary()
    : readServiceErrorSummary(servicePathsInput));
  const reasonSummary = [
    prepared.firstAttempt.exitCode === 0 && !prepared.confirmed
      ? 'Device Service 已安装但版本/健康确认失败。'
      : '',
    startDetail,
    errorLog,
  ].filter(Boolean).join('\n').slice(0, ERROR_LOG_SUMMARY_MAX_CHARS);

  // 回滚：再次 fence 是尽力而为；即使失败也直接做快照恢复（mv/rm），
  // 绝不在 crash-loop 的服务运行期间重跑 npm install（原实现会把树越搅越烂）。
  progress.detail('新版本未就绪，开始回滚…');
  progress.detail('停止 Device Service…');
  const fencedForRollback = await safeBoolean(fence);
  progress.detail('从快照恢复上一版本…');
  const snapshotRestored = await safeBoolean(() => restoreSnapshot({ packageRoot, backupRoot }));
  if (!snapshotRestored) {
    progress.fail(
      `新版本 ${latest} 未能就绪，自动回滚失败（UPDATE_RECOVERY_REQUIRED）。`
      + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : '')
      + `\n可手动恢复：${formatManualRecovery(backupRoot, current.version)}`,
    );
    return UPDATE_CLI_EXIT.rejected;
  }
  progress.detail(`恢复 Device Service（${current.version}）…`);
  const serviceRestored = await prepareDeviceServiceWithRetry(
    runAgentBean, agentBeanExecutable,
    ['device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS)],
    confirmServiceReady, current.version, progress,
  );
  if (serviceRestored.confirmed) {
    progress.fail(
      `新版本 ${latest} 未能就绪，已回滚到 ${current.version} 并恢复 Device Service。`
      + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : ''),
    );
    return UPDATE_CLI_EXIT.rejected;
  }
  progress.fail(
    (fencedForRollback
      ? `新版本 ${latest} 未能就绪，自动回滚失败（UPDATE_RECOVERY_REQUIRED）。`
      : `新版本 ${latest} 未能就绪，Device Service 无法安全停止且自动恢复失败（UPDATE_RECOVERY_REQUIRED）。`)
    + (reasonSummary ? `\n原因摘要：\n${reasonSummary}` : '')
    + `\n可手动恢复：${formatManualRecovery(backupRoot, current.version)}`,
  );
  return UPDATE_CLI_EXIT.rejected;
}

/**
 * 启动 Device Service 并在未就绪时有限重试（device restart）。
 * 启动期服务端连接闪断会让首次 install 超时；手动 `device install && device restart`
 * 能恢复的根源就在这里，update 不应把瞬时连接抖动当成版本问题直接回滚。
 */
async function prepareDeviceServiceWithRetry(
  runAgentBean: (executable: string, argv: readonly string[]) => Promise<PlatformCommandResult>,
  executable: string,
  firstArgv: readonly string[],
  confirmServiceReady: (expectedVersion: string) => Promise<boolean>,
  expectedVersion: string,
  progress?: UpdateProgress,
): Promise<{ confirmed: boolean; firstAttempt: PlatformCommandResult }> {
  progress?.detail(`运行 agentbean ${firstArgv.join(' ')}…`);
  const firstAttempt = await safeRunAgentBean(runAgentBean, executable, firstArgv);
  let confirmed = firstAttempt.exitCode === 0
    && await safeBoolean(() => confirmServiceReady(expectedVersion));
  for (let attempt = 0; attempt < SERVICE_START_RETRY_ATTEMPTS && !confirmed; attempt += 1) {
    progress?.detail(`服务未就绪，重试 device restart（${attempt + 1}/${SERVICE_START_RETRY_ATTEMPTS}）…`);
    const restarted = await safeRunAgentBean(runAgentBean, executable, [
      'device', 'restart', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    confirmed = restarted.exitCode === 0
      && await safeBoolean(() => confirmServiceReady(expectedVersion));
  }
  if (confirmed) progress?.detail(`Device Service 已确认版本 ${expectedVersion}`);
  return { confirmed, firstAttempt };
}

/**
 * 获取更新锁（exclusive create + 陈旧超时接管）。
 * 返回 true 表示获得锁；false 表示已有并发的 AgentBean 更新在进行。
 */
export async function acquireUpdateLockFile(
  lockFilePath: string,
  staleMs = UPDATE_LOCK_STALE_MS,
): Promise<boolean> {
  if (await tryAcquireUpdateLockFile(lockFilePath)) return true;
  let stale = false;
  try {
    const parsed = JSON.parse(await readFile(lockFilePath, 'utf8')) as { startedAt?: unknown };
    const startedAt = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN;
    stale = Number.isFinite(startedAt) && Date.now() - startedAt >= staleMs;
  } catch {
    return false;
  }
  if (!stale) return false;
  await rm(lockFilePath, { force: true });
  return tryAcquireUpdateLockFile(lockFilePath);
}

export async function releaseUpdateLockFile(lockFilePath: string): Promise<void> {
  await rm(lockFilePath, { force: true });
}

async function tryAcquireUpdateLockFile(lockFilePath: string): Promise<boolean> {
  try {
    await mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 });
    const handle = await open(lockFilePath, 'wx', 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** 把当前全局安装 mv 到备份目录；包目录不存在时视为无需备份。 */
export async function snapshotInstalledPackage(input: {
  readonly packageRoot: string;
  readonly backupRoot: string;
}): Promise<boolean> {
  try {
    await rm(input.backupRoot, { recursive: true, force: true });
    await access(input.packageRoot);
    await rename(input.packageRoot, input.backupRoot);
    return true;
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? true : false;
  }
}

/** 删除半安装的新目录并把备份 mv 回原位。 */
export async function restorePackageSnapshot(input: {
  readonly packageRoot: string;
  readonly backupRoot: string;
}): Promise<boolean> {
  try {
    await access(input.backupRoot);
  } catch {
    return false;
  }
  try {
    await rm(input.packageRoot, { recursive: true, force: true });
    await rename(input.backupRoot, input.packageRoot);
    return true;
  } catch {
    return false;
  }
}

/** 更新成功且服务健康确认后清理备份目录。 */
export async function discardPackageSnapshot(backupRoot: string): Promise<void> {
  await rm(backupRoot, { recursive: true, force: true });
}

/** 运行级确认：Device Service 已以目标版本 running/degraded。 */
export async function confirmDeviceServiceVersion(input: {
  readonly expectedVersion: string;
  readonly baseDir?: string;
}): Promise<boolean> {
  try {
    const state = await createDeviceServiceStateStore(deviceServicePaths(input.baseDir).stateFile).read();
    return Boolean(state
      && (state.phase === 'running' || state.phase === 'degraded')
      && state.version === input.expectedVersion);
  } catch {
    return false;
  }
}

function formatManualRecovery(backupRoot: string, version: string): string {
  return `恢复备份目录 ${backupRoot}，或 npm install -g ${CANONICAL_PACKAGE}@${version} && agentbean device install`;
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
