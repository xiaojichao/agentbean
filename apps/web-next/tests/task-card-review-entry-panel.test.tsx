// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OutputPackageDto, PackageMemberAvailableActionsDto } from '@agentbean/contracts';

import { TaskCardReviewEntryPanel } from '../components/TaskCardReviewEntryPanel';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  onUpdated: vi.fn(() => () => {}),
  onArtifactsUpdated: vi.fn(() => () => {}),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function memberAction(collectionId: string, versionId: string, reviewState: string): PackageMemberAvailableActionsDto {
  return {
    collectionId,
    versionId,
    reviewState: reviewState as PackageMemberAvailableActionsDto['reviewState'],
    isFinalVersion: false,
    collectionRevision: 3,
    actions: [],
  };
}

function pkgFixture(): OutputPackageDto {
  return {
    schemaVersion: 1,
    packageId: 'pkg-1',
    teamId: 'team-1',
    channelId: 'ch-1',
    revision: 1,
    deliveryId: 'delivery-1',
    publishId: 'publish-1',
    workspaceRevisionId: 'ws-rev-1',
    agentId: 'agent-1',
    taskId: 'task-1',
    taskBinding: 'managed',
    taskAttempt: 1,
    members: [
      { sequence: 1, shortLabel: 'F1', filename: 'a.md', artifactVersionId: 'v-1', collectionId: 'c-1' },
      { sequence: 2, shortLabel: 'F2', filename: 'b.md', artifactVersionId: 'v-2', collectionId: 'c-2' },
      { sequence: 3, shortLabel: 'F3', filename: 'c.md', artifactVersionId: 'v-3', collectionId: 'c-3' },
    ],
    memberCount: 3,
    status: 'recorded',
    createdAt: 1_786_000_000_000,
  } as OutputPackageDto;
}

function projectFixture(actions: readonly PackageMemberAvailableActionsDto[], threadRootMessageId?: string) {
  mocks.getOutputPackage.mockResolvedValue({
    ok: true,
    package: pkgFixture(),
    availableActions: actions,
    ...(threadRootMessageId ? { threadRootMessageId } : {}),
  });
}

describe('TaskCardReviewEntryPanel（新版原型三入口）', () => {
  beforeEach(() => {
    mocks.onUpdated.mockReturnValue(() => {});
    mocks.onArtifactsUpdated.mockReturnValue(() => {});
  });

  test('呈现状态摘要与三入口按钮；不做任何直接审核提交', async () => {
    projectFixture([
      memberAction('c-1', 'v-1', 'approved'),
      memberAction('c-2', 'v-2', 'pending'),
      memberAction('c-3', 'v-3', 'changes_requested'),
    ], 'thread-root-1');
    const onViewFiles = vi.fn();
    const onReviewFiles = vi.fn();
    const onOpenThread = vi.fn();

    render(
      <TaskCardReviewEntryPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onViewFiles={onViewFiles}
        onReviewFiles={onReviewFiles}
        onOpenThread={onOpenThread}
      />,
    );

    await waitForPanel();
    expect(screen.getByText('查看交付文件')).toBeTruthy();
    expect(screen.getByText('审核交付文件')).toBeTruthy();
    expect(screen.getByText('打开讨论串')).toBeTruthy();
    // 新版原型：卡片不承载审核操作。
    expect(screen.queryByText('通过并设为最终版')).toBeNull();
    // 微调对齐原型：入口面板只保留三按钮，无标题/摘要/help 文字。
    expect(screen.queryByText('任务卡片只做状态摘要和入口，不直接审核文件')).toBeNull();

    fireEvent.click(screen.getByText('查看交付文件'));
    expect(onViewFiles).toHaveBeenCalledOnce();

    // 审核交付文件：初始选中第一个待处理版本（v-2 pending 先于 v-3 changes_requested）。
    fireEvent.click(screen.getByText('审核交付文件'));
    expect(onReviewFiles).toHaveBeenCalledWith('v-2');

    fireEvent.click(screen.getByText('打开讨论串'));
    expect(onOpenThread).toHaveBeenCalledWith('thread-root-1');
  });

  test('全部成员处理完毕时「审核交付文件」禁用并给出说明', async () => {
    projectFixture([
      memberAction('c-1', 'v-1', 'approved'),
      memberAction('c-2', 'v-2', 'approved'),
    ]);
    render(
      <TaskCardReviewEntryPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onViewFiles={vi.fn()}
        onReviewFiles={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    await waitForPanel();
    const reviewButton = screen.getByText('审核交付文件').closest('button');
    expect(reviewButton?.disabled).toBe(true);
  });

  test('投影未就绪或焦点包缺失时不渲染面板', () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false, error: 'NOT_FOUND' });
    const { container } = render(
      <TaskCardReviewEntryPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onViewFiles={vi.fn()}
        onReviewFiles={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-smoke="task-card-review-entry"]')).toBeNull();

    cleanup();
    const { container: empty } = render(
      <TaskCardReviewEntryPanel
        channelId="ch-1"
        focusPackageId={null}
        archived={false}
        onViewFiles={vi.fn()}
        onReviewFiles={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(empty.querySelector('[data-smoke="task-card-review-entry"]')).toBeNull();
  });
});

function waitForPanel() {
  return screen.findByText('查看交付文件');
}
