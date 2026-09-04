/** Server-owned result notifications. Reading a notification never accepts a delivery. */
export interface CompletionNotificationDto {
  readonly id: string;
  readonly teamId: string;
  readonly recipientId: string;
  readonly kind: 'delivery_ready' | 'request_completed';
  readonly title: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export interface CompletionNotificationWake {
  readonly teamId: string;
  readonly recipientId: string;
}

/** Stable descending-time / ascending-id cursor; never an authorization token. */
export interface CompletionNotificationCursor {
  readonly createdAt: number;
  readonly id: string;
}
export const COMPLETION_NOTIFICATION_PAGE_SIZE = 50;

export function completionNotificationPath(teamPath: string, item: CompletionNotificationDto): string {
  const base = '/' + encodeURIComponent(teamPath);
  if (item.taskId && item.channelId) return base + '/tasks?' + new URLSearchParams({ thread: item.channelId + ':' + item.taskId });
  if (item.taskId) return base + '/tasks?' + new URLSearchParams({ task: item.taskId });
  if (item.channelId && item.threadId) return base + '/channel/' + encodeURIComponent(item.channelId) + '?' + new URLSearchParams({
    thread: item.channelId + ':' + item.threadId,
    ...(item.messageId ? { message: item.channelId + ':' + item.messageId } : {}),
  });
  return base + '/tasks';
}
