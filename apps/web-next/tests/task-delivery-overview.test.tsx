// @vitest-environment jsdom

/**
 * #1065 AC3/AC4 Task 交付视图组件。
 *
 * 只消费 Server task:delivery-overview 单一投影——责任焦点、stage 目标/依赖、
 * acceptance contract、当前交付、availableActions(可发现性,不授权)与执行链时间线;
 * 文本标签齐全(不只依赖颜色/图标,AC11);加载/错误态有文本反馈。
 */
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  queryTaskDeliveryOverview: vi.fn(),
  onUpdated: vi.fn(),
  onArtifactsUpdated: vi.fn(),
  onSnapshot: vi.fn(),
  acceptRootDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    queryTaskDeliveryOverview: mocks.queryTaskDeliveryOverview,
    onUpdated: mocks.onUpdated,
    onArtifactsUpdated: mocks.onArtifactsUpdated,
  }),
  taskEvents: () => ({
    onSnapshot: mocks.onSnapshot,
    acceptRootDelivery: mocks.acceptRootDelivery,
  }),
}));

import { TaskDeliveryOverview } from '../components/TaskDeliveryOverview';
import type { TaskDeliveryOverviewV1 } from '@agentbean/contracts';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  mocks.onUpdated.mockReturnValue(() => {});
  mocks.onArtifactsUpdated.mockReturnValue(() => {});
  mocks.onSnapshot.mockReturnValue(() => {});
});

const overviewFixture: TaskDeliveryOverviewV1 = {
  schemaVersion: 1,
  taskId: 'task-1',
  channelId: 'ch-1',
  task: {
    id: 'task-1', teamId: 'team-1', title: '交付文档', description: '', status: 'in_review',
    creatorId: 'u-1', tags: [], sortOrder: 0, createdAt: 100, updatedAt: 200,
  },
  acceptanceContract: {
    nodeKind: 'root',
    reviewPolicy: 'human',
    humanAcceptanceAuthorityIds: ['u-1'],
    requiresHumanAcceptance: true,
    acceptanceCriteria: ['文档可读'],
    taskRevision: 1,
    attempt: 1,
    maxAttempts: 3,
    requiredReviewCoverage: { requiredForFinalCount: 1, finalizedCount: 1, complete: true },
  },
  responsibilityFocus: {
    kind: 'review_wait',
    detail: '等待人类验收/审核交付',
  },
  delivery: {
    packages: [
      {
        schemaVersion: 1, packageId: 'pkg-1', teamId: 'team-1', channelId: 'ch-1', revision: 1,
        deliveryId: 'del-1', publishId: 'pub-1', workspaceRevisionId: 'rev-1', agentId: 'agent-1',
        taskId: 'task-1', taskBinding: 'managed', taskRevision: 1, taskAttempt: 1,
        memberCount: 2, reviewState: 'pending', status: 'recorded', createdAt: 300,
      },
    ],
    pendingDeliveries: [],
    focusPackageId: 'pkg-1',
  },
  availableActions: [
    { action: 'open-task', label: '打开 Task' },
    { action: 'delegate-to-agent', label: '交给 Agent 处理' },
  ],
  timeline: [
    { id: 'offer-1', kind: 'offer', at: 100, actorKind: 'system', summary: '向 Agent「Agent-A」发布工作 Offer' },
    { id: 'delivery-1', kind: 'delivery', at: 300, actorKind: 'system', summary: '交付文件包形成(2 个文件)' },
  ],
  asOf: 400,
  audienceScope: 'team-1:ch-1:u-1',
  consistencyToken: { schemaVersion: 1, entries: [] },
};

describe('TaskDeliveryOverview(#1065 AC3/AC4)', () => {
  test('项目、产物或任务事实更新时重新读取 Server 投影', async () => {
    let artifactRefresh: (() => void) | undefined;
    let taskRefresh: ((tasks: Array<{ id: string; channelId?: string }>) => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId, handler) => {
      artifactRefresh = handler;
      return () => {};
    });
    mocks.onSnapshot.mockImplementation((handler) => {
      taskRefresh = handler;
      return () => {};
    });
    mocks.queryTaskDeliveryOverview.mockResolvedValue({ ok: true, overview: overviewFixture });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => expect(mocks.queryTaskDeliveryOverview).toHaveBeenCalledTimes(1));

    artifactRefresh?.();
    await vi.waitFor(() => expect(mocks.queryTaskDeliveryOverview).toHaveBeenCalledTimes(2));
    taskRefresh?.([{ id: 'task-1', channelId: 'ch-1' }]);
    await vi.waitFor(() => expect(mocks.queryTaskDeliveryOverview).toHaveBeenCalledTimes(3));
  });

  test('渲染责任焦点/验收约定/当前交付/availableActions/执行链(文本标签)', async () => {
    mocks.queryTaskDeliveryOverview.mockResolvedValue({ ok: true, overview: overviewFixture });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-delivery-overview"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="task-focus-detail"]')?.textContent).toContain('等待人类验收/审核交付');
    expect(document.querySelector('[data-smoke="task-acceptance-contract"]')?.textContent).toContain('需要人类验收');
    expect(document.querySelector('[data-smoke="task-acceptance-contract"]')?.textContent).toContain('文档可读');
    expect(document.querySelector('[data-smoke="task-delivery"]')?.textContent).toContain('文件包 2 个文件');
    expect(document.querySelector('[data-smoke="task-available-actions"]')?.textContent).toContain('打开 Task');
    expect(document.querySelector('[data-smoke="task-timeline"]')?.textContent).toContain('发布 Offer');
    expect(document.querySelector('[data-smoke="task-timeline"]')?.textContent).toContain('交付文件包形成');
  });

  test('stage 目标与依赖状态来自 Server 投影', async () => {
    mocks.queryTaskDeliveryOverview.mockResolvedValue({
      ok: true,
      overview: {
        ...overviewFixture,
        stage: {
          id: 'stage-1', teamId: 'team-1', channelId: 'ch-1', name: '文档', goal: '产出交付文档',
          ownerId: 'u-1', reviewerIds: [], acceptanceCriteria: [], task: overviewFixture.task,
          taskRevision: 1, aggregateStatus: 'blocked', blockingReasons: [],
          upstreamStageIds: [], dependenciesSatisfied: false,
          missingRequiredInputs: [{ key: 'in-1', kind: 'artifact', label: '上游产物', edgeId: 'e-1', upstreamStageId: 'stage-0' }],
          executionAllowed: false, advance: { kind: 'waiting', automatic: false, stableInputs: [], candidateAgentIds: [], taskRevision: 1, stageTaskRevision: 1 },
          createdAt: 100, updatedAt: 100,
        },
      },
    });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-stage"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-smoke="task-stage"]')?.textContent).toContain('产出交付文档');
    expect(document.querySelector('[data-smoke="task-stage"]')?.textContent).toContain('前置依赖未全部满足');
    expect(document.querySelector('[data-smoke="task-stage"]')?.textContent).toContain('上游产物');
  });

  test('availableActions 可发现性:disabled 动作显示文本原因,点击回调 action', async () => {
    mocks.queryTaskDeliveryOverview.mockResolvedValue({
      ok: true,
      overview: {
        ...overviewFixture,
        responsibilityFocus: { kind: 'none', detail: '等待分配' },
        availableActions: [
          { action: 'open-task', label: '打开 Task' },
          { action: 'delegate-to-agent', label: '交给 Agent 处理', disabled: true, disabledReason: '暂无交付文件包' },
          { action: 'review-package', label: '审核交付包' },
        ],
      },
    });
    const onAction = vi.fn();
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" onAction={onAction} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-available-actions"]')).not.toBeNull();
    });
    const text = document.querySelector('[data-smoke="task-available-actions"]')!.textContent ?? '';
    expect(text).toContain('暂无交付文件包');
    const reviewButton = document.querySelector('[data-smoke="task-action-review-package"]')!;
    fireEvent.click(reviewButton);
    expect(onAction).toHaveBeenCalledWith({ action: 'review-package', label: '审核交付包' });
  });

  test('验收动作先确认，再以投影 revision 提交具名 command 并刷新投影', async () => {
    let refreshProjection: (() => void) | undefined;
    mocks.onArtifactsUpdated.mockImplementation((_channelId, handler) => {
      refreshProjection = handler;
      return () => {};
    });
    mocks.queryTaskDeliveryOverview.mockResolvedValueOnce({
      ok: true,
      overview: {
        ...overviewFixture,
        availableActions: [{ action: 'accept-delivery', label: '验收本次交付' }],
      },
    }).mockResolvedValue({
      ok: true,
      overview: {
        ...overviewFixture,
        acceptanceContract: {
          ...overviewFixture.acceptanceContract,
          taskRevision: 2,
        },
        availableActions: [{ action: 'accept-delivery', label: '验收本次交付' }],
      },
    });
    mocks.acceptRootDelivery.mockResolvedValue({ ok: true });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-action-accept-delivery"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-smoke="task-action-accept-delivery"]')!);
    expect(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"]')).not.toBeNull();
    expect(mocks.acceptRootDelivery).not.toHaveBeenCalled();

    refreshProjection?.();
    await vi.waitFor(() => expect(mocks.queryTaskDeliveryOverview).toHaveBeenCalledTimes(2));

    fireEvent.click(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"] button:last-child')!);
    await vi.waitFor(() => expect(mocks.acceptRootDelivery).toHaveBeenCalledWith({
      taskId: 'task-1',
      expectedTaskRevision: 1,
    }));
    await vi.waitFor(() => expect(mocks.queryTaskDeliveryOverview).toHaveBeenCalledTimes(3));
    expect(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"]')).toBeNull();
  });

  test('Server 禁用的验收动作不会打开确认对话框', async () => {
    mocks.queryTaskDeliveryOverview.mockResolvedValue({
      ok: true,
      overview: {
        ...overviewFixture,
        availableActions: [{
          action: 'accept-delivery',
          label: '验收本次交付',
          disabled: true,
          disabledReason: '还有文件未通过审核',
        }],
      },
    });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-action-accept-delivery"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-smoke="task-action-accept-delivery"]')!);
    expect(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"]')).toBeNull();
    expect(mocks.acceptRootDelivery).not.toHaveBeenCalled();
  });

  test('切换 Task 身份时清除已冻结的验收目标', async () => {
    mocks.queryTaskDeliveryOverview.mockResolvedValue({
      ok: true,
      overview: {
        ...overviewFixture,
        availableActions: [{ action: 'accept-delivery', label: '验收本次交付' }],
      },
    });
    const { rerender } = render(
      <TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />,
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-action-accept-delivery"]')).not.toBeNull();
    });
    fireEvent.click(document.querySelector('[data-smoke="task-action-accept-delivery"]')!);
    expect(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"]')).not.toBeNull();

    rerender(<TaskDeliveryOverview teamId="team-1" channelId="ch-2" taskId="task-2" />);
    expect(document.querySelector('[data-smoke="task-action-accept-delivery"]')).toBeNull();
    expect(document.querySelector('[data-smoke="task-delivery-loading"]')).not.toBeNull();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-delivery-acceptance-dialog"]')).toBeNull();
    });
    expect(mocks.acceptRootDelivery).not.toHaveBeenCalled();
  });

  test('加载与错误态有文本反馈', async () => {
    mocks.queryTaskDeliveryOverview.mockReturnValue(new Promise(() => undefined));
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    expect(document.querySelector('[data-smoke="task-delivery-loading"]')?.textContent).toContain('正在读取交付视图');
    cleanup();
    vi.clearAllMocks();

    mocks.queryTaskDeliveryOverview.mockResolvedValue({ ok: false, error: 'PROJECTION_NOT_READY', message: '交付视图暂不可用' });
    render(<TaskDeliveryOverview teamId="team-1" channelId="ch-1" taskId="task-1" />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-smoke="task-delivery-error"]')?.textContent).toContain('交付视图暂不可用');
    });
  });
});
