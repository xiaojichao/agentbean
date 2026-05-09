'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Hash, Search, Plus, Inbox, Bookmark, Image, Paperclip, Send, SquareDot, Pencil, Users, BookmarkCheck } from 'lucide-react';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { ChatMessage } from '@/lib/schema';
import { NewChannelDialog } from '@/components/new-channel-dialog';

export default function ChatPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const channels = useAgentBeanStore((s) => s.channels);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);

  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'chat' | 'tasks'>('chat');
  const [asTask, setAsTask] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Subscribe to channels
  useEffect(() => {
    if (conn !== 'open') return;
    const socket = getWebSocket();
    socket.emit('channels:subscribe', {});
    const handler = (list: any[]) => {
      applyChannelsSnapshot(list);
      setActiveChannel((prev) => {
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    };
    socket.on('channels:snapshot', handler);
    return () => { socket.off('channels:snapshot', handler); };
  }, [conn, applyChannelsSnapshot]);

  const handleMessage = useCallback((msg: ChatMessage) => {
    appendMessage(msg);
  }, [appendMessage]);

  useEffect(() => {
    if (!activeChannel || conn !== 'open') return;
    const socket = getWebSocket();
    socket.emit('channel:join', { channelId: activeChannel }, (res: any) => {
      if (res?.ok && res.messages) applyChannelHistory(activeChannel, res.messages);
    });
    socket.on('channel:message', handleMessage);
    return () => { socket.off('channel:message', handleMessage); };
  }, [activeChannel, conn, applyChannelHistory, handleMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesByChannel]);

  const sendMessage = () => {
    if (!input.trim() || !activeChannel) return;
    getWebSocket().emit('message:send', { channelId: activeChannel, body: input.trim() });
    setInput('');
  };

  const messages = activeChannel ? (messagesByChannel[activeChannel] ?? []) : [];
  const filteredChannels = search ? channels.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())) : channels;
  const activeChannelObj = channels.find((c) => c.id === activeChannel);
  const activeName = activeChannelObj?.name ?? '';

  const toggleSave = (msgId: string) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  };

  return (
    <div className="-m-6 flex h-[calc(100vh-40px)]">
      {/* Left sidebar — channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-[#F8F5E6]">
        <div className="p-3">
          <div className="flex items-center gap-2 rounded-md bg-white/70 px-3 py-1.5">
            <Search size={14} className="text-neutral-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索 ⌘K" className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400" />
          </div>
        </div>

        <div className="flex gap-4 px-4 pb-2">
          <button className="flex items-center gap-1.5 text-xs font-medium text-neutral-700"><Inbox size={14} /> 收件箱</button>
          <button className="flex items-center gap-1.5 text-xs text-neutral-500"><Bookmark size={14} /> 已收藏</button>
        </div>

        <div className="border-t border-neutral-300/40" />

        <div className="flex-1 overflow-y-auto px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">频道 {channels.length}</span>
            <button onClick={() => setShowNewChannel(true)} className="text-neutral-400 hover:text-neutral-700"><Plus size={14} /></button>
          </div>
          {filteredChannels.map((ch) => (
            <button key={ch.id} onClick={() => setActiveChannel(ch.id)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === ch.id ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
              <Hash size={14} className="text-neutral-400 shrink-0" />
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
          {filteredChannels.length === 0 && <div className="px-2 py-4 text-center text-xs text-neutral-400">暂无频道</div>}

          <div className="mt-4 mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">私信 0</span>
          </div>
          <div className="px-2 text-xs text-neutral-400">暂无私信</div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Channel header */}
        {activeChannel && (
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Hash size={14} className="text-neutral-400 shrink-0" />
                <span className="text-sm font-semibold truncate">{activeName}</span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-400 truncate">— 通用频道</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="停止所有 Agent">
                <SquareDot size={14} />
              </button>
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="编辑频道">
                <Pencil size={14} />
              </button>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100" title="查看参与者">
                <Users size={14} />
                <span>{Object.keys(agents).length + (currentUser ? 1 : 0)}</span>
              </button>
            </div>
          </div>
        )}

        {/* Tabs */}
        {activeChannel && (
          <div className="flex border-b border-neutral-200">
            <button onClick={() => setTab('chat')} className={`border-b-2 px-4 py-2 text-xs font-medium tracking-wide ${tab === 'chat' ? 'border-amber-400 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>聊天</button>
            <button onClick={() => setTab('tasks')} className={`border-b-2 px-4 py-2 text-xs tracking-wide ${tab === 'tasks' ? 'border-amber-400 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>任务</button>
          </div>
        )}

        {tab === 'chat' ? (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {!activeChannel && <div className="py-12 text-center text-sm text-neutral-400">选择一个频道开始聊天</div>}
              {activeChannel && messages.length === 0 && (
                <div className="py-8 text-center text-xs text-neutral-400">
                  <div className="mb-1">消息的开头</div>
                  <div className="text-neutral-300">发送第一条消息开始对话</div>
                </div>
              )}
              {activeChannel && messages.length > 0 && (
                <div className="mb-4 text-center text-xs text-neutral-300">消息的开头</div>
              )}
              <div className="space-y-4">
                {messages.map((msg) => (
                  <ChatBubble key={msg.id} msg={msg} saved={savedIds.has(msg.id)} onToggleSave={() => toggleSave(msg.id)} />
                ))}
              </div>
              <div ref={messagesEndRef} />
            </div>

            {activeChannel && (
              <div className="border-t border-neutral-200 p-3">
                <div className="rounded-lg border border-neutral-300 bg-white">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    rows={2}
                    placeholder={`Message #${activeName}`}
                    className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400"
                  />
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <button className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="附件图片">
                        <Image size={16} />
                      </button>
                      <button className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="附件文件">
                        <Paperclip size={16} />
                      </button>
                      <label className="flex items-center gap-1 ml-1 cursor-pointer text-neutral-400 hover:text-neutral-600">
                        <input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} className="rounded border-neutral-300" />
                        <span className="text-xs">As Task</span>
                      </label>
                    </div>
                    <button onClick={sendMessage} disabled={!input.trim()} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40">
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">任务看板开发中...</div>
        )}
      </div>

      {showNewChannel && <NewChannelDialog onClose={() => setShowNewChannel(false)} />}
    </div>
  );
}

function ChatBubble({ msg, saved, onToggleSave }: { msg: ChatMessage; saved: boolean; onToggleSave: () => void }) {
  const agent = useAgentBeanStore((s) => msg.senderId ? s.agents[msg.senderId] : undefined);
  const currentUser = useAgentBeanStore((s) => s.currentUser);

  if (msg.senderKind === 'system') {
    return (
      <div className="mx-auto my-1 max-w-prose rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700">
        {msg.body}
      </div>
    );
  }

  const isHuman = msg.senderKind === 'human';
  const speaker = isHuman
    ? (currentUser?.username ?? '你')
    : (agent?.name ?? msg.senderId ?? 'Agent');
  const time = formatTime(msg.createdAt);
  const isOwner = isHuman && currentUser?.id === msg.senderId;
  const parts = parseMentions(msg.body);

  return (
    <div className="group relative flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700">
        {speaker[0].toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-900">{speaker}</span>
          {isOwner && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">owner</span>}
          {!isHuman && agent?.role && <span className="text-xs text-neutral-400">{agent.role}</span>}
          <span className="text-[10px] text-neutral-400">{time}</span>
        </div>
        <div className="mt-1 whitespace-pre-wrap text-sm text-neutral-700 leading-relaxed">
          {parts.map((part, i) =>
            part.type === 'mention'
              ? <span key={i} className="font-medium text-blue-600 hover:underline cursor-pointer">{part.text}</span>
              : <span key={i}>{part.text}</span>
          )}
        </div>
      </div>
      <button onClick={onToggleSave} className={`absolute -right-1 top-0 flex h-6 w-6 items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity ${saved ? 'text-amber-500 opacity-100' : 'text-neutral-400 hover:text-neutral-600'}`}>
        {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
      </button>
    </div>
  );
}

function formatTime(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) {
    return `昨天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffDays < 7) {
    return `${diffDays}天前`;
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function parseMentions(body: string): { type: 'text' | 'mention'; text: string }[] {
  const regex = /@(\w+)/g;
  const parts: { type: 'text' | 'mention'; text: string }[] = [];
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: body.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'mention', text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push({ type: 'text', text: body.slice(lastIndex) });
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: body }];
}
