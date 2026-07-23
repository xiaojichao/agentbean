import { describe, expect, test } from 'vitest';

import {
  DEFAULT_USER_MEMORY_KIND,
  SYSTEM_USER_KIND_OPTIONS,
  assessUserMemoryContentFit,
  isInactiveForRetrieval,
  systemUserStatusLabel,
  validateDeactivationReason,
  validateSystemUserMemoryForm,
} from '../lib/system-user-memory-form';

describe('system-user-memory-form lib (issue #717)', () => {
  test('exposes exactly four kinds and defaults User Memory to preference (AC#4)', () => {
    expect(SYSTEM_USER_KIND_OPTIONS.map((o) => o.value)).toEqual(['fact', 'decision', 'rule', 'preference']);
    expect(DEFAULT_USER_MEMORY_KIND).toBe('preference');
  });

  test('systemUserStatusLabel distinguishes deactivated vs expired', () => {
    expect(systemUserStatusLabel('active')).toBe('生效中');
    expect(systemUserStatusLabel('superseded')).toBe('已被取代');
    expect(systemUserStatusLabel('expired')).toBe('已过期');
    expect(systemUserStatusLabel('expired', '不再适用')).toBe('已停用');
  });

  test('isInactiveForRetrieval (AC#8)', () => {
    expect(isInactiveForRetrieval('active')).toBe(false);
    expect(isInactiveForRetrieval('expired')).toBe(true);
    expect(isInactiveForRetrieval('superseded')).toBe(true);
  });

  test('validateSystemUserMemoryForm requires content and kind', () => {
    expect(validateSystemUserMemoryForm({ kind: 'preference', content: '' })).toBe('请填写正文');
    expect(validateSystemUserMemoryForm({ kind: 'preference', content: '  ' })).toBe('请填写正文');
    expect(validateSystemUserMemoryForm({ kind: '' as never, content: 'x' })).toBe('请选择类型');
    expect(validateSystemUserMemoryForm({ kind: 'rule', content: '约定' })).toBeNull();
  });

  test('validateDeactivationReason requires a reason (ADR 0046)', () => {
    expect(validateDeactivationReason('')).toBe('请填写变更原因');
    expect(validateDeactivationReason('  ')).toBe('请填写变更原因');
    expect(validateDeactivationReason('不再适用')).toBeNull();
  });

  test('assessUserMemoryContentFit returns guidance hint (AC#4)', () => {
    const assessment = assessUserMemoryContentFit('我喜欢简洁回复');
    expect(assessment.ok).toBe(true);
    expect(assessment.hint).toBeTruthy();
    // 默认实现：无论内容都给引导（不阻塞）。
    expect(assessUserMemoryContentFit('').ok).toBe(true);
  });
});
