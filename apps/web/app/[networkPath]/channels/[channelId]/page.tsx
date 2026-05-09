'use client';
import { useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { ChannelMessage } from '@/components/channel-message';
import { ChannelInput } from '@/components/channel-input';

export default function ChannelPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const messages = useAgentBeanStore((s) => s.messagesByChannel[channelId] ?? []);
  const channel = useAgentBeanStore((s) => s.channels.find((c) => c.id === channelId));
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);

  useEffect(() => {
    const socket = getWebSocket();
    socket.emit('channel:join', { channelId });

    const onHistory = (payload: { channelId: string; messages: any[] }) => {
      if (payload.channelId === channelId) useAgentBeanStore.getState().applyChannelHistory(channelId, payload.messages);
    };
    const onMessage = (msg: any) => {
      if (msg.channelId === channelId) useAgentBeanStore.getState().appendMessage(msg);
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', onMessage);

    return () => {
      socket.emit('channel:leave', { channelId });
      socket.off('channel:history', onHistory);
      socket.off('channel:message', onMessage);
    };
  }, [channelId]);

  const sorted = useMemo(
    () => [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [messages],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="px-1 py-2 text-base font-semibold">
        {channel?.name ?? '频道'}
      </div>
      <div className="flex-1 overflow-auto space-y-2 pr-1">
        {sorted.length === 0 ? (
          <div className="text-sm text-neutral-500">等待 Agent 自我介绍…</div>
        ) : (
          sorted.map((m) => <ChannelMessage key={m.id} msg={m} />)
        )}
      </div>
      <ChannelInput channelId={channelId} />
    </div>
  );
}
