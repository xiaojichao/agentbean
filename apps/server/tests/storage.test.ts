import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { StorageManager } from '../src/storage.js';

const TEST_DIR = './data/test-storage';

describe('StorageManager', () => {
  beforeEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });

  it('creates a storage space with db and artifacts dir', () => {
    const sm = new StorageManager(TEST_DIR);
    const space = sm.createSpace('net-001');
    expect(existsSync(space.dbPath)).toBe(true);
    expect(existsSync(space.artifactDir)).toBe(true);
    expect(space.db).toBeDefined();
  });

  it('returns cached space on second get', () => {
    const sm = new StorageManager(TEST_DIR);
    const s1 = sm.createSpace('net-001');
    const s2 = sm.getSpace('net-001');
    expect(s1.db).toBe(s2.db);
  });

  it('initializes network-local schema on create', () => {
    const sm = new StorageManager(TEST_DIR);
    sm.createSpace('net-001');
    const db = sm.getSpace('net-001').db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain('channels');
    expect(names).toContain('messages');
    expect(names).toContain('artifacts');
  });
});
