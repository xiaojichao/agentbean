import { describe, expect, test } from 'vitest';
import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

import {
  channelTaskEntrySubview,
  channelTasksHistoryMode,
  channelTasksRouteParams,
  matchingChannelTaskStageId,
  parseChannelTasksSubview,
  resolveChannelTasksSubview,
} from '../lib/channel-task-workspace-route';

describe('频道 Tasks 路由与 Server 事实分流', () => {
  test('有阶段时默认项目推进，无阶段时默认普通任务', () => {
    expect(resolveChannelTasksSubview(undefined, true)).toBe('project');
    expect(resolveChannelTasksSubview(undefined, false)).toBe('plain');
    expect(resolveChannelTasksSubview('plain', true)).toBe('plain');
    expect(parseChannelTasksSubview('unknown')).toBeUndefined();
  });

  test('仅按 Server governance/stage 投影分流，不使用负责人、标签或状态猜测', () => {
    const plain = entry({ mode: 'plain', withStage: false });
    const managed = entry({ mode: 'managed', withStage: false });
    const staged = entry({ mode: 'plain', withStage: true });

    expect(plain.task.assigneeId).toBe('agent-legacy');
    expect(plain.task.tags).toContain('项目');
    expect(plain.task.status).toBe('in_progress');
    expect(channelTaskEntrySubview(plain)).toBe('plain');
    expect(channelTaskEntrySubview(managed)).toBe('project');
    expect(channelTaskEntrySubview(staged)).toBe('project');
  });

  test('URL 同时保留 Tasks 子视图、stage 与 canonical task，切到普通任务会清理项目选中态', () => {
    const selected = channelTasksRouteParams(new URLSearchParams('message=message-1'), {
      view: 'project',
      stageId: 'stage-1',
      taskId: 'task-1',
    });
    expect(selected.get('chatTab')).toBe('tasks');
    expect(selected.get('tasksView')).toBe('project');
    expect(selected.get('stage')).toBe('stage-1');
    expect(selected.get('task')).toBe('task:task-1');
    expect(selected.has('message')).toBe(false);

    const plain = channelTasksRouteParams(selected, { view: 'plain' });
    expect(plain.get('tasksView')).toBe('plain');
    expect(plain.has('stage')).toBe(false);
    expect(plain.has('task')).toBe(false);
  });

  test('默认视图规范化不污染历史，用户主动切换和打开任务写入浏览历史', () => {
    expect(channelTasksHistoryMode('resolve_default')).toBe('replace');
    expect(channelTasksHistoryMode('select_subview')).toBe('push');
    expect(channelTasksHistoryMode('open_task')).toBe('push');
  });

  test('只向实际绑定所选阶段的任务传递阶段上下文', () => {
    const staged = entry({ mode: 'managed', withStage: true });
    const plain = entry({ mode: 'plain', withStage: false });

    expect(matchingChannelTaskStageId(staged, 'stage-1')).toBe('stage-1');
    expect(matchingChannelTaskStageId(staged, 'stage-other')).toBeNull();
    expect(matchingChannelTaskStageId(plain, 'stage-1')).toBeNull();
    expect(matchingChannelTaskStageId(undefined, 'stage-1')).toBeNull();
  });
});

function entry(options: { mode: 'plain' | 'managed'; withStage: boolean }): ChannelTaskWorkspaceEntryV1 {
  const task: ChannelTaskWorkspaceEntryV1['task'] = {
    id: 'task-1', teamId: 'team-1', channelId: 'channel-1', title: '准备发布',
    status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-legacy', tags: ['项目'],
    sortOrder: 1, createdAt: 1, updatedAt: 2,
  };
  return {
    schemaVersion: 1,
    task,
    governance: {
      mode: options.mode,
      sources: options.mode === 'managed' ? ['task_coordination'] : [],
      allowDirectStatusMutation: options.mode === 'plain',
      allowDirectAssigneeMutation: options.mode === 'plain',
      allowDirectDelete: options.mode === 'plain',
    },
    responsibilityFocus: { kind: 'none', detail: '尚未产生责任' },
    delivery: { packageCount: 0, pendingDeliveryCount: 0 },
    review: { reviewerIds: [] },
    ...(options.withStage ? {
      stage: {
        id: 'stage-1', teamId: 'team-1', channelId: 'channel-1', name: '发布', goal: '完成发布',
        ownerId: 'user-1', reviewerIds: [], acceptanceCriteria: [], task, taskRevision: 1,
        aggregateStatus: 'active', blockingReasons: [], upstreamStageIds: [], dependenciesSatisfied: true,
        missingRequiredInputs: [], executionAllowed: true,
        advance: {
          kind: 'waiting', automatic: false, stableInputs: [], candidateAgentIds: [],
          taskRevision: 1, stageTaskRevision: 1,
        },
        createdAt: 1, updatedAt: 2,
      },
    } : {}),
  };
}
