/**
 * #929 System activity socket client helpers.
 * notice 只是唤醒；权威状态必须走 query。
 * #995 review action 必须 dispatch 到 task lifecycle socket，不走 system-activity:command。
 */
import { WEB_EVENTS } from '@agentbean/contracts';
import type { SystemActivityQueryName } from '@agentbean/contracts';
import {
  buildBoundActionPayload,
  mapReviewCommandToTaskSocketEvent,
  type NamedActivityActionCommand,
  type SystemAttentionItemView,
} from '@/lib/system-activity';

export interface SystemActivitySocketLike {
  emitWithAck?(event: string, payload: unknown): Promise<unknown>;
}

export async function dispatchSystemActivityCommand(
  socket: SystemActivitySocketLike,
  input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  },
): Promise<unknown> {
  if (!socket.emitWithAck) {
    throw new Error('SOCKET_EMIT_WITH_ACK_UNAVAILABLE');
  }
  return socket.emitWithAck(WEB_EVENTS.systemActivity.command, input);
}

export async function dispatchSystemActivityQuery(
  socket: SystemActivitySocketLike,
  input: {
    queryName: SystemActivityQueryName;
    payload: unknown;
    userId: string;
    teamId: string;
  },
): Promise<unknown> {
  if (!socket.emitWithAck) {
    throw new Error('SOCKET_EMIT_WITH_ACK_UNAVAILABLE');
  }
  return socket.emitWithAck(WEB_EVENTS.systemActivity.query, input);
}

/**
 * 将 Inbox / Task 时间线的具名 review action 发到 lifecycle task socket。
 * remediation command 仍留给 remediation 入口（本 helper 返回 null）。
 */
export async function dispatchNamedReviewAction(
  socket: SystemActivitySocketLike,
  input: {
    command: NamedActivityActionCommand;
    attention: SystemAttentionItemView;
    reason?: string;
    deliveryMessageId?: string;
  },
): Promise<{ ok: boolean; task?: unknown; error?: string } | null> {
  const mapped = mapReviewCommandToTaskSocketEvent(input.command);
  if (!mapped) return null;
  if (!socket.emitWithAck) {
    throw new Error('SOCKET_EMIT_WITH_ACK_UNAVAILABLE');
  }
  const bound = buildBoundActionPayload({
    command: input.command,
    taskId: input.attention.taskId,
    attention: input.attention,
    reason: input.reason,
    deliveryMessageId: input.deliveryMessageId,
  });
  if (mapped === 'acceptRootDelivery') {
    return socket.emitWithAck(WEB_EVENTS.task.acceptRootDelivery, {
      taskId: bound.taskId,
      expectedTaskRevision: bound.expectedTaskRevision,
      ...(bound.deliveryMessageId ? { deliveryMessageId: bound.deliveryMessageId } : {}),
    }) as Promise<{ ok: boolean; task?: unknown; error?: string }>;
  }
  if (mapped === 'rejectRootDelivery') {
    return socket.emitWithAck(WEB_EVENTS.task.rejectRootDelivery, {
      taskId: bound.taskId,
      expectedTaskRevision: bound.expectedTaskRevision,
      reason: bound.reason,
    }) as Promise<{ ok: boolean; task?: unknown; error?: string }>;
  }
  if (mapped === 'cancel') {
    return socket.emitWithAck(WEB_EVENTS.task.cancel, {
      taskId: bound.taskId,
      reason: bound.reason,
    }) as Promise<{ ok: boolean; task?: unknown; error?: string }>;
  }
  return socket.emitWithAck(WEB_EVENTS.task.close, {
    taskId: bound.taskId,
    reason: bound.reason,
  }) as Promise<{ ok: boolean; task?: unknown; error?: string }>;
}

export const SYSTEM_ACTIVITY_NOTICE_EVENT = WEB_EVENTS.systemActivity.notice;
