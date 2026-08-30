import { describe, expect, test } from 'vitest';
import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

import {
  channelTaskEntrySubview,
  channelTaskHasProjectFacts,
  channelTaskResponsibilityFocusFilterValue,
  channelTasksHistoryMode,
  matchingChannelTaskStageId,
} from '../lib/channel-task-workspace-route';

describe('频道 Tasks 路由与 Server 事实分流', () => {
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

  test('打开任务写入浏览历史', () => {
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

  test('责任焦点筛选值来自 Server responsibilityFocus 投影，缺省回落 unassigned', () => {
    const plainEntry = entry({ mode: 'plain', withStage: false });
    const agentEntry: ChannelTaskWorkspaceEntryV1 = {
      ...plainEntry,
      responsibilityFocus: { kind: 'agent', agentId: 'agent-1', detail: '执行中' },
    };
    const reviewWaitEntry: ChannelTaskWorkspaceEntryV1 = {
      ...plainEntry,
      responsibilityFocus: { kind: 'review_wait', detail: '等待审核' },
    };

    expect(channelTaskResponsibilityFocusFilterValue(undefined)).toBe('unassigned');
    expect(channelTaskResponsibilityFocusFilterValue(plainEntry)).toBe('unassigned');
    expect(channelTaskResponsibilityFocusFilterValue(agentEntry)).toBe('agent-1');
    expect(channelTaskResponsibilityFocusFilterValue(reviewWaitEntry)).toBe('review_wait');
  });

  test('普通 Task 只有 Server 已投影责任、交付或审核事实才算项目事实', () => {
    const plainEntry = entry({ mode: 'plain', withStage: false });

    expect(channelTaskHasProjectFacts(undefined)).toBe(false);
    expect(channelTaskHasProjectFacts(plainEntry)).toBe(false);
    // assignee、tag 和 status 不是项目事实。
    expect(plainEntry.task.assigneeId).toBe('agent-legacy');
    expect(channelTaskHasProjectFacts(entry({ mode: 'managed', withStage: false }))).toBe(true);
    expect(channelTaskHasProjectFacts(entry({ mode: 'plain', withStage: true }))).toBe(true);
    expect(channelTaskHasProjectFacts({
      ...plainEntry,
      responsibilityFocus: { kind: 'agent', agentId: 'agent-1', detail: '执行中' },
    })).toBe(true);
    expect(channelTaskHasProjectFacts({
      ...plainEntry,
      delivery: { ...plainEntry.delivery, packageCount: 1 },
    })).toBe(true);
    expect(channelTaskHasProjectFacts({
      ...plainEntry,
      review: { reviewerIds: ['user-1'] },
    })).toBe(true);
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
    delivery: { packageCount: 0, pendingDeliveryCount: 0, requiredForFinalCount: 0, finalizedCount: 0 },
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
