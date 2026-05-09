'use client';
import { useState } from 'react';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { OutboundMessage } from '@/lib/schema';

export function ChannelInput({ channelId }: { channelId: string }) {
  const [body, setBody] = useState('');
  const addOutbound = useAgentBeanStore((s) => s.addOutbound);
  const resolveOutbound = useAgentBeanStore((s) => s.resolveOutbound);

  const send = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const socket = getWebSocket();
    if (!socket.connected) {
      const id = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      addOutbound({ id, channelId, body: trimmed, status: 'pending' });
      resolveOutbound(id, 'failed');
      return;
    }
    const id = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const out: OutboundMessage = { id, channelId, body: trimmed, status: 'pending' };
    addOutbound(out);
    socket.emit('message:send',
      { channelId, body: trimmed, clientMsgId: id },
      (res: any) => resolveOutbound(id, res?.ok ? 'sent' : 'failed'),
    );
    setBody('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-neutral-200 p-3 bg-white">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        placeholder="输入消息,⌘/Ctrl + Enter 发送"
        className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
      />
      <div className="flex justify-end mt-2">
        <button
          onClick={send}
          disabled={body.trim().length === 0}
          className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5 disabled:opacity-50"
        >发送</button>
      </div>
    </div>
  );
}
