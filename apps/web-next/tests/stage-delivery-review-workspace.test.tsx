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
  submitPackageArtifactReview: vi.fn(),
  submitPackageReviewAndFinalize: vi.fn(),
  submitPackageReviewAndRejectDelivery: vi.fn(),
  setArtifactFinalVersion: vi.fn(),
  acceptRootDelivery: vi.fn(),
  rejectRootDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    queryStageDeliveryReviewWorkspace: mocks.query,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    submitPackageReviewAndFinalize: mocks.submitPackageReviewAndFinalize,
    submitPackageReviewAndRejectDelivery: mocks.submitPackageReviewAndRejectDelivery,
    setArtifactFinalVersion: mocks.setArtifactFinalVersion,
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
    const workspace = workspaceFixture();
    mocks.query.mockResolvedValue({ ok: true, workspace });
    const onOpenThread = vi.fn();
    const onViewAssetSource = vi.fn();
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        participantName={(id) => ({ 'reviewer-1': '审核人', 'agent-1': '执行 Agent' })[id] ?? id}
        onOpenThread={onOpenThread}
        onViewAssetSource={onViewAssetSource}
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

    fireEvent.click(screen.getByRole('button', { name: '回到讨论串' }));
    expect(onOpenThread).toHaveBeenCalledWith('message-root-1');
    fireEvent.click(screen.getByRole('button', { name: '查看资产来源' }));
    expect(onViewAssetSource).toHaveBeenCalledWith('package-1');
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
  test('只渲染 Server availableActions 按钮，并在确认后提交具名 command', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'pending',
        availableActions: ['review-approved', 'review-changes-requested', 'review-rejected', 'review-and-finalize', 'review-and-reject-delivery'],
      }),
    });
    mocks.submitPackageArtifactReview.mockResolvedValue({ ok: true, review: { id: 'review-new' } });
    const onMutationSucceeded = vi.fn();
    render(
      <StageDeliveryReviewWorkspace
        teamId="team-1"
        channelId="channel-1"
        stageId="stage-1"
        taskId="task-1"
        onMutationSucceeded={onMutationSucceeded}
      />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="package-review-action"]')).not.toBeNull());
    const buttons = Array.from(document.querySelectorAll('[data-smoke="package-review-action"]'));
    expect(buttons.map((node) => node.getAttribute('data-action'))).toEqual([
      'review-approved',
      'review-changes-requested',
      'review-rejected',
      'review-and-finalize',
      'review-and-reject-delivery',
    ]);

    fireEvent.click(screen.getByRole('button', { name: '通过审核' }));
    expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-smoke="stage-review-mutation-target"]')?.textContent).toContain('package-1');
    expect(document.querySelector('[data-smoke="stage-review-mutation-target"]')?.textContent).toContain('version-1');
    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '质量合格' } });
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'approved',
        availableActions: ['set-final'],
        asOf: 200,
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(mocks.submitPackageArtifactReview).toHaveBeenCalledTimes(1));
    expect(mocks.submitPackageArtifactReview).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-1',
      packageId: 'package-1',
      collectionId: 'collection-1',
      versionId: 'version-1',
      decision: 'approved',
      comment: '质量合格',
    }));
    const idempotencyKey = mocks.submitPackageArtifactReview.mock.calls[0]?.[0]?.idempotencyKey as string;
    expect(idempotencyKey).toMatch(/^stage-package:review-approved:/);
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).toBeNull());
    expect(onMutationSucceeded).toHaveBeenCalled();
    // 成功后以 Server projection 刷新，不乐观改本地 reviewState。
    await vi.waitFor(() => expect(mocks.query.mock.calls.length).toBeGreaterThan(1));
  });

  test('结构化失败保留对话框与原 idempotency key，可原 key 重试', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'pending',
        availableActions: ['review-changes-requested'],
      }),
    });
    mocks.submitPackageArtifactReview
      .mockResolvedValueOnce({ ok: false, error: 'CONFLICT', message: 'task-revision-stale' })
      .mockResolvedValueOnce({ ok: true, review: { id: 'review-retry' } });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '要求修改' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '要求修改' }));
    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '请补截图' } });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-review-mutation-error"]')?.textContent).toContain('task-revision-stale'));
    expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).not.toBeNull();
    const firstKey = mocks.submitPackageArtifactReview.mock.calls[0]?.[0]?.idempotencyKey;
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(mocks.submitPackageArtifactReview).toHaveBeenCalledTimes(2));
    expect(mocks.submitPackageArtifactReview.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
  });

  test('通过并设为最终版走原子组合命令，不拆成 review + set-final', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'pending',
        availableActions: ['review-and-finalize'],
      }),
    });
    mocks.submitPackageReviewAndFinalize.mockResolvedValue({ ok: true });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '通过并设为最终版' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '通过并设为最终版' }));
    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '可最终化' } });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(mocks.submitPackageReviewAndFinalize).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'approved',
      expectedCollectionRevision: 2,
      comment: '可最终化',
    })));
    expect(mocks.submitPackageArtifactReview).not.toHaveBeenCalled();
    expect(mocks.setArtifactFinalVersion).not.toHaveBeenCalled();
  });

  test('审核并退回交付需要 rejectReason，并提交 expectedTaskRevision/attempt', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'pending',
        availableActions: ['review-and-reject-delivery'],
      }),
    });
    mocks.submitPackageReviewAndRejectDelivery.mockResolvedValue({ ok: true });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '审核并退回交付' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '审核并退回交付' }));
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    expect(document.querySelector('[data-smoke="stage-review-mutation-error"]')?.textContent).toMatch(/审核意见|退回理由/);
    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '需要重做' } });
    fireEvent.change(screen.getByLabelText('退回理由'), { target: { value: '验收材料不完整' } });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(mocks.submitPackageReviewAndRejectDelivery).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'changes_requested',
      expectedTaskRevision: 1,
      expectedTaskAttempt: 1,
      rejectReason: '验收材料不完整',
      comment: '需要重做',
    })));
  });

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
    fireEvent.click(screen.getByRole('button', { name: '验收交付' }));
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '提交中…' })).toBeTruthy());
    expect(mocks.acceptRootDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      expectedTaskRevision: 1,
    }));
    resolveAccept?.({ ok: true });
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).toBeNull());
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

  test('失败后清除 lock，原 idempotency key 可重试；soft refresh 不拆掉对话框', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        reviewState: 'pending',
        availableActions: ['review-approved'],
      }),
    });
    mocks.submitPackageArtifactReview.mockResolvedValue({
      ok: false,
      error: 'FORBIDDEN',
      message: 'actor-not-authorized',
    });
    let refresh: (() => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId, handler) => {
      refresh = handler;
      return () => {};
    });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(screen.getByRole('button', { name: '通过审核' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '通过审核' }));
    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-review-mutation-error"]')?.textContent).toContain('actor-not-authorized'));
    expect(screen.getByRole('button', { name: '通过审核' }).textContent).not.toContain('提交中');
    refresh?.();
    await Promise.resolve();
    expect(document.querySelector('[data-smoke="stage-review-mutation-dialog"]')).not.toBeNull();
    expect(screen.getByLabelText('审核意见')).toBeTruthy();
  });

  test('归档频道不展示 package mutation 按钮', async () => {
    mocks.query.mockResolvedValue({
      ok: true,
      workspace: workspaceFixture({
        archived: true,
        reviewState: 'pending',
        availableActions: ['review-approved'],
      }),
    });
    render(
      <StageDeliveryReviewWorkspace teamId="team-1" channelId="channel-1" stageId="stage-1" taskId="task-1" />,
    );
    await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-smoke="package-review-action"]')).toHaveLength(0);
    expect(document.querySelector('[data-smoke="stage-delivery-acceptance"]')).toBeNull();
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
      nodeKind: 'root' as const, reviewPolicy: 'human', humanAcceptanceAuthorityIds: ['reviewer-1'],
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
    availableActions: [{ action: 'open-task' as const, label: '打开 Task' }],
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
