// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StageDeliveryReviewWorkspaceV1 } from '@agentbean/contracts';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  onUpdated: vi.fn(),
  onArtifactsUpdated: vi.fn(),
  onSnapshot: vi.fn(),
  acceptRootDelivery: vi.fn(),
  rejectRootDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    queryStageDeliveryReviewWorkspace: mocks.query,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
  }),
  taskEvents: () => ({
    onSnapshot: mocks.onSnapshot,
    acceptRootDelivery: mocks.acceptRootDelivery,
    rejectRootDelivery: mocks.rejectRootDelivery,
  }),
}));

import { StageDeliveryReviewWorkspace } from '../components/StageDeliveryReviewWorkspace';

beforeEach(() => {
  mocks.onUpdated.mockReturnValue(() => {});
  mocks.onArtifactsUpdated.mockReturnValue(() => {});
  mocks.onSnapshot.mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('阶段交付审核工作区', () => {
  test('在 Tasks 内完整展示阶段、版本身份、覆盖、审核人、阻断和统一时间线', async () => {
    const workspace = workspaceFixture({ availableActions: ['review-and-finalize'] });
    mocks.query.mockResolvedValue({ ok: true, workspace });
    const onOpenThread = vi.fn();
    const onViewAssetSource = vi.fn();
    const onOpenPackagePreview = vi.fn();
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        participantName={(id) => ({ 'reviewer-1': '审核人', 'agent-1': '执行 Agent' })[id] ?? id}
        onOpenThread={onOpenThread}
        onViewAssetSource={onViewAssetSource}
        onOpenPackagePreview={onOpenPackagePreview}
      />,
    );

    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
    expect(screen.getByText('目标：形成可验收的发布文件包')).toBeTruthy();
    expect(screen.getByText(/验收标准：全部必需成员有审核结论/)).toBeTruthy();
    expect(screen.getByText(/ArtifactVersion upstream-version-1/)).toBeTruthy();
    expect(document.querySelector('[data-version-policy="delivered"]')?.textContent).toContain('version-1');
    expect(document.querySelector('[data-version-policy="current"]')?.textContent).toContain('version-2');
    expect(document.querySelector('[data-version-policy="final"]')?.textContent).toContain('version-1');
    expect(document.querySelector('[data-version-policy="specified"]')?.textContent).toContain('version-2');
    expect(document.querySelector('[data-smoke="stage-review-coverage"]')?.textContent).toContain('已审核 1');
    expect(document.querySelector('[data-smoke="stage-review-coverage"]')?.textContent).toContain('实际审核人：审核人');
    expect(document.querySelector('[data-smoke="stage-review-member-review"]')?.textContent).toContain('Package 审核/最终化不会自动完成 Task');
    expect(document.querySelector('[data-smoke="stage-review-blockers"]')?.textContent).toContain('required_review_missing');
    expect(document.querySelector('[data-smoke="task-timeline"]')?.textContent).toContain('审核通过');

    fireEvent.click(screen.getByRole('button', { name: '打开讨论串' }));
    expect(onOpenThread).toHaveBeenCalledWith('message-root-1');
    fireEvent.click(screen.getByRole('button', { name: '查看交付文件' }));
    expect(onViewAssetSource).toHaveBeenCalledWith('package-1');
    fireEvent.click(screen.getByRole('button', { name: '预览并审核此文件' }));
    expect(onOpenPackagePreview).toHaveBeenCalledWith(expect.objectContaining({
      packageId: 'package-1',
      threadRootMessageId: 'message-root-1',
      taskId: 'task-1',
      memberCount: 1,
    }), 'version-1', false);
    fireEvent.click(screen.getByRole('button', { name: '审核交付文件' }));
    expect(onOpenPackagePreview).toHaveBeenLastCalledWith(expect.objectContaining({ packageId: 'package-1' }));
    expect(document.querySelector('[data-smoke="package-review-action"]')).toBeNull();
  });

  test('区分无交付、归档只读与不可见版本', async () => {
    const noDelivery = workspaceFixture({ noDelivery: true, archived: true });
    mocks.query.mockResolvedValueOnce({ ok: true, workspace: noDelivery });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-no-delivery"]')).not.toBeNull());
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();

    cleanup();
    mocks.query.mockResolvedValueOnce({ ok: true, workspace: workspaceFixture({ unavailableVersion: true }) });
    render(<StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />);
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-version-unavailable"]')).not.toBeNull());
    expect(document.querySelector('[data-smoke="stage-delivery-version-unavailable"]')?.textContent).toContain('仅保留 OutputPackage 冻结身份');
  });

  test.each([
    ['PROJECTION_NOT_READY', 'stage-delivery-not_ready', '尚未追上最新一致性水位'],
    ['FORBIDDEN', 'stage-delivery-no_permission', '没有查看'],
    ['INTERNAL_ERROR', 'stage-delivery-error', '读取失败'],
  ])('错误 %s 使用独立状态', async (error, smoke, text) => {
    mocks.query.mockResolvedValue({ ok: false, error, message: error === 'INTERNAL_ERROR' ? '读取失败' : undefined });
    render(<StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />);
    await vi.waitFor(() => expect(document.querySelector(`[data-smoke="${smoke}"]`)).not.toBeNull());
    expect(document.querySelector(`[data-smoke="${smoke}"]`)?.textContent).toContain(text);
  });

  test('较旧请求在较新投影之后返回时不能覆盖新 revision', async () => {
    let refresh: (() => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId, handler) => {
      refresh = handler;
      return () => {};
    });
    let resolveOld: ((value: unknown) => void) | undefined;
    let resolveNew: ((value: unknown) => void) | undefined;
    mocks.query
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveNew = resolve; }));
    render(<StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />);
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    refresh?.();
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
    resolveNew?.({ ok: true, workspace: workspaceFixture({ stageName: '新阶段投影', asOf: 500 }) });
    await vi.waitFor(() => expect(screen.getByText('新阶段投影')).toBeTruthy());
    resolveOld?.({ ok: true, workspace: workspaceFixture({ stageName: '旧阶段投影', asOf: 100 }) });
    await Promise.resolve();
    expect(screen.queryByText('旧阶段投影')).toBeNull();
    expect(screen.getByText('新阶段投影')).toBeTruthy();
  });
});

describe('阶段交付审核 mutation 闭环 (#1177)', () => {
  test('Task 验收/退回走 lifecycle commands，提交中锁定同目标动作', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'approved',
        availableActions: [],
        taskInReview: true,
      }),
    });
    let resolveAccept: ((value: { ok: boolean }) => void) | undefined;
    mocks.acceptRootDelivery.mockReturnValue(new Promise((resolve) => { resolveAccept = resolve; }));
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        currentUserId="reviewer-1"
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-acceptance"]')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '验收本次交付' }));
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '提交中…' })).toBeTruthy());
    expect(mocks.acceptRootDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      expectedTaskRevision: 1,
    }));
    resolveAccept?.({ ok: true });
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).toBeNull());
  });

  test('Task 投影里的验收快捷动作复用阶段验收对话框', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'approved',
        taskInReview: true,
        taskAcceptAction: true,
      }),
    });
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        currentUserId="reviewer-1"
      />,
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-action-accept-delivery"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-smoke="task-action-accept-delivery"]')!);
    expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).not.toBeNull();
    expect(mocks.acceptRootDelivery).not.toHaveBeenCalled();
  });

  test('非预绑定验收人看不到 Task delivery 验收按钮', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'approved',
        availableActions: [],
        taskInReview: true,
      }),
    });
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        currentUserId="outsider"
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
    expect(document.querySelector('[data-smoke="stage-delivery-acceptance"]')).toBeNull();
  });

  test('子任务不展示验收/退回按钮（accept/rejectRootDelivery 仅对 root 合法）', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'approved',
        availableActions: [],
        taskInReview: true,
        nodeKind: 'subtask',
      }),
    });
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        currentUserId="reviewer-1"
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
    expect(document.querySelector('[data-smoke="stage-delivery-acceptance"]')).toBeNull();
  });

  test('归档频道不展示 package mutation 按钮', async () => {
    const onOpenPackagePreview = vi.fn();
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        archived: true,
        reviewState: 'pending',
        availableActions: ['review-approved'],
      }),
    });
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        onOpenPackagePreview={onOpenPackagePreview}
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-smoke="package-review-action"]')).toHaveLength(0);
    expect(document.querySelector('[data-smoke="stage-delivery-acceptance"]')).toBeNull();
    expect((screen.getByRole('button', { name: '审核交付文件' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '预览此文件' }));
    expect(onOpenPackagePreview).toHaveBeenCalledWith(expect.objectContaining({ packageId: 'package-1' }), 'version-1', true);
  });
});

function workspaceFixture(options: {
  noDelivery?: boolean;
  archived?: boolean;
  unavailableVersion?: boolean;
  stageName?: string;
  asOf?: number;
  reviewState?: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  availableActions?: Array<
    | 'review-approved'
    | 'review-changes-requested'
    | 'review-rejected'
    | 'review-and-finalize'
    | 'review-and-reject-delivery'
    | 'set-final'
  >;
  taskInReview?: boolean;
  nodeKind?: 'root' | 'subtask';
  taskAcceptAction?: boolean;
} = {}): StageDeliveryReviewWorkspaceV1 {
  const reviewState = options.reviewState ?? 'approved';
  const availableActions = options.availableActions ?? [];
  const task = {
    id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: '审核发布包', description: '',
    status: (options.taskInReview || reviewState === 'pending' ? 'in_review' : 'in_review') as const,
    creatorId: 'reviewer-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 2,
  };
  const stage = {
    id: 'stage-1', teamId: 'team-1', channelId: 'channel-1', name: options.stageName ?? '发布审核',
    goal: '形成可验收的发布文件包', ownerId: 'reviewer-1', reviewerIds: ['reviewer-1'],
    acceptanceCriteria: ['全部必需成员有审核结论'], task, taskRevision: 1,
    aggregateStatus: 'in_review' as const, blockingReasons: [], upstreamStageIds: ['stage-upstream'],
    dependenciesSatisfied: true, missingRequiredInputs: [], executionAllowed: true,
    advance: {
      kind: 'waiting' as const, automatic: false,
      stableInputs: [{
        key: 'script', kind: 'artifact_version' as const, edgeId: 'edge-1', upstreamStageId: 'stage-upstream',
        collectionId: 'upstream-collection', versionId: 'upstream-version-1', artifactId: 'artifact-upstream',
        reviewId: 'review-upstream', finalizationId: 'final-upstream', taskRevision: 1,
      }],
      candidateAgentIds: [], taskRevision: 1, stageTaskRevision: 1,
    },
    createdAt: 1, updatedAt: 2,
  };
  const identity = (policy: 'delivered' | 'current' | 'final' | 'specified', versionId: string, versionNumber: number) => ({
    sequence: 1,
    shortLabel: 'F1',
    collectionId: 'collection-1',
    versionId,
    versionNumber,
    artifactId: `artifact-${versionId}`,
    filename: 'release.md',
    reviewState: reviewState,
    isFinalVersion: policy === 'final',
    collectionRevision: 2,
    source: { taskId: 'task-1', taskRevision: 1, workspaceRunId: 'run-1', invocationId: 'invocation-1' },
  });
  const packageDto = {
    schemaVersion: 1 as const, packageId: 'package-1', teamId: 'team-1', channelId: 'channel-1', revision: 1,
    deliveryId: 'delivery-1', publishId: 'publish-1', workspaceRevisionId: 'workspace-revision-1', agentId: 'agent-1',
    taskId: 'task-1', taskBinding: 'managed' as const, taskRevision: 1, taskAttempt: 1,
    workspaceRunId: 'run-1', invocationId: 'invocation-1',
    members: [{
      packageId: 'package-1', sequence: 1, shortLabel: 'F1', collectionId: 'collection-1', artifactVersionId: 'version-1',
      role: 'deliverable' as const, requiredForFinal: true, sourcePath: 'docs/release.md', filename: 'release.md', sizeBytes: 10,
    }],
    memberCount: 1, status: 'recorded' as const, createdAt: 10,
  };
  const projection = (policy: 'delivered' | 'current' | 'final' | 'specified', versionId: string, versionNumber: number) => ({
    policy,
    status: 'ready' as const,
    members: [identity(policy, versionId, versionNumber)],
    blockers: [],
    omitted: [],
    consistencyToken: { schemaVersion: 1 as const, entries: [] },
  });
  const taskOverview = {
    schemaVersion: 1 as const, taskId: 'task-1', channelId: 'channel-1', task, stage,
    acceptanceContract: {
      nodeKind: options.nodeKind ?? ('root' as const), reviewPolicy: 'human', humanAcceptanceAuthorityIds: ['reviewer-1'],
      requiresHumanAcceptance: true, acceptanceCriteria: ['交付可用'], taskRevision: 1, attempt: 1, maxAttempts: 3,
      requiredReviewCoverage: { requiredForFinalCount: 1, finalizedCount: reviewState === 'approved' ? 1 : 0, complete: reviewState === 'approved' },
    },
    responsibilityFocus: { kind: 'review_wait' as const, detail: '等待人类验收/审核交付' },
    delivery: options.noDelivery ? { packages: [], pendingDeliveries: [] } : {
      packages: [{
        schemaVersion: 1 as const, packageId: 'package-1', teamId: 'team-1', channelId: 'channel-1', revision: 1,
        deliveryId: 'delivery-1', publishId: 'publish-1', workspaceRevisionId: 'workspace-revision-1', agentId: 'agent-1',
        taskId: 'task-1', taskBinding: 'managed' as const, taskRevision: 1, taskAttempt: 1,
        memberCount: 1, reviewState, status: 'recorded' as const, createdAt: 10,
      }], pendingDeliveries: [], focusPackageId: 'package-1',
    },
    availableActions: [
      { action: 'open-task' as const, label: '打开 Task' },
      ...(options.taskAcceptAction
        ? [{ action: 'accept-delivery' as const, label: '验收本次交付' }]
        : []),
    ],
    timeline: [{ id: 'review-1', kind: 'review' as const, at: 20, actorKind: 'human' as const, summary: '审核通过' }],
    asOf: options.asOf ?? 100,
    audienceScope: 'team-1:channel-1:reviewer-1',
    consistencyToken: { schemaVersion: 1 as const, entries: [{ streamKind: 'output-package', streamId: 'channel-1', revision: 2 }] },
  };
  return {
    schemaVersion: 1,
    channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1', stage, taskOverview,
    threadRootMessageId: 'message-root-1', suggestedReviewerIds: ['reviewer-1'], archived: Boolean(options.archived),
    ...(options.noDelivery ? {} : {
      focusPackage: {
        package: packageDto,
        projections: {
          delivered: projection('delivered', 'version-1', 1),
          current: projection('current', 'version-2', 2),
          final: projection('final', 'version-1', 1),
          specified: projection('specified', 'version-2', 2),
        },
        members: [{
          sequence: 1, shortLabel: 'F1', collectionId: 'collection-1', artifactVersionId: 'version-1',
          requiredForFinal: true, sourcePath: 'docs/release.md', filename: 'release.md',
          ...(options.unavailableVersion ? {} : {
            delivered: identity('delivered', 'version-1', 1),
            current: identity('current', 'version-2', 2),
            final: identity('final', 'version-1', 1),
            specified: identity('specified', 'version-2', 2),
          }),
          review: {
            state: reviewState, covered: reviewState !== 'pending', actualReviewerIds: reviewState === 'pending' ? [] : ['reviewer-1'],
            records: reviewState === 'pending' ? [] : [{
              id: 'review-1', teamId: 'team-1', channelId: 'channel-1', collectionId: 'collection-1',
              versionId: 'version-1', packageId: 'package-1', deliveryId: 'delivery-1', taskId: 'task-1',
              taskRevision: 1, taskAttempt: 1, decision: 'approved' as const, comment: '符合要求',
              authorityBasis: 'stage-reviewer-delegation' as const, reviewedBy: 'reviewer-1', createdAt: 20,
            }],
          },
          finalization: reviewState === 'approved' ? {
            id: 'finalization-1', teamId: 'team-1', channelId: 'channel-1', collectionId: 'collection-1',
            versionId: 'version-1', basisReviewId: 'review-1', actorKind: 'human' as const,
            finalizedBy: 'reviewer-1', createdAt: 21,
          } : undefined,
          availableActions: {
            collectionId: 'collection-1',
            versionId: 'version-1',
            reviewState,
            isFinalVersion: false,
            collectionRevision: 2,
            actions: availableActions,
          },
        }],
        coverage: {
          requiredCount: 1,
          reviewedCount: reviewState === 'pending' ? 0 : 1,
          approvedCount: reviewState === 'approved' ? 1 : 0,
          uncoveredCount: reviewState === 'pending' ? 1 : 0,
          complete: reviewState === 'approved',
          uncoveredCollectionIds: reviewState === 'pending' ? ['collection-1'] : [],
          actualReviewerIds: reviewState === 'pending' ? [] : ['reviewer-1'],
        },
      },
    }),
    blockers: [{
      source: 'review', code: 'required_review_missing', collectionId: 'collection-2', shortLabel: 'F2', filename: 'missing.md',
    }],
    asOf: options.asOf ?? 100,
    audienceScope: 'team-1:channel-1:reviewer-1',
    consistencyToken: { schemaVersion: 1, entries: [{ streamKind: 'output-package', streamId: 'channel-1', revision: 2 }] },
  };
}
