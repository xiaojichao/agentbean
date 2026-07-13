import { describe, expect, test } from 'vitest';
import { collectSystemInfo, readDaemonVersion, readPiManagementRuntimeVersion } from '../src/system-info';

describe('system-info', () => {
  test('collectSystemInfo returns os-derived fields with expected shapes', () => {
    const info = collectSystemInfo();
    expect(typeof info.hostname).toBe('string');
    expect(typeof info.platform).toBe('string');
    expect(typeof info.arch).toBe('string');
    expect(typeof info.osVersion).toBe('string');
    expect(typeof info.cpuModel).toBe('string');
    expect(typeof info.cpuCores).toBe('number');
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(typeof info.totalMemoryGB).toBe('number');
    expect(info.totalMemoryGB).toBeGreaterThan(0);
    expect(typeof info.freeMemoryGB).toBe('number');
    expect(info.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test('readDaemonVersion returns the package version', () => {
    const version = readDaemonVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('readDaemonVersion falls back to the built output package root', () => {
    const requested: string[] = [];
    const version = readDaemonVersion((id) => {
      requested.push(id);
      if (id === '../package.json') {
        throw new Error('package not copied next to built source');
      }
      return { version: '9.8.7' };
    });

    expect(version).toBe('9.8.7');
    expect(requested).toEqual(['../package.json', '../../../../package.json']);
  });

  test('readPiManagementRuntimeVersion reads only the daemon exact dependency', () => {
    expect(readPiManagementRuntimeVersion(() => ({
      dependencies: { '@agentbean/pi-management-runtime': '0.1.0' },
    }))).toBe('0.1.0');
    expect(readPiManagementRuntimeVersion(() => ({
      dependencies: { '@agentbean/pi-management-runtime': '^0.1.0' },
    }))).toBe('unknown');
  });
});
