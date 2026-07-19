import { join } from 'node:path';
import { agentBeanHome } from './profile-paths.js';

export interface DeviceServicePaths {
  readonly root: string;
  readonly controlSocket: string;
  readonly stateFile: string;
  readonly lockDirectory: string;
  readonly runtimeOwnerFile: string;
  readonly migrationJournalFile: string;
  readonly migrationLockDirectory: string;
  readonly legacyRuntimeDirectory: string;
  readonly payloadDirectory: string;
  readonly payloadFile: string;
  readonly logDirectory: string;
  readonly logFile: string;
}

export function deviceServicePaths(baseDir?: string): DeviceServicePaths {
  const root = join(agentBeanHome(baseDir), 'service');
  const logDirectory = join(root, 'logs');
  const payloadDirectory = join(root, 'payload');
  return {
    root,
    controlSocket: join(root, 'control.sock'),
    stateFile: join(root, 'state.json'),
    lockDirectory: join(root, 'service.lock'),
    runtimeOwnerFile: join(root, 'runtime-owner.json'),
    migrationJournalFile: join(root, 'migration.json'),
    migrationLockDirectory: join(root, 'migration.lock'),
    legacyRuntimeDirectory: join(root, 'legacy-runtimes'),
    payloadDirectory,
    payloadFile: join(payloadDirectory, 'agentbean-service.mjs'),
    logDirectory,
    logFile: join(logDirectory, 'device-service.log'),
  };
}
