import { listAuthProfiles, type AuthProfile } from './auth-store.js';
import {
  expandAllProfiles,
  parseDaemonNextCliConfig,
  runDaemonNextCli,
  type DaemonNextCliDeps,
} from './cli.js';
import type { DeviceServiceCore } from './device-service-core.js';
import {
  bindDeviceServiceSignals,
  createDeviceServiceHost,
  type CreateDeviceServiceHostInput,
  type DeviceServiceHost,
  type DeviceServiceProfileRunner,
} from './device-service-host.js';
import { createDeviceServiceProfileRunner } from './device-service-profile-runner.js';
import { readDaemonVersion } from './system-info.js';
import { assertDeviceRuntimeOwner, readDeviceRuntimeOwner, type DeviceRuntimeOwner } from './device-runtime-owner.js';
import { readDeviceMigrationJournal, type DeviceMigrationJournal } from './device-migration.js';
import { discoverUnregisteredLegacyRuntimePids } from './legacy-runtime-registration.js';

export interface RunDeviceServiceInput {
  readonly baseDir?: string;
  readonly daemonDeps?: DaemonNextCliDeps;
  readonly listProfiles?: () => AuthProfile[];
  readonly runDaemon?: typeof runDaemonNextCli;
  readonly createHost?: (input: CreateDeviceServiceHostInput) => DeviceServiceHost;
  readonly bindSignals?: typeof bindDeviceServiceSignals;
  readonly readVersion?: () => string;
  readonly assertRuntimeOwner?: (owner: DeviceRuntimeOwner) => Promise<void>;
  readonly readRuntimeOwner?: () => Promise<DeviceRuntimeOwner>;
  readonly readMigrationJournal?: () => Promise<DeviceMigrationJournal | null>;
  readonly discoverLegacyRuntimePids?: () => Promise<number[]>;
  readonly legacyFenceIntervalMs?: number;
  readonly exitCodeTarget?: Pick<NodeJS.Process, 'exitCode'>;
}

export async function runDeviceService(input: RunDeviceServiceInput = {}): Promise<void> {
  const assertRuntimeOwner = input.assertRuntimeOwner
    ?? ((owner: DeviceRuntimeOwner) => assertDeviceRuntimeOwner(owner, input.baseDir));
  const [owner, migration] = await Promise.all([
    (input.readRuntimeOwner ?? (() => readDeviceRuntimeOwner(input.baseDir)))(),
    (input.readMigrationJournal ?? (() => readDeviceMigrationJournal(input.baseDir)))(),
  ]);
  const migrationOnly = owner === 'legacy-daemon'
    && (migration?.phase === 'checking-health' || migration?.phase === 'ready-to-commit');
  if (!migrationOnly) await assertRuntimeOwner('device-service');
  if (migrationOnly) {
    const host = (input.createHost ?? createDeviceServiceHost)({
      runners: [],
      version: (input.readVersion ?? readDaemonVersion)(),
      ...(input.baseDir ? { baseDir: input.baseDir } : {}),
    });
    (input.bindSignals ?? bindDeviceServiceSignals)(host);
    await host.start();
    return;
  }
  const discoverLegacyRuntimePids = input.discoverLegacyRuntimePids
    ?? (input.assertRuntimeOwner ? async () => [] : () => discoverUnregisteredLegacyRuntimePids(new Set()));
  if ((await discoverLegacyRuntimePids()).length > 0) throw new Error('LEGACY_RUNTIME_FENCE_ACTIVE');
  const profiles = (input.listProfiles ?? (() => listAuthProfiles({
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  })))();
  if (profiles.length === 0) throw new Error('SERVICE_NO_PROFILES');
  const baseConfig = parseDaemonNextCliConfig({ argv: [] });
  const configs = expandAllProfiles({ ...baseConfig, allProfiles: false }, profiles);
  let host: DeviceServiceHost | undefined;
  const runners = await Promise.all(configs.map(async (config): Promise<DeviceServiceProfileRunner> => {
    let core: DeviceServiceCore | undefined;
    let profileRemoved = false;
    try {
      await (input.runDaemon ?? runDaemonNextCli)(config, {
        ...input.daemonDeps,
        runtimeOwner: 'device-service',
        assertRuntimeOwner,
        exit: () => {
          profileRemoved = true;
          void Promise.resolve(core?.stop?.()).catch(() => undefined);
          void host?.refreshStatus().catch(() => undefined);
        },
        startDeviceServiceCore: async (created) => {
          core = created.core;
        },
      });
    } catch {
      return failedProfileRunner(config.profileId);
    }
    if (!core) return failedProfileRunner(config.profileId);
    const serviceCore = core;
    return createDeviceServiceProfileRunner({
      profileId: config.profileId,
      core: serviceCore,
      beginDrain: async (deadlineMs) => {
        try {
          await serviceCore.beginDrain(deadlineMs);
          return { ok: true };
        } catch {
          return { ok: false, reasonCode: 'PROFILE_DRAIN_FAILED' };
        }
      },
      readCounts: () => ({
        activeWorkCount: serviceCore.activeWorkCount(),
        outboxPendingCount: serviceCore.outboxPendingCount(),
      }),
      readPhase: () => profileRemoved ? 'failed' : undefined,
    });
  }));
  host = (input.createHost ?? createDeviceServiceHost)({
    runners,
    version: (input.readVersion ?? readDaemonVersion)(),
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  });
  (input.bindSignals ?? bindDeviceServiceSignals)(host);
  await host.start();
  bindLegacyRuntimeFence(host, discoverLegacyRuntimePids, {
    intervalMs: input.legacyFenceIntervalMs,
    exitCodeTarget: input.exitCodeTarget,
  });
}

export function bindLegacyRuntimeFence(
  host: Pick<DeviceServiceHost, 'stop'>,
  discoverLegacyRuntimePids: () => Promise<number[]>,
  options: { intervalMs?: number; exitCodeTarget?: Pick<NodeJS.Process, 'exitCode'> } = {},
): () => void {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void discoverLegacyRuntimePids().then(async (pids) => {
      if (pids.length === 0) return;
      (options.exitCodeTarget ?? process).exitCode = 1;
      await host.stop(30_000);
    }).catch(() => {
      (options.exitCodeTarget ?? process).exitCode = 1;
      return host.stop(30_000);
    }).finally(() => {
      checking = false;
    });
  }, options.intervalMs ?? 1_000);
  timer.unref();
  return () => clearInterval(timer);
}

function failedProfileRunner(profileId: string): DeviceServiceProfileRunner {
  return {
    profileId,
    async start() { throw new Error('PROFILE_START_FAILED'); },
    async beginDrain() { return { ok: false, reasonCode: 'PROFILE_DRAIN_FAILED' }; },
    async stop() {},
    snapshot() {
      return { phase: 'failed', activeWorkCount: 0, outboxPendingCount: 0 };
    },
  };
}
