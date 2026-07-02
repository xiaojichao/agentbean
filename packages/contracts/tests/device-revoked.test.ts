// packages/contracts/tests/device-revoked.test.ts
import { describe, test, expect } from 'vitest';
import { ERROR_CODES } from '../src/common';

describe('DEVICE_REVOKED error code', () => {
  test('is registered in ERROR_CODES', () => {
    expect(ERROR_CODES).toContain('DEVICE_REVOKED');
  });
});
