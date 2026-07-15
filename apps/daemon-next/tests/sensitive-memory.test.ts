import { describe, expect, test } from 'vitest';

import { containsSensitiveMemoryText } from '../src/memory/sensitive-memory';

describe('automatic local Memory sensitive boundary', () => {
  test.each([
    'tool --token secret-value',
    'tool --password hunter2',
    'https://user:password@example.com/repo.git',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-value',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA12345678901234567890123456789012',
    '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz1234567890',
    '//registry.example.com/:_password=c2VjcmV0LXZhbHVl',
    'authToken: super-secret-value',
    '_clientSecret super-secret-value',
    'npm_abcdefghijklmnopqrstuvwxyz1234567890',
    'NPM_TOKEN super-secret-value',
    'AWS_SECRET_ACCESS_KEY super-secret-value',
  ])('拒绝自动持久化 %s', (value) => {
    expect(containsSensitiveMemoryText(value)).toBe(true);
  });

  test('普通已脱敏命令可进入确定性学习', () => {
    expect(containsSensitiveMemoryText('npm test -- --runInBand')).toBe(false);
    expect(containsSensitiveMemoryText('tool --token [redacted]')).toBe(true);
  });
});
