// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChannelProjectOverviewDto, ProjectArtifactLibraryDto } from '@agentbean/contracts';

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
    expect(screen.queryByLabelText('项目设置')).toBeNull();
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
    expect(screen.getByLabelText('项目设置')).toBeTruthy();
    expect(screen.getByText('发布准备')).toBeTruthy();
    expect(screen.getByText('完成发布方案')).toBeTruthy();
    expect(screen.getByText('待开始')).toBeTruthy();
    expect(screen.getByText('绑定任务尚未开始')).toBeTruthy();
    expect(screen.getByText('已归档 · 只读')).toBeTruthy();
    expect(screen.getByText('审核人')).toBeTruthy();
  });

  test('#1179 已有阶段时可添加后续阶段，且不把配置表单混入运行态字段之外的入口', async () => {
    const onCreateStage = vi.fn(async () => null);
    render(
      <ChannelProjectOverview
        overview={{ ...overview(), archived: false }}
        tasks={[
          { id: 'task-1', title: '完成发布方案' },
          { id: 'task-2', title: '完成分镜' },
        ]}
        participants={[
          { id: 'owner-1', name: '项目负责人', kind: 'human' },
          { id: 'reviewer-1', name: '审核人', kind: 'human' },
        ]}
        currentUserId="owner-1"
        onCreateStage={onCreateStage}
        onCreateEdge={vi.fn()}
      />,
    );
    expect(screen.getByText('项目阶段配置')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加阶段' }));
    fireEvent.change(screen.getByLabelText('阶段名称'), { target: { value: '分镜' } });
    fireEvent.change(screen.getByLabelText('阶段目标'), { target: { value: '完成分镜稿' } });
    fireEvent.change(screen.getByLabelText('绑定任务'), { target: { value: 'task-2' } });
    fireEvent.change(screen.getByLabelText('验收标准（每行一条）'), { target: { value: '分镜完整' } });
    fireEvent.click(screen.getByRole('button', { name: '创建阶段' }));

    await waitFor(() => expect(onCreateStage).toHaveBeenCalledWith({
      name: '分镜',
      goal: '完成分镜稿',
      ownerId: 'owner-1',
      reviewerIds: ['reviewer-1'],
      acceptanceCriteria: ['分镜完整'],
      taskId: 'task-2',
    }));
  });

  test('#1179 归档频道不提供添加阶段入口', () => {
    render(
      <ChannelProjectOverview
        overview={overview()}
        tasks={[
          { id: 'task-1', title: '完成发布方案' },
          { id: 'task-2', title: '完成分镜' },
        ]}
        participants={[{ id: 'owner-1', name: '项目负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreateStage={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '添加阶段' })).toBeNull();
  });

  test('#824 阶段详情展示审核状态、当前版与最终版', () => {
    render(
      <ChannelProjectOverview
        overview={overview()}
        artifactLibrary={{
          archived: false,
          collections: [{
            id: 'collection-1',
            name: '发布方案',
            currentVersionId: 'version-1',
            finalVersionId: 'version-1',
            versions: [{
              id: 'version-1',
              source: { stageId: 'stage-1' },
              versionNumber: 2,
              reviewState: 'approved',
            }],
          }],
        } as ProjectArtifactLibraryDto}
        tasks={[]}
        participants={[
          { id: 'owner-1', name: '项目负责人', kind: 'human' },
          { id: 'reviewer-1', name: '审核人', kind: 'human' },
        ]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('阶段产物（1）'));
    expect(screen.getByText('发布方案 · v2 · 已通过 · 当前版 · 最终版')).toBeTruthy();
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

  test('#822 展示前置阶段、依赖满足情况、缺失必需输入与阻塞原因', () => {
    render(
      <ChannelProjectOverview
        overview={twoStageOverview({ upstreamDone: false })}
        tasks={[]}
        participants={[{ id: 'owner-1', name: '负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
        onCreateEdge={vi.fn()}
        onDeleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByTestId('stage-upstream-stage-down').textContent).toContain('剧本');
    expect(screen.getByTestId('stage-upstream-stage-down').textContent).toContain('依赖未满足');
    expect(screen.getByTestId('stage-missing-inputs-stage-down').textContent).toContain('剧本终稿');
    expect(screen.getByTestId('stage-blocking-stage-down').textContent).toContain('前置阶段尚未完成');
    expect(screen.getByTestId('stage-blocking-stage-down').textContent).toContain('缺少必需输入');
    expect(screen.getByTestId('stage-execution-blocked-stage-down')).toBeTruthy();
    expect(screen.getByTestId('stage-edge-edge-1').textContent).toContain('剧本 → 分镜');
  });

  test('#822 依赖满足后不再展示阻塞提示', () => {
    render(
      <ChannelProjectOverview
        overview={twoStageOverview({ upstreamDone: true })}
        tasks={[]}
        participants={[{ id: 'owner-1', name: '负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
        onCreateEdge={vi.fn()}
        onDeleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByTestId('stage-upstream-stage-down').textContent).toContain('依赖已满足');
    expect(screen.queryByTestId('stage-missing-inputs-stage-down')).toBeNull();
    expect(screen.queryByTestId('stage-execution-blocked-stage-down')).toBeNull();
  });

  test('#822 项目负责人可以提交新的 Stage edge 与必需输入规则', async () => {
    const onCreateEdge = vi.fn(async () => null);
    render(
      <ChannelProjectOverview
        overview={twoStageOverview({ upstreamDone: true, edges: [] })}
        tasks={[]}
        participants={[{ id: 'owner-1', name: '负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
        onCreateEdge={onCreateEdge}
        onDeleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByTestId('stage-edges-empty')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('前置阶段'), { target: { value: 'stage-up' } });
    fireEvent.change(screen.getByLabelText('后续阶段'), { target: { value: 'stage-down' } });
    fireEvent.change(screen.getByLabelText('项目语义'), { target: { value: 'blocks_start' } });
    fireEvent.change(screen.getByLabelText('必需输入'), { target: { value: '剧本终稿' } });
    fireEvent.change(screen.getByLabelText('必需输入来源 ID'), { target: { value: 'collection-script' } });
    fireEvent.click(screen.getByRole('button', { name: '添加必需输入' }));
    fireEvent.change(screen.getByLabelText('必需输入 2'), { target: { value: '制片说明' } });
    fireEvent.change(screen.getByLabelText('必需输入类型 2'), { target: { value: 'document' } });
    fireEvent.change(screen.getByLabelText('必需输入来源 ID 2'), { target: { value: 'bundle-production' } });
    fireEvent.click(screen.getByRole('button', { name: '添加依赖' }));

    await waitFor(() => expect(onCreateEdge).toHaveBeenCalledWith({
      upstreamStageId: 'stage-up',
      downstreamStageId: 'stage-down',
      semantics: 'blocks_start',
      requiredInputs: [
        {
          key: 'artifact-1',
          kind: 'artifact',
          label: '剧本终稿',
          source: {
            kind: 'artifact_collection',
            collectionId: 'collection-script',
            versionPolicy: 'final',
          },
        },
        {
          key: 'document-2',
          kind: 'document',
          label: '制片说明',
          source: {
            kind: 'document_bundle',
            bundleId: 'bundle-production',
          },
        },
      ],
    }));
  });

  test('#822 归档频道可读依赖图但不提供增删入口', () => {
    render(
      <ChannelProjectOverview
        overview={{ ...twoStageOverview({ upstreamDone: true }), archived: true }}
        tasks={[]}
        participants={[{ id: 'owner-1', name: '负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
        onCreateEdge={vi.fn()}
        onDeleteEdge={vi.fn()}
      />,
    );
    expect(screen.getByTestId('stage-edge-edge-1')).toBeTruthy();
    expect(screen.getByTestId('stage-edges-readonly')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加依赖' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除依赖 edge-1' })).toBeNull();
  });

  test('#822 删除依赖会回传边身份', async () => {
    const onDeleteEdge = vi.fn(async () => null);
    render(
      <ChannelProjectOverview
        overview={twoStageOverview({ upstreamDone: true })}
        tasks={[]}
        participants={[{ id: 'owner-1', name: '负责人', kind: 'human' }]}
        currentUserId="owner-1"
        onCreate={vi.fn()}
        onCreateEdge={vi.fn()}
        onDeleteEdge={onDeleteEdge}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除依赖 edge-1' }));
    await waitFor(() => expect(onDeleteEdge).toHaveBeenCalledWith('edge-1'));
  });
});

function selectMultiple(element: HTMLElement, values: string[]): void {
  const select = element as HTMLSelectElement;
  for (const option of select.options) option.selected = values.includes(option.value);
  fireEvent.change(select);
}

/** #822 两阶段依赖投影 fixture：上游「剧本」→ 下游「分镜」，边声明一条必需输入。 */
function twoStageOverview(options: {
  upstreamDone: boolean;
  edges?: ChannelProjectOverviewDto['edges'];
}): ChannelProjectOverviewDto {
  const base = overview();
  const requiredInputs = [{
    key: 'artifact-1',
    kind: 'artifact' as const,
    label: '剧本终稿',
    source: {
      kind: 'artifact_collection' as const,
      collectionId: 'collection-script',
      versionPolicy: 'final' as const,
    },
  }];
  const edges = options.edges ?? [{
    id: 'edge-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    upstreamStageId: 'stage-up',
    downstreamStageId: 'stage-down',
    upstreamTaskId: 'task-up',
    downstreamTaskId: 'task-down',
    semantics: 'blocks_start' as const,
    requiredInputs,
    createdBy: 'owner-1',
    createdAt: 1,
    updatedAt: 1,
  }];
  const stageTemplate = base.stages[0] as ChannelProjectOverviewDto['stages'][number];
  const blocked = edges.length > 0 && !options.upstreamDone;
  return {
    ...base,
    archived: false,
    edges,
    stages: [
      {
        ...stageTemplate,
        id: 'stage-up',
        name: '剧本',
        task: { ...stageTemplate.task, id: 'task-up', title: '完成剧本', status: options.upstreamDone ? 'done' : 'todo' },
        aggregateStatus: options.upstreamDone ? 'complete' : 'pending',
        blockingReasons: [],
        upstreamStageIds: [],
        dependenciesSatisfied: true,
        missingRequiredInputs: [],
        executionAllowed: true,
      },
      {
        ...stageTemplate,
        id: 'stage-down',
        name: '分镜',
        task: { ...stageTemplate.task, id: 'task-down', title: '完成分镜', status: 'todo' },
        aggregateStatus: 'pending',
        blockingReasons: blocked
          ? [
            { code: 'stage_dependency_incomplete', taskId: 'task-down', upstreamStageId: 'stage-up', edgeId: 'edge-1' },
            { code: 'required_input_missing', taskId: 'task-down', upstreamStageId: 'stage-up', edgeId: 'edge-1', requiredInputKey: 'artifact-1' },
          ]
          : [],
        upstreamStageIds: edges.length > 0 ? ['stage-up'] : [],
        dependenciesSatisfied: !blocked,
        missingRequiredInputs: blocked
          ? [{ edgeId: 'edge-1', upstreamStageId: 'stage-up', ...requiredInputs[0] as typeof requiredInputs[number] }]
          : [],
        executionAllowed: !blocked,
      },
    ],
  };
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
      taskRevision: 1,
      aggregateStatus: 'pending',
      blockingReasons: [{ code: 'task_not_started', taskId: 'task-1' }],
      upstreamStageIds: [],
      dependenciesSatisfied: true,
      missingRequiredInputs: [],
      executionAllowed: true,
      advance: {
        kind: 'waiting',
        automatic: true,
        reason: 'task_not_pending',
        stableInputs: [],
        candidateAgentIds: [],
        taskRevision: 1,
        stageTaskRevision: 1,
        coordinationTaskRevision: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    }],
    edges: [],
  };
}
