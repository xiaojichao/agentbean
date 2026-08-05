/**
 * #929 Web：audience-scoped System activity 客户端辅助。
 *
 * 不乐观推进业务状态；review/remediation 必须映射到具名 Server command。
 * 禁止把 PI 渲染为成员/头像/聊天气泡。
 */

export type SystemActivityLevel = 'info' | 'milestone' | 'attention' | 'action_required';

export interface SystemActivityItemView {
  readonly projectionId: string;
  readonly eventId: string;
  readonly surface: 'task_timeline' | 'thread_card' | 'attention_inbox';
  readonly level: SystemActivityLevel;
  readonly factKind: string;
  readonly taskId: string;
  readonly summary: string;
  readonly occurredAt: number;
  readonly actorKind: 'system';
  readonly attentionIdentity?: string;
  readonly attentionRevision?: number;
  readonly taskRevision?: number;
  readonly deliveryRevision?: number;
  readonly allowedCommands?: readonly string[];
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
}

export interface SystemAttentionItemView {
  readonly attentionIdentity: string;
  readonly taskId: string;
  readonly level: 'attention' | 'action_required';
  readonly state: 'open' | 'resolved' | 'dismissed_by_policy' | 'superseded';
  readonly revision: number;
  readonly summary: string;
  readonly unread: boolean;
  readonly allowedCommands?: readonly string[];
  readonly confirmationToken?: string;
  readonly escalationRevision?: number;
  readonly taskRevision?: number;
  readonly deliveryRevision?: number;
}

export interface ThreadTaskCardView {
  readonly taskId: string;
  readonly currentLevel: SystemActivityLevel;
  readonly currentSummary: string;
  readonly milestones: readonly SystemActivityItemView[];
}

/** review / remediation 具名 command 白名单（客户端不得发明新 command）。 */
export const NAMED_REVIEW_COMMANDS = [
  'accept-root-delivery',
  'reject-root-delivery',
  'cancel-task',
  'close-task',
] as const;

export const NAMED_REMEDIATION_COMMANDS = [
  'retry-attempt',
  'increase-attempt-budget',
  'revise-subtask-contract',
  'extend-deadline',
  'cancel-subtask',
  'terminate-root-task',
] as const;

export type NamedActivityActionCommand =
  | (typeof NAMED_REVIEW_COMMANDS)[number]
  | (typeof NAMED_REMEDIATION_COMMANDS)[number];

const ALL_NAMED = new Set<string>([...NAMED_REVIEW_COMMANDS, ...NAMED_REMEDIATION_COMMANDS]);

export function isNamedActivityAction(command: string): command is NamedActivityActionCommand {
  return ALL_NAMED.has(command);
}

/**
 * 从 attention 提取可操作具名 command。
 * 客户端不能把 read/seen/dismiss 当作解决 action_required 的动作。
 */
export function actionableCommandsFromAttention(
  item: SystemAttentionItemView,
): readonly NamedActivityActionCommand[] {
  if (item.state !== 'open') return [];
  return (item.allowedCommands ?? []).filter(isNamedActivityAction);
}

/** 打开通知只清 unread：生成 mark-attention-seen 输入（不解决责任）。 */
export function buildMarkAttentionSeenPayload(item: SystemAttentionItemView, recipientId: string): {
  attentionIdentity: string;
  recipientId: string;
  expectedRevision: number;
} {
  return {
    attentionIdentity: item.attentionIdentity,
    recipientId,
    expectedRevision: item.revision,
  };
}

/** change-feed cursor ack：明确不推进 Message Read / attention / Task responsibility。 */
export function buildAckChangeFeedCursorPayload(recipientId: string, cursor: string): {
  recipientId: string;
  cursor: string;
  doesNotAdvance: {
    messageRead: true;
    attention: true;
    taskResponsibility: true;
  };
} {
  return {
    recipientId,
    cursor,
    doesNotAdvance: {
      messageRead: true,
      attention: true,
      taskResponsibility: true,
    },
  };
}

export function activityLevelLabel(level: SystemActivityLevel): string {
  switch (level) {
    case 'info':
      return '信息';
    case 'milestone':
      return '里程碑';
    case 'attention':
      return '待关注';
    case 'action_required':
      return '需处理';
    default:
      return level;
  }
}

export function commandActionLabel(command: NamedActivityActionCommand): string {
  switch (command) {
    case 'accept-root-delivery':
      return '接受交付';
    case 'reject-root-delivery':
      return '退回修改';
    case 'cancel-task':
      return '取消任务';
    case 'close-task':
      return '关闭任务';
    case 'retry-attempt':
      return '重试 attempt';
    case 'increase-attempt-budget':
      return '增加预算';
    case 'revise-subtask-contract':
      return '修订合同';
    case 'extend-deadline':
      return '延期';
    case 'cancel-subtask':
      return '取消子任务';
    case 'terminate-root-task':
      return '终止根任务';
    default:
      return command;
  }
}

/** Task 时间线：仅当前受众可见项，按 sequence 排序。 */
export function sortTaskTimeline(
  items: readonly SystemActivityItemView[],
): SystemActivityItemView[] {
  return [...items]
    .filter((item) => item.surface === 'task_timeline' && item.actorKind === 'system')
    .sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
}

/** Inbox：仅 open attention / action_required；unread 优先。 */
export function sortAttentionInbox(
  items: readonly SystemAttentionItemView[],
): SystemAttentionItemView[] {
  return [...items]
    .filter((item) => item.state === 'open')
    .sort((a, b) => {
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      if (a.level !== b.level) {
        return a.level === 'action_required' ? -1 : 1;
      }
      return a.attentionIdentity.localeCompare(b.attentionIdentity);
    });
}

export function unreadAttentionCount(items: readonly SystemAttentionItemView[]): number {
  return items.filter((item) => item.state === 'open' && item.unread).length;
}

/**
 * 绑定 revision 的 review/remediation action payload 骨架。
 * 真正 dispatch 走 lifecycle/remediation socket；此处只保证字段完整。
 */
export function buildBoundActionPayload(input: {
  command: NamedActivityActionCommand;
  taskId: string;
  attention: SystemAttentionItemView;
  /** reject-root-delivery 必填；其余 command 可选。 */
  reason?: string;
  deliveryMessageId?: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    taskId: input.taskId,
    expectedTaskRevision: input.attention.taskRevision ?? 0,
  };
  if (input.attention.confirmationToken) {
    base.actionRequiredId = input.attention.attentionIdentity;
    base.confirmationToken = input.attention.confirmationToken;
    base.expectedEscalationRevision = input.attention.escalationRevision ?? input.attention.revision;
  }
  if (input.command === 'accept-root-delivery') {
    base.expectedTaskRevision = input.attention.taskRevision ?? 0;
    if (input.deliveryMessageId) base.deliveryMessageId = input.deliveryMessageId;
    if (input.attention.deliveryRevision !== undefined) {
      base.deliveryRevision = input.attention.deliveryRevision;
    }
  }
  if (input.command === 'reject-root-delivery') {
    base.expectedTaskRevision = input.attention.taskRevision ?? 0;
    base.reason = input.reason?.trim() || '审查退回';
  }
  if (input.command === 'cancel-task' || input.command === 'close-task') {
    base.reason = input.reason?.trim() || (input.command === 'cancel-task' ? '用户取消' : '管理员关闭');
  }
  return base;
}

/** #995：将 system-activity 具名 review action 映射到 task socket 事件。 */
export function mapReviewCommandToTaskSocketEvent(
  command: NamedActivityActionCommand,
): 'acceptRootDelivery' | 'rejectRootDelivery' | 'cancel' | 'close' | null {
  switch (command) {
    case 'accept-root-delivery':
      return 'acceptRootDelivery';
    case 'reject-root-delivery':
      return 'rejectRootDelivery';
    case 'cancel-task':
      return 'cancel';
    case 'close-task':
      return 'close';
    default:
      return null;
  }
}

export function isProjectionNotReady(outcome: string | undefined): boolean {
  return outcome === 'projection_not_ready';
}
