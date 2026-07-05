import { describe, expect, test } from 'vitest';
import { matchingWorkspaceRunDetail, workspaceRunHistoryItems, type WorkspaceRunDetailBundle } from '../lib/task-workspace-run-detail';

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

describe('workspaceRunHistoryItems', () => {
  test('keeps every workspace run and marks the latest one', () => {
    const run1 = detailBundle({ id: 'run-1', command: 'npm test' }).workspaceRun;
    const run2 = detailBundle({ id: 'run-2', command: 'npm build' }).workspaceRun;

    expect(workspaceRunHistoryItems([run1, run2], 'run-2')).toEqual([
      { workspaceRun: run1, isLatest: false },
      { workspaceRun: run2, isLatest: true },
    ]);
  });
});
