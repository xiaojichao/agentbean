import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deviceServicePaths } from './device-service-paths.js';
import { acquireDeviceServiceLock, type DeviceServiceLock } from './device-service-lock.js';
import { commitDeviceRuntimeOwner, readDeviceRuntimeOwner, type DeviceRuntimeOwner } from './device-runtime-owner.js';
import {
  discoverUnregisteredLegacyRuntimePids,
  discoverInstalledLegacyExecutables,
  listRegisteredLegacyRuntimes,
} from './legacy-runtime-registration.js';

export type DeviceMigrationPhase =
  | 'idle'
  | 'stopping-legacy'
  | 'checking-health'
  | 'ready-to-commit'
  | 'failed'
  | 'cancelled'
  | 'committed';

export interface DeviceMigrationJournal {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly phase: Exclude<DeviceMigrationPhase, 'idle'>;
  readonly checkpoint: 'stopping-legacy' | 'checking-health' | 'ready-to-commit' | 'committed';
  readonly dataPolicy: 'in-place';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly reasonCode?: string;
}

export interface DeviceMigrationStatus {
  readonly schemaVersion: 1;
  readonly owner: DeviceRuntimeOwner;
  readonly phase: DeviceMigrationPhase;
  readonly canStart: boolean;
  readonly health: {
    readonly legacyRuntimeCount: number;
    readonly staleLiveRegistrationCount: number;
    readonly unregisteredLegacyRuntimeCount: number;
    readonly installedLegacyExecutableCount: number;
    readonly deviceServiceRunning: boolean;
    readonly migrationServiceHealthy: boolean;
    readonly platformSupported: boolean;
    readonly savedProfileCount: number;
    readonly dataPolicy: 'in-place';
  };
  readonly journal: DeviceMigrationJournal | null;
}

export interface DeviceMigrationDeps {
  readonly baseDir?: string;
  readonly now?: () => number;
  readonly readOwner?: () => Promise<DeviceRuntimeOwner>;
  readonly commitOwner?: () => Promise<void>;
  readonly stopLegacy?: () => Promise<void>;
  readonly listLegacy?: () => Promise<Awaited<ReturnType<typeof listRegisteredLegacyRuntimes>>>;
  readonly listUnregisteredLegacyPids?: (registeredPids: ReadonlySet<number>) => Promise<number[]>;
  readonly listInstalledLegacyExecutables?: () => Promise<string[]>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly acquireTransitionLock?: () => Promise<DeviceServiceLock>;
  readonly prepareMigrationService?: () => Promise<void>;
  readonly verifyMigrationService?: () => Promise<boolean>;
  readonly activateDeviceService?: () => Promise<void>;
  readonly stopMigrationService?: () => Promise<void>;
  readonly readPlatformSupported?: () => boolean;
  readonly readSavedProfileCount?: () => number;
}

export async function planDeviceMigration(deps: DeviceMigrationDeps = {}): Promise<DeviceMigrationStatus> {
  return inspectDeviceMigration(deps);
}

export async function startDeviceMigration(deps: DeviceMigrationDeps = {}): Promise<DeviceMigrationStatus> {
  const lock = await acquireTransitionLock(deps);
  try {
    return await startDeviceMigrationWhileLocked(deps);
  } finally {
    await lock.release();
  }
}

async function startDeviceMigrationWhileLocked(deps: DeviceMigrationDeps): Promise<DeviceMigrationStatus> {
  const owner = await readOwner(deps);
  const existing = await readDeviceMigrationJournal(deps.baseDir);
  if (owner === 'device-service') {
    if (existing?.phase !== 'committed') {
      try {
        await deps.activateDeviceService?.();
        await writeCommittedJournal(existing, deps);
      } catch (error) {
        if (existing) await writeJournal({
          ...existing,
          phase: 'ready-to-commit',
          checkpoint: 'ready-to-commit',
          updatedAt: isoNow(deps),
          reasonCode: stableReason(error),
        }, deps.baseDir);
        throw error;
      }
    }
    return inspectDeviceMigration(deps);
  }
  if (existing?.phase === 'committed') throw new Error('MIGRATION_OWNER_JOURNAL_MISMATCH');
  const now = isoNow(deps);
  const initial: DeviceMigrationJournal = existing && existing.phase !== 'cancelled'
    ? { ...existing, phase: 'stopping-legacy', checkpoint: 'stopping-legacy', updatedAt: now, reasonCode: undefined }
    : {
        schemaVersion: 1,
        migrationId: randomUUID(),
        phase: 'stopping-legacy',
        checkpoint: 'stopping-legacy',
        dataPolicy: 'in-place',
        startedAt: now,
        updatedAt: now,
      };
  await writeJournal(initial, deps.baseDir);
  try {
    await (deps.stopLegacy ?? (async () => undefined))();
    const preflight = await inspectHealth(deps);
    if (preflight.legacyRuntimeCount > 0 || preflight.staleLiveRegistrationCount > 0
      || preflight.unregisteredLegacyRuntimeCount > 0) {
      throw new Error('LEGACY_RUNTIME_STILL_ACTIVE');
    }
    if (preflight.installedLegacyExecutableCount > 0) throw new Error('LEGACY_EXECUTABLE_STILL_INSTALLED');
    if (!preflight.platformSupported) throw new Error('MIGRATION_PLATFORM_UNSUPPORTED');
    if (preflight.savedProfileCount === 0) throw new Error('SERVICE_NO_PROFILES');
    const reuseMigrationService = preflight.deviceServiceRunning && preflight.migrationServiceHealthy;
    if (preflight.deviceServiceRunning && !reuseMigrationService) throw new Error('DEVICE_SERVICE_ALREADY_ACTIVE');
    await writeJournal({ ...initial, phase: 'checking-health', checkpoint: 'checking-health', updatedAt: isoNow(deps) }, deps.baseDir);
    if (!reuseMigrationService) await deps.prepareMigrationService?.();
    const health = await inspectHealth(deps);
    if (health.legacyRuntimeCount > 0 || health.staleLiveRegistrationCount > 0
      || health.unregisteredLegacyRuntimeCount > 0) {
      throw new Error('LEGACY_RUNTIME_STILL_ACTIVE');
    }
    if (health.installedLegacyExecutableCount > 0) throw new Error('LEGACY_EXECUTABLE_STILL_INSTALLED');
    if (deps.prepareMigrationService && !health.migrationServiceHealthy) {
      throw new Error('MIGRATION_SERVICE_NOT_HEALTHY');
    }
    const ready: DeviceMigrationJournal = {
      ...initial,
      phase: 'ready-to-commit',
      checkpoint: 'ready-to-commit',
      updatedAt: isoNow(deps),
    };
    await writeJournal(ready, deps.baseDir);
    await (deps.commitOwner ?? (() => commitDeviceRuntimeOwner(deps.baseDir)))();
    await deps.activateDeviceService?.();
    await writeCommittedJournal(ready, deps);
    return inspectDeviceMigration(deps);
  } catch (error) {
    if (await readOwner(deps) === 'device-service') {
      const current = await readDeviceMigrationJournal(deps.baseDir) ?? initial;
      await writeJournal({
        ...current,
        phase: 'ready-to-commit',
        checkpoint: 'ready-to-commit',
        updatedAt: isoNow(deps),
        reasonCode: stableReason(error),
      }, deps.baseDir);
      throw error;
    }
    const current = await readDeviceMigrationJournal(deps.baseDir) ?? initial;
    await deps.stopMigrationService?.().catch(() => undefined);
    await writeJournal({
      ...current,
      phase: 'failed',
      updatedAt: isoNow(deps),
      reasonCode: stableReason(error),
    }, deps.baseDir);
    throw error;
  }
}

export async function resumeDeviceMigration(deps: DeviceMigrationDeps = {}): Promise<DeviceMigrationStatus> {
  const journal = await readDeviceMigrationJournal(deps.baseDir);
  const owner = await readOwner(deps);
  if (owner === 'device-service') return startDeviceMigration(deps);
  if (!journal || journal.phase === 'cancelled') throw new Error('MIGRATION_NOT_RESUMABLE');
  return startDeviceMigration(deps);
}

export async function cancelDeviceMigration(deps: DeviceMigrationDeps = {}): Promise<DeviceMigrationStatus> {
  const lock = await acquireTransitionLock(deps);
  try {
    if (await readOwner(deps) === 'device-service') throw new Error('MIGRATION_ALREADY_COMMITTED');
    const journal = await readDeviceMigrationJournal(deps.baseDir);
    if (!journal) throw new Error('MIGRATION_NOT_STARTED');
    await deps.stopMigrationService?.();
    await writeJournal({
      ...journal,
      phase: 'cancelled',
      updatedAt: isoNow(deps),
      reasonCode: undefined,
    }, deps.baseDir);
    return inspectDeviceMigration(deps);
  } finally {
    await lock.release();
  }
}

export async function inspectDeviceMigration(deps: DeviceMigrationDeps = {}): Promise<DeviceMigrationStatus> {
  const [owner, journal, health] = await Promise.all([
    readOwner(deps),
    readDeviceMigrationJournal(deps.baseDir),
    inspectHealth(deps),
  ]);
  const phase = owner === 'device-service' ? 'committed' : journal?.phase ?? 'idle';
  return {
    schemaVersion: 1,
    owner,
    phase,
    canStart: owner === 'legacy-daemon'
      && (!health.deviceServiceRunning || health.migrationServiceHealthy)
      && health.legacyRuntimeCount === 0
      && health.staleLiveRegistrationCount === 0
      && health.unregisteredLegacyRuntimeCount === 0
      && health.installedLegacyExecutableCount === 0
      && health.platformSupported
      && health.savedProfileCount > 0,
    health,
    journal,
  };
}

async function inspectHealth(deps: DeviceMigrationDeps): Promise<DeviceMigrationStatus['health']> {
  const runtimes = await (deps.listLegacy ?? (() => listRegisteredLegacyRuntimes(deps.baseDir)))();
  const liveRegisteredPids = new Set(runtimes.filter((runtime) => runtime.alive).map((runtime) => runtime.pid));
  const unregisteredPids = await (deps.listUnregisteredLegacyPids
    ?? (deps.listLegacy
      ? async () => []
      : (registeredPids) => discoverUnregisteredLegacyRuntimePids(registeredPids)))(liveRegisteredPids);
  const installedExecutables = await (deps.listInstalledLegacyExecutables
    ?? (deps.listLegacy ? async () => [] : discoverInstalledLegacyExecutables))();
  return {
    legacyRuntimeCount: runtimes.filter((runtime) => runtime.alive && runtime.fresh).length,
    staleLiveRegistrationCount: runtimes.filter((runtime) => runtime.alive && !runtime.fresh).length,
    unregisteredLegacyRuntimeCount: unregisteredPids.length,
    installedLegacyExecutableCount: installedExecutables.length,
    deviceServiceRunning: await isDeviceServiceRunning(deps),
    migrationServiceHealthy: await (deps.verifyMigrationService?.() ?? Promise.resolve(false)),
    platformSupported: deps.readPlatformSupported?.() ?? true,
    savedProfileCount: deps.readSavedProfileCount?.() ?? 1,
    dataPolicy: 'in-place',
  };
}

async function isDeviceServiceRunning(deps: DeviceMigrationDeps): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(join(deviceServicePaths(deps.baseDir).lockDirectory, 'owner.json'), 'utf8')) as {
      pid?: unknown;
    };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return true;
    return (deps.isProcessAlive ?? processIsAlive)(parsed.pid as number);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    return true;
  }
}

export async function readDeviceMigrationJournal(baseDir?: string): Promise<DeviceMigrationJournal | null> {
  try {
    const parsed = JSON.parse(await readFile(deviceServicePaths(baseDir).migrationJournalFile, 'utf8')) as Partial<DeviceMigrationJournal>;
    if (parsed.schemaVersion !== 1 || typeof parsed.migrationId !== 'string' || parsed.dataPolicy !== 'in-place'
      || typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string'
      || !isJournalPhase(parsed.phase) || !isCheckpoint(parsed.checkpoint)
      || (parsed.reasonCode !== undefined && typeof parsed.reasonCode !== 'string')) {
      throw new Error('MIGRATION_JOURNAL_INVALID');
    }
    return parsed as DeviceMigrationJournal;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writeCommittedJournal(
  previous: DeviceMigrationJournal | null,
  deps: DeviceMigrationDeps,
): Promise<void> {
  const now = isoNow(deps);
  await writeJournal({
    schemaVersion: 1,
    migrationId: previous?.migrationId ?? randomUUID(),
    phase: 'committed',
    checkpoint: 'committed',
    dataPolicy: 'in-place',
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  }, deps.baseDir);
}

async function writeJournal(journal: DeviceMigrationJournal, baseDir?: string): Promise<void> {
  const path = deviceServicePaths(baseDir).migrationJournalFile;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(journal)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readOwner(deps: DeviceMigrationDeps): Promise<DeviceRuntimeOwner> {
  return (deps.readOwner ?? (() => readDeviceRuntimeOwner(deps.baseDir)))();
}

async function acquireTransitionLock(deps: DeviceMigrationDeps): Promise<DeviceServiceLock> {
  return (deps.acquireTransitionLock
    ?? (() => acquireDeviceServiceLock(deviceServicePaths(deps.baseDir).migrationLockDirectory)))();
}

function isoNow(deps: DeviceMigrationDeps): string {
  return new Date((deps.now ?? Date.now)()).toISOString();
}

function stableReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'MIGRATION_PRECOMMIT_FAILED';
}

function isJournalPhase(value: unknown): value is DeviceMigrationJournal['phase'] {
  return value === 'stopping-legacy' || value === 'checking-health' || value === 'ready-to-commit'
    || value === 'failed' || value === 'cancelled' || value === 'committed';
}

function isCheckpoint(value: unknown): value is DeviceMigrationJournal['checkpoint'] {
  return value === 'stopping-legacy' || value === 'checking-health' || value === 'ready-to-commit' || value === 'committed';
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
