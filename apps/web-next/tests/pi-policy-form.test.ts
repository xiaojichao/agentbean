import { describe, expect, test } from 'vitest';

import { DEFAULT_PI_POLICY_STATE, piPolicyStateFromResult } from '../lib/pi-policy-form';

describe('pi-policy-form', () => {
  test('default state has auto-coordination enabled (AC#2)', () => {
    expect(DEFAULT_PI_POLICY_STATE.autoCoordinationEnabled).toBe(true);
  });

  test('derives enabled from a successful result', () => {
    expect(piPolicyStateFromResult({ ok: true, autoCoordinationEnabled: false }).autoCoordinationEnabled).toBe(false);
    expect(piPolicyStateFromResult({ ok: true, autoCoordinationEnabled: true }).autoCoordinationEnabled).toBe(true);
  });

  test('falls back to default-on when the result is missing the field', () => {
    expect(piPolicyStateFromResult({ ok: true }).autoCoordinationEnabled).toBe(true);
  });

  test('falls back to default-on when the read failed', () => {
    expect(piPolicyStateFromResult({ ok: false }).autoCoordinationEnabled).toBe(true);
  });
});
