import { chmod, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDeviceServiceDirectory } from './device-service-filesystem.js';

export type DeviceServicePhase =
  | 'starting'
  | 'running'
  | 'draining'
  | 'stopping'
  | 'stopped'
  | 'degraded'
  | 'failed';

export type DeviceServiceReasonCode =
  | 'SERVICE_READY'
  | 'SERVICE_ALREADY_RUNNING'
  | 'SERVICE_NOT_RUNNING'
  | 'SERVICE_CONTROL_UNAVAILABLE'
  | 'SERVICE_DRAIN_TIMEOUT'
  | 'SERVICE_STATE_WRITE_FAILED'
  | 'PROFILE_START_FAILED'
  | 'PROFILE_DRAIN_FAILED';

export interface DeviceServiceProfileCounts {
  readonly total: number;
  readonly healthy: number;
  readonly failed: number;
  readonly draining: number;
  readonly stopped: number;
}

export interface DeviceServiceState {
  readonly schemaVersion: 1;
  readonly phase: DeviceServicePhase;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly profiles: DeviceServiceProfileCounts;
  readonly activeWorkCount: number;
  readonly outboxPendingCount: number;
  readonly reasonCode: DeviceServiceReasonCode;
}

export interface DeviceServiceStateStore {
  write(state: DeviceServiceState): Promise<void>;
  read(): Promise<DeviceServiceState | null>;
}

export function createDeviceServiceStateStore(stateFile: string): DeviceServiceStateStore {
  return {
    async write(state) {
      const parent = dirname(stateFile);
      await ensurePrivateDeviceServiceDirectory(parent);
      const temporaryFile = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
      const handle = await open(temporaryFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporaryFile, stateFile);
        await chmod(stateFile, 0o600);
      } catch (error) {
        await rm(temporaryFile, { force: true });
        throw error;
      }
    },
    async read() {
      try {
        return JSON.parse(await readFile(stateFile, 'utf8')) as DeviceServiceState;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) return null;
        throw error;
      }
    },
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
