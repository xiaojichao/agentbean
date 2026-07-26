// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChannelProjectOverviewDto } from '@agentbean/contracts';

import { ChannelProjectOverview } from '../components/ChannelProjectOverview';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

describe('频道任务页项目总览', () => {
  test('无项目数据且没有可绑定任务时不渲染 Project 容器', () => {
    const { container } = render(
      <ChannelProjectOverview
        overview={null}
        tasks={[]}
        participants={[]}
        currentUserId="user-1"
        onCreate={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
    expect(screen.queryByLabelText('项目总览')).toBeNull();
  });

  test('展示 Stage 责任、绑定 Task、聚合状态、阻塞原因和归档只读状态', () => {
    render(
      <ChannelProjectOverview
        overview={overview()}
        tasks={[{ id: 'task-1', title: '完成发布方案' }]}
        participants={[
          { id: 'owner-1', name: '项目负责人', kind: 'human' },
          { id: 'reviewer-1', name: '审核人', kind: 'human' },
        ]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('项目总览')).toBeTruthy();
    expect(screen.getByText('发布准备')).toBeTruthy();
    expect(screen.getByText('完成发布方案')).toBeTruthy();
    expect(screen.getByText('待开始')).toBeTruthy();
    expect(screen.getByText('绑定任务尚未开始')).toBeTruthy();
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();
    expect(screen.getByText('审核人')).toBeTruthy();
  });

  test('只有显式操作后才展开首个 Stage 配置表单', () => {
    render(
      <ChannelProjectOverview
        overview={null}
        tasks={[{ id: 'task-1', title: '完成发布方案' }]}
        participants={[{ id: 'owner-1', name: '项目负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
      />,
    );
    expect(screen.queryByText('阶段名称')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建首个项目阶段' }));
    expect(screen.getByText('阶段名称')).toBeTruthy();
    expect(screen.getByRole('option', { name: '完成发布方案' })).toBeTruthy();
  });

  test('项目负责人、默认审核者和 Stage 审核者可独立配置且支持多选', async () => {
    const onCreate = vi.fn(async () => null);
    render(
      <ChannelProjectOverview
        overview={null}
        tasks={[{ id: 'task-1', title: '完成发布方案' }]}
        participants={[
          { id: 'owner-1', name: '发起人', kind: 'human' },
          { id: 'lead-1', name: '项目负责人', kind: 'human' },
          { id: 'reviewer-1', name: '审核人甲', kind: 'human' },
          { id: 'reviewer-2', name: '审核人乙', kind: 'human' },
        ]}
        currentUserId="owner-1"
        onCreate={onCreate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '创建首个项目阶段' }));
    fireEvent.change(screen.getByLabelText('阶段名称'), { target: { value: '发布准备' } });
    fireEvent.change(screen.getByLabelText('阶段目标'), { target: { value: '准备可审核发布' } });
    fireEvent.change(screen.getByLabelText('项目负责人'), { target: { value: 'lead-1' } });
    selectMultiple(screen.getByLabelText('默认审核者（可多选）'), ['reviewer-1', 'reviewer-2']);
    selectMultiple(screen.getByLabelText('阶段审核者（可多选）'), ['reviewer-2']);
    fireEvent.change(screen.getByLabelText('验收标准（每行一条）'), {
      target: { value: '发布步骤完整\n回滚方案明确' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建项目阶段' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      projectLeadId: 'lead-1',
      defaultReviewerIds: ['reviewer-1', 'reviewer-2'],
      stage: {
        name: '发布准备',
        goal: '准备可审核发布',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-2'],
        acceptanceCriteria: ['发布步骤完整', '回滚方案明确'],
        taskId: 'task-1',
      },
    }));
  });
});

function selectMultiple(element: HTMLElement, values: string[]): void {
  const select = element as HTMLSelectElement;
  for (const option of select.options) option.selected = values.includes(option.value);
  fireEvent.change(select);
}

function overview(): ChannelProjectOverviewDto {
  return {
    archived: true,
    profile: {
      id: 'profile-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      revision: 1,
      createdBy: 'owner-1',
      createdAt: 1,
      updatedAt: 1,
    },
    stages: [{
      id: 'stage-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      name: '发布准备',
      goal: '形成发布方案',
      ownerId: 'owner-1',
      reviewerIds: ['reviewer-1'],
      acceptanceCriteria: ['发布步骤完整'],
      task: {
        id: 'task-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        title: '完成发布方案',
        status: 'todo',
        creatorId: 'owner-1',
        assigneeId: 'owner-1',
        tags: [],
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      aggregateStatus: 'pending',
      blockingReasons: [{ code: 'task_not_started', taskId: 'task-1' }],
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}
