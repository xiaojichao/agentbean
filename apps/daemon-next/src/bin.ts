#!/usr/bin/env node

import { runDaemonNextCli } from './cli.js';
import { runDeviceCli } from './device-cli.js';
import { runDeviceService } from './device-service-runtime.js';

const argv = process.argv.slice(2);
const command = argv[0];
const execution = command === 'device'
  ? runDeviceCli(argv.slice(1)).then((code) => { process.exitCode = code; })
  : command === 'service' && argv[1] === 'run' && argv.length === 2
    ? runDeviceService()
    : runDaemonNextCli();

execution.catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
