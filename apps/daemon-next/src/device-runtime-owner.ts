import { readFile } from 'node:fs/promises';
import { deviceServicePaths } from './device-service-paths.js';

export type DeviceRuntimeOwner = 'legacy-daemon' | 'device-service';

export async function readDeviceRuntimeOwner(baseDir?: string): Promise<DeviceRuntimeOwner> {
  try {
    const parsed = JSON.parse(await readFile(deviceServicePaths(baseDir).runtimeOwnerFile, 'utf8')) as {
      owner?: unknown;
    };
    if (parsed.owner === 'legacy-daemon' || parsed.owner === 'device-service') return parsed.owner;
    throw new Error('DEVICE_RUNTIME_OWNER_INVALID');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'legacy-daemon';
    throw error;
  }
}

export async function assertDeviceRuntimeOwner(
  expected: DeviceRuntimeOwner,
  baseDir?: string,
): Promise<void> {
  const actual = await readDeviceRuntimeOwner(baseDir);
  if (actual !== expected) {
    throw new Error(expected === 'device-service'
      ? 'SERVICE_MIGRATION_REQUIRED'
      : 'DEVICE_SERVICE_OWNS_RUNTIME');
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
