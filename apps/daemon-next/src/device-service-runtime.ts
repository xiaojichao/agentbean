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

export interface RunDeviceServiceInput {
  readonly baseDir?: string;
  readonly daemonDeps?: DaemonNextCliDeps;
  readonly listProfiles?: () => AuthProfile[];
  readonly runDaemon?: typeof runDaemonNextCli;
  readonly createHost?: (input: CreateDeviceServiceHostInput) => DeviceServiceHost;
  readonly bindSignals?: typeof bindDeviceServiceSignals;
  readonly readVersion?: () => string;
}

export async function runDeviceService(input: RunDeviceServiceInput = {}): Promise<void> {
  const profiles = (input.listProfiles ?? (() => listAuthProfiles({
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  })))();
  if (profiles.length === 0) throw new Error('SERVICE_NO_PROFILES');
  const baseConfig = parseDaemonNextCliConfig({ argv: [] });
  const configs = expandAllProfiles({ ...baseConfig, allProfiles: false }, profiles);
  const runners = await Promise.all(configs.map(async (config): Promise<DeviceServiceProfileRunner> => {
    let core: DeviceServiceCore | undefined;
    let profileRemoved = false;
    try {
      await (input.runDaemon ?? runDaemonNextCli)(config, {
        ...input.daemonDeps,
        exit: () => {
          profileRemoved = true;
          void Promise.resolve(core?.stop?.()).catch(() => undefined);
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
  const host = (input.createHost ?? createDeviceServiceHost)({
    runners,
    version: (input.readVersion ?? readDaemonVersion)(),
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  });
  (input.bindSignals ?? bindDeviceServiceSignals)(host);
  await host.start();
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
