'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Hash, Search, Plus, Inbox, Bookmark, Image, Paperclip, Send, SquareDot, Pencil, Users, BookmarkCheck, Lock, MessageSquare, X } from 'lucide-react';
import { getWebSocket, dmEvents, channelEvents, memberEvents } from '@/lib/socket';
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
  const dms = useAgentBeanStore((s) => s.dms);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);

  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'chat' | 'tasks'>('chat');
  const [asTask, setAsTask] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showEditChannel, setShowEditChannel] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionMembers, setMentionMembers] = useState<{ id: string; name: string; kind: 'human' | 'agent' }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to channels + DMs
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
    const unsubDm = dmEvents().onSnapshot((list) => applyDmsSnapshot(list));
    return () => { socket.off('channels:snapshot', handler); unsubDm(); };
  }, [conn, applyChannelsSnapshot, applyDmsSnapshot]);

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

  // Fetch members for @mention
  useEffect(() => {
    if (conn !== 'open') return;
    memberEvents().list().then((res) => {
      if (!res.ok) return;
      const members: { id: string; name: string; kind: 'human' | 'agent' }[] = [];
      if (res.humans) {
        for (const h of res.humans) members.push({ id: h.userId, name: h.username, kind: 'human' });
      }
      if (res.agents) {
        for (const a of res.agents) members.push({ id: a.id, name: a.name, kind: 'agent' });
      }
      setMentionMembers(members);
    });
  }, [conn]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atMatch = before.match(/@(\w*)$/);
    if (atMatch) {
      setShowMention(true);
      setMentionQuery(atMatch[1].toLowerCase());
      setMentionIndex(0);
    } else {
      setShowMention(false);
    }
  };

  const filteredMentionMembers = mentionQuery
    ? mentionMembers.filter((m) => m.name.toLowerCase().includes(mentionQuery))
    : mentionMembers;

  const selectMention = (member: { id: string; name: string; kind: 'human' | 'agent' }) => {
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const newBefore = before.replace(/@\w*$/, `@${member.name} `);
    setInput(newBefore + after);
    setShowMention(false);
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = newBefore.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMention && filteredMentionMembers.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredMentionMembers.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(filteredMentionMembers[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMention(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const sendMessage = () => {
    if (!input.trim() || !activeChannel) return;
    getWebSocket().emit('message:send', { channelId: activeChannel, body: input.trim() });
    setInput('');
  };

  const messages = activeChannel ? (messagesByChannel[activeChannel] ?? []) : [];
  const filteredChannels = search ? channels.filter((c) => c.name.toLowerCase().includes(search.toLowerCase())) : channels;

  // Debounced message search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!search.trim()) { setSearchResults(null); return; }
    searchTimerRef.current = setTimeout(async () => {
      const res = await channelEvents().searchMessages(search.trim(), 20);
      if (res.ok && res.messages) setSearchResults(res.messages);
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);
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
              {ch.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
          {filteredChannels.length === 0 && <div className="px-2 py-4 text-center text-xs text-neutral-400">暂无频道</div>}

          <div className="mt-4 mb-1 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">私信 {dms.length}</span>
          </div>
          {dms.map((dm) => (
            <button key={dm.id} onClick={() => setActiveChannel(dm.id)} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === dm.id ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
              <MessageSquare size={14} className="text-neutral-400 shrink-0" />
              <span className="truncate">{dm.name}</span>
            </button>
          ))}
          {dms.length === 0 && <div className="px-2 text-xs text-neutral-400">暂无私信</div>}

          {searchResults && searchResults.length > 0 && (
            <>
              <div className="mt-4 mb-1 px-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">消息搜索结果</span>
              </div>
              {searchResults.map((msg) => (
                <button key={msg.id} onClick={() => { setActiveChannel(msg.channelId); setSearch(''); setSearchResults(null); }} className="w-full px-2 py-1.5 text-left text-xs hover:bg-white/50 rounded">
                  <div className="truncate text-neutral-700">{msg.body.slice(0, 60)}</div>
                  <div className="mt-0.5 text-[10px] text-neutral-400">{msg.senderKind} · {formatTime(msg.createdAt)}</div>
                </button>
              ))}
            </>
          )}
          {searchResults && searchResults.length === 0 && search.trim() && (
            <div className="mt-2 px-2 text-xs text-neutral-400">无搜索结果</div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Channel header */}
        {activeChannel && (
          <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {activeChannelObj?.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
                <span className="text-sm font-semibold truncate">{activeName}</span>
              </div>
              <div className="mt-0.5 text-xs text-neutral-400 truncate">— 通用频道</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="停止所有 Agent">
                <SquareDot size={14} />
              </button>
              <button onClick={() => setShowEditChannel(true)} className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="编辑频道">
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
                <div className="relative rounded-lg border border-neutral-300 bg-white">
                  {/* Mention popup */}
                  {showMention && filteredMentionMembers.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg z-10">
                      {filteredMentionMembers.map((m, i) => (
                        <button
                          key={m.id}
                          onClick={() => selectMention(m)}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === mentionIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-neutral-50'}`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${m.kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>
                            {m.kind === 'agent' ? 'A' : 'H'}
                          </span>
                          <span className="truncate">{m.name}</span>
                          <span className="ml-auto text-[10px] text-neutral-400">{m.kind === 'agent' ? 'Agent' : '人类'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleInputKeyDown}
                    rows={2}
                    placeholder={`Message #${activeName}  (输入 @ 提及成员)`}
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
      {showEditChannel && activeChannelObj && (
        <ChannelEditDialog
          channel={activeChannelObj}
          onClose={() => setShowEditChannel(false)}
          onSaved={() => setShowEditChannel(false)}
        />
      )}
    </div>
  );
}

function ChannelEditDialog({ channel, onClose, onSaved }: { channel: { id: string; name: string; visibility?: string }; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(channel.name);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || name.trim() === channel.name) return onSaved();
    setSaving(true);
    await channelEvents().update({ channelId: channel.id, name: name.trim() });
    setSaving(false);
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">编辑频道</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">频道名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
          </div>
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            {channel.visibility === 'private' ? <Lock size={12} /> : <Hash size={12} />}
            <span>{channel.visibility === 'private' ? '私有频道' : '公开频道'}</span>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100">取消</button>
          <button onClick={handleSave} disabled={saving || !name.trim()} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
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
