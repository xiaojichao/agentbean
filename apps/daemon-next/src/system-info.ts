import { hostname, platform, arch, release, version, cpus, totalmem, freemem } from 'node:os';
import { createRequire } from 'node:module';
import type { DeviceSystemInfoDto } from '../../../packages/contracts/src/index.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function collectSystemInfo(): DeviceSystemInfoDto {
  const cpuList = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    release: release(),
    osVersion: version(),
    cpuModel: cpuList[0]?.model,
    cpuCores: cpuList.length,
    totalMemoryGB: round2(totalmem() / 1024 ** 3),
    freeMemoryGB: round2(freemem() / 1024 ** 3),
    nodeVersion: process.version,
  };
}

export function readDaemonVersion(): string {
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere('../package.json') as { version?: string };
  return pkg.version ?? 'unknown';
}
