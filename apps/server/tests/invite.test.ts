import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { initGlobalDb, type GlobalDb } from '../src/db.js';
import { generateInviteCode } from '../src/invite.js';

const TEST_DB = './data/test-invite.db';

describe('invite', () => {
  let db: GlobalDb;

  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    db = initGlobalDb(TEST_DB);
    db.users.create({ id: 'u1', username: 'alice', createdAt: Date.now() });
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
  });

  it('creates and retrieves an invite', () => {
    const invite = db.invites.create({ id: 'inv1', code: 'abc12345', createdBy: 'u1' });
    expect(invite.code).toBe('abc12345');
    const found = db.invites.getByCode('abc12345');
    expect(found).not.toBeNull();
    expect(found!.createdBy).toBe('u1');
  });

  it('marks invite as used', () => {
    db.invites.create({ id: 'inv1', code: 'abc12345', createdBy: 'u1' });
    db.invites.markUsed('abc12345');
    const found = db.invites.getByCode('abc12345');
    expect(found!.usedAt).not.toBeNull();
  });

  it('generates compact invite codes', () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
