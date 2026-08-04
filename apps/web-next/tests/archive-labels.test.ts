/**
 * #1066 AC3/AC6：归档预检清单的文本化（AC13 Web 侧）。
 *
 * 每个 ChannelArchiveWorkKind 都必须有可读文案——归档确认对话框只渲染
 * archivePreflightItemLabel 的输出；未映射的 kind 落入 default 分支显式标注
 * 「未归类工作」，不允许静默消失。同时覆盖 #1066 新增 kinds。
 */
import { describe, expect, test } from 'vitest';
import { archivePreflightItemLabel } from '../lib/archive-labels';
import type { ChannelArchiveWorkKind } from '@agentbean/contracts';

const ALL_KINDS: ChannelArchiveWorkKind[] = [
  'task',
  'invocation',
  'claim',
  'lease',
  'offer',
  'pending_review',
  'pending_review_delivery',
  'pending_delivery',
];

describe('archivePreflightItemLabel (#1066)', () => {
  test('每个 work kind 都有文本标签', () => {
    for (const kind of ALL_KINDS) {
      const label = archivePreflightItemLabel({ kind, id: `id-${kind}`, title: `title-${kind}`, status: 'x' });
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('未归类工作');
    }
  });

  test('task/pending_review 显示标题与状态', () => {
    expect(archivePreflightItemLabel({ kind: 'task', id: 't-1', title: 'deliver docs', status: 'in_progress' }))
      .toContain('deliver docs');
    expect(archivePreflightItemLabel({ kind: 'task', id: 't-1', title: 'deliver docs', status: 'in_progress' }))
      .toContain('in_progress');
    expect(archivePreflightItemLabel({ kind: 'pending_review', id: 't-2', title: 'review me', status: 'in_review' }))
      .toContain('review me');
  });

  test('#1066 新 kinds：待审核交付与交付处理中明示', () => {
    expect(archivePreflightItemLabel({
      kind: 'pending_review_delivery', id: 'pkg-1', title: 'package pkg-1', status: 'pending',
    })).toBe('待审核交付: package pkg-1');
    expect(archivePreflightItemLabel({
      kind: 'pending_delivery', id: 'pub-1', title: 'publish pub-1', status: 'committed',
    })).toBe('交付处理中: publish pub-1');
  });

  test('未映射 kind 显式标注，不静默消失', () => {
    const label = archivePreflightItemLabel({ kind: 'unknown' as ChannelArchiveWorkKind, id: 'u-1' });
    expect(label).toBe('未归类工作: u-1');
  });
});
