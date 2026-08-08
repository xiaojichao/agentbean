import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  acquireUpdateLockFile,
  buildAgentBeanSpawn,
  fenceDeviceServiceForPackageSwap,
  waitForExecutableReady,
  readInstalledAgentBeanPackage,
  restorePackageSnapshot,
  runUpdateCli,
  SERVICE_INSTALL_DEADLINE_MS,
  SERVICE_START_RETRY_ATTEMPTS,
  snapshotInstalledPackage,
  UPDATE_CLI_EXIT,
  verifyInstalledPackage,
} from '../src/update-cli';
import { createUpdateProgress } from '../src/update-progress';
import type { PlatformCommandResult } from '../src/device-platform-service';
import type { UpdateProgress } from '../src/update-progress';

const success = (stdout = ''): PlatformCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const serviceStatus = (installed: boolean, loaded = installed) => ({
  installed, loaded, running: loaded, queryFailed: false,
});

/**
 * update 新增的并发锁、快照换包、快照回滚与运行级健康确认默认注入。
 * 每个用例使用独立 mock，避免真实读写 ~/.agentbean 与本机 npm 全局树。
 */
function updateFakes() {
  return {
    acquireUpdateLock: vi.fn(async () => true),
    releaseUpdateLock: vi.fn(async () => {}),
    snapshotInstalledPackage: vi.fn(async () => true),
    restorePackageSnapshot: vi.fn(async () => true),
    discardPackageSnapshot: vi.fn(async () => {}),
    confirmServiceReady: vi.fn(async () => true),
    waitForExecutableReady: vi.fn(async () => undefined),
  };
}

function npmRunner(latest = '0.3.13') {
  let installedVersion = '0.3.12';
  return vi.fn(async (argv: readonly string[]) => {
    if (argv[0] === 'prefix') return success('/opt/agentbean\n');
    if (argv[0] === 'view') return success(`${JSON.stringify(latest)}\n`);
    if (argv[0] === 'install') {
      installedVersion = argv.at(-1)?.split('@').at(-1) ?? installedVersion;
      return success();
    }
    if (argv[0] === 'list') {
      return success(JSON.stringify({ dependencies: { '@agentbean/daemon': { version: installedVersion } } }));
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected npm command' };
  });
}

const passVerify = async () => ({ ok: true as const });
const backupRoot = '/opt/agentbean/lib/agentbean-daemon-update-backup';
const notReady = { exitCode: 6, stdout: '', stderr: 'Device Service 安装后未在截止时间内就绪。' };

/** 首次 install 未就绪，重试全部失败，最后恢复 install 成功。 */
function failingStartThenRestore() {
  const mock = vi.fn().mockResolvedValueOnce(notReady);
  for (let attempt = 0; attempt < SERVICE_START_RETRY_ATTEMPTS; attempt += 1) {
    mock.mockResolvedValueOnce(notReady);
  }
  mock.mockResolvedValueOnce(success());
  return mock;
}

describe('agentbean update', () => {
  test('does nothing when the canonical package is already current', async () => {
    const runNpm = npmRunner('0.3.12');
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm).toHaveBeenCalledTimes(2);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('does not downgrade a local version newer than stable', async () => {
    const runNpm = npmRunner('0.3.12');
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.4.0' }, runNpm,
      ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm).toHaveBeenCalledTimes(2);
  });

  test('installs the exact stable version without restarting an uninstalled service', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(false),
      verifyInstalledPackage: passVerify, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm.mock.calls[1]?.[0]).toEqual([
      'view', '@agentbean/daemon@latest', 'version', '--json',
      '--registry=https://registry.npmjs.org/',
    ]);
    expect(runNpm.mock.calls[2]?.[0]).toEqual([
      'install', '--global', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '@agentbean/daemon@0.3.13',
    ]);
    expect(fakes.snapshotInstalledPackage).toHaveBeenCalledWith({
      packageRoot: '/opt/agentbean/lib/node_modules/@agentbean/daemon',
      backupRoot,
    });
    expect(fakes.discardPackageSnapshot).toHaveBeenCalledWith(backupRoot);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('fences Device Service before package swap and reinstalls after health is ready', async () => {
    let serviceLoaded = true;
    const npm = npmRunner();
    const runNpm = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === 'install' && serviceLoaded) {
        return { exitCode: 1, stdout: '', stderr: 'package is still in use' };
      }
      return npm(argv);
    });
    const runAgentBean = vi.fn(async () => {
      serviceLoaded = true;
      return success();
    });
    const stdout = vi.fn();
    const fakes = updateFakes();
    const steps: string[] = [];
    const progress: UpdateProgress = {
      begin: vi.fn(),
      step: vi.fn((label: string) => { steps.push(label); }),
      detail: vi.fn(),
      done: vi.fn((message: string) => { stdout(message); }),
      fail: vi.fn(),
    };

    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => {
        serviceLoaded = false;
        return true;
      },
      verifyInstalledPackage: passVerify,
      createProgress: () => progress,
      stdout, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);

    expect(serviceLoaded).toBe(true);
    expect(fakes.confirmServiceReady).toHaveBeenCalledWith('0.3.13');
    expect(fakes.discardPackageSnapshot).toHaveBeenCalledWith(backupRoot);
    expect(stdout).toHaveBeenCalledWith('AgentBean 已更新到 0.3.13，Device Service 已安全重启。');
    expect(steps).toEqual(expect.arrayContaining([
      '停止 Device Service',
      '备份当前安装',
      expect.stringContaining('安装 @agentbean/daemon@'),
      '启动 Device Service',
      '清理备份',
    ]));
    expect(progress.done).toHaveBeenCalled();
  });

  test('createUpdateProgress emits sequential task lines when not a TTY', () => {
    const lines: string[] = [];
    const progress = createUpdateProgress({
      isTTY: false,
      stdout: (message) => lines.push(message),
      stderr: (message) => lines.push(`ERR:${message}`),
    });
    progress.begin(3, 'AgentBean 更新 0.3.12 → 0.3.13');
    progress.step('停止 Device Service');
    progress.detail('bootout LaunchAgent…');
    progress.step('备份当前安装');
    progress.done('AgentBean 已更新到 0.3.13');
    expect(lines).toEqual([
      'AgentBean 更新 0.3.12 → 0.3.13',
      '[1/3] 停止 Device Service',
      '  → bootout LaunchAgent…',
      '[2/3] 备份当前安装',
      'AgentBean 已更新到 0.3.13',
    ]);
  });

  test('leaves the current package untouched when the Device Service cannot stop before update', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    const stderr = vi.fn();
    const fakes = updateFakes();

    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => false,
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);

    expect(runNpm).toHaveBeenCalledTimes(2);
    expect(runAgentBean).not.toHaveBeenCalled();
    expect(fakes.snapshotInstalledPackage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Device Service 无法在更新前安全停止（UPDATE_SERVICE_STOP_FAILED）。',
    );
  });

  test('fences even when Device Service is installed but unloaded', async () => {
    const fenceDeviceService = vi.fn(async () => true);
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true, false),
      fenceDeviceService,
      verifyInstalledPackage: passVerify, ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(fenceDeviceService).toHaveBeenCalledOnce();
    expect(runAgentBean).toHaveBeenCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
  });

  test('restores an installed Device Service without replacing its package while loaded', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async (_executable: string, argv: readonly string[]) => argv[1] === 'restart'
      ? { exitCode: 6, stdout: '', stderr: 'unexpected second restart' }
      : success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify, ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runAgentBean).toHaveBeenCalledOnce();
    expect(runAgentBean).toHaveBeenCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
  });

  test('rolls back via package snapshot and restores the service when the new version cannot start', async () => {
    const runNpm = npmRunner();
    const fenceDeviceService = vi.fn(async () => true);
    const runAgentBean = failingStartThenRestore();
    const fakes = updateFakes();
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService,
      verifyInstalledPackage: passVerify,
      readServiceErrorSummary: async () => 'ERR_MODULE_NOT_FOUND: Cannot find module typebox',
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    // fence before install + fence before rollback
    expect(fenceDeviceService).toHaveBeenCalledTimes(2);
    // 回滚不再调用 npm 安装旧版本（防止在 crash-loop 服务上重跑 npm reify）
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    expect(fakes.discardPackageSnapshot).not.toHaveBeenCalled();
    // install + SERVICE_START_RETRY_ATTEMPTS 次 restart + 恢复 install
    expect(runAgentBean).toHaveBeenCalledTimes(1 + SERVICE_START_RETRY_ATTEMPTS + 1);
    expect(runAgentBean).toHaveBeenLastCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('已回滚到 0.3.12'));
  });

  test('recovers by restarting the service when the first install is not ready', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn()
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce(success());
    const stdout = vi.fn();
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify,
      stdout, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    // 瞬时连接抖动：install 未就绪，restart 后即恢复，不回滚、不恢复快照
    expect(fakes.restorePackageSnapshot).not.toHaveBeenCalled();
    expect(runAgentBean).toHaveBeenCalledTimes(2);
    expect(runAgentBean).toHaveBeenLastCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'restart', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    expect(fakes.discardPackageSnapshot).toHaveBeenCalledWith(backupRoot);
    expect(stdout).toHaveBeenCalledWith('AgentBean 已更新到 0.3.13，Device Service 已安全重启。');
  });

  test('includes service error log summary when new version fails to become ready', async () => {
    const runNpm = npmRunner();
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm,
      runAgentBean: failingStartThenRestore(),
      getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify,
      readServiceErrorSummary: async () => 'ERR_MODULE_NOT_FOUND: Cannot find module typebox',
      stderr, ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ERR_MODULE_NOT_FOUND: Cannot find module typebox'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('已回滚到 0.3.12'));
  });

  test('reports recovery-required when the package snapshot cannot be restored', async () => {
    const fakes = updateFakes();
    fakes.restorePackageSnapshot.mockResolvedValue(false);
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => notReady);
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify,
      readServiceErrorSummary: async () => '',
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('自动回滚失败（UPDATE_RECOVERY_REQUIRED）'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('可手动恢复'));
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
  });

  test('does not report recovery-required when rollback restores the service after fence fails on rollback', async () => {
    const runNpm = npmRunner();
    const runAgentBean = failingStartThenRestore();
    const fenceDeviceService = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const stderr = vi.fn();
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService,
      verifyInstalledPackage: passVerify,
      readServiceErrorSummary: async () => '',
      readServiceLiveDetail: async () => '',
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    // 即使再次 fence 失败，也走快照恢复而不是 npm 回滚
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
    expect(runAgentBean).toHaveBeenLastCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    expect(stderr).toHaveBeenCalledWith(
      '新版本 0.3.13 未能就绪，已回滚到 0.3.12 并恢复 Device Service。\n原因摘要：\nDevice Service 安装后未在截止时间内就绪。',
    );
  });

  test('rolls back via snapshot when package installs but module import verification fails', async () => {
    const runNpm = npmRunner();
    const verifyInstalledPackage = vi.fn()
      .mockResolvedValueOnce({ ok: false, detail: '安装包模块无法加载：ERR_MODULE_NOT_FOUND typebox' });
    const runAgentBean = vi.fn(async () => success());
    const stderr = vi.fn();
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage,
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('安装包模块无法加载'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('已恢复 0.3.12'));
  });

  test('restores the Device Service after an installed package fails verification and rolls back', async () => {
    let serviceLoaded = true;
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('/opt/agentbean'))
      .mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success('{invalid json'));
    const runAgentBean = vi.fn(async () => {
      serviceLoaded = true;
      return success();
    });
    const stderr = vi.fn();
    const fakes = updateFakes();

    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => {
        serviceLoaded = false;
        return true;
      },
      verifyInstalledPackage: passVerify,
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);

    expect(serviceLoaded).toBe(true);
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    expect(runAgentBean).toHaveBeenCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', String(SERVICE_INSTALL_DEADLINE_MS),
    ]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('UPDATE_INSTALL_FAILED'));
  });

  test('rolls back via snapshot when npm install succeeds but the installed version cannot be verified', async () => {
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('/opt/agentbean'))
      .mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success('{invalid json'));
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, getDeviceServiceStatus: async () => serviceStatus(false),
      verifyInstalledPackage: passVerify, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
  });

  test('restores the snapshot when npm install itself fails', async () => {
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('/opt/agentbean'))
      .mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => ({ exitCode: 1, stdout: '', stderr: 'registry unavailable' }));
    const runAgentBean = vi.fn(async () => success());
    const stderr = vi.fn();
    const fakes = updateFakes();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify,
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    expect(runNpm.mock.calls.some((call) => call[0]?.at(-1) === '@agentbean/daemon@0.3.12')).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('UPDATE_INSTALL_FAILED'));
  });

  test('aborts before installing when the current package cannot be snapshotted', async () => {
    const fakes = updateFakes();
    fakes.snapshotInstalledPackage.mockResolvedValue(false);
    const runNpm = npmRunner();
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(stderr).toHaveBeenCalledWith('无法备份当前 AgentBean 安装（UPDATE_SNAPSHOT_FAILED）；未执行更新。');
    expect(runNpm.mock.calls.some((call) => call[0]?.[0] === 'install')).toBe(false);
    expect(fakes.releaseUpdateLock).toHaveBeenCalled();
  });

  test('rolls back when the running service does not report the target version', async () => {
    const fakes = updateFakes();
    // 新版本 0.3.13 的健康确认失败，回滚后 0.3.12 健康确认通过
    fakes.confirmServiceReady.mockImplementation(async (version: string) => version === '0.3.12');
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      fenceDeviceService: async () => true,
      verifyInstalledPackage: passVerify,
      readServiceErrorSummary: async () => '',
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(fakes.confirmServiceReady).toHaveBeenCalledWith('0.3.13');
    expect(fakes.restorePackageSnapshot).toHaveBeenCalledOnce();
    // install + SERVICE_START_RETRY_ATTEMPTS 次 restart + 恢复 install
    expect(runAgentBean).toHaveBeenCalledTimes(1 + SERVICE_START_RETRY_ATTEMPTS + 1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('已回滚到 0.3.12'));
  });

  test('refuses to run while another update holds the lock', async () => {
    const fakes = updateFakes();
    fakes.acquireUpdateLock.mockResolvedValue(false);
    const runNpm = npmRunner();
    const stderr = vi.fn();
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, getDeviceServiceStatus: async () => serviceStatus(true),
      stderr, ...fakes,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('UPDATE_LOCKED'));
    expect(runNpm.mock.calls.some((call) => call[0]?.[0] === 'install')).toBe(false);
    expect(fakes.releaseUpdateLock).not.toHaveBeenCalled();
  });

  test('acquireUpdateLockFile refuses a fresh lock and takes over a stale one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-update-lock-'));
    const lockPath = join(root, 'update.lock');
    expect(await acquireUpdateLockFile(lockPath)).toBe(true);
    expect(await acquireUpdateLockFile(lockPath)).toBe(false);
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 424242, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
    );
    expect(await acquireUpdateLockFile(lockPath, 10 * 60_000)).toBe(true);
  });

  test('snapshot helpers move the package out and restore it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-update-snapshot-'));
    const packageRoot = join(root, 'daemon');
    const snapshotRoot = join(root, 'backup');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"version":"0.3.12"}');
    expect(await snapshotInstalledPackage({ packageRoot, backupRoot: snapshotRoot })).toBe(true);
    await expect(access(join(packageRoot, 'package.json'))).rejects.toThrow();
    await expect(access(join(snapshotRoot, 'package.json'))).resolves.toBeUndefined();
    expect(await restorePackageSnapshot({ packageRoot, backupRoot: snapshotRoot })).toBe(true);
    await expect(access(join(packageRoot, 'package.json'))).resolves.toBeUndefined();
    expect(await restorePackageSnapshot({ packageRoot, backupRoot: snapshotRoot })).toBe(false);
  });

  test('fails closed when npm global prefix is not absolute', async () => {
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm: async () => success('relative-prefix'), ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
  });

  test('fails closed for unsupported sources, platforms, invalid registry output, and arguments', async () => {
    await expect(runUpdateCli([], { platform: 'linux' })).resolves.toBe(UPDATE_CLI_EXIT.platform);
    await expect(runUpdateCli(['--force'], { platform: 'darwin' })).resolves.toBe(UPDATE_CLI_EXIT.usage);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon-next', version: '0.3.12' },
      ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm: async (argv) => argv[0] === 'prefix' ? success('/opt/agentbean') : success('not-a-version'),
      ...updateFakes(),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
  });

  test('discovers canonical package metadata by walking parent directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-update-package-'));
    const nested = join(root, 'dist', 'apps', 'daemon-next', 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@agentbean/daemon', version: '1.2.3' }));
    await expect(readInstalledAgentBeanPackage(nested)).resolves.toEqual({
      name: '@agentbean/daemon', version: '1.2.3',
    });
  });

  test('verifyInstalledPackage rejects missing entry files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-update-verify-'));
    await expect(verifyInstalledPackage({ globalPrefix: root, version: '0.3.20' })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('fenceDeviceServiceForPackageSwap (#1114 僵尸防护)', () => {
  const plistPath = (home: string) => join(home, 'Library', 'LaunchAgents', 'com.agentbean.device-service.plist');

  async function makeHome() {
    const home = await mkdtemp(join(tmpdir(), 'update-fence-'));
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath(home), '<plist/>');
    return home;
  }

  test('bootout 按路径失败时按 label 兜底(僵尸可杀)', async () => {
    const home = await makeHome();
    const calls: Array<readonly string[]> = [];
    let printCount = 0;
    const run = vi.fn(async (_executable: string, argv: readonly string[]) => {
      calls.push(argv);
      if (argv[0] === 'bootout' && argv.length === 3) {
        // 按路径(domain + plistFile)失败——模拟 plist 状态与注册表不一致。
        return { exitCode: 5, stdout: '', stderr: 'Boot-out failed' };
      }
      if (argv[0] === 'bootout' && argv.length === 2) return success(); // 按 label 成功
      if (argv[0] === 'print') {
        printCount += 1;
        // 兜底 bootout 前:job 仍注册;之后:注销。
        return printCount <= 1 ? success('state = running\n pid = 123') : { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      return success();
    });
    const fenced = await fenceDeviceServiceForPackageSwap({ home, baseDir: join(home, '.agentbean'), run });
    expect(fenced).toBe(true);
    // uid 不写死:CI runner 的 getuid 非 501(2026-08-08 main 红实证)。
    expect(calls.some((argv) => argv[0] === 'bootout' && argv.length === 2
      && argv[1] === `gui/${process.getuid()}/com.agentbean.device-service`)).toBe(true);
  });

  test('bootout 退出码 0 但 job 仍注册时,kill 后再 bootout 直至 print 失败', async () => {
    const home = await makeHome();
    let printCount = 0;
    let killCount = 0;
    const run = vi.fn(async (_executable: string, argv: readonly string[]) => {
      if (argv[0] === 'bootout') return success();
      if (argv[0] === 'kill') { killCount += 1; return success(); }
      if (argv[0] === 'print') {
        printCount += 1;
        // 前两次:仍注册(退出码 0 假象);kill 后:注销。
        return printCount <= 2 ? success('state = running\n pid = 123') : { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      return success();
    });
    const fenced = await fenceDeviceServiceForPackageSwap({ home, baseDir: join(home, '.agentbean'), run });
    expect(fenced).toBe(true);
    expect(killCount).toBeGreaterThan(0);
  });

  test('print 一开始就不可用(queryFailed)也照样尝试卸载', async () => {
    const home = await makeHome();
    let bootoutCount = 0;
    const run = vi.fn(async (_executable: string, argv: readonly string[]) => {
      if (argv[0] === 'bootout') { bootoutCount += 1; return success(); }
      if (argv[0] === 'print') return { exitCode: 1, stdout: '', stderr: 'not found' };
      return success();
    });
    const fenced = await fenceDeviceServiceForPackageSwap({ home, baseDir: join(home, '.agentbean'), run });
    expect(fenced).toBe(true);
    expect(bootoutCount).toBeGreaterThan(0);
  });
});

describe('waitForExecutableReady (#1114 换包窗口)', () => {
  test('存在的可执行入口立即就绪;不存在的超时报明细', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'update-bin-'));
    const bin = join(dir, 'agentbean');
    await writeFile(bin, '#!/usr/bin/env node\n');
    await expect(waitForExecutableReady(bin, 1_000)).resolves.toBeUndefined();
    const missing = await waitForExecutableReady(join(dir, 'nope'), 600);
    expect(missing).toContain('未就绪');
  });
});

describe('buildAgentBeanSpawn (#1114 EACCES 防护)', () => {
  test('经 node 执行 bin 软链目标,不依赖 +x/shebang', () => {
    const spawn = buildAgentBeanSpawn('/opt/agentbean/bin/agentbean', ['device', 'install']);
    expect(spawn.file).toBe(process.execPath);
    expect(spawn.args).toEqual(['/opt/agentbean/bin/agentbean', 'device', 'install']);
  });
});
