import { describe, expect, test } from 'vitest';

import {
  EMPTY_DRAFT_FORM,
  draftFormFromProjection,
  updateRow,
  validateDraftForm,
} from '../lib/agent-exposure-form';

describe('agent-exposure-form', () => {
  test('空投影导出空表单', () => {
    expect(draftFormFromProjection(null)).toEqual(EMPTY_DRAFT_FORM);
  });

  test('从 active 投影导出表单初值（含 available 状态）', () => {
    const form = draftFormFromProjection({
      capabilities: [{ name: 'code-review', description: '审查' }],
      skills: [{ name: 'typescript', description: 'TS' }],
      availability: { status: 'unavailable' },
      validUntil: 1000,
    });
    expect(form.capabilities).toEqual([{ name: 'code-review', description: '审查' }]);
    expect(form.available).toBe(false);
    expect(form.validUntil).toBe(1000);
  });

  test('validateDraftForm：无 capability 报错', () => {
    expect(validateDraftForm(EMPTY_DRAFT_FORM)).toBe('至少需要 1 个 Capability');
  });

  test('validateDraftForm：capability 名重复（大小写不敏感）报错', () => {
    expect(
      validateDraftForm({
        ...EMPTY_DRAFT_FORM,
        capabilities: [{ name: 'code-review', description: 'a' }, { name: 'Code-Review', description: 'b' }],
      }),
    ).toBe('Capability 名称不能重复');
  });

  test('validateDraftForm：合法表单返回 null', () => {
    expect(
      validateDraftForm({
        ...EMPTY_DRAFT_FORM,
        capabilities: [{ name: 'code-review', description: '审查' }],
        skills: [{ name: 'typescript', description: 'TS' }],
      }),
    ).toBeNull();
  });

  test('updateRow 不可变更新指定行', () => {
    const rows = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }];
    expect(updateRow(rows, 1, { description: 'z' })).toEqual([
      { name: 'a', description: 'x' },
      { name: 'b', description: 'z' },
    ]);
  });
});
