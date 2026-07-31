/**
 * #1014：将 Task lifecycle / remediation 权威结果映射为 SystemActivitySourceFact。
 * 纯函数，无 IO。
 */
import type {
  SystemActivityFactKind,
  SystemActivitySourceFactV1,
} from '@agentbean/contracts';
import type { TaskLifecycleCommandName } from '@agentbean/contracts';
import type { TaskRemediationCommandName } from '@agentbean/contracts';

export interface LifecycleActivityMapInput {
  readonly commandName: TaskLifecycleCommandName;
  readonly teamId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly channelId?: string;
  readonly rootTaskId?: string;
  readonly visibleRecipientIds: readonly string[];
  readonly responsibleRecipientIds: readonly string[];
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly deliveryMessageId?: string;
  readonly reason?: string;
  readonly status?: string;
}

export interface RemediationActivityMapInput {
  readonly commandName: TaskRemediationCommandName;
  readonly teamId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly channelId?: string;
  readonly rootTaskId?: string;
  readonly visibleRecipientIds: readonly string[];
  readonly responsibleRecipientIds: readonly string[];
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly actionRequiredId?: string;
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
  readonly allowedCommands?: readonly string[];
  readonly summary?: string;
  readonly failureClass?: string;
}

const LIFECYCLE_FACT: Partial<Record<TaskLifecycleCommandName, SystemActivityFactKind>> = {
  'transition-task-in-progress': 'task_state_changed',
  'submit-root-delivery': 'in_review',
  'accept-root-delivery': 'delivery_accepted',
  'reject-root-delivery': 'delivery_rejected',
  'transition-subtask-in-review': 'in_review',
  'accept-subtask': 'delivery_accepted',
  'reject-subtask': 'delivery_rejected',
  'cancel-task': 'task_cancelled',
  'close-task': 'task_closed',
  'start-execution': 'execution_started',
};

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function defaultSummary(
  factKind: SystemActivityFactKind,
  reason?: string,
  failureClass?: string,
): string {
  switch (factKind) {
    case 'task_state_changed':
      return '任务状态已更新';
    case 'in_review':
      return '交付已提交，等待验收';
    case 'delivery_accepted':
      return '交付已接受';
    case 'delivery_rejected':
      return reason?.trim() ? `交付已退回：${reason.trim()}` : '交付已退回修改';
    case 'task_cancelled':
      return reason?.trim() ? `任务已取消：${reason.trim()}` : '任务已取消';
    case 'task_closed':
      return reason?.trim() ? `任务已关闭：${reason.trim()}` : '任务已关闭';
    case 'execution_started':
      return '执行已开始';
    case 'action_required_opened':
      return failureClass
        ? `需要人工处置（${failureClass}）`
        : '需要人工处置';
    case 'action_required_resolved':
      return '人工处置已完成';
    default:
      return '系统活动更新';
  }
}

/**
 * lifecycle 成功 command → 投影原料；不映射的 command 返回 null。
 */
export function mapLifecycleCommandToActivityFact(
  input: LifecycleActivityMapInput,
): SystemActivitySourceFactV1 | null {
  const factKind = LIFECYCLE_FACT[input.commandName];
  if (!factKind) return null;
  const visible = unique(input.visibleRecipientIds);
  if (visible.length === 0) return null;

  const needsAttention = factKind === 'in_review';
  const responsible = needsAttention
    ? unique(input.responsibleRecipientIds.length > 0
      ? input.responsibleRecipientIds
      : visible)
    : unique(input.responsibleRecipientIds);

  return {
    schemaVersion: 1,
    eventId: input.eventId,
    streamKind: 'task',
    streamId: input.taskId,
    sequence: input.sequence,
    teamId: input.teamId,
    taskId: input.taskId,
    ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    factKind,
    occurredAt: input.occurredAt,
    visibleRecipientIds: visible,
    responsibleRecipientIds: responsible,
    summary: defaultSummary(factKind, input.reason),
    taskRevision: input.taskRevision,
    ...(needsAttention
      ? {
          attentionKey: `review:${input.taskId}`,
          allowedCommands: ['accept-root-delivery', 'reject-root-delivery'],
          escalationRevision: 1,
        }
      : {}),
    ...(input.deliveryMessageId ? { deliveryRevision: 1 } : {}),
  };
}

/**
 * remediation 成功 command → 投影原料。
 * classify/open AR → action_required_opened；retry 等解决 → action_required_resolved。
 */
export function mapRemediationCommandToActivityFact(
  input: RemediationActivityMapInput,
): SystemActivitySourceFactV1 | null {
  let factKind: SystemActivityFactKind | null = null;
  if (
    input.commandName === 'classify-failure'
    || input.commandName === 'request-conditional-reassignment'
  ) {
    if (input.actionRequiredId) factKind = 'action_required_opened';
    else factKind = 'recovery_pending';
  } else if (
    input.commandName === 'retry-attempt'
    || input.commandName === 'increase-attempt-budget'
    || input.commandName === 'revise-subtask-contract'
    || input.commandName === 'extend-deadline'
    || input.commandName === 'cancel-subtask'
    || input.commandName === 'terminate-root-task'
  ) {
    factKind = 'action_required_resolved';
  } else if (input.commandName === 'issue-progress-challenge') {
    factKind = 'waiting';
  } else if (input.commandName === 'fence-stale-attempt') {
    factKind = 'recovery_pending';
  }

  if (!factKind) return null;
  const visible = unique(input.visibleRecipientIds);
  if (visible.length === 0) return null;
  const responsible = unique(
    input.responsibleRecipientIds.length > 0 ? input.responsibleRecipientIds : visible,
  );

  return {
    schemaVersion: 1,
    eventId: input.eventId,
    streamKind: 'task-remediation',
    streamId: input.taskId,
    sequence: input.sequence,
    teamId: input.teamId,
    taskId: input.taskId,
    ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    factKind,
    occurredAt: input.occurredAt,
    visibleRecipientIds: visible,
    responsibleRecipientIds: responsible,
    summary: input.summary ?? defaultSummary(factKind, undefined, input.failureClass),
    taskRevision: input.taskRevision,
    ...(input.actionRequiredId
      ? {
          attentionKey: `esc:${input.actionRequiredId}`,
          ...(input.allowedCommands ? { allowedCommands: input.allowedCommands } : {}),
          ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
          ...(input.escalationRevision !== undefined
            ? { escalationRevision: input.escalationRevision }
            : {}),
        }
      : {}),
  };
}

/** 从 task 成员与频道成员推导可见/责任受众（服务端侧最小规则）。 */
export function deriveActivityAudience(input: {
  readonly teamMemberIds: readonly string[];
  readonly channelHumanMemberIds?: readonly string[] | null;
  readonly creatorId?: string | null;
  readonly assigneeId?: string | null;
  readonly humanEscalationIds?: readonly string[] | null;
  readonly forActionRequired?: boolean;
  readonly forReview?: boolean;
}): {
  readonly visibleRecipientIds: readonly string[];
  readonly responsibleRecipientIds: readonly string[];
} {
  const channel = input.channelHumanMemberIds?.filter(Boolean) ?? [];
  const team = input.teamMemberIds.filter(Boolean);
  const visible = unique(channel.length > 0 ? channel : team);
  const responsibleBase = unique([
    ...(input.humanEscalationIds ?? []),
    ...(input.creatorId ? [input.creatorId] : []),
    ...(input.assigneeId && !input.assigneeId.startsWith('agent') ? [input.assigneeId] : []),
  ]);
  const responsible = unique(
    input.forActionRequired || input.forReview
      ? (responsibleBase.length > 0 ? responsibleBase : visible)
      : responsibleBase,
  );
  return { visibleRecipientIds: visible, responsibleRecipientIds: responsible };
}
