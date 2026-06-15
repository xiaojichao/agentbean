'use client';

import { useEffect, useMemo } from 'react';
import { Bot, Circle, Hash, Lock, MessageSquare, Users } from 'lucide-react';
import { agentEvents, channelEvents, dmEvents, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { ChannelInput } from '@/components/channel-input';
import { ChannelMessage } from '@/components/channel-message';

export function ConversationPage({ channelId, mode }: { channelId: string; mode: 'channel' | 'dm' }) {
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const messages = useAgentBeanStore((s) => s.messagesByChannel[channelId] ?? []);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);

  useEffect(() => {
    if (!currentTeamId) return;
    const socket = getWebSocket();
    agentEvents(socket).subscribe(currentTeamId);
    channelEvents(socket).subscribe(currentTeamId);
    dmEvents(socket).list().then((res) => {
      if (res.ok && res.dms) applyDmsSnapshot(res.dms);
    });
    const offAgents = agentEvents(socket).onSnapshot(applyAgentsSnapshot);
    const offStatus = agentEvents(socket).onStatus(applyAgentStatus);
    const offDms = dmEvents(socket).onSnapshot(applyDmsSnapshot);
    socket.on('channels:snapshot', applyChannelsSnapshot);
    socket.emit('channel:join', { channelId });

    const onHistory = (payload: { channelId: string; messages: any[] }) => {
      if (payload.channelId === channelId) applyChannelHistory(channelId, payload.messages);
    };
    const onMessage = (msg: any) => {
      if (msg.channelId === channelId) appendMessage(msg);
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', onMessage);

    return () => {
      offAgents();
      offStatus();
      offDms();
      socket.off('channels:snapshot', applyChannelsSnapshot);
      socket.off('channel:history', onHistory);
      socket.off('channel:message', onMessage);
    };
  }, [channelId, currentTeamId, applyAgentsSnapshot, applyAgentStatus, applyChannelsSnapshot, applyDmsSnapshot, applyChannelHistory, appendMessage]);

  const sorted = useMemo(
    () => [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [messages],
  );
  const channel = channels.find((item) => item.id === channelId);
  const dm = dms.find((item) => item.id === channelId);
  const dmAgent = dm ? agents[dm.dmTargetId] : undefined;
  const title = mode === 'dm' ? (dmAgent?.name ?? dm?.name ?? '私聊') : (channel?.name ?? '频道');
  const isPrivate = mode === 'dm' || channel?.visibility === 'private';

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${mode === 'dm' ? 'bg-purple-50 text-purple-600' : 'bg-amber-50 text-amber-600'}`}>
            {mode === 'dm' ? <MessageSquare size={17} /> : isPrivate ? <Lock size={17} /> : <Hash size={17} />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-neutral-900">{title}</div>
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              {mode === 'dm' ? (
                <>
                  <Bot size={12} />
                  <span>{dmAgent ? '智能体私聊' : '私聊频道'}</span>
                  {dmAgent && (
                    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${dmAgent.status === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>
                      <Circle size={5} className="fill-current" />
                      {dmAgent.status === 'online' ? '在线' : dmAgent.status === 'busy' ? '忙碌' : '离线'}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <Users size={12} />
                  <span>{isPrivate ? '私有频道' : '公开频道'}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-neutral-50 px-4 py-4">
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            {mode === 'dm' ? '还没有私聊消息。' : '这个频道还没有消息。'}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            {sorted.map((message) => <ChannelMessage key={message.id} msg={message} />)}
          </div>
        )}
      </div>

      <ChannelInput channelId={channelId} />
    </div>
  );
}
