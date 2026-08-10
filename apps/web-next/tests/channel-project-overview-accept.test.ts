import { describe, expect, test } from 'vitest';
import type { ChannelProjectOverviewDto } from '@agentbean/contracts';

import { acceptChannelProjectOverview } from '../lib/channel-project-overview';

describe('acceptChannelProjectOverview (#1179)', () => {
  test('空当前状态直接接受入站快照', () => {
    const next = overview({ revision: 1, updatedAt: 10 });
    expect(acceptChannelProjectOverview(undefined, next)).toBe(next);
    expect(acceptChannelProjectOverview(null, next)).toBe(next);
  });

  test('入站 null 在尚无本地画像时采纳，已有画像时忽略 stale null', () => {
    expect(acceptChannelProjectOverview(undefined, null)).toBeNull();
    expect(acceptChannelProjectOverview(null, null)).toBeNull();
    const current = overview({ revision: 2, updatedAt: 20 });
    expect(acceptChannelProjectOverview(current, null)).toBe(current);
  });

  test('旧 revision 不能覆盖新配置', () => {
    const current = overview({ revision: 3, updatedAt: 30, stageName: '新阶段' });
    const stale = overview({ revision: 2, updatedAt: 99, stageName: '旧阶段' });
    expect(acceptChannelProjectOverview(current, stale)).toBe(current);
  });

  test('更高 revision 替换当前快照', () => {
    const current = overview({ revision: 2, updatedAt: 20, stageName: '旧阶段' });
    const next = overview({ revision: 3, updatedAt: 10, stageName: '新阶段' });
    expect(acceptChannelProjectOverview(current, next)).toBe(next);
  });

  test('同 revision 取 updatedAt 较新的快照', () => {
    const current = overview({ revision: 2, updatedAt: 20, stageName: '较早' });
    const next = overview({ revision: 2, updatedAt: 40, stageName: '较新' });
    const older = overview({ revision: 2, updatedAt: 10, stageName: '更早' });
    expect(acceptChannelProjectOverview(current, next)).toBe(next);
    expect(acceptChannelProjectOverview(current, older)).toBe(current);
  });

  test('不同频道的入站快照替换当前状态', () => {
    const current = overview({ revision: 5, updatedAt: 50, channelId: 'channel-a' });
    const next = overview({ revision: 1, updatedAt: 1, channelId: 'channel-b' });
    expect(acceptChannelProjectOverview(current, next)).toBe(next);
  });
});

function overview(options: {
  revision: number;
  updatedAt: number;
  stageName?: string;
  channelId?: string;
}): ChannelProjectOverviewDto {
  return {
    archived: false,
    profile: {
      id: 'profile-1',
      teamId: 'team-1',
      channelId: options.channelId ?? 'channel-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      revision: options.revision,
      createdBy: 'owner-1',
      createdAt: 1,
      updatedAt: options.updatedAt,
    },
    stages: [{
      id: 'stage-1',
      teamId: 'team-1',
      channelId: options.channelId ?? 'channel-1',
      name: options.stageName ?? '阶段',
      goal: '目标',
      ownerId: 'owner-1',
      reviewerIds: ['reviewer-1'],
      acceptanceCriteria: ['标准'],
      task: {
        id: 'task-1',
        teamId: 'team-1',
        channelId: options.channelId ?? 'channel-1',
        title: '任务',
        status: 'todo',
        creatorId: 'owner-1',
        tags: [],
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      taskRevision: 1,
      aggregateStatus: 'pending',
      blockingReasons: [],
      upstreamStageIds: [],
      dependenciesSatisfied: true,
      missingRequiredInputs: [],
      executionAllowed: true,
      advance: {
        kind: 'waiting',
        automatic: false,
        stableInputs: [],
        candidateAgentIds: [],
        taskRevision: 1,
        stageTaskRevision: 1,
      },
      createdAt: 1,
      updatedAt: options.updatedAt,
    }],
    edges: [],
  };
}
