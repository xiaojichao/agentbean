import { describe, expect, test } from 'vitest';

import { UNKNOWN_PI_POLICY_STATE, piPolicyStateFromResult } from '../lib/pi-policy-form';

describe('pi-policy-form', () => {
  test('keeps the UI state unknown before a trusted server result arrives', () => {
    expect(UNKNOWN_PI_POLICY_STATE.autoCoordinationEnabled).toBeNull();
  });

  test('derives enabled from a successful result', () => {
    expect(piPolicyStateFromResult({ ok: true, autoCoordinationEnabled: false }).autoCoordinationEnabled).toBe(false);
    expect(piPolicyStateFromResult({ ok: true, autoCoordinationEnabled: true }).autoCoordinationEnabled).toBe(true);
  });

  test('keeps the state unknown when the result is missing the field', () => {
    expect(piPolicyStateFromResult({ ok: true }).autoCoordinationEnabled).toBeNull();
  });

  test('keeps the state unknown when the read failed', () => {
    expect(piPolicyStateFromResult({ ok: false }).autoCoordinationEnabled).toBeNull();
  });
});
