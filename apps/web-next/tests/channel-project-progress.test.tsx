// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ChannelProjectOverviewDto,
  ChannelTaskWorkspaceV1,
  OutputPackageDto,
  PackageMemberAvailableActionsDto,
} from '@agentbean/contracts';

import { ChannelProjectProgress } from '../components/ChannelProjectProgress';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
  onUpdated: vi.fn(() => () => {}),
  onArtifactsUpdated: vi.fn(() => () => {}),
}));

// review lane 卡片挂载 TaskCardReviewPanel 会拉焦点包投影；默认投影不可得（面板不渲染）。
vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
  }),
}));

beforeEach(() => {
  mocks.getOutputPackage.mockReset();
  mocks.getOutputPackage.mockResolvedValue({ ok: false, error: 'NOT_FOUND' });
  mocks.onUpdated.mockReset();
  mocks.onUpdated.mockReturnValue(() => {});
  mocks.onArtifactsUpdated.mockReset();
  mocks.onArtifactsUpdated.mockReturnValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderProgress(props: Partial<Parameters<typeof ChannelProjectProgress>[0]> = {}) {
  const callbacks = {
    channelId: 'channel-1',
    onBackToThread: vi.fn(),
    onReviewDeliveryFiles: vi.fn(),
    onViewDeliveryFiles: vi.fn(),
  };
  render(
    <ChannelProjectProgress
      overview={overview()}
      workspace={workspace()}
      participants={participants}
      currentUserId="reviewer-1"
      state="ready"
      archived={false}
      {...callbacks}
      {...props}
    />,
  );
  return callbacks;
}

describe('频道项目推进工作区', () => {
  test('阶段卡片展示 Server 阶段、责任、交付与审核事实，进行中卡提供查看进度与讨论串入口', () => {
    const callbacks = renderProgress({ selectedStageId: 'stage-1' });

    const card = document.querySelector('[data-smoke="channel-project-stage-card"]');
    expect(card?.getAttribute('aria-current')).toBe('true');
    expect(card?.textContent).toContain('形成可验收的发布方案');
    expect(card?.textContent).toContain('任务状态：进行中');
    expect(card?.textContent).toContain('Agent「执行 Agent」正在执行');
    expect(card?.textContent).toContain('无前置阶段');
    expect(card?.textContent).toContain('交付包 2 个');
    expect(card?.textContent).toContain('最终版 1/2');
    expect(card?.textContent).toContain('实际审核人审核人');
    expect(document.querySelector('[data-smoke="channel-project-lanes"]')).toBeTruthy();
    expect(document.querySelector('[data-smoke="channel-project-lane-active"]')?.textContent).toContain('发布准备');
    expect(document.querySelector('[data-smoke="channel-project-lane-review"]')?.textContent).toContain('暂无待审核交付');
    // 新版原型：进行中卡为「查看执行进度」「打开讨论串」；不再打开任务详情侧边栏，无直接指派入口。
    fireEvent.click(screen.getByRole('button', { name: '查看执行进度' }));
    expect(callbacks.onBackToThread).toHaveBeenCalledWith(undefined, 'task-1');
    fireEvent.click(screen.getByRole('button', { name: '打开讨论串' }));
    expect(card?.textContent).not.toContain('交给智能体处理');
  });

  test('待审核卡片展示结构化事实与交付摘要，不再提供打开侧边栏的入口按钮', () => {
    const baseOverview = overview();
    const reviewStage = {
      ...baseOverview.stages[0]!,
      id: 'stage-review',
      name: '交付审核',
      goal: '核对本次 Agent 交付的当前文件版本',
      task: { ...baseOverview.stages[0]!.task, id: 'task-review', status: 'in_review' as const },
      aggregateStatus: 'in_review' as const,
    };
    const baseEntry = workspace().entries[0]!;
    const reviewEntry = {
      ...baseEntry,
      task: reviewStage.task,
      stage: reviewStage,
      responsibilityFocus: { kind: 'review_wait' as const, detail: '等待成员审核交付' },
      delivery: {
        ...baseEntry.delivery,
        focusReviewState: 'pending' as const,
        fileReviewApprovedCount: 1,
        fileReviewRequiredCount: 3,
        fileReviewComplete: false,
      },
      review: { reviewerIds: ['reviewer-1'] },
    };

    renderProgress({
      overview: { ...baseOverview, stages: [reviewStage] },
      workspace: { ...workspace(), entries: [reviewEntry] },
      selectedStageId: 'stage-review',
    });

    const card = document.querySelector('[data-smoke="channel-project-stage-card"]');
    expect(card?.getAttribute('aria-current')).toBe('true');
    expect(card?.textContent).toContain('阶段任务 · 审核中');
    expect(card?.textContent).toContain('负责人等待成员审核交付');
    expect(card?.textContent).toContain('建议审核人审核人');
    expect(card?.textContent).toContain('待审核输出');
    expect(card?.textContent).toContain('文件审核 1/3（待补齐）');
    expect(card?.querySelector('ul')).toBeNull();
    expect(card?.textContent).toContain('当前状态：待审核');
    expect(card?.textContent).not.toContain('Agent 已形成');
    // 原型对齐：审核动作内嵌卡片；「查看交付文件与审核」侧边栏入口与提示语移除。
    expect(card?.textContent).not.toContain('查看交付文件与审核');
    expect(card?.textContent).not.toContain('任务卡片只做状态摘要和入口');
    expect(document.querySelector('[data-smoke="task-card-review-entry"]')).toBeNull();
  });

  test('待审核输出按 Server 投影顺序渲染语义列表，并按当前成员版本展示审核态', async () => {
    const longFilename = '这是一份用于验证任务卡片不会被超长文件名撑破的发布方案.md';
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: outputPackageFixture([
        { sequence: 1, shortLabel: 'F1', filename: longFilename, artifactVersionId: 'v-1', collectionId: 'c-1' },
        { sequence: 2, shortLabel: 'F2', filename: '分镜提示词.md', artifactVersionId: 'v-2', collectionId: 'c-2' },
        { sequence: 3, shortLabel: 'F3', filename: '交付说明.md', artifactVersionId: 'v-3', collectionId: 'c-3' },
      ]),
      availableActions: [
        memberAction('c-1', 'v-1', 'approved'),
        memberAction('c-2', 'v-2', 'changes_requested'),
        memberAction('c-3', 'v-old', 'rejected'),
      ],
    });
    const review = reviewProgressFixture('pkg-1');

    renderProgress(review);

    const list = await screen.findByRole('list', { name: '待审核输出文件' });
    expect(list.className).toContain('list-disc');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      `F1 ${longFilename}（已通过）`,
      'F2 分镜提示词.md（要求修改）',
      'F3 交付说明.md',
    ]);
    const longFilenameNode = screen.getByTitle(longFilename);
    expect(longFilenameNode.className).toContain('break-all');
  });

  test('焦点包成员为空时保留交付摘要且不渲染空列表', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true,
      package: outputPackageFixture([]),
      availableActions: [],
    });
    const review = reviewProgressFixture('pkg-empty');

    renderProgress(review);

    await screen.findByText('查看交付文件');
    const card = document.querySelector('[data-smoke="channel-project-stage-card"]');
    expect(card?.textContent).toContain('交付包 2 个 · 文件审核 1/3（待补齐） · 最终版 1/2');
    expect(card?.querySelector('ul')).toBeNull();
  });

  test('零个必需文件时将文件审核展示为不适用', () => {
    const baseOverview = overview();
    const reviewStage = {
      ...baseOverview.stages[0]!,
      task: { ...baseOverview.stages[0]!.task, status: 'in_review' as const },
      aggregateStatus: 'in_review' as const,
    };
    const baseEntry = workspace().entries[0]!;
    const reviewEntry = {
      ...baseEntry,
      task: reviewStage.task,
      stage: reviewStage,
      delivery: {
        ...baseEntry.delivery,
        fileReviewApprovedCount: 0,
        fileReviewRequiredCount: 0,
        fileReviewComplete: true,
        requiredForFinalCount: 0,
        finalizedCount: 0,
      },
      review: { reviewerIds: ['reviewer-1'] },
    };

    renderProgress({
      overview: { ...baseOverview, stages: [reviewStage] },
      workspace: { ...workspace(), entries: [reviewEntry] },
    });

    const card = document.querySelector('[data-smoke="channel-project-stage-card"]');
    expect(card?.textContent).toContain('文件审核不适用（0 个必需文件）');
    expect(card?.textContent).not.toContain('文件审核尚未补齐');
  });

  test('支持创建者、责任焦点、建议/实际审核人与待我审核筛选', () => {
    renderProgress({ workspace: workspace({ includeSecond: true }) });

    const activeLane = () => document.querySelector('[data-smoke="channel-project-lane-active"]')!;

    fireEvent.change(screen.getByLabelText('项目任务创建者'), { target: { value: 'creator-2' } });
    expect(activeLane().textContent).not.toContain('发布准备');
    fireEvent.change(screen.getByLabelText('项目任务创建者'), { target: { value: 'all' } });
    expect(activeLane().textContent).toContain('发布准备');

    fireEvent.change(screen.getByLabelText('项目任务责任焦点'), { target: { value: 'agent-1' } });
    expect(activeLane().textContent).toContain('发布准备');

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'actual:reviewer-1' } });
    expect(activeLane().textContent).toContain('发布准备');

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'pending-me' } });
    expect(screen.getByText('当前筛选下没有项目任务')).toBeTruthy();
  });

  test('待我审核依据当前焦点交付，不受历史审核干扰且不包含尚无交付的任务', () => {
    const current = workspace({ includeSecond: true });
    const historicalReviewWithPendingDelivery = {
      ...current.entries[0]!,
      delivery: { ...current.entries[0]!.delivery, focusReviewState: 'pending' as const },
    };
    renderProgress({
      workspace: { ...current, entries: [historicalReviewWithPendingDelivery, current.entries[1]!] },
    });

    fireEvent.change(screen.getByLabelText('项目任务审核人'), { target: { value: 'pending-me' } });
    const activeLane = document.querySelector('[data-smoke="channel-project-lane-active"]');
    expect(activeLane?.textContent).toContain('发布准备');
    expect(activeLane?.textContent).not.toContain('managed-2');
  });

  test('准确区分 loading、not_ready、无权限和错误', () => {
    const { rerender } = render(<ChannelProjectProgress
      overview={null}
      workspace={null}
      channelId="channel-1"
      participants={participants}
      currentUserId="reviewer-1"
      archived={false}
      state="loading"
      onBackToThread={vi.fn()}
      onViewDeliveryFiles={vi.fn()}
    />);
    expect(screen.getByText('正在加载项目推进事实…')).toBeTruthy();

    rerender(<ChannelProjectProgress
      overview={null}
      workspace={null}
      channelId="channel-1"
      participants={participants}
      currentUserId="reviewer-1"
      archived={false}
      state="not_ready"
      onBackToThread={vi.fn()}
      onViewDeliveryFiles={vi.fn()}
    />);
    expect(screen.getByText('项目推进事实尚未就绪')).toBeTruthy();

    rerender(<ChannelProjectProgress
      overview={null}
      workspace={null}
      channelId="channel-1"
      participants={participants}
      currentUserId="reviewer-1"
      archived={false}
      state="no_permission"
      onBackToThread={vi.fn()}
      onViewDeliveryFiles={vi.fn()}
    />);
    expect(screen.getByText('你没有查看该频道项目事实的权限')).toBeTruthy();

    rerender(<ChannelProjectProgress
      overview={null}
      workspace={null}
      channelId="channel-1"
      participants={participants}
      currentUserId="reviewer-1"
      archived={false}
      state="error"
      errorMessage="读取失败"
      onBackToThread={vi.fn()}
      onViewDeliveryFiles={vi.fn()}
    />);
    expect(screen.getByText('读取失败')).toBeTruthy();
  });

  test('无项目事实时渲染空泳道工作台框架（居中筛选下拉，无手动配置入口）', () => {
    renderProgress({ overview: null, workspace: plainWorkspace() });

    expect(screen.getByLabelText('项目任务创建者')).toBeTruthy();
    expect(screen.getByLabelText('项目任务责任焦点')).toBeTruthy();
    expect(screen.getByLabelText('项目任务审核人')).toBeTruthy();
    expect(screen.getByText('暂无进行中的阶段')).toBeTruthy();
    expect(screen.getByText('暂无待审核交付')).toBeTruthy();
    expect(screen.getByText('暂无已结束阶段')).toBeTruthy();
    expect(screen.queryByText('把频道工作组织成阶段推进')).toBeNull();
    // 设计文档语义：阶段由 Server 写入事实——UI 不提供手动配置入口。
    expect(screen.queryByRole('button', { name: '配置首个项目阶段' })).toBeNull();
    expect(screen.queryByRole('button', { name: '项目设置' })).toBeNull();
  });

  test('按阶段与任务事实投影到三条业务泳道并区分完成与取消', () => {
    const baseOverview = overview();
    const reviewStage = {
      ...baseOverview.stages[0]!,
      id: 'stage-review',
      name: '交付审核',
      task: { ...baseOverview.stages[0]!.task, id: 'task-review', status: 'in_review' as const },
      aggregateStatus: 'in_review' as const,
    };
    const completeStage = {
      ...baseOverview.stages[0]!,
      id: 'stage-complete',
      name: '发布完成',
      task: { ...baseOverview.stages[0]!.task, id: 'task-complete', status: 'done' as const },
      aggregateStatus: 'complete' as const,
    };
    const cancelledStage = {
      ...baseOverview.stages[0]!,
      id: 'stage-cancelled',
      name: '取消发布',
      task: { ...baseOverview.stages[0]!.task, id: 'task-cancelled', status: 'cancelled' as const },
      aggregateStatus: 'in_review' as const,
    };
    const dependencyBlockedStage = {
      ...baseOverview.stages[0]!,
      id: 'stage-dependency-blocked',
      name: '等待前置交付',
      task: { ...baseOverview.stages[0]!.task, id: 'task-dependency-blocked', status: 'done' as const },
      aggregateStatus: 'active' as const,
    };
    const baseWorkspace = workspace();
    const entry = baseWorkspace.entries[0]!;
    renderProgress({
      overview: { ...baseOverview, stages: [baseOverview.stages[0]!, reviewStage, completeStage, cancelledStage, dependencyBlockedStage] },
      workspace: {
        ...baseWorkspace,
        entries: [
          entry,
          { ...entry, task: reviewStage.task, stage: reviewStage, delivery: { ...entry.delivery, focusReviewState: 'pending' } },
          { ...entry, task: completeStage.task, stage: completeStage },
          { ...entry, task: cancelledStage.task, stage: cancelledStage },
          { ...entry, task: dependencyBlockedStage.task, stage: dependencyBlockedStage },
        ],
      },
    });

    expect(document.querySelector('[data-smoke="channel-project-lane-active"]')?.textContent).toContain('发布准备');
    expect(document.querySelector('[data-smoke="channel-project-lane-active"]')?.textContent).toContain('等待前置交付');
    expect(document.querySelector('[data-smoke="channel-project-lane-review"]')?.textContent).toContain('交付审核');
    // 原型对齐：审核动作内嵌卡片；旧侧边栏入口按钮不再渲染。
    expect(document.querySelector('[data-smoke="channel-project-lane-review"]')?.textContent).not.toContain('查看交付文件与审核');
    expect(document.querySelector('[data-smoke="channel-project-lane-complete"]')?.textContent).toContain('发布完成');
    expect(document.querySelector('[data-smoke="channel-project-lane-complete"]')?.textContent).toContain('查看交付与 final');
    expect(document.querySelector('[data-smoke="channel-project-lane-complete"]')?.textContent).toContain('取消发布');
    expect(document.querySelector('[data-smoke="channel-project-lane-complete"]')?.textContent).toContain('阶段任务 · 已取消');
  });

  test('已结束卡「查看交付与 final」定位 Files 逻辑产物视图', () => {
    const baseOverview = overview();
    const completeStage = {
      ...baseOverview.stages[0]!,
      task: { ...baseOverview.stages[0]!.task, status: 'done' as const },
      aggregateStatus: 'complete' as const,
    };
    const entry = workspace().entries[0]!;
    const callbacks = renderProgress({
      overview: { ...baseOverview, stages: [completeStage] },
      workspace: { ...workspace(), entries: [{ ...entry, task: completeStage.task, stage: completeStage }] },
    });

    fireEvent.click(screen.getByRole('button', { name: '查看交付与 final' }));
    expect(callbacks.onViewDeliveryFiles).toHaveBeenCalledWith('task-1');
  });

  test('归档频道仅保留只读徽章，无任何设置入口与运行态写操作', () => {
    renderProgress({ overview: { ...overview(), archived: true }, archived: true });
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看项目设置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '配置首个项目阶段' })).toBeNull();
    expect(screen.queryByRole('button', { name: '项目设置 / 阶段配置' })).toBeNull();
  });

  test('#1179 默认推进面不展示创建阶段、依赖边或底层引用 ID 表单', () => {
    renderProgress();
    expect(screen.queryByText('创建首个项目阶段')).toBeNull();
    expect(screen.queryByText('添加阶段')).toBeNull();
    expect(screen.queryByText('阶段依赖')).toBeNull();
    expect(screen.queryByLabelText('前置阶段')).toBeNull();
    expect(screen.queryByLabelText('产物集合 ID')).toBeNull();
    expect(screen.queryByLabelText('必需输入来源 ID')).toBeNull();
    expect(screen.queryByRole('button', { name: '项目设置 / 阶段配置' })).toBeNull();
  });
});

function reviewProgressFixture(focusPackageId: string) {
  const baseOverview = overview();
  const reviewStage = {
    ...baseOverview.stages[0]!,
    id: 'stage-review',
    name: '交付审核',
    task: { ...baseOverview.stages[0]!.task, id: 'task-review', status: 'in_review' as const },
    aggregateStatus: 'in_review' as const,
  };
  const baseWorkspace = workspace();
  const baseEntry = baseWorkspace.entries[0]!;
  return {
    overview: { ...baseOverview, stages: [reviewStage] },
    workspace: {
      ...baseWorkspace,
      entries: [{
        ...baseEntry,
        task: reviewStage.task,
        stage: reviewStage,
        responsibilityFocus: { kind: 'review_wait' as const, detail: '等待成员审核交付' },
        delivery: {
          ...baseEntry.delivery,
          focusPackageId,
          focusReviewState: 'pending' as const,
          fileReviewApprovedCount: 1,
          fileReviewRequiredCount: 3,
          fileReviewComplete: false,
        },
        review: { reviewerIds: ['reviewer-1'] },
      }],
    },
    selectedStageId: 'stage-review',
  };
}

function outputPackageFixture(members: OutputPackageDto['members']): OutputPackageDto {
  return {
    schemaVersion: 1,
    packageId: 'pkg-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    revision: 1,
    deliveryId: 'delivery-1',
    publishId: 'publish-1',
    workspaceRevisionId: 'workspace-revision-1',
    agentId: 'agent-1',
    taskId: 'task-review',
    taskBinding: 'managed',
    taskAttempt: 1,
    members,
    memberCount: members.length,
    status: 'recorded',
    createdAt: 1_786_000_000_000,
  } as OutputPackageDto;
}

function memberAction(
  collectionId: string,
  versionId: string,
  reviewState: PackageMemberAvailableActionsDto['reviewState'],
): PackageMemberAvailableActionsDto {
  return {
    collectionId,
    versionId,
    reviewState,
    isFinalVersion: false,
    collectionRevision: 1,
    actions: [],
  };
}

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
