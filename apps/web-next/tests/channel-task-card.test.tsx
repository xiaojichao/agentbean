// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import {
  ChannelTaskCard,
  channelTaskResponsibilityFocusFilterValue,
} from '../components/ChannelTaskCard';

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
      reviewerLabel={entry.review.latest || entry.review.reviewerIds.length > 0 ? '审核员' : '未绑定'}
      {...callbacks}
    />,
  );
  return callbacks;
}

describe('ChannelTaskCard', () => {
  test('责任焦点筛选只使用 Server 投影，不把普通任务负责人当成责任事实', () => {
    const plainEntry: ChannelTaskWorkspaceEntryV1 = {
      ...baseEntry,
      governance: {
        mode: 'plain', sources: [], allowDirectStatusMutation: true,
        allowDirectAssigneeMutation: true, allowDirectDelete: true,
      },
      responsibilityFocus: { kind: 'none', detail: '尚无协调事实' },
    };

    expect(plainEntry.task.assigneeId).toBe('agent-legacy');
    expect(channelTaskResponsibilityFocusFilterValue(plainEntry)).toBe('unassigned');
    expect(channelTaskResponsibilityFocusFilterValue(baseEntry)).toBe('agent-1');
    expect(channelTaskResponsibilityFocusFilterValue({
      ...baseEntry,
      responsibilityFocus: { kind: 'review_wait', detail: '等待人工审核' },
    })).toBe('review_wait');
  });

  test('受管任务显示 Server 责任/交付/审核投影并关闭自由 mutation 入口', () => {
    const callbacks = renderCard(baseEntry);
    const card = document.querySelector('[data-smoke="channel-task-card"]')!;
    expect(card.getAttribute('data-governance')).toBe('managed');
    expect(card.getAttribute('draggable')).toBe('false');
    expect(document.querySelector('[data-smoke="task-card-focus"]')?.textContent).toContain('Agent A');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('要求修改');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('1 批处理中');
    expect(document.querySelector('[data-smoke="task-card-reviewer"]')?.textContent).toContain('建议审核人：审核员');
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
    expect(document.querySelector('[data-smoke="task-card-governance"]')?.textContent).toContain('普通任务');
    expect(document.querySelector('[data-smoke="task-card-focus"]')?.textContent).toContain('尚无协调事实');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('暂无交付包');
    expect(document.querySelector('[data-smoke="task-card-reviewer"]')?.textContent).toContain('未绑定');
    const select = document.querySelector('select')!;
    fireEvent.change(select, { target: { value: 'done' } });
    expect(callbacks.onMove).toHaveBeenCalledWith('done');
    fireEvent.click(document.querySelector('button[title="删除任务"]')!);
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
  });

  test('普通任务也展示已有的 Server 交付与审核事实，但不升级为受管任务', () => {
    const plainEntry: ChannelTaskWorkspaceEntryV1 = {
      ...baseEntry,
      governance: {
        mode: 'plain', sources: [], allowDirectStatusMutation: true,
        allowDirectAssigneeMutation: true, allowDirectDelete: true,
      },
      responsibilityFocus: { kind: 'none', detail: '尚无协调事实' },
      delivery: {
        packageCount: 2,
        pendingDeliveryCount: 1,
        focusPackageId: 'package-2',
        focusReviewState: 'approved',
      },
      review: {
        reviewerIds: ['reviewer-1'],
        latest: {
          reviewId: 'review-1',
          reviewedBy: 'reviewer-1',
          decision: 'approved',
          comment: '可以继续',
          createdAt: 3,
        },
      },
    };

    renderCard(plainEntry);

    expect(document.querySelector('[data-smoke="task-card-governance"]')?.textContent).toContain('普通任务');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('交付包 2 个');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('已通过');
    expect(document.querySelector('[data-smoke="task-card-delivery"]')?.textContent).toContain('1 批处理中');
    expect(document.querySelector('[data-smoke="task-card-reviewer"]')?.textContent).toContain('实际审核人：审核员');
    expect(document.querySelector('select')).not.toBeNull();
    expect(document.querySelector('button[title="删除任务"]')).not.toBeNull();
  });

  test('阶段不可执行但没有具体原因时不伪造阻塞点数量', () => {
    renderCard({
      ...baseEntry,
      stage: {
        id: 'stage-1', teamId: 'team-1', channelId: 'channel-1', name: '验收', goal: '完成验收',
        ownerId: 'user-1', reviewerIds: [], acceptanceCriteria: [], task: baseEntry.task,
        taskRevision: 1, aggregateStatus: 'blocked', blockingReasons: [], upstreamStageIds: [],
        dependenciesSatisfied: false, missingRequiredInputs: [], executionAllowed: false,
        advance: {
          kind: 'waiting', automatic: false, reason: 'execution_gate_blocked', stableInputs: [],
          candidateAgentIds: [], taskRevision: 1, stageTaskRevision: 1,
        },
        createdAt: 1, updatedAt: 2,
      },
    });

    const blockers = document.querySelector('[data-smoke="task-card-blockers"]')?.textContent;
    expect(blockers).toContain('当前阶段不可执行');
    expect(blockers).not.toContain('1 个执行阻塞点');
  });
});
