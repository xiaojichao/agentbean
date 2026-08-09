import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

export type ChannelTasksSubview = 'project' | 'plain';

export function parseChannelTasksSubview(value: string | null): ChannelTasksSubview | undefined {
  return value === 'project' || value === 'plain' ? value : undefined;
}

export function resolveChannelTasksSubview(
  requested: ChannelTasksSubview | undefined,
  hasProjectStages: boolean,
): ChannelTasksSubview {
  return requested ?? (hasProjectStages ? 'project' : 'plain');
}

/**
 * 子视图归属只消费 Server governance 与 ProjectStage 投影。
 * assignee、tag 和 TaskStatus 都不是项目事实，不能参与归类。
 */
export function channelTaskEntrySubview(entry: ChannelTaskWorkspaceEntryV1): ChannelTasksSubview {
  return entry.governance.mode === 'managed' || entry.stage ? 'project' : 'plain';
}

export function channelTasksRouteParams(
  current: URLSearchParams,
  selection: {
    view: ChannelTasksSubview;
    stageId?: string | null;
    taskId?: string | null;
  },
): URLSearchParams {
  const next = new URLSearchParams(current.toString());
  next.set('chatTab', 'tasks');
  next.set('tasksView', selection.view);
  next.delete('message');
  next.delete('thread');
  next.delete('profile');

  if (selection.view === 'plain') {
    next.delete('stage');
    next.delete('task');
    return next;
  }

  if (selection.stageId === null) next.delete('stage');
  else if (selection.stageId) next.set('stage', selection.stageId);

  if (selection.taskId === null) next.delete('task');
  else if (selection.taskId) next.set('task', `task:${selection.taskId}`);

  return next;
}
