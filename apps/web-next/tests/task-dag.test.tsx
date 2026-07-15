// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { TaskDagViewDto } from '@agentbean/contracts';
import { TaskDagPanel } from '../components/TaskDagPanel';
import { acceptTaskDagSnapshot } from '../lib/task-dag';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

afterEach(cleanup);

describe('Task DAG Web surface', () => {
  test('rejects a late snapshot before it can overwrite a newer graph revision', () => {
    const current = snapshot(3, 4, 40);
    expect(acceptTaskDagSnapshot(current, snapshot(2, 9, 90))).toBe(current);
    expect(acceptTaskDagSnapshot(current, snapshot(3, 5, 50))).toMatchObject({ nodes: [{ taskRevision: 5 }] });
    expect(acceptTaskDagSnapshot(current, snapshot(3, 4, 39))).toBe(current);
  });

  test('shows dependency, claim, attempt, acceptance and raw result while events stay collapsed', () => {
    const dag = snapshot(3, 4, 40);
    render(<TaskDagPanel dag={dag} teamPath="team" />);
    expect(screen.getByText('Task DAG')).toBeTruthy();
    expect(screen.getByText(/attempt 2\/3/)).toBeTruthy();
    expect(screen.getByText(/依赖：task-root/)).toBeTruthy();
    expect(screen.getByText(/agent-1 · active/)).toBeTruthy();
    expect(screen.getByText(/验收：accepted/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '原始回复' }).getAttribute('href'))
      .toBe('/team/channel/channel-1?message=channel-1%3Amessage-result');
    expect(screen.getByText(/协作轨迹（默认折叠，1）/).closest('details')?.hasAttribute('open')).toBe(false);
    expect(screen.getByText(/agent-1 → agent-2/)).toBeTruthy();
    expect(screen.getByText(/管理事件（默认折叠/).closest('details')?.hasAttribute('open')).toBe(false);
  });
});

function snapshot(graphRevision: number, taskRevision: number, updatedAt: number): TaskDagViewDto {
  return {
    schemaVersion: 1,
    managementRunId: 'run-1',
    rootTaskId: 'task-child',
    graphRevision,
    nodes: [{
      task: { id: 'task-child', teamId: 'team-1', title: '子任务', status: 'done', creatorId: 'user-1', assigneeId: 'agent-1', channelId: 'channel-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt },
      taskRevision,
      coordination: { schemaVersion: 1, rootTaskId: 'task-root', parentTaskId: 'task-root', managementRunId: 'run-1', nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [], dependencyTaskIds: ['task-root'], attempt: 2, maxAttempts: 3 },
      claim: { agentId: 'agent-1', taskRevision, taskAttempt: 2, status: 'active', acquiredAt: 2, expiresAt: 20 },
      latestDelivery: { id: 'delivery-1', invocationId: 'invocation-1', summary: '已完成交付' },
      canonicalAcceptance: { decision: 'accepted', reason: '证据完整', decidedBy: 'manager', decidedAt: 4 },
      resultRefs: [{ kind: 'invocation', id: 'invocation-1' }, { kind: 'message', id: 'message-result' }],
    }],
    handoffs: [{ id: 'handoff-1', fromAgentId: 'agent-1', toAgentId: 'agent-2',
      kind: 'continuation', objective: '继续收尾', status: 'accepted',
      invocationId: 'invocation-2', createdAt: 3, updatedAt: 4 }],
    events: [{ sequence: graphRevision, type: 'task-acceptance-decided', createdAt: 4 }],
  };
}
