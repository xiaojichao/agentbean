import type { ChatMessage } from './schema';
import { mergedStandalonePackageCardIds, shouldHideSystemMessage } from './system-messages';
import {
  taskStatusEventForTask,
  taskStatusEventSummary,
  type TaskStatusEventSummary,
} from './task-status-event';

function messageMeta(message: ChatMessage): Record<string, unknown> {
  if (message.meta && typeof message.meta === 'object') return message.meta;
  if (!message.metaJson) return {};
  try {
    const parsed = JSON.parse(message.metaJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function taskStatusEventFromMessage(message: ChatMessage): TaskStatusEventSummary | null {
  return taskStatusEventSummary(messageMeta(message));
}

function isLegacyTaskClaimAcknowledgement(message: ChatMessage): boolean {
  return messageMeta(message).kind === 'task-claim-confirmed';
}

/**
 * Web 聊天视图投影：状态流水仍保留在客户端原始消息集合中，但不进入频道主线、
 * Thread 回复/计数、Activity 或消息搜索。该规则不改变 Server/Contracts 序列化边界。
 */
export function projectChatViewMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const mergedCardIds = mergedStandalonePackageCardIds(messages);
  return messages.filter((message) =>
    !shouldHideSystemMessage(message)
    && !taskStatusEventFromMessage(message)
    && !isLegacyTaskClaimAcknowledgement(message)
    && !mergedCardIds.has(message.id));
}

/** 从原始客户端消息集合恢复某个 Task 的完整状态流水，保留原有顺序。 */
export function taskStatusMessagesForTask(
  messages: readonly ChatMessage[],
  taskId: string | null | undefined,
): ChatMessage[] {
  if (!taskId) return [];
  return messages.filter((message) => Boolean(taskStatusEventForTask(messageMeta(message), taskId)));
}

/** 历史 message 深链命中隐藏状态事件时，解析其对应 Task。 */
export function taskIdForStatusMessageDeepLink(
  messages: readonly ChatMessage[],
  messageId: string,
): string | null {
  const target = messages.find((message) => message.id === messageId);
  return target ? taskStatusEventFromMessage(target)?.taskId ?? null : null;
}
