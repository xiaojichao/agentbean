// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChannelProjectOverviewDto, ChannelTaskWorkspaceV1 } from '@agentbean/contracts';

import { ChannelProjectProgress } from '../components/ChannelProjectProgress';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

describe('频道项目推进工作区', () => {
  test('阶段卡片展示 Server 阶段、责任、交付与审核事实并保持选中态', () => {
    const onOpenStage = vi.fn();
    render(
      <ChannelProjectProgress
        overview={overview()}
        workspace={workspace()}
        participants={participants}
        currentUserId="reviewer-1"
        selectedStageId="stage-1"
        state="ready"
        archived={false}
        onOpenStage={onOpenStage}
        onOpenSettings={vi.fn()}
      />,
    );

    const card = screen.getByRole('button', { name: /打开阶段 发布准备/ });
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(card.textContent).toContain('形成可验收的发布方案');
    expect(card.textContent).toContain('任务状态：进行中');
    expect(card.textContent).toContain('Agent「执行 Agent」正在执行');
    expect(card.textContent).toContain('无前置阶段');
    expect(card.textContent).toContain('交付包 2 个');
    expect(card.textContent).toContain('最终版 1/2');
    expect(card.textContent).toContain('实际审核人：审核人');
    fireEvent.click(card);
    expect(onOpenStage).toHaveBeenCalledWith('stage-1', 'task-1');
  });

  test('支持创建者、责任焦点、建议/实际审核人与待我审核筛选', () => {
    render(
      <ChannelProjectProgress
        overview={overview()}
        workspace={workspace({ includeSecond: true })}
        participants={participants}
        currentUserId="reviewer-1"
        state="ready"
        archived={false}
        onOpenStage={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('项目任务创建者'), { target: { value: 'creator-2' } });
    expect(screen.queryByRole('button', { name: /打开阶段 发布准备/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('项目任务创建者'), { target: { value: 'all' } });

    fireEvent.change(screen.getByLabelText('项目任务责任焦点'), { target: { value: 'agent-1' } });
    expect(screen.getByRole('button', { name: /打开阶段 发布准备/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'actual:reviewer-1' } });
    expect(screen.getByRole('button', { name: /打开阶段 发布准备/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'pending-me' } });
    expect(screen.getByText('当前筛选下没有项目任务')).toBeTruthy();
  });

  test('待我审核依据当前焦点交付，不受历史审核干扰且不包含尚无交付的任务', () => {
    const current = workspace({ includeSecond: true });
    const historicalReviewWithPendingDelivery = {
      ...current.entries[0]!,
      delivery: { ...current.entries[0]!.delivery, focusReviewState: 'pending' as const },
    };
    render(
      <ChannelProjectProgress
        overview={overview()}
        workspace={{ ...current, entries: [historicalReviewWithPendingDelivery, current.entries[1]!] }}
        participants={participants}
        currentUserId="reviewer-1"
        state="ready"
        archived={false}
        onOpenStage={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'pending-me' } });
    expect(screen.getByRole('button', { name: /打开阶段 发布准备/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /打开受管任务/ })).toBeNull();
  });

  test('准确区分 loading、not_ready、无权限和错误', () => {
    const props = {
      overview: null,
      workspace: null,
      participants,
      currentUserId: 'reviewer-1',
      archived: false,
      onOpenStage: vi.fn(),
      onOpenSettings: vi.fn(),
    } as const;
    const { rerender } = render(<ChannelProjectProgress {...props} state="loading" />);
    expect(screen.getByText('正在加载项目推进事实…')).toBeTruthy();

    rerender(<ChannelProjectProgress {...props} state="not_ready" />);
    expect(screen.getByText('项目推进事实尚未就绪')).toBeTruthy();

    rerender(<ChannelProjectProgress {...props} state="no_permission" />);
    expect(screen.getByText('你没有查看该频道项目事实的权限')).toBeTruthy();

    rerender(<ChannelProjectProgress {...props} state="error" errorMessage="读取失败" />);
    expect(screen.getByText('读取失败')).toBeTruthy();

  });

  test('无项目事实时用已有普通任务数量引导显式配置首个阶段', () => {
    const onOpenSettings = vi.fn();
    render(
      <ChannelProjectProgress
        overview={null}
        workspace={plainWorkspace()}
        participants={participants}
        currentUserId="reviewer-1"
        state="ready"
        archived={false}
        onOpenStage={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByText('把频道工作组织成阶段推进')).toBeTruthy();
    expect(screen.getByText(/已有 2 个普通任务/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '配置首个项目阶段' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  test('归档频道只提供查看设置入口，不暴露运行态写操作', () => {
    render(
      <ChannelProjectProgress
        overview={{ ...overview(), archived: true }}
        workspace={workspace()}
        participants={participants}
        state="ready"
        archived
        onOpenStage={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看项目设置' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '项目设置 / 阶段配置' })).toBeNull();
  });

  test('#1179 默认推进面不展示创建阶段、依赖边或底层引用 ID 表单', () => {
    render(
      <ChannelProjectProgress
        overview={overview()}
        workspace={workspace()}
        participants={participants}
        state="ready"
        archived={false}
        onOpenStage={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.queryByText('创建首个项目阶段')).toBeNull();
    expect(screen.queryByText('添加阶段')).toBeNull();
    expect(screen.queryByText('阶段依赖')).toBeNull();
    expect(screen.queryByLabelText('前置阶段')).toBeNull();
    expect(screen.queryByLabelText('产物集合 ID')).toBeNull();
    expect(screen.queryByLabelText('必需输入来源 ID')).toBeNull();
    expect(screen.getByRole('button', { name: '项目设置 / 阶段配置' })).toBeTruthy();
  });
});

const participants = [
  { id: 'creator-1', name: '创建者', kind: 'human' as const },
  { id: 'creator-2', name: '另一创建者', kind: 'human' as const },
  { id: 'reviewer-1', name: '审核人', kind: 'human' as const },
  { id: 'agent-1', name: '执行 Agent', kind: 'agent' as const },
];

function overview(): ChannelProjectOverviewDto {
  const task = taskDto('task-1', 'creator-1');
  return {
    archived: false,
    profile: {
      id: 'profile-1', teamId: 'team-1', channelId: 'channel-1', projectLeadId: 'creator-1',
      defaultReviewerIds: ['reviewer-1'], revision: 1, createdBy: 'creator-1', createdAt: 1, updatedAt: 2,
    },
    stages: [{
      id: 'stage-1', teamId: 'team-1', channelId: 'channel-1', name: '发布准备',
      goal: '形成可验收的发布方案', ownerId: 'creator-1', reviewerIds: ['reviewer-1'],
      acceptanceCriteria: ['发布方案完整'], task, taskRevision: 2, aggregateStatus: 'active',
      blockingReasons: [], upstreamStageIds: [], dependenciesSatisfied: true,
      missingRequiredInputs: [], executionAllowed: true,
      advance: {
        kind: 'waiting', automatic: false, stableInputs: [], candidateAgentIds: [],
        taskRevision: 2, stageTaskRevision: 2,
      },
      createdAt: 1, updatedAt: 2,
    }],
    edges: [],
  };
}

function workspace(options: { includeSecond?: boolean } = {}): ChannelTaskWorkspaceV1 {
  const stage = overview().stages[0];
  const entries: ChannelTaskWorkspaceV1['entries'][number][] = [{
    schemaVersion: 1,
    task: stage.task,
    governance: {
      mode: 'managed', sources: ['project_stage'], allowDirectStatusMutation: false,
      allowDirectAssigneeMutation: false, allowDirectDelete: false,
    },
    stage,
    responsibilityFocus: {
      kind: 'execution_active', agentId: 'agent-1', agentName: '执行 Agent', detail: 'Agent「执行 Agent」正在执行',
    },
    delivery: {
      packageCount: 2,
      pendingDeliveryCount: 0,
      requiredForFinalCount: 2,
      finalizedCount: 1,
      focusReviewState: 'approved',
    },
    review: {
      reviewerIds: ['reviewer-1'],
      latest: {
        reviewId: 'review-1', reviewedBy: 'reviewer-1', decision: 'approved', comment: '通过', createdAt: 2,
      },
    },
  }];
  if (options.includeSecond) {
    entries.push({
      ...entries[0],
      task: taskDto('managed-2', 'creator-2'),
      stage: undefined,
      responsibilityFocus: { kind: 'none', detail: '尚未产生责任' },
      delivery: { packageCount: 0, pendingDeliveryCount: 0, requiredForFinalCount: 0, finalizedCount: 0 },
      review: { reviewerIds: ['reviewer-1'] },
    });
  }
  return {
    schemaVersion: 1, channelId: 'channel-1', entries, asOf: 2,
    audienceScope: 'team-1:channel-1:reviewer-1', consistencyToken: { schemaVersion: 1, entries: [] },
  };
}

function plainWorkspace(): ChannelTaskWorkspaceV1 {
  return {
    schemaVersion: 1,
    channelId: 'channel-1',
    entries: ['plain-1', 'plain-2'].map((id) => ({
      schemaVersion: 1,
      task: taskDto(id, 'creator-1'),
      governance: {
        mode: 'plain' as const,
        sources: [],
        allowDirectStatusMutation: true,
        allowDirectAssigneeMutation: true,
        allowDirectDelete: true,
      },
      responsibilityFocus: { kind: 'none' as const, detail: '尚无协调事实' },
      delivery: { packageCount: 0, pendingDeliveryCount: 0, requiredForFinalCount: 0, finalizedCount: 0 },
      review: { reviewerIds: [] },
    })),
  };
}

function taskDto(id: string, creatorId: string): ChannelTaskWorkspaceV1['entries'][number]['task'] {
  return {
    id, teamId: 'team-1', channelId: 'channel-1', title: id === 'task-1' ? '完成发布方案' : '未绑定阶段的受管任务',
    status: 'in_progress', creatorId, tags: [], sortOrder: 1, createdAt: 1, updatedAt: 2,
  };
}
