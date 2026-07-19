import { join } from 'node:path';
import { agentBeanHome } from './profile-paths.js';

export interface DeviceServicePaths {
  readonly root: string;
  readonly controlSocket: string;
  readonly stateFile: string;
  readonly lockDirectory: string;
  readonly runtimeOwnerFile: string;
  readonly logDirectory: string;
  readonly logFile: string;
}

export function deviceServicePaths(baseDir?: string): DeviceServicePaths {
  const root = join(agentBeanHome(baseDir), 'service');
  const logDirectory = join(root, 'logs');
  return {
    root,
    controlSocket: join(root, 'control.sock'),
    stateFile: join(root, 'state.json'),
    lockDirectory: join(root, 'service.lock'),
    runtimeOwnerFile: join(root, 'runtime-owner.json'),
    logDirectory,
    logFile: join(logDirectory, 'device-service.log'),
  };
}
