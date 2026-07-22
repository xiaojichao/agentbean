import { describe, expect, test } from 'vitest';

import {
  FORMAL_KIND_OPTIONS,
  FORMAL_SCOPE_OPTIONS,
  formalStatusLabel,
  isDeactivated,
  isInactiveForRetrieval,
  validateCorrectionForm,
  validateFormalMemoryForm,
} from '../lib/formal-memory-form';

describe('formal-memory-form lib (issue #716)', () => {
  test('exposes exactly four formal kinds and two scopes (AC#2)', () => {
    expect(FORMAL_KIND_OPTIONS.map((o) => o.value)).toEqual(['fact', 'decision', 'rule', 'preference']);
    expect(FORMAL_SCOPE_OPTIONS.map((o) => o.value)).toEqual(['team', 'channel']);
  });

  test('formalStatusLabel distinguishes deactivated vs expired (AC#3)', () => {
    expect(formalStatusLabel('active')).toBe('生效中');
    expect(formalStatusLabel('candidate')).toBe('待审批');
    expect(formalStatusLabel('superseded')).toBe('已被取代');
    expect(formalStatusLabel('expired')).toBe('已过期');
    expect(formalStatusLabel('expired', '手动停用')).toBe('已停用');
  });

  test('isDeactivated / isInactiveForRetrieval (AC#8)', () => {
    expect(isDeactivated('expired')).toBe(true);
    expect(isDeactivated('active')).toBe(false);
    expect(isInactiveForRetrieval('expired')).toBe(true);
    expect(isInactiveForRetrieval('superseded')).toBe(true);
    expect(isInactiveForRetrieval('deleted')).toBe(true);
    expect(isInactiveForRetrieval('active')).toBe(false);
  });

  test('validateFormalMemoryForm requires content', () => {
    expect(validateFormalMemoryForm({ kind: 'fact', content: '' })).not.toBeNull();
    expect(validateFormalMemoryForm({ kind: 'fact', content: '   ' })).not.toBeNull();
    expect(validateFormalMemoryForm({ kind: 'fact', content: 'x' })).toBeNull();
  });

  test('validateCorrectionForm requires reason and content', () => {
    expect(validateCorrectionForm({ content: 'x', reason: '' })).not.toBeNull();
    expect(validateCorrectionForm({ content: '', reason: 'x' })).not.toBeNull();
    expect(validateCorrectionForm({ content: 'x', reason: 'x' })).toBeNull();
  });
});
