'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Hash, Search, Plus, Inbox, Bookmark, Image, Paperclip, Send, SquareDot, Pencil, Users, BookmarkCheck, Lock, MessageSquare, X, MoreHorizontal, Copy, Trash2, Circle, FolderOpen, ChevronRight } from 'lucide-react';
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
  const searchParams = useSearchParams();
  const dmParam = searchParams.get('dm');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'chat' | 'tasks' | 'files'>('chat');
  const [asTask, setAsTask] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showEditChannel, setShowEditChannel] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [sidebarView, setSidebarView] = useState<'channels' | 'search' | 'inbox' | 'saved'>('channels');
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [dmsExpanded, setDmsExpanded] = useState(true);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [_searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
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
    const unsubDm = dmEvents().onSnapshot((list) => {
      applyDmsSnapshot(list);
      if (dmParam && list.some((d) => d.id === dmParam)) {
        setActiveChannel(dmParam);
      }
    });
    return () => { socket.off('channels:snapshot', handler); unsubDm(); };
  }, [conn, applyChannelsSnapshot, applyDmsSnapshot]);

  const handleMessage = useCallback((msg: ChatMessage) => {
    appendMessage(msg);
  }, [appendMessage]);

  useEffect(() => {
    if (!activeChannel || conn !== 'open') return;
    const socket = getWebSocket();
    socket.emit('channel:join', { channelId: activeChannel });
    const onHistory = (payload: { channelId: string; messages: ChatMessage[] }) => {
      if (payload.channelId === activeChannel) applyChannelHistory(activeChannel, payload.messages);
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', handleMessage);
    return () => { socket.off('channel:history', onHistory); socket.off('channel:message', handleMessage); };
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

  const activeChannelObj = channels.find((c) => c.id === activeChannel);
  const activeName = activeChannelObj?.name ?? '';
  const activeDm = dms.find((d) => d.id === activeChannel);
  const isDm = !!activeDm;

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    const atMatch = before.match(/@([\w-]*)$/);
    if (atMatch) {
      setShowMention(true);
      setMentionQuery(atMatch[1].toLowerCase());
      setMentionIndex(0);
    } else {
      setShowMention(false);
    }
  };

  // In DM channels, only show the DM target in mention dropdown
  const dmTargetMember = isDm && activeDm
    ? mentionMembers.find((m) => m.id === activeDm.dmTargetId)
    : null;

  const filteredMentionMembers = isDm
    ? (dmTargetMember ? [dmTargetMember] : [])
    : (mentionQuery
        ? mentionMembers.filter((m) => m.name.toLowerCase().includes(mentionQuery))
        : mentionMembers);

  const selectMention = (member: { id: string; name: string; kind: 'human' | 'agent' }) => {
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const after = input.slice(cursor);
    const newBefore = before.replace(/@[\w-]*$/, `@${member.name} `);
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

  const toggleSave = (msgId: string) => {
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar — channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-[#F8F5E6]">
        {/* Chat label */}
        <div className="flex h-14 items-center border-b border-neutral-300/40 px-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">聊天</div>

        {/* Search / Inbox / Saved buttons */}
        <div className="px-2 py-2 space-y-0.5">
          <button onClick={() => { setSidebarView(sidebarView === 'search' ? 'channels' : 'search'); setSearch(''); setSearchResults(null); }} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'search' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Search size={14} className="text-neutral-400 shrink-0" />
            <span>搜索</span>
            <span className="ml-auto text-[10px] text-neutral-400">⌘K</span>
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'inbox' ? 'channels' : 'inbox')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'inbox' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Inbox size={14} className="text-neutral-400 shrink-0" />
            <span>收件箱</span>
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'saved' ? 'channels' : 'saved')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'saved' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Bookmark size={14} className="text-neutral-400 shrink-0" />
            <span>已收藏</span>
          </button>
        </div>

        <div className="border-t border-neutral-300/40 mx-2" />

        {/* Channel list + DM list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {/* Channels */}
          <div className="mb-1">
            <div onClick={() => setChannelsExpanded((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700 cursor-pointer">
              <ChevronRight size={10} className={`shrink-0 transition-transform ${channelsExpanded ? 'rotate-90' : ''}`} />
              频道
              <span className="ml-1 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{channels.length}</span>
              <button onClick={(e) => { e.stopPropagation(); setShowNewChannel(true); }} className="ml-auto text-neutral-400 hover:text-neutral-700"><Plus size={13} /></button>
            </div>
          </div>
          {channelsExpanded && (
            <div className="space-y-0.5">
              {filteredChannels.map((ch) => (
                <button key={ch.id} onClick={() => { setActiveChannel(ch.id); setSidebarView('channels'); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === ch.id && sidebarView === 'channels' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
                  {ch.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
                  <span className="truncate">{ch.name}</span>
                </button>
              ))}
              {filteredChannels.length === 0 && <div className="px-2 py-2 text-center text-xs text-neutral-400">暂无频道</div>}
            </div>
          )}

          {/* DMs */}
          <div className="mt-3 mb-1">
            <button onClick={() => setDmsExpanded((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700">
              <ChevronRight size={10} className={`shrink-0 transition-transform ${dmsExpanded ? 'rotate-90' : ''}`} />
              私信
              <span className="ml-1 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{dms.length}</span>
            </button>
          </div>
          {dmsExpanded && (
            <div className="space-y-0.5">
              {dms.map((dm) => {
                const dmAgent = agents[dm.dmTargetId];
                const dmStatus = dmAgent?.status;
                return (
                  <button key={dm.id} onClick={() => { setActiveChannel(dm.id); setSidebarView('channels'); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === dm.id && sidebarView === 'channels' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
                    <MessageSquare size={14} className="text-neutral-400 shrink-0" />
                    <span className="truncate">{dm.name}</span>
                    {dmStatus && (
                      <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${dmStatus === 'online' ? 'bg-emerald-50 text-emerald-600' : dmStatus === 'busy' ? 'bg-amber-50 text-amber-600' : 'bg-neutral-100 text-neutral-400'}`}>{dmStatus === 'online' ? '在线' : dmStatus === 'busy' ? '忙碌' : '离线'}</span>
                    )}
                  </button>
                );
              })}
              {dms.length === 0 && <div className="px-2 text-xs text-neutral-400">暂无私信</div>}
            </div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col min-w-0">
        {sidebarView === 'search' ? (
          <SearchView onClose={() => setSidebarView('channels')} onJump={(chId) => { setActiveChannel(chId); setSidebarView('channels'); }} />
        ) : sidebarView === 'inbox' ? (
          <InboxView />
        ) : sidebarView === 'saved' ? (
          <SavedView savedIds={savedIds} />
        ) : (
        <>
        {/* Channel header */}
        {activeChannel && (
          <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {activeChannelObj?.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
              <span className="text-sm font-semibold truncate">{activeName}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  placeholder="搜索消息..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-48 rounded-md border border-neutral-200 bg-neutral-50 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400"
                />
              </div>
              <button className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="停止所有 Agent">
                <SquareDot size={14} />
              </button>
              <button onClick={() => setShowEditChannel(true)} className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="编辑频道">
                <Pencil size={14} />
              </button>
              <div className="relative">
                <button onClick={() => setShowMembers((v) => !v)} className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100" title="查看参与者">
                  <Users size={14} />
                  <span>{Object.keys(agents).length + (currentUser ? 1 : 0)}</span>
                </button>
                {showMembers && (
                  <div className="absolute right-0 top-9 z-20 w-56 rounded-lg border border-neutral-200 bg-white py-2 shadow-lg">
                    <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">成员</div>
                    {currentUser && (
                      <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] font-semibold text-emerald-700">{currentUser.username[0]?.toUpperCase()}</div>
                        <span className="truncate">{currentUser.username}</span>
                        <span className="ml-auto rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">你</span>
                      </div>
                    )}
                    {Object.values(agents).map((a) => (
                      <div key={a.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-100 text-[10px] font-semibold text-purple-700">{a.name[0]?.toUpperCase()}</div>
                        <span className="truncate">{a.name}</span>
                        <Circle size={6} className={`ml-auto shrink-0 fill-current ${a.status === 'online' ? 'text-emerald-500' : a.status === 'busy' ? 'text-amber-500' : 'text-neutral-300'}`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        {activeChannel && (
          <div className="flex border-b border-neutral-200">
            <button onClick={() => setTab('chat')} className={`border-b-2 px-4 py-2 text-xs font-medium tracking-wide ${tab === 'chat' ? 'border-amber-400 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>聊天</button>
            <button onClick={() => setTab('tasks')} className={`border-b-2 px-4 py-2 text-xs tracking-wide ${tab === 'tasks' ? 'border-amber-400 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>任务</button>
            <button onClick={() => setTab('files')} className={`border-b-2 px-4 py-2 text-xs tracking-wide ${tab === 'files' ? 'border-amber-400 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>文件</button>
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
                  {showMention && filteredMentionMembers.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg z-10">
                      {filteredMentionMembers.map((m, i) => (
                        <button key={m.id} onClick={() => selectMention(m)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === mentionIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-neutral-50'}`}>
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${m.kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>{m.kind === 'agent' ? 'A' : 'H'}</span>
                          <span className="truncate">{m.name}</span>
                          <span className="ml-auto text-[10px] text-neutral-400">{m.kind === 'agent' ? 'Agent' : '人类'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleInputKeyDown} rows={2} placeholder={isDm ? `私信 ${activeDm?.name ?? ''}` : `Message #${activeName}  (输入 @ 提及成员)`} className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400" />
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <button className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="附件图片"><Image size={16} /></button>
                      <button className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600" title="附件文件"><Paperclip size={16} /></button>
                      <label className="flex items-center gap-1 ml-1 cursor-pointer text-neutral-400 hover:text-neutral-600"><input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} className="rounded border-neutral-300" /><span className="text-xs">As Task</span></label>
                    </div>
                    <button onClick={sendMessage} disabled={!input.trim()} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40"><Send size={14} /></button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : tab === 'tasks' ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">任务看板开发中...</div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-neutral-400">
            <FolderOpen size={32} strokeWidth={1.5} />
            <span className="text-sm">文件管理开发中...</span>
          </div>
        )}
        </>
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
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.body);
    setCopied(true);
    setShowMenu(false);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative flex gap-1">
      {/* Left action buttons — show on hover */}
      <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity w-6">
        <button onClick={onToggleSave} className={`flex h-5 w-5 items-center justify-center rounded ${saved ? 'text-amber-500' : 'text-neutral-300 hover:text-neutral-500'}`}>
          {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </button>
        <div className="relative">
          <button onClick={() => setShowMenu((v) => !v)} className="flex h-5 w-5 items-center justify-center rounded text-neutral-300 hover:text-neutral-500">
            <MoreHorizontal size={13} />
          </button>
          {showMenu && (
            <div className="absolute left-0 top-6 z-10 w-28 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
              <button onClick={handleCopy} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                <Copy size={12} /> {copied ? '已复制' : '复制'}
              </button>
              {isOwner && (
                <button onClick={() => { setShowMenu(false); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50">
                  <Trash2 size={12} /> 删除
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Avatar */}
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
  const regex = /@([\w-]+)/g;
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

function SearchView({ onClose, onJump }: { onClose: () => void; onJump: (channelId: string) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const channels = useAgentBeanStore((s) => s.channels);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const timer = setTimeout(async () => {
      const res = await channelEvents().searchMessages(query.trim(), 30);
      if (res.ok && res.messages) setResults(res.messages);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const getChannelName = (chId: string) => channels.find((c) => c.id === chId)?.name ?? chId;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-14 items-center border-b border-neutral-200 px-6">
        <div className="flex w-full items-center gap-3">
          <Search size={18} className="text-neutral-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus placeholder="搜索频道、私信、消息..." className="flex-1 text-sm outline-none placeholder:text-neutral-400" />
          <button onClick={onClose} className="rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">ESC</button>
        </div>
      </div>
      <div className="flex gap-2 border-b border-neutral-200 px-6 py-2">
        <button className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white">我的消息</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {results === null && !query.trim() && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
            <Search size={32} strokeWidth={1.5} />
            <p className="mt-2 text-sm font-medium">搜索一切</p>
            <p className="text-xs">搜索频道、私信、成员和消息历史</p>
          </div>
        )}
        {results !== null && results.length === 0 && (
          <div className="py-8 text-center text-sm text-neutral-400">没有找到匹配的结果</div>
        )}
        {results && results.map((msg) => (
          <button key={msg.id} onClick={() => onJump(msg.channelId)} className="mb-2 w-full rounded-lg border border-neutral-100 p-3 text-left hover:bg-neutral-50">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <Hash size={12} /> <span>{getChannelName(msg.channelId)}</span>
              <span>· {formatTime(msg.createdAt)}</span>
            </div>
            <div className="mt-1 truncate text-sm text-neutral-700">{msg.body.slice(0, 120)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function InboxView() {
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);

  const allMessages = Object.values(messagesByChannel).flat();
  const recentMessages = allMessages
    .filter((m) => m.senderKind !== 'system')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-14 flex-col justify-center border-b border-neutral-200 px-6">
        <h2 className="text-lg font-semibold">收件箱</h2>
        <p className="text-xs text-neutral-400">{recentMessages.length} 条消息</p>
      </div>
      <div className="flex gap-2 border-b border-neutral-200 px-6 py-2">
        <button className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white">全部</button>
        <button className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600">未读</button>
        <button className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600">提及</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {recentMessages.length === 0 && (
          <div className="py-12 text-center text-sm text-neutral-400">暂无消息</div>
        )}
        {recentMessages.map((msg) => {
          const agent = useAgentBeanStore.getState().agents[msg.senderId ?? ''];
          const speaker = msg.senderKind === 'human' ? (useAgentBeanStore.getState().currentUser?.username ?? '用户') : (agent?.name ?? msg.senderId ?? 'Agent');
          return (
            <div key={msg.id} className="flex items-start gap-3 border-b border-neutral-100 px-6 py-3 hover:bg-neutral-50">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700">{speaker[0]?.toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900">{speaker}</span>
                  <span className="text-[10px] text-neutral-400">{formatTime(msg.createdAt)}</span>
                </div>
                <div className="truncate text-sm text-neutral-600">{msg.body.slice(0, 100)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SavedView({ savedIds }: { savedIds: Set<string> }) {
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);

  const allMessages = Object.values(messagesByChannel).flat();
  const savedMessages = allMessages.filter((m) => savedIds.has(m.id));

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-14 flex-col justify-center border-b border-neutral-200 px-6">
        <h2 className="text-lg font-semibold">已收藏</h2>
        <p className="text-xs text-neutral-400">{savedIds.size} 条收藏</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {savedMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
            <Bookmark size={32} strokeWidth={1.5} />
            <p className="mt-2 text-sm">暂无收藏消息</p>
            <p className="text-xs">点击消息旁的书签图标收藏消息</p>
          </div>
        )}
        {savedMessages.map((msg) => {
          const agent = useAgentBeanStore.getState().agents[msg.senderId ?? ''];
          const speaker = msg.senderKind === 'human' ? (useAgentBeanStore.getState().currentUser?.username ?? '用户') : (agent?.name ?? msg.senderId ?? 'Agent');
          return (
            <div key={msg.id} className="flex items-start gap-3 border-b border-neutral-100 px-6 py-3 hover:bg-neutral-50">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700">{speaker[0]?.toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900">{speaker}</span>
                  <span className="text-[10px] text-neutral-400">{formatTime(msg.createdAt)}</span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">{msg.body.slice(0, 200)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
