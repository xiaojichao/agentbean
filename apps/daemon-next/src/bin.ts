#!/usr/bin/env node

import { runDaemonNextCli } from './cli.js';
import { runDeviceCli } from './device-cli.js';
import { runUpdateCli } from './update-cli.js';
import { assertDeviceRuntimeOwner } from './device-runtime-owner.js';
import { registerLegacyRuntime } from './legacy-runtime-registration.js';
import { acquireDeviceServiceLock, DeviceServiceAlreadyRunningError } from './device-service-lock.js';
import { deviceServicePaths } from './device-service-paths.js';

const argv = process.argv.slice(2);
const command = argv[0];
const execution = command === 'device'
  ? runDeviceCli(argv.slice(1)).then((code) => { process.exitCode = code; })
  : command === 'update'
    ? runUpdateCli(argv.slice(1)).then((code) => { process.exitCode = code; })
  : command === 'service' && argv[1] === 'run' && argv.length === 2
    ? runDeviceCli(['run']).then((code) => { process.exitCode = code; })
    : runLegacyDaemonEntry();

execution.catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function runLegacyDaemonEntry(): Promise<void> {
  let transitionLock;
  try {
    transitionLock = await acquireDeviceServiceLock(deviceServicePaths().migrationLockDirectory);
  } catch (error) {
    if (error instanceof DeviceServiceAlreadyRunningError) throw new Error('DEVICE_SERVICE_MIGRATION_IN_PROGRESS');
    throw error;
  }
  let registration;
  try {
    await assertDeviceRuntimeOwner('legacy-daemon');
    registration = await registerLegacyRuntime();
    await assertDeviceRuntimeOwner('legacy-daemon');
  } catch (error) {
    await registration?.release();
    throw error;
  } finally {
    await transitionLock.release();
  }
  try {
    await runDaemonNextCli();
  } finally {
    await registration.release();
  }
}
