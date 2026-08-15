// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
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

const BASE_PROPS = { teamId: 'team-1', channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1' } as const;

async function renderWorkspace(
  workspace: StageDeliveryReviewWorkspaceV1,
  props: Partial<Parameters<typeof StageDeliveryReviewWorkspace>[0]> = {},
) {
  mocks.query.mockResolvedValue({ ok: true, workspace });
  render(<StageDeliveryReviewWorkspace {...BASE_PROPS} {...props} />);
  await vi.waitFor(() => expect(document.querySelector('[data-smoke="stage-delivery-review-workspace"]')).not.toBeNull());
}

function expectNoServerFacts() {
  // 预填是纯客户端导航：不得触发任何 review/delivery mutation（message:send 不经过本组件）。
  expect(mocks.submitPackageArtifactReview).not.toHaveBeenCalled();
  expect(mocks.submitPackageReviewAndFinalize).not.toHaveBeenCalled();
  expect(mocks.submitPackageReviewAndRejectDelivery).not.toHaveBeenCalled();
  expect(mocks.setArtifactFinalVersion).not.toHaveBeenCalled();
  expect(mocks.acceptRootDelivery).not.toHaveBeenCalled();
  expect(mocks.rejectRootDelivery).not.toHaveBeenCalled();
}

describe('阶段工作区交接入口（#1178）', () => {
  test('「交给智能体处理」上抛焦点包 current 引用（含逐成员 revision fence）与绑定 Thread', async () => {
    const onStageHandoff = vi.fn();
    const onAction = vi.fn();
    await renderWorkspace(
      workspaceFixture({ taskActions: ['delegate-to-agent'] }),
      { onStageHandoff, onAction },
    );
    const button = document.querySelector('[data-smoke="task-action-delegate-to-agent"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    // current 是指针策略：fence 取自 Server current 投影的 collectionRevision，
    // 发送时 Server 复验缺/不符即 revision_stale fail closed。
    expect(onStageHandoff).toHaveBeenCalledWith({
      action: 'delegate-to-agent',
      threadRootMessageId: 'message-root-1',
      selection: {
        kind: 'package_projection',
        packageId: 'package-1',
        policy: 'current',
        expectedMemberRevisions: [{ collectionId: 'collection-1', revision: 2 }],
      },
    });
    // 阶段上下文里 delegate 被拦截上抛，不再走原 action 直通。
    expect(onAction).not.toHaveBeenCalled();
    expectNoServerFacts();
  });

  test('未接 onStageHandoff 时 delegate-to-agent 保持原 action 直通（旧路径兼容）', async () => {
    const onAction = vi.fn();
    await renderWorkspace(workspaceFixture({ taskActions: ['delegate-to-agent'] }), { onAction });
    fireEvent.click(document.querySelector('[data-smoke="task-action-delegate-to-agent"]')!);
    expect(onAction).toHaveBeenCalledWith({ action: 'delegate-to-agent', label: '交给智能体处理' });
  });

  test('无交付包时「交给智能体处理」上抛不带引用选择', async () => {
    const onStageHandoff = vi.fn();
    await renderWorkspace(
      workspaceFixture({ noDelivery: true, taskActions: ['delegate-to-agent'] }),
      { onStageHandoff },
    );
    fireEvent.click(document.querySelector('[data-smoke="task-action-delegate-to-agent"]')!);
    expect(onStageHandoff).toHaveBeenCalledWith({
      action: 'delegate-to-agent',
      threadRootMessageId: 'message-root-1',
    });
  });

  test('「要求修改后继续」在 changes_requested 审核事实下可见，点击上抛 delivered 成员版本显式选择', async () => {
    const onStageHandoff = vi.fn();
    await renderWorkspace(workspaceFixture({ reviewState: 'changes_requested' }), { onStageHandoff });
    const button = document.querySelector('[data-smoke="stage-review-continue-handoff"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    // 设计修正：不能用 delivered 指针——reject-delivery 写入的 changes_requested/rejected
    // review 会让指针解析被 REVIEW_BASIS_BLOCKED 拒绝（只豁免显式选择）。成员版本取自
    // Server delivered 投影（冻结事实），发送时冻结为具体 artifactVersionId。
    expect(onStageHandoff).toHaveBeenCalledWith({
      action: 'continue-after-changes',
      threadRootMessageId: 'message-root-1',
      selection: {
        kind: 'package_members',
        packageId: 'package-1',
        members: [{ collectionId: 'collection-1', versionId: 'version-1' }],
      },
    });
    expectNoServerFacts();
  });

  test('delivered 投影 not_ready 时「要求修改后继续」上抛不带 selection（父级只预填文案）', async () => {
    const onStageHandoff = vi.fn();
    await renderWorkspace(
      workspaceFixture({ reviewState: 'changes_requested', deliveredNotReady: true }),
      { onStageHandoff },
    );
    const button = document.querySelector('[data-smoke="stage-review-continue-handoff"]');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onStageHandoff).toHaveBeenCalledWith({
      action: 'continue-after-changes',
      threadRootMessageId: 'message-root-1',
    });
    expectNoServerFacts();
  });

  test.each([
    ['changes_requested（要求修改）', { reviewState: 'changes_requested' as const }, true],
    ['rejected（交付被退回）', { reviewState: 'rejected' as const }, true],
    ['approved（已通过）', { reviewState: 'approved' as const }, false],
    ['pending（未审核）', { reviewState: 'pending' as const }, false],
    ['Task 终态 done', { reviewState: 'changes_requested' as const, taskStatus: 'done' as const }, false],
    ['Task 终态 closed', { reviewState: 'changes_requested' as const, taskStatus: 'closed' as const }, false],
    ['Task 终态 cancelled', { reviewState: 'changes_requested' as const, taskStatus: 'cancelled' as const }, false],
    ['频道已归档', { reviewState: 'changes_requested' as const, archived: true }, false],
    ['无交付文件包', { reviewState: 'changes_requested' as const, noDelivery: true }, false],
  ])('「要求修改后继续」可见条件：%s → %s', async (_label, options, visible) => {
    await renderWorkspace(workspaceFixture(options), { onStageHandoff: vi.fn() });
    expect(document.querySelector('[data-smoke="stage-review-continue-handoff"]') !== null).toBe(visible);
  });

  test('无绑定讨论串时「要求修改后继续」禁用（无回落对象）', async () => {
    const onStageHandoff = vi.fn();
    await renderWorkspace(
      workspaceFixture({ reviewState: 'changes_requested', noThread: true }),
      { onStageHandoff },
    );
    const button = document.querySelector<HTMLButtonElement>('[data-smoke="stage-review-continue-handoff"]');
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
  });
});

function workspaceFixture(options: {
  noDelivery?: boolean;
  archived?: boolean;
  noThread?: boolean;
  deliveredNotReady?: boolean;
  reviewState?: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  taskStatus?: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled' | 'closed';
  taskActions?: Array<'open-task' | 'delegate-to-agent' | 'review-package'>;
} = {}): StageDeliveryReviewWorkspaceV1 {
  const reviewState = options.reviewState ?? 'approved';
  const taskStatus = options.taskStatus ?? 'in_review';
  const task = {
    id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: '审核发布包', description: '',
    status: taskStatus,
    creatorId: 'reviewer-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 2,
  };
  const stage = {
    id: 'stage-1', teamId: 'team-1', channelId: 'channel-1', name: '发布审核',
    goal: '形成可验收的发布文件包', ownerId: 'reviewer-1', reviewerIds: ['reviewer-1'],
    acceptanceCriteria: ['全部必需成员有审核结论'], task, taskRevision: 1,
    aggregateStatus: 'in_review' as const, blockingReasons: [], upstreamStageIds: [],
    dependenciesSatisfied: true, missingRequiredInputs: [], executionAllowed: true,
    advance: {
      kind: 'waiting' as const, automatic: false, stableInputs: [],
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
    reviewState,
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
  const deliveredProjection = options.deliveredNotReady
    ? {
        policy: 'delivered' as const,
        status: 'not_ready' as const,
        members: [],
        blockers: [{ code: 'collection_unavailable' as const, collectionId: 'collection-1' }],
        omitted: [],
        consistencyToken: { schemaVersion: 1 as const, entries: [] },
      }
    : projection('delivered', 'version-1', 1);
  const taskActions = options.taskActions ?? [];
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
    availableActions: [
      { action: 'open-task' as const, label: '打开 Task' },
      ...taskActions
        .filter((action) => action !== 'open-task')
        .map((action) => ({ action, label: action === 'delegate-to-agent' ? '交给智能体处理' : action })),
    ],
    timeline: [{ id: 'review-1', kind: 'review' as const, at: 20, actorKind: 'human' as const, summary: '审核结论' }],
    asOf: 100,
    audienceScope: 'team-1:channel-1:reviewer-1',
    consistencyToken: { schemaVersion: 1 as const, entries: [{ streamKind: 'output-package', streamId: 'channel-1', revision: 2 }] },
  };
  return {
    schemaVersion: 1,
    channelId: 'channel-1', stageId: 'stage-1', taskId: 'task-1', stage, taskOverview,
    ...(options.noThread ? {} : { threadRootMessageId: 'message-root-1' }),
    suggestedReviewerIds: ['reviewer-1'], archived: Boolean(options.archived),
    ...(options.noDelivery ? {} : {
      focusPackage: {
        package: packageDto,
        projections: {
          delivered: deliveredProjection,
          current: projection('current', 'version-2', 2),
          final: projection('final', 'version-1', 1),
        },
        members: [{
          sequence: 1, shortLabel: 'F1', collectionId: 'collection-1', artifactVersionId: 'version-1',
          requiredForFinal: true, sourcePath: 'docs/release.md', filename: 'release.md',
          delivered: identity('delivered', 'version-1', 1),
          current: identity('current', 'version-2', 2),
          final: identity('final', 'version-1', 1),
          review: {
            state: reviewState, covered: reviewState !== 'pending', actualReviewerIds: reviewState === 'pending' ? [] : ['reviewer-1'],
            records: reviewState === 'pending' ? [] : [{
              id: 'review-1', teamId: 'team-1', channelId: 'channel-1', collectionId: 'collection-1',
              versionId: 'version-1', packageId: 'package-1', deliveryId: 'delivery-1', taskId: 'task-1',
              taskRevision: 1, taskAttempt: 1,
              decision: (reviewState === 'pending' ? 'approved' : reviewState) as 'approved' | 'rejected' | 'changes_requested',
              comment: '审核意见', authorityBasis: 'stage-reviewer-delegation' as const, reviewedBy: 'reviewer-1', createdAt: 20,
            }],
          },
          availableActions: {
            collectionId: 'collection-1',
            versionId: 'version-1',
            reviewState,
            isFinalVersion: false,
            collectionRevision: 2,
            actions: [],
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
    blockers: [],
    asOf: 100,
    audienceScope: 'team-1:channel-1:reviewer-1',
    consistencyToken: { schemaVersion: 1, entries: [{ streamKind: 'output-package', streamId: 'channel-1', revision: 2 }] },
  };
}
