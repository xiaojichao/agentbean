import { describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  cancelDeviceMigration,
  inspectDeviceMigration,
  resumeDeviceMigration,
  startDeviceMigration,
} from '../src/device-migration';
import { DEVICE_CLI_EXIT, runDeviceCli } from '../src/device-cli';
import { assertDeviceRuntimeOwner, readDeviceRuntimeOwner } from '../src/device-runtime-owner';
import { deviceServicePaths } from '../src/device-service-paths';
import { acquireDeviceServiceLock } from '../src/device-service-lock';
import {
  listRegisteredLegacyRuntimes,
  discoverUnregisteredLegacyRuntimePids,
  discoverInstalledLegacyExecutables,
  registerLegacyRuntime,
} from '../src/legacy-runtime-registration';

describe('Device Service migration', () => {
  test('reports an idle in-place plan through the stable JSON CLI', async () => {
    const output: string[] = [];
    const status = await inspectDeviceMigration({
      readOwner: async () => 'legacy-daemon',
      listLegacy: async () => [],
    });
    await expect(runDeviceCli(['migrate', 'plan', '--json'], {
      migrate: vi.fn(async () => status),
      stdout: (line) => output.push(line),
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      schemaVersion: 1,
      owner: 'legacy-daemon',
      phase: 'idle',
      canStart: true,
      health: { dataPolicy: 'in-place' },
    });
  });

  test('plan reports unsupported platform and missing saved Profiles before start', async () => {
    await expect(inspectDeviceMigration({
      readOwner: async () => 'legacy-daemon',
      listLegacy: async () => [],
      readPlatformSupported: () => false,
      readSavedProfileCount: () => 0,
    })).resolves.toMatchObject({
      canStart: false,
      health: { platformSupported: false, savedProfileCount: 0 },
    });
  });

  test('commits owner atomically without copying or deleting user data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-migration-data-'));
    const baseDir = join(home, '.agentbean');
    const canaries = new Map<string, Buffer>([
      [join(baseDir, 'teams', 'profile-a', 'auth.json'), Buffer.from([0, 1, 2, 255])],
      [join(baseDir, 'teams', 'profile-a', 'management', 'outbox.json'), Buffer.from('outbox')],
      [join(baseDir, 'teams', 'profile-a', 'memory', 'capsule.bin'), Buffer.from([9, 8, 7])],
      [join(baseDir, 'machine-id'), Buffer.from('machine-id')],
      [join(home, 'Workspace', 'canary'), Buffer.from('workspace')],
    ]);
    for (const [path, value] of canaries) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value);
    }

    const result = await startDeviceMigration({ baseDir, stopLegacy: async () => undefined, listLegacy: async () => [] });

    expect(result).toMatchObject({ owner: 'device-service', phase: 'committed' });
    expect(await readDeviceRuntimeOwner(baseDir)).toBe('device-service');
    expect((await stat(deviceServicePaths(baseDir).runtimeOwnerFile)).mode & 0o777).toBe(0o600);
    expect((await stat(deviceServicePaths(baseDir).migrationJournalFile)).mode & 0o777).toBe(0o600);
    for (const [path, value] of canaries) expect(await readFile(path)).toEqual(value);
  });

  test('keeps Legacy ownership on a pre-commit failure and resumes idempotently', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-resume-'));
    await expect(startDeviceMigration({
      baseDir,
      stopLegacy: async () => { throw new Error('LEGACY_RUNTIME_STOP_TIMEOUT'); },
      listLegacy: async () => [],
    })).rejects.toThrow('LEGACY_RUNTIME_STOP_TIMEOUT');

    expect(await readDeviceRuntimeOwner(baseDir)).toBe('legacy-daemon');
    expect(await inspectDeviceMigration({ baseDir, listLegacy: async () => [] })).toMatchObject({
      owner: 'legacy-daemon',
      phase: 'failed',
      journal: { reasonCode: 'LEGACY_RUNTIME_STOP_TIMEOUT' },
    });

    const resumed = await resumeDeviceMigration({ baseDir, stopLegacy: async () => undefined, listLegacy: async () => [] });
    expect(resumed).toMatchObject({ owner: 'device-service', phase: 'committed' });
    await expect(resumeDeviceMigration({ baseDir, listLegacy: async () => [] })).resolves.toMatchObject({ phase: 'committed' });
  });

  test('repairs a crash between owner commit and committed journal', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-postcommit-'));
    const paths = deviceServicePaths(baseDir);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.runtimeOwnerFile, '{"schemaVersion":1,"owner":"device-service"}\n', { mode: 0o600 });
    await writeFile(paths.migrationJournalFile, JSON.stringify({
      schemaVersion: 1,
      migrationId: 'migration-1',
      phase: 'ready-to-commit',
      checkpoint: 'ready-to-commit',
      dataPolicy: 'in-place',
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:01.000Z',
    }), { mode: 0o600 });

    const result = await resumeDeviceMigration({ baseDir, listLegacy: async () => [] });
    expect(result).toMatchObject({ owner: 'device-service', phase: 'committed', journal: { checkpoint: 'committed' } });
  });

  test('resume reuses a healthy migration-only host after a pre-commit crash', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-reuse-host-'));
    const paths = deviceServicePaths(baseDir);
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.lockDirectory, { recursive: true });
    await writeFile(join(paths.lockDirectory, 'owner.json'), '{"schemaVersion":1,"pid":42,"nonce":"migration"}\n');
    await writeFile(paths.migrationJournalFile, JSON.stringify({
      schemaVersion: 1,
      migrationId: 'migration-reuse',
      phase: 'ready-to-commit',
      checkpoint: 'ready-to-commit',
      dataPolicy: 'in-place',
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:01.000Z',
    }), { mode: 0o600 });
    const prepareMigrationService = vi.fn(async () => undefined);

    await expect(resumeDeviceMigration({
      baseDir,
      listLegacy: async () => [],
      isProcessAlive: (pid) => pid === 42,
      verifyMigrationService: async () => true,
      prepareMigrationService,
      activateDeviceService: async () => undefined,
    })).resolves.toMatchObject({ owner: 'device-service', phase: 'committed' });
    expect(prepareMigrationService).not.toHaveBeenCalled();
  });

  test('cancel is pre-commit only and an active runtime blocks commit', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-cancel-'));
    await expect(startDeviceMigration({
      baseDir,
      stopLegacy: async () => undefined,
      listLegacy: async () => [{
        schemaVersion: 1, pid: 42, nonce: 'live', startedAt: '2026-07-19T00:00:00.000Z',
        file: '/tmp/live', fresh: true, alive: true,
      }],
    })).rejects.toThrow('LEGACY_RUNTIME_STILL_ACTIVE');
    await expect(cancelDeviceMigration({ baseDir, listLegacy: async () => [] })).resolves.toMatchObject({
      owner: 'legacy-daemon', phase: 'cancelled',
    });
    await startDeviceMigration({ baseDir, stopLegacy: async () => undefined, listLegacy: async () => [] });
    await expect(cancelDeviceMigration({ baseDir, listLegacy: async () => [] })).rejects.toThrow('MIGRATION_ALREADY_COMMITTED');
  });

  test('rejects a legacy npm process that predates runtime registration', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-unregistered-'));
    await expect(startDeviceMigration({
      baseDir,
      stopLegacy: async () => undefined,
      listLegacy: async () => [],
      listUnregisteredLegacyPids: async () => [4242],
    })).rejects.toThrow('LEGACY_RUNTIME_STILL_ACTIVE');
    expect(await readDeviceRuntimeOwner(baseDir)).toBe('legacy-daemon');
  });

  test('rejects commit while a historical global npm executable can bypass the new shim', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-old-package-'));
    await expect(startDeviceMigration({
      baseDir,
      listLegacy: async () => [],
      listInstalledLegacyExecutables: async () => ['/opt/lib/node_modules/@agentbean/daemon/dist/bin.js'],
    })).rejects.toThrow('LEGACY_EXECUTABLE_STILL_INSTALLED');
    expect(await readDeviceRuntimeOwner(baseDir)).toBe('legacy-daemon');
  });

  test('fences the Legacy compatibility entry after commit with a new CLI instruction', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-fence-'));
    await startDeviceMigration({ baseDir, stopLegacy: async () => undefined, listLegacy: async () => [] });
    await expect(assertDeviceRuntimeOwner('legacy-daemon', baseDir)).rejects.toThrow(
      'DEVICE_SERVICE_OWNS_RUNTIME：Legacy Daemon 已停用，请改用 `agentbean device status`。',
    );
  });

  test('holds the startup transition lock until the owner commit is complete', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-lock-'));
    const lockPath = deviceServicePaths(baseDir).migrationLockDirectory;
    await startDeviceMigration({
      baseDir,
      stopLegacy: async () => {
        await expect(acquireDeviceServiceLock(lockPath)).rejects.toThrow('SERVICE_ALREADY_RUNNING');
      },
      listLegacy: async () => [],
    });
    const next = await acquireDeviceServiceLock(lockPath);
    await next.release();
  });

  test('verifies a migration-only Service Host before commit and activates runners after commit', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-host-'));
    let owner: 'legacy-daemon' | 'device-service' = 'legacy-daemon';
    let migrationHealthy = false;
    const lifecycle: string[] = [];
    const result = await startDeviceMigration({
      baseDir,
      readOwner: async () => owner,
      stopLegacy: async () => { lifecycle.push('stop-legacy'); },
      listLegacy: async () => [],
      isProcessAlive: () => false,
      prepareMigrationService: async () => {
        lifecycle.push('prepare-migration-host');
        migrationHealthy = true;
      },
      verifyMigrationService: async () => migrationHealthy,
      commitOwner: async () => {
        lifecycle.push('commit-owner');
        owner = 'device-service';
      },
      activateDeviceService: async () => { lifecycle.push('activate-runners'); },
    });

    expect(lifecycle).toEqual(['stop-legacy', 'prepare-migration-host', 'commit-owner', 'activate-runners']);
    expect(result).toMatchObject({ owner: 'device-service', phase: 'committed' });
  });

  test('keeps a post-commit activation failure resumable without restoring Legacy', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-migration-activation-'));
    let owner: 'legacy-daemon' | 'device-service' = 'legacy-daemon';
    await expect(startDeviceMigration({
      baseDir,
      readOwner: async () => owner,
      stopLegacy: async () => undefined,
      listLegacy: async () => [],
      prepareMigrationService: async () => undefined,
      verifyMigrationService: async () => true,
      commitOwner: async () => { owner = 'device-service'; },
      activateDeviceService: async () => { throw new Error('DEVICE_SERVICE_ACTIVATION_FAILED'); },
    })).rejects.toThrow('DEVICE_SERVICE_ACTIVATION_FAILED');
    expect(owner).toBe('device-service');
    expect(await inspectDeviceMigration({
      baseDir,
      readOwner: async () => owner,
      listLegacy: async () => [],
    })).toMatchObject({ phase: 'committed', journal: { phase: 'ready-to-commit' } });
    await expect(resumeDeviceMigration({
      baseDir,
      readOwner: async () => owner,
      listLegacy: async () => [],
      activateDeviceService: async () => undefined,
    })).resolves.toMatchObject({ owner: 'device-service', phase: 'committed', journal: { phase: 'committed' } });
  });
});

describe('Legacy runtime registration', () => {
  test('registers privately, heartbeats, releases idempotently, and exposes only process metadata', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-legacy-registration-'));
    const registration = await registerLegacyRuntime(baseDir, { pid: 4242, now: () => 1_000 });
    const records = await listRegisteredLegacyRuntimes(baseDir, {
      now: () => 1_000,
      isProcessAlive: (pid) => pid === 4242,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: 4242, fresh: true, alive: true });
    expect((await stat(registration.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(registration.file, 'utf8')).not.toMatch(/token|auth|profile/i);
    await registration.release();
    await registration.release();
    expect(await listRegisteredLegacyRuntimes(baseDir)).toEqual([]);
  });

  test('reports fresh and stale live registrations without signaling either process', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-legacy-stop-'));
    const fresh = await registerLegacyRuntime(baseDir, { pid: 101 });
    const stale = await registerLegacyRuntime(baseDir, { pid: 303, now: () => 0 });
    await expect(listRegisteredLegacyRuntimes(baseDir, {
      now: () => 20_000,
      isProcessAlive: (pid) => pid === 101 || pid === 303,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 101, alive: true }),
      expect.objectContaining({ pid: 303, alive: true, fresh: false }),
    ]));
    await fresh.release();
    await stale.release();
  });

  test('detects pre-registration npm daemons but excludes the migration and service entries', async () => {
    const output = [
      '  101 /opt/homebrew/bin/node /opt/homebrew/bin/agentbean-next-daemon --all-profiles',
      '  202 /opt/homebrew/bin/node /usr/local/lib/node_modules/@agentbean/daemon-next/dist/apps/daemon-next/src/bin.js',
      '  303 /opt/homebrew/bin/node /opt/homebrew/bin/agentbean device migrate start',
      '  404 /opt/homebrew/bin/node /opt/homebrew/bin/agentbean service run',
      '  505 /opt/bin/claude --resume /Users/shaw/AgentBean/session.json --add-dir /Users/shaw/agentbean',
      '  606 npm exec @agentbean/daemon@latest --profile-id main --server-url https://api.agentbean.dev',
      '  707 node /Users/shaw/.npm/_npx/hash/node_modules/.bin/daemon --invite-code code --server-url https://api.agentbean.dev',
      '  808 node /opt/lib/node_modules/@agentbean/daemon/dist/bin.js --profile-id main --server-url https://api.agentbean.dev',
      '  909 /opt/homebrew/bin/agentbean-daemon --profile-id main --server-url https://api.agentbean.dev',
    ].join('\n');
    await expect(discoverUnregisteredLegacyRuntimePids(new Set([202]), {
      pid: 999,
      runPs: async () => output,
    })).resolves.toEqual([101, 606, 707, 808, 909]);
  });

  test('requires the historical global npm executable to be uninstalled before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-legacy-executable-'));
    const bin = join(root, 'bin');
    const historical = join(root, 'node_modules', '@agentbean', 'daemon', 'dist', 'bin.js');
    const current = join(root, 'node_modules', '@agentbean', 'daemon-next', 'dist', 'bin.js');
    const oldNext = join(root, 'old', 'node_modules', '@agentbean', 'daemon-next', 'dist', 'bin.js');
    await mkdir(bin, { recursive: true });
    await mkdir(dirname(historical), { recursive: true });
    await mkdir(dirname(current), { recursive: true });
    await mkdir(dirname(oldNext), { recursive: true });
    await writeFile(historical, 'historical');
    await writeFile(current, '#!/usr/bin/env node\nconsole.error("DEVICE_SERVICE_OWNS_RUNTIME：Legacy Daemon 已停用"); process.exit(1);\n', { mode: 0o700 });
    await writeFile(oldNext, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
    await symlink(historical, join(bin, 'daemon'));
    await symlink(current, join(bin, 'agentbean'));
    await symlink(oldNext, join(bin, 'agentbean-next-daemon'));

    const discovered = await discoverInstalledLegacyExecutables(bin);
    expect(discovered).toHaveLength(2);
    expect(discovered).toEqual(expect.arrayContaining([
      expect.stringMatching(/node_modules\/@agentbean\/daemon\/dist\/bin\.js$/),
      expect.stringMatching(/old\/node_modules\/@agentbean\/daemon-next\/dist\/bin\.js$/),
    ]));
  });
});
