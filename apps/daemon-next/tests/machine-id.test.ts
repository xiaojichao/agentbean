import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateMachineId } from '../src/machine-id';
import { machineIdFile } from '../src/profile-paths';

function tmpBase(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'machine-id-')));
}

describe('machine-id', () => {
  it('generates and persists a stable machine id', () => {
    const baseDir = tmpBase();
    const first = loadOrCreateMachineId({ baseDir, generate: () => 'machine-1' });
    const second = loadOrCreateMachineId({ baseDir, generate: () => 'machine-2' });

    expect(first).toBe('machine-1');
    expect(second).toBe('machine-1');
  });

  it('writes the machine id with restrictive permissions', () => {
    const baseDir = tmpBase();
    loadOrCreateMachineId({ baseDir, generate: () => 'machine-secure' });

    expect(statSync(machineIdFile(baseDir)).mode & 0o777).toBe(0o600);
  });
});
