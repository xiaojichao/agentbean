import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('my-secret');
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('my-secret');
    await expect(verifyPassword('my-secret', hash)).resolves.toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('my-secret');
    await expect(verifyPassword('wrong', hash)).resolves.toBe(false);
  });

  it('produces different hashes for same password', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});
