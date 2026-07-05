import { describe, expect, test } from 'vitest';
import { matchingWorkspaceRunDetail, type WorkspaceRunDetailBundle } from '../lib/task-workspace-run-detail';

function detailBundle(overrides: Partial<WorkspaceRunDetailBundle['workspaceRun']> = {}): WorkspaceRunDetailBundle {
  return {
    workspaceRun: {
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      status: 'succeeded',
      artifactIds: [],
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    },
    artifacts: [],
  };
}

describe('matchingWorkspaceRunDetail', () => {
  test('keeps detail that belongs to the current team and run', () => {
    const detail = detailBundle();

    expect(matchingWorkspaceRunDetail(detail, 'team-1', 'run-1')).toBe(detail);
  });

  test('drops stale detail from a previous run while the next detail is loading', () => {
    const detail = detailBundle({ id: 'run-old' });

    expect(matchingWorkspaceRunDetail(detail, 'team-1', 'run-new')).toBeNull();
  });

  test('drops stale detail from another team', () => {
    const detail = detailBundle({ teamId: 'team-old' });

    expect(matchingWorkspaceRunDetail(detail, 'team-new', 'run-1')).toBeNull();
  });
});
