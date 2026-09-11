import { useEffect } from 'react';
import type { ChatMessage } from './schema';
import { messageReactionEvents } from './socket';

// 等待频道首批历史落地，避免补取的旧消息被 history 覆盖。
export function useMessageLinkContext(
  channelId: string | null,
  targetId: string | null,
  ready: boolean,
  targetLoaded: boolean,
  upsertMessages: (messages: ChatMessage[]) => void,
  markContextLoadedMessage: (message: ChatMessage) => ChatMessage,
) {
  useEffect(() => {
    if (!ready || !channelId || !targetId || targetLoaded) return;
    let cancelled = false;
    void messageReactionEvents().context(targetId).then((result) => {
      if (cancelled || !result.ok || !result.messages) return;
      upsertMessages(result.messages
        .filter((message) => message.channelId === channelId)
        .map(markContextLoadedMessage));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [channelId, targetId, ready, targetLoaded, upsertMessages, markContextLoadedMessage]);
}
