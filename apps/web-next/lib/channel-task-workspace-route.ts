import type { ChannelTaskWorkspaceEntryV1 } from '@agentbean/contracts';

export type ChannelTasksSubview = 'project' | 'plain';
export type ChannelTasksNavigationIntent = 'resolve_default' | 'select_subview' | 'open_task';

export function channelTasksHistoryMode(
  intent: ChannelTasksNavigationIntent,
): 'push' | 'replace' {
  return intent === 'resolve_default' ? 'replace' : 'push';
}

/**
 * 子视图归属只消费 Server governance 与 ProjectStage 投影。
 * assignee、tag 和 TaskStatus 都不是项目事实，不能参与归类。
 */
export function channelTaskEntrySubview(entry: ChannelTaskWorkspaceEntryV1): ChannelTasksSubview {
  return entry.governance.mode === 'managed' || entry.stage ? 'project' : 'plain';
}

/** 仅把 URL 中的阶段上下文交给实际绑定该阶段的任务，避免残留 deep link 污染其他任务详情。 */
export function matchingChannelTaskStageId(
  entry: ChannelTaskWorkspaceEntryV1 | undefined,
  selectedStageId: string | null,
): string | null {
  return entry?.stage?.id === selectedStageId ? selectedStageId : null;
}

export function channelTaskResponsibilityFocusFilterValue(
  entry: ChannelTaskWorkspaceEntryV1 | undefined,
): string {
  if (!entry) return 'unassigned';
  if (entry.responsibilityFocus.kind === 'review_wait') return 'review_wait';
  return entry.responsibilityFocus.agentId ?? 'unassigned';
}

/**
 * 普通 Task 只有在 Server 已经投影出真实的责任、交付或审核事实时才展示项目摘要。
 * assignee、tag 和 TaskStatus 不能把历史普通任务推断成项目任务。
 */
export function channelTaskHasProjectFacts(entry: ChannelTaskWorkspaceEntryV1 | undefined): boolean {
  if (!entry) return false;
  return entry.governance.mode === 'managed'
    || Boolean(entry.stage)
    || entry.responsibilityFocus.kind !== 'none'
    || entry.delivery.packageCount > 0
    || entry.delivery.pendingDeliveryCount > 0
    || entry.review.reviewerIds.length > 0
    || Boolean(entry.review.latest);
}
