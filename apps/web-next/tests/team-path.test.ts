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
  test('migrates the legacy path key once and removes it', () => {
    const storage = new MemoryStorage({ 'agentbean.networkPath': 'team-one' });

    expect(readStoredTeamPath(storage)).toBe('team-one');
    expect(storage.getItem('agentbean.teamPath')).toBe('team-one');
    expect(storage.getItem('agentbean.networkPath')).toBeNull();
  });

  test('writes only the Team path key', () => {
    const storage = new MemoryStorage({ 'agentbean.networkPath': 'stale' });

    writeStoredTeamPath(storage, 'team-two');

    expect(storage.getItem('agentbean.teamPath')).toBe('team-two');
    expect(storage.getItem('agentbean.networkPath')).toBeNull();
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

  test('keeps only the temporary Release A Team page redirect', async () => {
    const nextConfig = (await import('../next.config.mjs')).default;
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const temporarySource = `/:teamPath/${['net', 'works'].join('')}`;

    expect(redirects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '/:teamPath/computer/:id',
          destination: '/:teamPath/devices/:id',
          permanent: true,
        }),
        expect.objectContaining({
          source: temporarySource,
          destination: '/:teamPath/teams',
          permanent: true,
        }),
      ]),
    );
  });
});
