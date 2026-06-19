import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonScanSnapshot } from '../src/index';
import { loadScanCache, saveScanCache } from '../src/scan-cache';

const baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'scan-cache-')));

describe('scan-cache', () => {
  it('returns null when cache file does not exist', () => {
    expect(loadScanCache('nope', baseDir)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const dir = join(baseDir, 'corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scanned-agents.json'), '{ not json');
    expect(loadScanCache('corrupt', baseDir)).toBeNull();
  });

  it('round-trips a snapshot through save then load', () => {
    const snap: DaemonScanSnapshot = {
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', command: '/usr/bin/codex' }],
      agents: [],
    };
    saveScanCache(snap, 'roundtrip', baseDir);
    const loaded = loadScanCache('roundtrip', baseDir);
    expect(loaded).toEqual(snap);
  });

  it('isolates caches per profileId', () => {
    const a: DaemonScanSnapshot = { runtimes: [{ adapterKind: 'codex', name: 'A', command: '/a' }], agents: [] };
    const b: DaemonScanSnapshot = { runtimes: [{ adapterKind: 'gemini', name: 'B', command: '/b' }], agents: [] };
    saveScanCache(a, 'prof-a', baseDir);
    saveScanCache(b, 'prof-b', baseDir);
    expect(loadScanCache('prof-a', baseDir)?.runtimes[0].name).toBe('A');
    expect(loadScanCache('prof-b', baseDir)?.runtimes[0].name).toBe('B');
  });
});
