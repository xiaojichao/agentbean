/**
 * #929 System activity socket client helpers.
 * notice 只是唤醒；权威状态必须走 query。
 */
import { WEB_EVENTS } from '@agentbean/contracts';
import type { SystemActivityQueryName } from '@agentbean/contracts';

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

export const SYSTEM_ACTIVITY_NOTICE_EVENT = WEB_EVENTS.systemActivity.notice;
