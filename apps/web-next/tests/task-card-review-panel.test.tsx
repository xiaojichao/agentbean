// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OutputPackageDto, PackageMemberAvailableActionsDto } from '@agentbean/contracts';

import { TaskCardReviewPanel } from '../components/TaskCardReviewPanel';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  onUpdated: vi.fn(() => () => {}),
  onArtifactsUpdated: vi.fn(() => () => {}),
  submitPackageArtifactReviews: vi.fn(),
  submitPackageReviewAndFinalize: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
    submitPackageArtifactReviews: mocks.submitPackageArtifactReviews,
    submitPackageReviewAndFinalize: mocks.submitPackageReviewAndFinalize,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function memberAction(
  collectionId: string,
  versionId: string,
  actions: readonly string[],
  collectionRevision = 3,
): PackageMemberAvailableActionsDto {
  return {
    collectionId,
    versionId,
    reviewState: 'pending',
    isFinalVersion: false,
    collectionRevision,
    actions: actions as PackageMemberAvailableActionsDto['actions'],
  };
}

function pkgFixture(overrides: Partial<OutputPackageDto> = {}): OutputPackageDto {
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
    ],
    memberCount: 2,
    status: 'recorded',
    createdAt: 1_786_000_000_000,
    ...overrides,
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

const REVIEW_ACTIONS = ['review-approved', 'review-changes-requested', 'review-rejected', 'review-and-finalize'];

describe('TaskCardReviewPanel（原型 review-panel 对齐）', () => {
  beforeEach(() => {
    mocks.onUpdated.mockReturnValue(() => {});
    mocks.onArtifactsUpdated.mockReturnValue(() => {});
  });

  test('Server 投影有动作时渲染三组动作；无任何动作时不渲染审核组', async () => {
    projectFixture([
      memberAction('c-1', 'v-1', REVIEW_ACTIONS),
      memberAction('c-2', 'v-2', REVIEW_ACTIONS),
    ], 'thread-root-1');

    const { unmount } = render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('通过审核')).toBeTruthy();
    });
    expect(screen.getByText('要求修改')).toBeTruthy();
    expect(screen.getByText('拒绝此版本')).toBeTruthy();
    expect(screen.getByText('通过并设为最终版')).toBeTruthy();
    expect(screen.getByText('回到讨论串继续')).toBeTruthy();
    expect(screen.getByText('任一频道成员都可以审核；实际审核人以点击者为准')).toBeTruthy();

    // 无任何可用动作（Server 明确空 actions）→ 审核组隐藏，回到讨论串仍在
    unmount();
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: pkgFixture(),
      availableActions: [memberAction('c-1', 'v-1', [])],
      threadRootMessageId: 'thread-root-1',
    });
    render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText('通过审核')).toBeNull();
    });
    expect(screen.getByText('回到讨论串继续')).toBeTruthy();
  });

  test('通过审核走批量命令且默认意见；要求修改意见必填', async () => {
    projectFixture([
      memberAction('c-1', 'v-1', REVIEW_ACTIONS),
      memberAction('c-2', 'v-2', REVIEW_ACTIONS),
    ]);
    mocks.submitPackageArtifactReviews.mockResolvedValue({
      ok: true,
      reviews: [{ id: 'r-1' }, { id: 'r-2' }],
    });

    const onMutationSucceeded = vi.fn();
    render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={onMutationSucceeded}
      />,
    );

    await waitFor(() => { expect(screen.getByText('通过审核')).toBeTruthy(); });

    // 通过审核：打开内联表单 → 直接确认（意见可选，使用默认文案）
    fireEvent.click(screen.getByText('通过审核'));
    fireEvent.click(screen.getByText('确认提交'));
    await waitFor(() => {
      expect(mocks.submitPackageArtifactReviews).toHaveBeenCalledTimes(1);
    });
    expect(mocks.submitPackageArtifactReviews).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'ch-1',
      packageId: 'pkg-1',
      deliveryId: 'delivery-1',
      expectedPackageRevision: 1,
      targets: [
        { collectionId: 'c-1', artifactVersionId: 'v-1' },
        { collectionId: 'c-2', artifactVersionId: 'v-2' },
      ],
      decision: 'approved',
      comment: '卡片批量通过当前 Server 版本',
    }));
    expect(onMutationSucceeded).toHaveBeenCalled();

    // 要求修改：意见必填
    fireEvent.click(screen.getByText('要求修改'));
    fireEvent.click(screen.getByText('确认提交'));
    await waitFor(() => {
      expect(screen.getByText('请填写审核意见')).toBeTruthy();
    });
    expect(mocks.submitPackageArtifactReviews).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '第二段太长' } });
    mocks.submitPackageArtifactReviews.mockResolvedValue({ ok: true, reviews: [{ id: 'r-3' }, { id: 'r-4' }] });
    fireEvent.click(screen.getByText('确认提交'));
    await waitFor(() => {
      expect(mocks.submitPackageArtifactReviews).toHaveBeenCalledTimes(2);
    });
    expect(mocks.submitPackageArtifactReviews).toHaveBeenLastCalledWith(expect.objectContaining({
      decision: 'changes_requested',
      comment: '第二段太长',
    }));
  });

  test('通过并设为最终版逐成员提交并汇报进度', async () => {
    projectFixture([
      memberAction('c-1', 'v-1', REVIEW_ACTIONS, 7),
      memberAction('c-2', 'v-2', REVIEW_ACTIONS, 9),
    ]);
    mocks.submitPackageReviewAndFinalize
      .mockResolvedValueOnce({ ok: true, review: { id: 'r-1' }, finalization: { versionId: 'v-1' } })
      .mockResolvedValueOnce({ ok: false, error: 'CONFLICT', message: '集合 revision 已推进' });

    render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={vi.fn()}
      />,
    );

    await waitFor(() => { expect(screen.getByText('通过并设为最终版')).toBeTruthy(); });
    fireEvent.click(screen.getByText('通过并设为最终版'));
    fireEvent.click(screen.getByText('确认提交'));

    await waitFor(() => {
      expect(mocks.submitPackageReviewAndFinalize).toHaveBeenCalledTimes(2);
    });
    expect(mocks.submitPackageReviewAndFinalize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: 'ch-1',
      packageId: 'pkg-1',
      collectionId: 'c-1',
      versionId: 'v-1',
      expectedCollectionRevision: 7,
    }));
    expect(mocks.submitPackageReviewAndFinalize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      collectionId: 'c-2',
      versionId: 'v-2',
      expectedCollectionRevision: 9,
    }));
    await waitFor(() => {
      expect(screen.getByText(/已通过并设为最终版 1\/2 个文件版本/)).toBeTruthy();
    });
  });

  test('回到讨论串继续只做导航，不触发任何 mutation', async () => {
    projectFixture([memberAction('c-1', 'v-1', REVIEW_ACTIONS)], 'thread-root-9');
    const onBackToThread = vi.fn();

    render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={onBackToThread}
        onMutationSucceeded={vi.fn()}
      />,
    );

    await waitFor(() => { expect(screen.getByText('回到讨论串继续')).toBeTruthy(); });
    fireEvent.click(screen.getByText('回到讨论串继续'));
    expect(onBackToThread).toHaveBeenCalledWith('thread-root-9');
    expect(mocks.submitPackageArtifactReviews).not.toHaveBeenCalled();
    expect(mocks.submitPackageReviewAndFinalize).not.toHaveBeenCalled();
  });

  test('投影未就绪或焦点包缺失时不渲染面板', () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false, error: 'NOT_FOUND' });
    const { container } = render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId="pkg-1"
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-smoke="task-card-review-panel"]')).toBeNull();

    cleanup();
    const { container: emptyContainer } = render(
      <TaskCardReviewPanel
        channelId="ch-1"
        focusPackageId={null}
        archived={false}
        onBackToThread={vi.fn()}
        onMutationSucceeded={vi.fn()}
      />,
    );
    expect(emptyContainer.querySelector('[data-smoke="task-card-review-panel"]')).toBeNull();
  });
});
