import { MESSAGE_BATCH_QUIET_WINDOW_MS } from '../../../packages/contracts/src/message';
import type { ChatMessage } from './schema';

export const MESSAGE_GROUP_WINDOW_MS = MESSAGE_BATCH_QUIET_WINDOW_MS;

export function isMessageGroupContinuation(
  previous: ChatMessage | undefined,
  current: ChatMessage,
): boolean {
  if (!previous || previous.senderKind === 'system' || current.senderKind === 'system') {
    return false;
  }
  if (!previous.senderId || previous.senderId !== current.senderId) {
    return false;
  }
  if (previous.senderKind !== current.senderKind || previous.channelId !== current.channelId) {
    return false;
  }
  const gap = current.createdAt - previous.createdAt;
  return gap >= 0 && gap <= MESSAGE_GROUP_WINDOW_MS;
}
