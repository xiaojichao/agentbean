import { describe, expect, test } from 'vitest';

import {
  EMPTY_PROJECTION_DRAFT_FORM,
  PROJECTION_KIND_LABELS,
  draftFormFromProjection,
  normalizeTagInput,
  projectionStatusLabel,
  validateProjectionDraftForm,
} from '../lib/agent-memory-projection-form';

describe('agent-memory-projection-form (issue #718 web)', () => {
  test('EMPTY_PROJECTION_DRAFT_FORM 默认 fact/空内容', () => {
    expect(EMPTY_PROJECTION_DRAFT_FORM.kind).toBe('fact');
    expect(EMPTY_PROJECTION_DRAFT_FORM.content).toBe('');
    expect(EMPTY_PROJECTION_DRAFT_FORM.tags).toEqual([]);
  });

  test('PROJECTION_KIND_LABELS 覆盖 4 类', () => {
    expect(PROJECTION_KIND_LABELS.fact).toBe('事实');
    expect(PROJECTION_KIND_LABELS.decision).toBe('决策');
    expect(PROJECTION_KIND_LABELS.rule).toBe('规则');
    expect(PROJECTION_KIND_LABELS.preference).toBe('偏好');
  });

  test('draftFormFromProjection(null) → 空表单', () => {
    expect(draftFormFromProjection(null)).toEqual(EMPTY_PROJECTION_DRAFT_FORM);
  });

  test('draftFormFromProjection 从 active 投影导出初值（含 tags 副本，不共享引用）', () => {
    const form = draftFormFromProjection({
      kind: 'preference', content: ' prefers concise replies', summary: 's',
      tags: ['code-review', 'style'], validUntil: 1000,
    });
    expect(form.kind).toBe('preference');
    expect(form.content).toBe(' prefers concise replies');
    expect(form.summary).toBe('s');
    expect(form.tags).toEqual(['code-review', 'style']);
    expect(form.tags).not.toBe(['code-review', 'style']); // 新数组
    expect(form.validUntil).toBe(1000);
  });

  test('draftFormFromProjection 缺省 summary/tags 回落空', () => {
    const form = draftFormFromProjection({
      kind: 'fact', content: 'c', validUntil: null,
    });
    expect(form.summary).toBe('');
    expect(form.tags).toEqual([]);
  });

  test('validateProjectionDraftForm 空 content 返回错误', () => {
    expect(validateProjectionDraftForm({ ...EMPTY_PROJECTION_DRAFT_FORM })).toBe('投影内容不能为空');
    expect(validateProjectionDraftForm({ ...EMPTY_PROJECTION_DRAFT_FORM, content: '   ' })).toBe('投影内容不能为空');
  });

  test('validateProjectionDraftForm 非空 content 通过', () => {
    expect(validateProjectionDraftForm({ ...EMPTY_PROJECTION_DRAFT_FORM, content: '有效内容' })).toBeNull();
  });

  test('projectionStatusLabel 各状态', () => {
    expect(projectionStatusLabel('draft')).toBe('草稿');
    expect(projectionStatusLabel('active')).toBe('生效中');
    expect(projectionStatusLabel('superseded')).toBe('已取代');
    expect(projectionStatusLabel('expired')).toBe('已过期');
    expect(projectionStatusLabel('withdrawn')).toBe('已撤回');
    expect(projectionStatusLabel('unknown')).toBe('unknown');
  });

  test('normalizeTagInput lowercase + trim', () => {
    expect(normalizeTagInput('  Code-Review ')).toBe('code-review');
    expect(normalizeTagInput('LINT')).toBe('lint');
  });
});
