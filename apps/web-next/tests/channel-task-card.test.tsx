// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { ChannelTaskCard } from '../components/ChannelTaskCard';

afterEach(cleanup);

const baseEntry: ChannelTaskWorkspaceEntryV1 = {
  schemaVersion: 1,
  task: {
    id: 'task-1', teamId: 'team-1', title: '整理交付文档', description: '输出最终说明',
    status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-legacy', channelId: 'channel-1',
    tags: ['文档'], sortOrder: 1, createdAt: 1, updatedAt: 2,
  },
  governance: {
    mode: 'managed', sources: ['task_coordination'], nodeKind: 'root',
    allowDirectStatusMutation: false, allowDirectAssigneeMutation: false, allowDirectDelete: false,
  },
  responsibilityFocus: {
    kind: 'execution_active', agentId: 'agent-1', agentName: 'Agent A',
    claimLeaseId: 'claim-1', detail: 'Agent「Agent A」正在执行',
  },
  delivery: {
    packageCount: 1, pendingDeliveryCount: 1, focusPackageId: 'package-1',
    focusMemberCount: 2, focusReviewState: 'changes_requested',
  },
  review: { reviewerIds: ['reviewer-1'] },
};

function renderCard(entry: ChannelTaskWorkspaceEntryV1) {
  const callbacks = {
    onDelete: vi.fn(), onMove: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onOpenDetail: vi.fn(),
  };
  render(
    <ChannelTaskCard
      entry={entry}
      creatorName="小王"
      assigneeName="旧负责人"
      reviewerLabel="审核员"
      {...callbacks}
    />,
  );
  return callbacks;
}

describe('ChannelTaskCard', () => {
  test('受管任务显示 Server 责任/交付/审核投影并关闭自由 mutation 入口', () => {
    const callbacks = renderCard(baseEntry);
    const card = document.querySelector('[data-smoke="channel-task-card"]')!;
    expect(card.getAttribute('data-governance')).toBe('managed');
    expect(card.getAttribute('draggable')).toBe('false');
    expect(document.querySelector('[data-smoke="task-card-focus"]')?.textContent).toContain('Agent A');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('要求修改');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('1 批处理中');
    expect(document.querySelector('[data-smoke="task-card-reviewer"]')?.textContent).toContain('审核员');
    expect(document.querySelector('select')).toBeNull();
    expect(document.querySelector('button[title="删除任务"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-smoke="task-card-open-detail"]')!);
    expect(callbacks.onOpenDetail).toHaveBeenCalledOnce();
  });

  test('普通任务保留状态迁移与删除入口', () => {
    const plainEntry: ChannelTaskWorkspaceEntryV1 = {
      ...baseEntry,
      governance: {
        mode: 'plain', sources: [], allowDirectStatusMutation: true,
        allowDirectAssigneeMutation: true, allowDirectDelete: true,
      },
      responsibilityFocus: { kind: 'none', detail: '尚无协调事实' },
      delivery: { packageCount: 0, pendingDeliveryCount: 0 },
      review: { reviewerIds: [] },
    };
    const callbacks = renderCard(plainEntry);
    const select = document.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'done' } });
    expect(callbacks.onMove).toHaveBeenCalledWith('done');
    fireEvent.click(document.querySelector('button[title="删除任务"]')!);
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
  });
});
