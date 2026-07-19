import type { DeviceServiceCore } from './device-service-core.js';
import type {
  DeviceServiceProfileRunner,
  ProfileDrainResult,
  ProfileRuntimePhase,
  ProfileRuntimeStatus,
} from './device-service-host.js';

export interface CreateDeviceServiceProfileRunnerInput {
  readonly profileId: string;
  readonly core: DeviceServiceCore;
  readonly beginDrain: (deadlineMs: number) => Promise<ProfileDrainResult>;
  readonly readCounts?: () => Pick<ProfileRuntimeStatus, 'activeWorkCount' | 'outboxPendingCount'>;
}

export function createDeviceServiceProfileRunner(
  input: CreateDeviceServiceProfileRunnerInput,
): DeviceServiceProfileRunner {
  let phase: ProfileRuntimePhase = 'stopped';
  const counts = () => input.readCounts?.() ?? { activeWorkCount: 0, outboxPendingCount: 0 };
  return {
    profileId: input.profileId,
    async start() {
      phase = 'starting';
      try {
        await input.core.start();
        phase = 'healthy';
      } catch (error) {
        phase = 'failed';
        throw error;
      }
    },
    async beginDrain(deadlineMs) {
      phase = 'draining';
      try {
        const result = await input.beginDrain(deadlineMs);
        if (!result.ok) phase = 'degraded';
        return result;
      } catch (error) {
        phase = 'degraded';
        throw error;
      }
    },
    async stop() {
      try {
        await input.core.stop?.();
      } finally {
        phase = 'stopped';
      }
    },
    snapshot() {
      return { phase, ...counts() };
    },
  };
}
