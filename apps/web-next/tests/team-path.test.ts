import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readStoredTeamPath, writeStoredTeamPath, type StorageLike } from '../lib/team-path';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('Team path storage and route tree', () => {
  test('ignores removed legacy storage keys', () => {
    const legacyKey = ['agentbean', ['network', 'Path'].join('')].join('.');
    const storage = new MemoryStorage({ [legacyKey]: 'stale-team' });

    expect(readStoredTeamPath(storage)).toBeNull();
    expect(storage.getItem('agentbean.teamPath')).toBeNull();
  });

  test('writes only the Team path key', () => {
    const storage = new MemoryStorage();

    writeStoredTeamPath(storage, 'team-two');

    expect(storage.getItem('agentbean.teamPath')).toBe('team-two');
  });

  test('uses only Team route segments', () => {
    const appDir = join(process.cwd(), 'app');
    const oldSegment = `[${['network', 'Path'].join('')}]`;
    const oldPage = ['net', 'works'].join('');

    expect(existsSync(join(appDir, '[teamPath]'))).toBe(true);
    expect(existsSync(join(appDir, '[teamPath]', 'teams', 'page.tsx'))).toBe(true);
    expect(existsSync(join(appDir, oldSegment))).toBe(false);
    expect(existsSync(join(appDir, '[teamPath]', oldPage))).toBe(false);
  });

  test('does not retain removed Team page aliases', async () => {
    const nextConfig = (await import('../next.config.mjs')).default;
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const removedSource = `/:teamPath/${['net', 'works'].join('')}`;

    expect(redirects).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: removedSource })]),
    );
  });
});
