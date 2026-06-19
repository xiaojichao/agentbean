import { hostname, platform, arch, release, version, cpus, totalmem, freemem } from 'node:os';
import { createRequire } from 'node:module';
import type { DeviceSystemInfoDto } from '../../../packages/contracts/src/index.js';

type PackageRequire = (id: string) => unknown;

const DAEMON_PACKAGE_JSON_CANDIDATES = [
  '../package.json',
  '../../../../package.json',
] as const;

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

export function readDaemonVersion(requireFromHere: PackageRequire = createRequire(import.meta.url)): string {
  for (const candidate of DAEMON_PACKAGE_JSON_CANDIDATES) {
    try {
      const pkg = requireFromHere(candidate) as { version?: string };
      if (pkg.version) {
        return pkg.version;
      }
    } catch {
      // Source and built output sit at different depths; try the next package root candidate.
    }
  }
  return 'unknown';
}
