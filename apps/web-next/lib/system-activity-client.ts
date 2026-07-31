/**
 * #998 System activity 客户端：query / mark-seen / 绑定动作。
 */
import type { SystemActivityQueryName } from '@agentbean/contracts';
import type {
  NamedActivityActionCommand,
  SystemActivityItemView,
  SystemAttentionItemView,
  ThreadTaskCardView,
} from './system-activity';
import {
  buildBoundActionPayload,
  buildMarkAttentionSeenPayload,
  isProjectionNotReady,
} from './system-activity';
import { systemActivityEvents } from './socket';

type QueryAck = {
  ok?: boolean;
  response?: {
    outcome?: string;
    result?: Record<string, unknown>;
  };
  error?: string;
};

type CommandAck = {
  ok?: boolean;
  response?: {
    outcome?: string;
    result?: Record<string, unknown>;
  };
  error?: string;
};

function asItems(raw: unknown): SystemActivityItemView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      projectionId: String(e.projectionId ?? ''),
      eventId: String(e.eventId ?? ''),
      surface: (e.surface as SystemActivityItemView['surface']) ?? 'task_timeline',
      level: (e.level as SystemActivityItemView['level']) ?? 'info',
      factKind: String(e.factKind ?? ''),
      taskId: String(e.taskId ?? ''),
      summary: String(e.summary ?? ''),
      occurredAt: Number(e.occurredAt ?? 0),
      actorKind: 'system',
      attentionIdentity: typeof e.attentionIdentity === 'string' ? e.attentionIdentity : undefined,
      attentionRevision: typeof e.attentionRevision === 'number' ? e.attentionRevision : undefined,
      taskRevision: typeof e.taskRevision === 'number' ? e.taskRevision : undefined,
      deliveryRevision: typeof e.deliveryRevision === 'number' ? e.deliveryRevision : undefined,
      allowedCommands: Array.isArray(e.allowedCommands) ? e.allowedCommands as string[] : undefined,
      confirmationToken: typeof e.confirmationToken === 'string' ? e.confirmationToken : undefined,
      escalationRevision: typeof e.escalationRevision === 'number' ? e.escalationRevision : undefined,
    };
  });
}

function asAttentionItems(raw: unknown): SystemAttentionItemView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>;
    return {
      attentionIdentity: String(e.attentionIdentity ?? ''),
      taskId: String(e.taskId ?? ''),
      level: e.level === 'action_required' ? 'action_required' : 'attention',
      state: (e.state as SystemAttentionItemView['state']) ?? 'open',
      revision: Number(e.revision ?? 1),
      summary: String(e.summary ?? ''),
      unread: Boolean(e.unread),
      allowedCommands: Array.isArray(e.allowedCommands) ? e.allowedCommands as string[] : undefined,
      confirmationToken: typeof e.confirmationToken === 'string' ? e.confirmationToken : undefined,
      escalationRevision: typeof e.escalationRevision === 'number' ? e.escalationRevision : undefined,
      taskRevision: typeof e.taskRevision === 'number' ? e.taskRevision : undefined,
      deliveryRevision: typeof e.deliveryRevision === 'number' ? e.deliveryRevision : undefined,
    };
  });
}

async function dispatchQuery(input: {
  queryName: SystemActivityQueryName;
  payload: unknown;
  userId: string;
  teamId: string;
}): Promise<QueryAck> {
  const raw = await systemActivityEvents().query(input);
  return (raw ?? {}) as QueryAck;
}

async function dispatchCommand(input: {
  envelope: unknown;
  payload: unknown;
  userId: string;
  teamId: string;
}): Promise<CommandAck> {
  const raw = await systemActivityEvents().command(input);
  return (raw ?? {}) as CommandAck;
}

export async function loadTaskTimeline(input: {
  userId: string;
  teamId: string;
  taskId: string;
  limit?: number;
}): Promise<{
  items: SystemActivityItemView[];
  projectionNotReady: boolean;
  error?: string;
}> {
  const ack = await dispatchQuery({
    queryName: 'query-task-activity',
    payload: { taskId: input.taskId, recipientId: input.userId, limit: input.limit ?? 50 },
    userId: input.userId,
    teamId: input.teamId,
  });
  if (!ack.ok) return { items: [], projectionNotReady: false, error: ack.error ?? 'QUERY_FAILED' };
  if (isProjectionNotReady(ack.response?.outcome)) {
    return { items: [], projectionNotReady: true };
  }
  const result = ack.response?.result;
  return {
    items: asItems(result?.items),
    projectionNotReady: false,
  };
}

export async function loadThreadTaskCard(input: {
  userId: string;
  teamId: string;
  taskId: string;
  channelId: string;
  threadId?: string;
}): Promise<{
  card: ThreadTaskCardView | null;
  projectionNotReady: boolean;
  error?: string;
}> {
  const ack = await dispatchQuery({
    queryName: 'query-thread-task-card',
    payload: {
      taskId: input.taskId,
      channelId: input.channelId,
      recipientId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    userId: input.userId,
    teamId: input.teamId,
  });
  if (!ack.ok) return { card: null, projectionNotReady: false, error: ack.error ?? 'QUERY_FAILED' };
  if (isProjectionNotReady(ack.response?.outcome)) {
    return { card: null, projectionNotReady: true };
  }
  const cardRaw = ack.response?.result?.card as Record<string, unknown> | undefined;
  if (!cardRaw) return { card: null, projectionNotReady: false };
  return {
    card: {
      taskId: String(cardRaw.taskId ?? input.taskId),
      currentLevel: (cardRaw.currentLevel as ThreadTaskCardView['currentLevel']) ?? 'info',
      currentSummary: String(cardRaw.currentSummary ?? ''),
      milestones: asItems(cardRaw.milestones),
    },
    projectionNotReady: false,
  };
}

export async function loadAttentionInbox(input: {
  userId: string;
  teamId: string;
  limit?: number;
  onlyUnread?: boolean;
}): Promise<{
  items: SystemAttentionItemView[];
  projectionNotReady: boolean;
  error?: string;
}> {
  const ack = await dispatchQuery({
    queryName: 'query-attention-inbox',
    payload: {
      recipientId: input.userId,
      limit: input.limit ?? 50,
      ...(input.onlyUnread !== undefined ? { onlyUnread: input.onlyUnread } : {}),
    },
    userId: input.userId,
    teamId: input.teamId,
  });
  if (!ack.ok) return { items: [], projectionNotReady: false, error: ack.error ?? 'QUERY_FAILED' };
  if (isProjectionNotReady(ack.response?.outcome)) {
    return { items: [], projectionNotReady: true };
  }
  return {
    items: asAttentionItems(ack.response?.result?.items),
    projectionNotReady: false,
  };
}

export async function markAttentionSeen(input: {
  userId: string;
  teamId: string;
  item: SystemAttentionItemView;
}): Promise<{ ok: boolean; error?: string }> {
  const payload = buildMarkAttentionSeenPayload(input.item, input.userId);
  const ack = await dispatchCommand({
    envelope: {
      schemaVersion: 1,
      commandName: 'mark-attention-seen',
      commandSchemaVersion: 1,
      idempotencyKey: `seen:${payload.attentionIdentity}:${payload.expectedRevision}:${Date.now()}`,
    },
    payload,
    userId: input.userId,
    teamId: input.teamId,
  });
  if (!ack.ok) return { ok: false, error: ack.error };
  if (ack.response?.outcome === 'applied' || ack.response?.outcome === 'replayed') {
    return { ok: true };
  }
  return { ok: false, error: String(ack.response?.outcome ?? 'REJECTED') };
}

/**
 * 具名 review/remediation：只组 payload 骨架；真正 socket 事件由调用方选择 lifecycle/remediation 通道。
 * 此处返回可序列化绑定，避免客户端发明 command。
 */
export function prepareNamedAction(input: {
  command: NamedActivityActionCommand;
  taskId: string;
  attention: SystemAttentionItemView;
}): { command: NamedActivityActionCommand; payload: Record<string, unknown> } {
  return {
    command: input.command,
    payload: buildBoundActionPayload(input),
  };
}

export { SYSTEM_ACTIVITY_NOTICE_EVENT } from './system-activity-socket';
