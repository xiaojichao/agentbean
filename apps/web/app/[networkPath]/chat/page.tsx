'use client';

import { useEffect, useState, useRef, useCallback, type ReactNode, type RefObject } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Hash, Search, Plus, Activity, Bookmark, Image, Paperclip, Send, SquareDot, Pencil, Users, BookmarkCheck, Lock, MessageSquare, X, MoreHorizontal, Copy, Trash2, Circle, FolderOpen, ChevronRight, Smile, LayoutGrid, List, ChevronDown, User, Tag, ExternalLink, Download } from 'lucide-react';
import { getResolvedServerUrl, getStoredAuthToken, getWebSocket, dmEvents, channelEvents, memberEvents, taskEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import type { AgentSnapshot, AgentStatus, Artifact, ChatMessage } from '@/lib/schema';
import { NewChannelDialog } from '@/components/new-channel-dialog';

type ChatTab = 'chat' | 'tasks' | 'files';
type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';
type TaskViewMode = 'board' | 'list';

interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  creatorId: string;
  assigneeId: string | null;
  channelId: string | null;
  tags: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface ConversationFile {
  artifact: Artifact;
  messageId: string;
  createdAt: number;
  senderKind: ChatMessage['senderKind'];
  senderId: string | null;
}

const TASK_COLUMNS: { id: TaskStatus; label: string; empty: string; badge: string; collapsedByDefault?: boolean }[] = [
  { id: 'todo', label: '待办', empty: '暂无待办任务。', badge: 'border-orange-200 bg-orange-100 text-orange-700' },
  { id: 'in_progress', label: '进行中', empty: '暂无进行中任务。', badge: 'border-cyan-200 bg-cyan-100 text-cyan-700' },
  { id: 'in_review', label: '待审核', empty: '暂无待审核任务。', badge: 'border-purple-200 bg-purple-100 text-purple-700' },
  { id: 'done', label: '已完成', empty: '暂无已完成任务。', badge: 'border-emerald-200 bg-emerald-100 text-emerald-700', collapsedByDefault: true },
  { id: 'closed', label: '已关闭', empty: '暂无已关闭任务。', badge: 'border-neutral-300 bg-neutral-100 text-neutral-600', collapsedByDefault: true },
];

export default function ChatPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const channels = useAgentBeanStore((s) => s.channels);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentNetworkId = useAgentBeanStore((s) => s.currentNetworkId);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const dms = useAgentBeanStore((s) => s.dms);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);
  const router = useRouter();
  const params = useParams();
  const np = useCurrentNetworkPath();

  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const dmParam = searchParams.get('dm');
  const chatTabParam = searchParams.get('chatTab');
  const threadParam = searchParams.get('thread');
  const routeChannelId = typeof params.channelId === 'string' ? params.channelId : null;
  const routeDmId = typeof params.dmId === 'string' ? params.dmId : null;
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<ChatTab>('chat');
  const [asTask, setAsTask] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showEditChannel, setShowEditChannel] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [sidebarView, setSidebarView] = useState<'channels' | 'search' | 'inbox' | 'saved'>('channels');
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [dmsExpanded, setDmsExpanded] = useState(true);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [reactionIds, setReactionIds] = useState<Set<string>>(new Set());
  const [reactionsLoaded, setReactionsLoaded] = useState(false);
  const [_searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionMembers, setMentionMembers] = useState<{ id: string; name: string; kind: 'human' | 'agent' }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<Artifact[]>([]);
  const [threadAttachments, setThreadAttachments] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadInput, setThreadInput] = useState('');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskView, setTaskView] = useState<TaskViewMode>('board');
  const [taskCreatorFilter, setTaskCreatorFilter] = useState<string>('all');
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState<string>('all');
  const [showCreatorFilter, setShowCreatorFilter] = useState(false);
  const [showAssigneeFilter, setShowAssigneeFilter] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [collapsedTaskColumns, setCollapsedTaskColumns] = useState<Set<TaskStatus>>(() => new Set(TASK_COLUMNS.filter((col) => col.collapsedByDefault).map((col) => col.id)));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadImageInputRef = useRef<HTMLInputElement>(null);
  const threadFileInputRef = useRef<HTMLInputElement>(null);
  const dmsRef = useRef(dms);
  const savedKey = `agentbean:chat:saved:${np}`;
  const reactionsKey = `agentbean:chat:reactions:${np}`;

  useEffect(() => {
    dmsRef.current = dms;
  }, [dms]);

  useEffect(() => {
    if (chatTabParam === 'chat' || chatTabParam === 'tasks' || chatTabParam === 'files') {
      setTab(chatTabParam);
    }
  }, [chatTabParam]);

  // Subscribe to channels + DMs
  useEffect(() => {
    if (conn !== 'open') return;
    const socket = getWebSocket();
    socket.emit('channels:subscribe', {});
    const handler = (list: any[]) => {
      applyChannelsSnapshot(list);
      setActiveChannel((prev) => {
        if (routeChannelId && list.some((c) => c.id === routeChannelId)) return routeChannelId;
        if (routeDmId || dmParam) return prev;
        if (prev && dmsRef.current.some((d) => d.id === prev)) return prev;
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    };
    socket.on('channels:snapshot', handler);
    const unsubDm = dmEvents().onSnapshot((list) => {
      applyDmsSnapshot(list);
      if (routeDmId && list.some((d) => d.id === routeDmId)) {
        setActiveChannel(routeDmId);
      }
      if (dmParam && list.some((d) => d.id === dmParam)) {
        setActiveChannel(dmParam);
      }
    });
    return () => { socket.off('channels:snapshot', handler); unsubDm(); };
  }, [conn, applyChannelsSnapshot, applyDmsSnapshot, dmParam, routeChannelId, routeDmId]);

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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(savedKey);
      setSavedIds(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setSavedIds(new Set());
    }
    setSavedLoaded(true);
  }, [savedKey]);

  useEffect(() => {
    if (!savedLoaded) return;
    try {
      window.localStorage.setItem(savedKey, JSON.stringify([...savedIds]));
    } catch {}
  }, [savedIds, savedKey, savedLoaded]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(reactionsKey);
      setReactionIds(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setReactionIds(new Set());
    }
    setReactionsLoaded(true);
  }, [reactionsKey]);

  useEffect(() => {
    if (!reactionsLoaded) return;
    try {
      window.localStorage.setItem(reactionsKey, JSON.stringify([...reactionIds]));
    } catch {}
  }, [reactionIds, reactionsKey, reactionsLoaded]);

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
  const activeDmAgent = activeDm ? agents[activeDm.dmTargetId] : undefined;
  const activeDmName = activeDmAgent?.name ?? activeDm?.name ?? '';
  const activeDmSubtitle = activeDmAgent?.description?.trim() || activeDmAgent?.role || '智能体私聊';
  const taskParticipants = [
    ...(currentUser ? [{ id: currentUser.id, name: `${currentUser.username}（你）`, kind: 'human' as const }] : []),
    ...Object.values(agents).map((agent) => ({ id: agent.id, name: agent.name, kind: 'agent' as const })),
  ];

  const switchTab = (nextTab: ChatTab) => {
    setTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === 'chat') params.delete('chatTab');
    else params.set('chatTab', nextTab);
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  };

  const setThreadUrl = useCallback((messageId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (messageId && activeChannel) params.set('thread', `${activeChannel}:${messageId}`);
    else params.delete('thread');
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [activeChannel, router, searchParams]);

  const openThread = useCallback((messageId: string) => {
    setThreadRootId(messageId);
    setThreadUrl(messageId);
  }, [setThreadUrl]);

  const closeThread = useCallback(() => {
    setThreadRootId(null);
    setThreadInput('');
    setThreadAttachments([]);
    setThreadUrl(null);
  }, [setThreadUrl]);

  const loadTasks = useCallback(async () => {
    if (!activeChannel || conn !== 'open') return;
    setTasksLoading(true);
    try {
      const res = await taskEvents().list(activeChannel);
      if (res.ok && res.tasks) setTasks(res.tasks as TaskItem[]);
    } finally {
      setTasksLoading(false);
    }
  }, [activeChannel, conn]);

  useEffect(() => {
    if (tab !== 'tasks') return;
    loadTasks();
  }, [tab, loadTasks]);

  useEffect(() => {
    if (!activeChannel) return;
    const nextThreadRootId = parseThreadMessageId(threadParam, activeChannel);
    setThreadRootId((prev) => {
      if (nextThreadRootId) return nextThreadRootId;
      return threadParam === null ? null : prev;
    });
  }, [activeChannel, threadParam]);

  useEffect(() => {
    setTaskCreatorFilter('all');
    setTaskAssigneeFilter('all');
    setShowCreateTask(false);
  }, [activeChannel]);

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

  const uploadFiles = async (files: FileList | File[], target: 'main' | 'thread') => {
    if (!activeChannel || !currentUser || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: Artifact[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('channelId', activeChannel);
        form.append('uploaderId', currentUser.id);
        form.append('file', file);
        const res = await fetch(`${getResolvedServerUrl()}/api/networks/${encodeURIComponent(currentNetworkId)}/artifacts/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${getStoredAuthToken()}` },
          body: form,
        });
        if (!res.ok) throw new Error(await res.text());
        uploaded.push(await res.json());
      }
      if (target === 'thread') setThreadAttachments((prev) => [...prev, ...uploaded]);
      else setPendingAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      appendMessage({
        id: `local-upload-error-${Date.now()}`,
        channelId: activeChannel,
        senderKind: 'system',
        senderId: null,
        body: `附件上传失败：${err instanceof Error ? err.message : 'unknown'}`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'upload-fail' }),
      });
    } finally {
      setUploading(false);
    }
  };

  const sendMessage = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || !activeChannel) return;
    const channelId = activeChannel;
    const body = input.trim();
    const artifactIds = pendingAttachments.map((a) => a.id);
    const createTask = asTask;
    getWebSocket().emit('message:send', { channelId, body: body || '附件', asTask, artifactIds }, (res?: { ok?: boolean; error?: string }) => {
      if (res?.ok) {
        if (createTask && tab === 'tasks') loadTasks();
        return;
      }
      appendMessage({
        id: `local-error-${Date.now()}`,
        channelId,
        senderKind: 'system',
        senderId: null,
        body: `发送失败：${res?.error ?? 'unknown'}`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'send-fail' }),
      });
    });
    setInput('');
    setPendingAttachments([]);
    setAsTask(false);
  };

  const sendThreadMessage = () => {
    if ((!threadInput.trim() && threadAttachments.length === 0) || !activeChannel || !threadRootId) return;
    const channelId = activeChannel;
    const body = threadInput.trim() || '附件';
    const artifactIds = threadAttachments.map((a) => a.id);
    getWebSocket().emit('message:send', { channelId, body, parentMessageId: threadRootId, artifactIds }, (res?: { ok?: boolean; error?: string }) => {
      if (res?.ok) return;
      appendMessage({
        id: `local-thread-error-${Date.now()}`,
        channelId,
        senderKind: 'system',
        senderId: null,
        body: `发送失败：${res?.error ?? 'unknown'}`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'send-fail' }),
      });
    });
    setThreadInput('');
    setThreadAttachments([]);
  };

  const messages = activeChannel ? (messagesByChannel[activeChannel] ?? []) : [];
  const threadRoot = threadRootId ? messages.find((msg) => msg.id === threadRootId) ?? null : null;
  const rootMessages = messages.filter((msg) => !parentMessageId(msg));
  const threadReplies = threadRootId ? messages.filter((msg) => parentMessageId(msg) === threadRootId) : [];
  const conversationFiles = messages
    .flatMap((msg) => (msg.artifacts ?? []).map((artifact) => ({
      artifact,
      messageId: msg.id,
      createdAt: artifact.createdAt || msg.createdAt,
      senderKind: msg.senderKind,
      senderId: msg.senderId,
    } satisfies ConversationFile)))
    .sort((a, b) => b.createdAt - a.createdAt);
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

  const toggleReaction = (msgId: string) => {
    setReactionIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  };

  const handleReply = (msg: ChatMessage) => {
    const speaker = resolveMessageSpeaker(msg, currentUser?.username, agents);
    openThread(msg.id);
    setThreadInput((prev) => {
      const prefix = `回复 ${speaker}: `;
      return prev.trim() ? `${prev}\n${prefix}` : prefix;
    });
  };

  const handleThreadReply = (msg: ChatMessage) => {
    const speaker = resolveMessageSpeaker(msg, currentUser?.username, agents);
    setThreadInput((prev) => {
      const prefix = `回复 ${speaker}: `;
      return prev.trim() ? `${prev}\n${prefix}` : prefix;
    });
  };

  const jumpToMessage = (messageId: string) => {
    setTab('chat');
    setThreadRootId(null);
    setThreadInput('');
    setThreadAttachments([]);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('chatTab');
    params.delete('thread');
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
    setTimeout(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  const viewThreadRootInChannel = () => {
    if (!threadRootId) return;
    switchTab('chat');
    setTimeout(() => {
      document.getElementById(`message-${threadRootId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar — channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-[#F8F5E6]">
        {/* Chat label */}
        <div className="flex h-14 items-center border-b border-neutral-300/40 px-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">聊天</div>

        {/* Search / Activity / Saved buttons */}
        <div className="px-2 py-2 space-y-0.5">
          <button onClick={() => { setSidebarView(sidebarView === 'search' ? 'channels' : 'search'); setSearch(''); setSearchResults(null); }} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'search' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Search size={14} className="text-neutral-400 shrink-0" />
            <span>搜索</span>
            <span className="ml-auto text-[10px] text-neutral-400">⌘K</span>
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'inbox' ? 'channels' : 'inbox')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'inbox' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Activity size={14} className="text-neutral-400 shrink-0" />
            <span>活动</span>
            <span className="ml-auto rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">{Object.values(messagesByChannel).flat().filter((m) => m.senderKind !== 'system').length}</span>
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'saved' ? 'channels' : 'saved')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'saved' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Bookmark size={14} className="text-neutral-400 shrink-0" />
            <span>收藏</span>
            <span className="ml-auto rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{savedIds.size}</span>
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
                <button key={ch.id} onClick={() => { setActiveChannel(ch.id); setSidebarView('channels'); router.push(`/${np}/channel/${ch.id}`); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === ch.id && sidebarView === 'channels' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
                  {ch.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
                  <span className="truncate">{ch.name}</span>
                </button>
              ))}
              {filteredChannels.length === 0 && <div className="px-2 py-2 text-center text-xs text-neutral-400">暂无频道</div>}
            </div>
          )}

          {/* DMs */}
          <div className="mx-2 my-3 border-t border-neutral-300/50" />
          <div className="mb-1">
            <button onClick={() => setDmsExpanded((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700">
              <ChevronRight size={10} className={`shrink-0 transition-transform ${dmsExpanded ? 'rotate-90' : ''}`} />
              私聊
              <span className="ml-1 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{dms.length}</span>
            </button>
          </div>
          {dmsExpanded && (
            <div className="space-y-0.5">
              {dms.map((dm) => {
                const dmAgent = agents[dm.dmTargetId];
                const dmStatus = dmAgent?.status;
                const dmName = dmAgent?.name ?? dm.name;
                const dmSubtitle = dmAgent?.description?.trim() || dmAgent?.role || '智能体私聊';
                return (
                  <button key={dm.id} onClick={() => { setActiveChannel(dm.id); setSidebarView('channels'); router.push(`/${np}/dm/${dm.id}`); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === dm.id && sidebarView === 'channels' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
                    <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-purple-100 text-[10px] font-semibold text-purple-700">
                      {dmName[0]?.toUpperCase() ?? 'A'}
                      <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[#F8F5E6] ${statusDotClass(dmStatus)}`} />
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm leading-4">{dmName}</div>
                      <div className="truncate text-[10px] leading-3 text-neutral-400">{dmSubtitle}</div>
                    </div>
                  </button>
                );
              })}
              {dms.length === 0 && <div className="px-2 text-xs text-neutral-400">暂无私聊</div>}
            </div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col min-w-0">
        {sidebarView === 'search' ? (
          <SearchView onClose={() => setSidebarView('channels')} onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} />
        ) : sidebarView === 'inbox' ? (
          <ActivityView onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} />
        ) : sidebarView === 'saved' ? (
          <SavedView savedIds={savedIds} onUnsave={(msgId) => toggleSave(msgId)} onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} />
        ) : (
        <>
        {/* Conversation header */}
        {activeChannel && (
          <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {isDm ? (
                <>
                  <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-purple-100 text-xs font-semibold text-purple-700">
                    {activeDmName[0]?.toUpperCase() ?? 'A'}
                    <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${statusDotClass(activeDmAgent?.status)}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-neutral-900">{activeDmName}</div>
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-400">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(activeDmAgent?.status)}`} />
                      <span className="shrink-0">{statusLabel(activeDmAgent?.status)}</span>
                      <span className="text-neutral-300">·</span>
                      <span className="truncate">{activeDmSubtitle}</span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {activeChannelObj?.visibility === 'private' ? <Lock size={14} className="shrink-0 text-neutral-400" /> : <Hash size={14} className="shrink-0 text-neutral-400" />}
                  <span className="truncate text-sm font-semibold">{activeName}</span>
                </>
              )}
            </div>
            {!isDm && (
            <div className="flex shrink-0 items-center gap-2">
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
            )}
          </div>
        )}

        {/* Tabs */}
        {activeChannel && (
          <div className="flex border-b border-neutral-200">
            <button onClick={() => switchTab('chat')} className={`border-b-2 px-4 py-2 text-xs font-medium tracking-wide ${tab === 'chat' ? 'border-amber-400 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>聊天</button>
            <button onClick={() => switchTab('tasks')} className={`border-b-2 px-4 py-2 text-xs tracking-wide ${tab === 'tasks' ? 'border-amber-400 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>任务</button>
            <button onClick={() => switchTab('files')} className={`border-b-2 px-4 py-2 text-xs tracking-wide ${tab === 'files' ? 'border-amber-400 font-medium text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>文件</button>
          </div>
        )}

        {tab === 'chat' ? (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {!activeChannel && <div className="py-12 text-center text-sm text-neutral-400">选择一个频道或私聊开始聊天</div>}
              {activeChannel && rootMessages.length === 0 && (
                <div className="py-8 text-center text-xs text-neutral-400">
                  <div className="mb-1">消息的开头</div>
                  <div className="text-neutral-300">发送第一条消息开始对话</div>
                </div>
              )}
              {activeChannel && rootMessages.length > 0 && (
                <div className="mb-4 text-center text-xs text-neutral-300">消息的开头</div>
              )}
              <div className="space-y-4">
                {rootMessages.map((msg) => (
                  <ChatBubble
                    key={msg.id}
                    msg={msg}
                    saved={savedIds.has(msg.id)}
                    reacted={reactionIds.has(msg.id)}
                    onReply={() => handleReply(msg)}
                    onOpenThread={() => openThread(msg.id)}
                    onToggleReaction={() => toggleReaction(msg.id)}
                    onToggleSave={() => toggleSave(msg.id)}
                    replyCount={messages.filter((item) => parentMessageId(item) === msg.id).length}
                  />
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
                  <textarea ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleInputKeyDown} rows={2} placeholder={isDm ? `私聊 @${activeDmName}` : `发送到 #${activeName}  (输入 @ 提及成员)`} className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400" />
                  {pendingAttachments.length > 0 && (
                    <AttachmentStrip
                      attachments={pendingAttachments}
                      onRemove={(id) => setPendingAttachments((prev) => prev.filter((item) => item.id !== id))}
                    />
                  )}
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files, 'main'); e.currentTarget.value = ''; }} />
                      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files, 'main'); e.currentTarget.value = ''; }} />
                      <button onClick={() => imageInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件图片"><Image size={16} /></button>
                      <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件文件"><Paperclip size={16} /></button>
                      <label className="ml-1 flex cursor-pointer items-center gap-1 text-neutral-400 hover:text-neutral-600"><input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} className="rounded border-neutral-300" /><span className="text-xs">作为任务</span></label>
                    </div>
                    <button onClick={sendMessage} disabled={uploading || (!input.trim() && pendingAttachments.length === 0)} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40"><Send size={14} /></button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : tab === 'tasks' ? (
          activeChannel ? (
            <ConversationTasks
              tasks={tasks}
              loading={tasksLoading}
              view={taskView}
              creatorFilter={taskCreatorFilter}
              assigneeFilter={taskAssigneeFilter}
              participants={taskParticipants}
              currentUserId={currentUser?.id}
              defaultAssigneeId={activeDm?.dmTargetId ?? null}
              channelId={activeChannel}
              dragTaskId={dragTaskId}
              collapsedColumns={collapsedTaskColumns}
              showCreatorFilter={showCreatorFilter}
              showAssigneeFilter={showAssigneeFilter}
              showCreate={showCreateTask}
              onViewChange={setTaskView}
              onCreatorFilterChange={setTaskCreatorFilter}
              onAssigneeFilterChange={setTaskAssigneeFilter}
              onToggleCreatorFilter={() => setShowCreatorFilter((v) => !v)}
              onToggleAssigneeFilter={() => setShowAssigneeFilter((v) => !v)}
              onCloseFilters={() => { setShowCreatorFilter(false); setShowAssigneeFilter(false); }}
              onToggleCreate={() => setShowCreateTask((v) => !v)}
              onCloseCreate={() => setShowCreateTask(false)}
              onCreate={(task) => setTasks((prev) => [task, ...prev])}
              onDelete={(taskId) => setTasks((prev) => prev.filter((task) => task.id !== taskId))}
              onDragStart={setDragTaskId}
              onDragEnd={() => setDragTaskId(null)}
              onToggleColumn={(status) => setCollapsedTaskColumns((prev) => {
                const next = new Set(prev);
                if (next.has(status)) next.delete(status); else next.add(status);
                return next;
              })}
              onTaskUpdate={(updated) => setTasks((prev) => prev.map((task) => task.id === updated.id ? updated : task))}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">选择一个频道或私聊查看任务</div>
          )
        ) : (
          <ConversationFiles
            files={conversationFiles}
            agents={agents}
            currentUsername={currentUser?.username}
            onJump={jumpToMessage}
          />
        )}
        </>
      )}
    </div>

      {threadRoot && activeChannel && (
        <ThreadPanel
          root={threadRoot}
          replies={threadReplies}
          agents={agents}
          currentUsername={currentUser?.username}
          title={`线程 — ${isDm ? `@${activeDmName}` : `#${activeName}`}`}
          input={threadInput}
          attachments={threadAttachments}
          uploading={uploading}
          imageInputRef={threadImageInputRef}
          fileInputRef={threadFileInputRef}
          savedIds={savedIds}
          reactionIds={reactionIds}
          onInput={setThreadInput}
          onSend={sendThreadMessage}
          onUpload={(files) => uploadFiles(files, 'thread')}
          onRemoveAttachment={(id) => setThreadAttachments((prev) => prev.filter((item) => item.id !== id))}
          onReply={handleThreadReply}
          onToggleSave={toggleSave}
          onToggleReaction={toggleReaction}
          onViewInChannel={viewThreadRootInChannel}
          onClose={closeThread}
        />
      )}

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

function ConversationTasks({
  tasks,
  loading,
  view,
  creatorFilter,
  assigneeFilter,
  participants,
  currentUserId,
  defaultAssigneeId,
  channelId,
  dragTaskId,
  collapsedColumns,
  showCreatorFilter,
  showAssigneeFilter,
  showCreate,
  onViewChange,
  onCreatorFilterChange,
  onAssigneeFilterChange,
  onToggleCreatorFilter,
  onToggleAssigneeFilter,
  onCloseFilters,
  onToggleCreate,
  onCloseCreate,
  onCreate,
  onDelete,
  onDragStart,
  onDragEnd,
  onToggleColumn,
  onTaskUpdate,
}: {
  tasks: TaskItem[];
  loading: boolean;
  view: TaskViewMode;
  creatorFilter: string;
  assigneeFilter: string;
  participants: { id: string; name: string; kind: 'human' | 'agent' }[];
  currentUserId?: string;
  defaultAssigneeId: string | null;
  channelId: string;
  dragTaskId: string | null;
  collapsedColumns: Set<TaskStatus>;
  showCreatorFilter: boolean;
  showAssigneeFilter: boolean;
  showCreate: boolean;
  onViewChange: (view: TaskViewMode) => void;
  onCreatorFilterChange: (id: string) => void;
  onAssigneeFilterChange: (id: string) => void;
  onToggleCreatorFilter: () => void;
  onToggleAssigneeFilter: () => void;
  onCloseFilters: () => void;
  onToggleCreate: () => void;
  onCloseCreate: () => void;
  onCreate: (task: TaskItem) => void;
  onDelete: (taskId: string) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onToggleColumn: (status: TaskStatus) => void;
  onTaskUpdate: (task: TaskItem) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (showCreate) setAssigneeId(defaultAssigneeId ?? '');
  }, [defaultAssigneeId, showCreate]);

  const filteredTasks = tasks.filter((task) => {
    if (creatorFilter !== 'all' && task.creatorId !== creatorFilter) return false;
    if (assigneeFilter === 'unassigned' && task.assigneeId) return false;
    if (assigneeFilter !== 'all' && assigneeFilter !== 'unassigned' && task.assigneeId !== assigneeFilter) return false;
    return true;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const res = await taskEvents().create({
        title: title.trim(),
        description: description.trim() || undefined,
        status: 'todo',
        assigneeId: assigneeId || undefined,
        channelId,
        tags: ['聊天'],
      });
      if (res.ok && res.task) {
        onCreate(res.task as TaskItem);
        setTitle('');
        setDescription('');
        onCloseCreate();
      }
    } finally {
      setSaving(false);
    }
  };

  const moveTask = async (task: TaskItem, status: TaskStatus) => {
    const maxSort = tasks.filter((item) => item.status === status && item.id !== task.id).reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const optimistic = { ...task, status, sortOrder: maxSort + 1, updatedAt: Date.now() };
    onTaskUpdate(optimistic);
    const res = await taskEvents().update({ id: task.id, status, sortOrder: maxSort + 1 });
    if (res.ok && res.task) onTaskUpdate(res.task as TaskItem);
  };

  const deleteTask = async (taskId: string) => {
    onDelete(taskId);
    await taskEvents().delete(taskId);
  };

  const creatorLabel = creatorFilter === 'all' ? '创建者' : participantName(creatorFilter, participants, currentUserId);
  const assigneeLabel = assigneeFilter === 'all'
    ? '负责人'
    : assigneeFilter === 'unassigned'
      ? '未分配'
      : participantName(assigneeFilter, participants, currentUserId);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4">
        <div className="relative">
          <button onClick={() => { onToggleCreatorFilter(); if (showAssigneeFilter) onToggleAssigneeFilter(); }} className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
            <User size={13} />
            <span>{creatorLabel}</span>
            <ChevronDown size={13} />
          </button>
          {showCreatorFilter && (
            <TaskFilterMenu
              title="创建者"
              value={creatorFilter}
              options={[{ id: 'all', name: '全部创建者' }, ...participants]}
              onSelect={(id) => { onCreatorFilterChange(id); onCloseFilters(); }}
            />
          )}
        </div>
        <div className="relative">
          <button onClick={() => { onToggleAssigneeFilter(); if (showCreatorFilter) onToggleCreatorFilter(); }} className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
            <User size={13} />
            <span>{assigneeLabel}</span>
            <ChevronDown size={13} />
          </button>
          {showAssigneeFilter && (
            <TaskFilterMenu
              title="负责人"
              value={assigneeFilter}
              options={[{ id: 'all', name: '全部负责人' }, { id: 'unassigned', name: '未分配' }, ...participants]}
              onSelect={(id) => { onAssigneeFilterChange(id); onCloseFilters(); }}
            />
          )}
        </div>
        <button onClick={onToggleCreate} className="flex h-8 items-center gap-1 rounded-md bg-pink-500 px-3 text-xs font-semibold text-white hover:bg-pink-600">
          <Plus size={13} />
          新建任务
        </button>
        <div className="flex-1" />
        <div className="flex overflow-hidden rounded-md border border-neutral-300">
          <button onClick={() => onViewChange('board')} className={`flex h-8 items-center gap-1 border-r border-neutral-300 px-2.5 text-xs font-medium ${view === 'board' ? 'bg-amber-300 text-neutral-900' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`} title="看板">
            <LayoutGrid size={13} />
            看板
          </button>
          <button onClick={() => onViewChange('list')} className={`flex h-8 items-center gap-1 px-2.5 text-xs font-medium ${view === 'list' ? 'bg-amber-300 text-neutral-900' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`} title="列表">
            <List size={13} />
            列表
          </button>
        </div>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="grid shrink-0 grid-cols-[minmax(180px,1.2fr)_minmax(180px,1.5fr)_180px_auto] items-end gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-neutral-500">标题</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="任务标题" className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500" />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-neutral-500">描述</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="补充说明" className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500" />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-neutral-500">负责人</span>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm outline-none focus:border-neutral-500">
              <option value="">未分配</option>
              {participants.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={!title.trim() || saving} className="h-9 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50">{saving ? '创建中...' : '创建'}</button>
            <button type="button" onClick={onCloseCreate} className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200" title="取消"><X size={15} /></button>
          </div>
        </form>
      )}

      {view === 'board' ? (
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-4">
          {TASK_COLUMNS.map((column) => {
            const colTasks = filteredTasks.filter((task) => task.status === column.id);
            const collapsed = collapsedColumns.has(column.id);
            return (
              <section key={column.id} className="flex w-72 shrink-0 flex-col border border-neutral-200 bg-neutral-50">
                <button onClick={() => onToggleColumn(column.id)} className="flex h-10 items-center gap-2 border-b border-neutral-200 bg-white px-3 text-left">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${column.badge}`}>{column.label}</span>
                  <span className="text-[11px] text-neutral-400">{colTasks.length}</span>
                  <ChevronDown size={14} className={`ml-auto text-neutral-400 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                </button>
                {!collapsed && (
                  <div
                    className="min-h-32 flex-1 space-y-2 overflow-y-auto p-2"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      const task = tasks.find((item) => item.id === dragTaskId);
                      if (task) moveTask(task, column.id);
                      onDragEnd();
                    }}
                  >
                    {colTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        participants={participants}
                        currentUserId={currentUserId}
                        onDelete={() => deleteTask(task.id)}
                        onMove={(status) => moveTask(task, status)}
                        onDragStart={() => onDragStart(task.id)}
                        onDragEnd={onDragEnd}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div className="flex h-16 items-center justify-center border border-dashed border-neutral-300 bg-white text-xs text-neutral-400">
                        {loading ? '加载中...' : column.empty}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                <th className="pb-2 pr-4 font-medium">编号</th>
                <th className="pb-2 pr-4 font-medium">标题</th>
                <th className="pb-2 pr-4 font-medium">状态</th>
                <th className="pb-2 pr-4 font-medium">创建者</th>
                <th className="pb-2 pr-4 font-medium">负责人</th>
                <th className="pb-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((task) => (
                <tr key={task.id} className="border-b border-neutral-100">
                  <td className="py-2 pr-4 text-xs text-neutral-400">#{task.id.slice(-6)}</td>
                  <td className="max-w-lg py-2 pr-4">
                    <div className="font-medium text-neutral-900">{task.title}</div>
                    {task.description && <div className="mt-0.5 truncate text-xs text-neutral-500">{task.description}</div>}
                  </td>
                  <td className="py-2 pr-4">
                    <select value={task.status} onChange={(e) => moveTask(task, e.target.value as TaskStatus)} className="h-7 rounded-md border border-neutral-200 bg-white px-2 text-xs">
                      {TASK_COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
                    </select>
                  </td>
                  <td className="py-2 pr-4 text-xs text-neutral-600">{participantName(task.creatorId, participants, currentUserId)}</td>
                  <td className="py-2 pr-4 text-xs text-neutral-600">{task.assigneeId ? participantName(task.assigneeId, participants, currentUserId) : '未分配'}</td>
                  <td className="py-2">
                    <button onClick={() => deleteTask(task.id)} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-500" title="删除任务">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredTasks.length === 0 && (
                <tr><td colSpan={6} className="py-10 text-center text-sm text-neutral-400">{loading ? '加载中...' : '暂无任务'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TaskFilterMenu({ title, value, options, onSelect }: { title: string; value: string; options: { id: string; name: string }[]; onSelect: (id: string) => void }) {
  return (
    <div className="absolute left-0 top-9 z-20 w-48 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
      <div className="px-3 py-1 text-[10px] font-semibold text-neutral-400">{title}</div>
      {options.map((option) => (
        <button key={option.id} onClick={() => onSelect(option.id)} className={`flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-neutral-50 ${value === option.id ? 'font-medium text-neutral-900' : 'text-neutral-600'}`}>
          <span className="truncate">{option.name}</span>
        </button>
      ))}
    </div>
  );
}

function TaskCard({
  task,
  participants,
  currentUserId,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  task: TaskItem;
  participants: { id: string; name: string; kind: 'human' | 'agent' }[];
  currentUserId?: string;
  onDelete: () => void;
  onMove: (status: TaskStatus) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <article draggable onDragStart={onDragStart} onDragEnd={onDragEnd} className="group cursor-grab border-2 border-neutral-900 bg-white p-3 shadow-sm active:cursor-grabbing">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-neutral-400">#{task.id.slice(-6)}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-5 text-neutral-900">{task.title}</div>
        </div>
        <button onClick={onDelete} className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-300 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100" title="删除任务">
          <Trash2 size={13} />
        </button>
      </div>
      {task.description && <div className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-500">{task.description}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        <span className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
          <User size={10} />
          {participantName(task.creatorId, participants, currentUserId)}
        </span>
        <span className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
          <User size={10} />
          {task.assigneeId ? participantName(task.assigneeId, participants, currentUserId) : '未分配'}
        </span>
        {task.tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
            <Tag size={9} />
            {tag}
          </span>
        ))}
      </div>
      <select value={task.status} onChange={(e) => onMove(e.target.value as TaskStatus)} className="mt-3 h-7 w-full border border-neutral-300 bg-white px-2 text-xs font-medium text-neutral-700">
        {TASK_COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
      </select>
    </article>
  );
}

function ConversationFiles({
  files,
  agents,
  currentUsername,
  onJump,
}: {
  files: ConversationFile[];
  agents: Record<string, AgentSnapshot>;
  currentUsername?: string;
  onJump: (messageId: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-white p-4">
      {files.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-400">
          <FolderOpen size={32} strokeWidth={1.5} />
          <span className="text-sm">暂无文件</span>
        </div>
      ) : (
        <div className="space-y-2">
          {files.map((file) => {
            const isImage = file.artifact.mimeType.startsWith('image/');
            const previewUrl = artifactUrl(isImage ? file.artifact.previewUrl : file.artifact.downloadUrl);
            const downloadUrl = artifactUrl(file.artifact.downloadUrl);
            return (
              <div key={`${file.messageId}-${file.artifact.id}`} className="flex min-h-20 items-center gap-3 border border-neutral-300 bg-white px-3 py-2 hover:border-neutral-900">
                <a href={previewUrl} target="_blank" rel="noreferrer" className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden border border-neutral-200 bg-neutral-50" title="预览文件">
                  {isImage ? (
                    <img src={artifactUrl(file.artifact.previewUrl)} alt={file.artifact.filename} className="h-full w-full object-cover" />
                  ) : (
                    <Paperclip size={20} className="text-neutral-400" />
                  )}
                </a>
                <a href={previewUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1" title="预览文件">
                  <div className="truncate text-sm font-semibold text-neutral-900">{file.artifact.filename}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    <span>{formatFileSize(file.artifact.sizeBytes)}</span>
                    <span className="text-neutral-300">·</span>
                    <span>{formatDateTime(file.createdAt)}</span>
                    <span className="text-neutral-300">·</span>
                    <span>{speakerName({ id: file.messageId, channelId: '', senderKind: file.senderKind, senderId: file.senderId, body: '', createdAt: file.createdAt }, agents, currentUsername)}</span>
                  </div>
                </a>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => onJump(file.messageId)} className="flex h-8 w-8 items-center justify-center border border-neutral-900 text-neutral-700 hover:bg-amber-50" title="跳转到原消息">
                    <ExternalLink size={15} />
                  </button>
                  <a href={downloadUrl} target="_blank" rel="noreferrer" className="flex h-8 w-8 items-center justify-center border border-neutral-900 text-neutral-700 hover:bg-amber-50" title="下载文件">
                    <Download size={15} />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThreadPanel({
  root,
  replies,
  agents,
  currentUsername,
  title,
  input,
  attachments,
  uploading,
  imageInputRef,
  fileInputRef,
  savedIds,
  reactionIds,
  onInput,
  onSend,
  onUpload,
  onRemoveAttachment,
  onReply,
  onToggleSave,
  onToggleReaction,
  onViewInChannel,
  onClose,
}: {
  root: ChatMessage;
  replies: ChatMessage[];
  agents: Record<string, AgentSnapshot>;
  currentUsername?: string;
  title: string;
  input: string;
  attachments: Artifact[];
  uploading: boolean;
  imageInputRef: RefObject<HTMLInputElement>;
  fileInputRef: RefObject<HTMLInputElement>;
  savedIds: Set<string>;
  reactionIds: Set<string>;
  onInput: (value: string) => void;
  onSend: () => void;
  onUpload: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onReply: (msg: ChatMessage) => void;
  onToggleSave: (msgId: string) => void;
  onToggleReaction: (msgId: string) => void;
  onViewInChannel: () => void;
  onClose: () => void;
}) {
  const subtitle = taskLabel(root) ?? resolveMessageSpeaker(root, currentUsername, agents);
  const renderThreadBubble = (msg: ChatMessage, replyCount = 0) => (
    <ChatBubble
      key={msg.id}
      msg={msg}
      saved={savedIds.has(msg.id)}
      reacted={reactionIds.has(msg.id)}
      onReply={() => onReply(msg)}
      onOpenThread={() => {}}
      onToggleReaction={() => onToggleReaction(msg.id)}
      onToggleSave={() => onToggleSave(msg.id)}
      replyCount={replyCount}
    />
  );
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-neutral-200 bg-white">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-900">{title}</div>
          <div className="truncate text-xs text-neutral-400">{subtitle}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={onViewInChannel} className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900" title="在频道中查看">
            <ExternalLink size={13} />
            <span>在频道中查看</span>
          </button>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭线程">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {renderThreadBubble(root, replies.length)}
        <div className="border-t border-neutral-100 pt-3 text-center text-[11px] text-neutral-400">
          <div>回复的开头</div>
          <div>{replies.length === 0 ? '暂无回复' : `${replies.length} 条回复`}</div>
        </div>
        {replies.map((msg) => renderThreadBubble(msg))}
      </div>
      <div className="border-t border-neutral-200 p-3">
        <div className="rounded-lg border border-neutral-300 bg-white">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={2}
            placeholder="回复线程"
            className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400"
          />
          {attachments.length > 0 && <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />}
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) onUpload(e.target.files); e.currentTarget.value = ''; }} />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) onUpload(e.target.files); e.currentTarget.value = ''; }} />
              <button onClick={() => imageInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件图片">
                <Image size={16} />
              </button>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件文件">
                <Paperclip size={16} />
              </button>
            </div>
            <button onClick={onSend} disabled={uploading || (!input.trim() && attachments.length === 0)} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40">
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function AttachmentStrip({ attachments, onRemove }: { attachments: Artifact[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-neutral-100 px-2 py-2">
      {attachments.map((artifact) => (
        <div key={artifact.id} className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600">
          {artifact.mimeType.startsWith('image/') ? <Image size={12} /> : <Paperclip size={12} />}
          <span className="truncate">{artifact.filename}</span>
          <button onClick={() => onRemove(artifact.id)} className="text-neutral-400 hover:text-neutral-700" title="移除附件">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ChatBubble({
  msg,
  saved,
  reacted,
  onReply,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  replyCount,
}: {
  msg: ChatMessage;
  saved: boolean;
  reacted: boolean;
  onReply: () => void;
  onOpenThread: () => void;
  onToggleReaction: () => void;
  onToggleSave: () => void;
  replyCount: number;
}) {
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
  const meta = parseMeta(msg);
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.body);
    setCopied(true);
    setShowMenu(false);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div id={`message-${msg.id}`} className="group relative flex gap-2 rounded-md border border-transparent px-2 py-2 transition-colors hover:border-neutral-900 hover:bg-white">
      <div className="pointer-events-none absolute right-2 top-1 z-10 flex items-center gap-0.5 border border-neutral-300 bg-white opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <button onClick={onReply} className="flex h-6 w-6 items-center justify-center border-r border-neutral-200 text-neutral-500 hover:bg-amber-50 hover:text-neutral-900" title="回复线程">
          <MessageSquare size={13} />
        </button>
        <button onClick={onToggleReaction} className={`flex h-6 w-6 items-center justify-center border-r border-neutral-200 hover:bg-amber-50 ${reacted ? 'text-pink-600' : 'text-neutral-500 hover:text-neutral-900'}`} title={reacted ? '取消表情' : '添加表情'}>
          <Smile size={13} />
        </button>
        <button onClick={onToggleSave} className={`flex h-6 w-6 items-center justify-center border-r border-neutral-200 hover:bg-amber-50 ${saved ? 'text-amber-500' : 'text-neutral-500 hover:text-neutral-900'}`} title={saved ? '取消收藏' : '收藏消息'}>
          {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </button>
        <div className="relative">
          <button onClick={() => setShowMenu((v) => !v)} className="flex h-6 w-6 items-center justify-center text-neutral-500 hover:bg-amber-50 hover:text-neutral-900" title="更多操作">
            <MoreHorizontal size={13} />
          </button>
          {showMenu && (
            <div className="absolute right-0 top-7 z-20 w-28 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
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
        <MarkdownMessage body={msg.body} />
        {msg.artifacts && msg.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {msg.artifacts.map((artifact) => (
              <ChatArtifactPreview key={artifact.id} artifact={artifact} />
            ))}
          </div>
        )}
        {(taskId || replyCount > 0 || reacted || saved) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {taskId && (
              <button onClick={onOpenThread} className="inline-flex h-5 items-center gap-1 border border-purple-200 bg-purple-50 px-1.5 text-[11px] font-medium text-purple-700 hover:bg-purple-100" title="查看任务线程">
                <span>#</span>
                <span>{taskId.slice(-6)}</span>
              </button>
            )}
            {replyCount > 0 && (
              <button onClick={onOpenThread} className="inline-flex h-5 items-center gap-1 border border-sky-200 bg-sky-50 px-1.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100" title="打开线程">
                <MessageSquare size={11} />
                <span>{replyCount} 条回复</span>
              </button>
            )}
            {reacted && (
              <button onClick={onToggleReaction} className="inline-flex h-5 items-center gap-1 border border-pink-200 bg-pink-50 px-1.5 text-[11px] font-medium text-pink-700 hover:bg-pink-100" title="取消表情">
                <span>❤️</span>
                <span>1</span>
              </button>
            )}
            {saved && (
              <span className="inline-flex h-5 items-center gap-1 border border-amber-200 bg-amber-50 px-1.5 text-[11px] font-medium text-amber-700">
                <BookmarkCheck size={11} />
                已收藏
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownMessage({ body }: { body: string }) {
  return (
    <div className="mt-1 space-y-2 break-words text-sm leading-relaxed text-neutral-700">
      {renderMarkdownBlocks(body)}
    </div>
  );
}

function renderMarkdownBlocks(body: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(
        <pre key={`code-${nodes.length}`} className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-950 px-3 py-2 text-xs leading-relaxed text-neutral-100">
          {fence[1] && <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">{fence[1]}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const className = headingClassName(level);
      nodes.push(<div key={`heading-${nodes.length}`} className={className}>{renderInlineMarkdown(heading[2]!)}</div>);
      i += 1;
      continue;
    }

    if (/^([-*_])\s*\1\s*\1\s*$/.test(trimmed)) {
      nodes.push(<div key={`rule-${nodes.length}`} className="my-2 border-t border-neutral-200" />);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test((lines[i] ?? '').trim())) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      nodes.push(
        <blockquote key={`quote-${nodes.length}`} className="border-l-2 border-neutral-300 pl-3 text-neutral-600">
          {quoteLines.map((quote, idx) => (
            <p key={idx}>{renderInlineMarkdown(quote)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test((lines[i] ?? '').trim())) {
        items.push((lines[i] ?? '').trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="list-disc space-y-1 pl-5">
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      );
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? '').trim())) {
        items.push((lines[i] ?? '').trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ol key={`ol-${nodes.length}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item)}</li>)}
        </ol>,
      );
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      const tableLines: string[] = [];
      while (i < lines.length && isMarkdownTableLine(lines[i] ?? '')) {
        tableLines.push(lines[i] ?? '');
        i += 1;
      }
      nodes.push(renderMarkdownTable(tableLines, `table-${nodes.length}`));
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^```/.test((lines[i] ?? '').trim()) &&
      !/^(#{1,4})\s+/.test((lines[i] ?? '').trim()) &&
      !/^([-*_])\s*\1\s*\1\s*$/.test((lines[i] ?? '').trim()) &&
      !/^>\s?/.test((lines[i] ?? '').trim()) &&
      !/^[-*]\s+/.test((lines[i] ?? '').trim()) &&
      !/^\d+[.)]\s+/.test((lines[i] ?? '').trim()) &&
      !isMarkdownTableStart(lines, i)
    ) {
      paragraph.push((lines[i] ?? '').trim());
      i += 1;
    }
    nodes.push(<p key={`p-${nodes.length}`}>{renderParagraphLines(paragraph)}</p>);
  }

  return nodes.length > 0 ? nodes : [<p key="empty" />];
}

function headingClassName(level: number): string {
  if (level === 1) return 'pt-1 text-base font-semibold text-neutral-950';
  if (level === 2) return 'pt-1 text-sm font-semibold text-neutral-950';
  return 'text-sm font-semibold text-neutral-900';
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.split('|').filter((cell) => cell.trim()).length >= 2;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const separator = lines[index + 1] ?? '';
  return isMarkdownTableLine(header) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator);
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderMarkdownTable(lines: string[], key: string): ReactNode {
  const header = parseMarkdownTableRow(lines[0] ?? '');
  const rows = lines.slice(2).map(parseMarkdownTableRow);
  return (
    <div key={key} className="overflow-x-auto rounded-md border border-neutral-200">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-neutral-50 text-neutral-900">
          <tr>
            {header.map((cell, index) => (
              <th key={index} className="border-b border-neutral-200 px-2 py-1.5 font-semibold">
                {renderInlineMarkdown(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-neutral-100 align-top">
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="px-2 py-1.5 text-neutral-700">
                  {renderInlineMarkdown(row[cellIndex] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderParagraphLines(lines: string[]): ReactNode[] {
  return lines.flatMap((line, index) => {
    const inline = renderInlineMarkdown(line);
    return index < lines.length - 1
      ? [...inline, <br key={`br-${index}`} />]
      : inline;
  });
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+]\([^)]+\)|https?:\/\/[^\s)]+|@[\w-]+)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code key={`inline-code-${match.index}`} className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.92em] text-neutral-900">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`strong-${match.index}`} className="font-semibold text-neutral-950">{renderInlineMarkdown(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      const href = link ? safeMarkdownHref(link[2]!) : null;
      nodes.push(href ? (
        <a key={`link-${match.index}`} href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">
          {renderInlineMarkdown(link![1]!)}
        </a>
      ) : token);
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      nodes.push(
        <a key={`url-${match.index}`} href={token} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">
          {token}
        </a>,
      );
    } else {
      nodes.push(<span key={`mention-${match.index}`} className="cursor-pointer font-medium text-blue-600 hover:underline">{token}</span>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function safeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/api/')) return artifactUrl(trimmed);
  return null;
}

function artifactUrl(path: string): string {
  const token = getStoredAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${getResolvedServerUrl()}${path}${sep}token=${encodeURIComponent(token)}`;
}

function parseMeta(msg: ChatMessage): Record<string, any> {
  if (!msg.metaJson) return {};
  try {
    const parsed = JSON.parse(msg.metaJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parentMessageId(msg: ChatMessage): string | null {
  const meta = parseMeta(msg);
  return typeof meta.parentMessageId === 'string'
    ? meta.parentMessageId
    : typeof meta.inReplyTo === 'string'
      ? meta.inReplyTo
      : null;
}

function parseThreadMessageId(raw: string | null, channelId: string): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return decoded || null;
  const left = decoded.slice(0, separatorIndex);
  const right = decoded.slice(separatorIndex + 1);
  return left === channelId && right ? right : null;
}

function taskLabel(msg: ChatMessage): string | null {
  const meta = parseMeta(msg);
  if (typeof meta.taskId !== 'string') return null;
  return `#${meta.taskId.slice(-6)} ${typeof meta.taskTitle === 'string' ? meta.taskTitle : '任务'}`;
}

function ChatArtifactPreview({ artifact }: { artifact: Artifact }) {
  const sizeLabel = formatFileSize(artifact.sizeBytes);
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <a href={artifactUrl(artifact.downloadUrl)} target="_blank" rel="noreferrer" className="block max-w-80">
        <img
          src={artifactUrl(artifact.previewUrl)}
          alt={artifact.filename}
          className="max-h-64 rounded-md border border-neutral-200 object-contain"
        />
        <div className="mt-1 truncate text-xs text-neutral-500">{artifact.filename}</div>
      </a>
    );
  }
  const fileKind = artifactKind(artifact);
  return (
    <a
      href={artifactUrl(artifact.downloadUrl)}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex min-h-16 max-w-96 items-center gap-3 border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-700 hover:border-neutral-900 hover:bg-amber-50/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-neutral-300 bg-neutral-50 text-neutral-500 group-hover:border-neutral-900 group-hover:bg-white">
        <Paperclip size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-neutral-900">{artifact.filename}</span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{fileKind.previewLabel} · {sizeLabel}</span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-400">{fileKind.documentLabel}</span>
      </span>
      <Download size={14} className="shrink-0 text-neutral-400 group-hover:text-neutral-700" />
    </a>
  );
}

function artifactKind(artifact: Artifact): { previewLabel: string; documentLabel: string } {
  const name = artifact.filename.toLowerCase();
  if (artifact.mimeType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown')) {
    return { previewLabel: 'Markdown preview', documentLabel: 'Markdown document' };
  }
  if (artifact.mimeType.startsWith('text/') || name.endsWith('.txt')) {
    return { previewLabel: 'Text preview', documentLabel: 'Text document' };
  }
  if (artifact.mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    return { previewLabel: 'PDF preview', documentLabel: 'PDF document' };
  }
  if (name.endsWith('.json') || artifact.mimeType === 'application/json') {
    return { previewLabel: 'JSON preview', documentLabel: 'JSON document' };
  }
  return { previewLabel: 'File preview', documentLabel: 'File attachment' };
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

function resolveMessageSpeaker(
  msg: ChatMessage,
  currentUsername: string | undefined,
  agents: Record<string, AgentSnapshot>,
): string {
  if (msg.senderKind === 'agent') return msg.senderId ? (agents[msg.senderId]?.name ?? msg.senderId) : 'Agent';
  if (msg.senderKind === 'human') return currentUsername ?? '你';
  return '系统';
}

function statusLabel(status?: AgentStatus): string {
  if (status === 'online') return '在线';
  if (status === 'busy') return '忙碌';
  if (status === 'connecting') return '连接中';
  if (status === 'error') return '异常';
  return '离线';
}

function statusDotClass(status?: AgentStatus): string {
  if (status === 'online') return 'bg-emerald-500';
  if (status === 'busy') return 'bg-amber-500';
  if (status === 'connecting') return 'bg-sky-500';
  if (status === 'error') return 'bg-red-500';
  return 'bg-neutral-300';
}

function uniqueMessages(messages: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const msg of messages) map.set(msg.id, msg);
  return [...map.values()];
}

function conversationLabel(
  channelId: string,
  channels: Array<{ id: string; name: string }>,
  dms: Array<{ id: string; name: string; dmTargetId: string }>,
  agents: Record<string, { name: string }>,
): string {
  const dm = dms.find((item) => item.id === channelId);
  if (dm) return `@${agents[dm.dmTargetId]?.name ?? dm.name}`;
  const channel = channels.find((item) => item.id === channelId);
  return channel ? `#${channel.name}` : channelId;
}

function speakerName(msg: ChatMessage, agents: Record<string, { name: string }>, currentUsername?: string): string {
  if (msg.senderKind === 'human') return currentUsername ?? '用户';
  if (msg.senderKind === 'agent') return agents[msg.senderId ?? '']?.name ?? msg.senderId ?? 'Agent';
  return '系统';
}

function participantName(id: string, participants: { id: string; name: string }[], currentUserId?: string): string {
  if (id === currentUserId) return '你';
  return participants.find((person) => person.id === id)?.name ?? id.slice(0, 8);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function SearchView({ onClose, onJump }: { onClose: () => void; onJump: (channelId: string) => void }) {
  const [query, setQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [scope, setScope] = useState<'all' | 'channels' | 'dms'>('all');
  const [sort, setSort] = useState<'relevant' | 'recent'>('relevant');
  const [results, setResults] = useState<ChatMessage[] | null>(null);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const timer = setTimeout(async () => {
      const res = await channelEvents().searchMessages(query.trim(), 30);
      if (res.ok && res.messages) setResults(res.messages);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const q = query.trim().toLowerCase();
  const channelMatches = q && scope !== 'dms'
    ? channels.filter((c) => c.name.toLowerCase().includes(q)).map((c) => ({
        id: c.id,
        title: c.name,
        label: '频道',
        subtitle: c.visibility === 'private' ? '私有频道' : '频道',
      }))
    : [];
  const dmMatches = q && scope !== 'channels'
    ? dms.filter((dm) => {
        const agent = agents[dm.dmTargetId];
        const name = agent?.name ?? dm.name;
        const subtitle = agent?.description ?? agent?.role ?? '';
        return `${name} ${subtitle}`.toLowerCase().includes(q);
      }).map((dm) => {
        const agent = agents[dm.dmTargetId];
        return {
          id: dm.id,
          title: agent?.name ?? dm.name,
          label: '私聊',
          subtitle: agent?.description?.trim() || agent?.role || '智能体私聊',
        };
      })
    : [];
  const messageMatches = (results ?? [])
    .filter((msg) => !mineOnly || msg.senderId === currentUser?.id)
    .filter((msg) => {
      if (scope === 'channels') return !dms.some((dm) => dm.id === msg.channelId);
      if (scope === 'dms') return dms.some((dm) => dm.id === msg.channelId);
      return true;
    })
    .sort((a, b) => {
      if (sort === 'recent') return b.createdAt - a.createdAt;
      const aPos = a.body.toLowerCase().indexOf(q);
      const bPos = b.body.toLowerCase().indexOf(q);
      return (aPos < 0 ? 9999 : aPos) - (bPos < 0 ? 9999 : bPos);
    });
  const total = channelMatches.length + dmMatches.length + messageMatches.length;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-14 items-center border-b border-neutral-200 px-6">
        <div className="flex w-full items-center gap-3">
          <Search size={18} className="text-neutral-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus placeholder="搜索频道、私聊、成员、消息..." className="flex-1 text-sm outline-none placeholder:text-neutral-400" />
          <button onClick={onClose} className="rounded bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">ESC</button>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-6 py-2">
        <button onClick={() => setMineOnly((v) => !v)} className={`rounded-full px-3 py-1 text-xs font-medium ${mineOnly ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>我的消息</button>
        <button onClick={() => setScope(scope === 'all' ? 'channels' : scope === 'channels' ? 'dms' : 'all')} className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200">
          {scope === 'all' ? '全部位置' : scope === 'channels' ? '频道' : '私聊'}
        </button>
        <button className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-500">任意时间</button>
        <div className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          <span>排序</span>
          <label className="flex items-center gap-1"><input type="radio" checked={sort === 'relevant'} onChange={() => setSort('relevant')} />相关</label>
          <label className="flex items-center gap-1"><input type="radio" checked={sort === 'recent'} onChange={() => setSort('recent')} />最新</label>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {results === null && !query.trim() && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
            <Search size={32} strokeWidth={1.5} />
            <p className="mt-2 text-sm font-medium">搜索一切</p>
            <p className="text-xs">搜索频道、私聊、成员和消息历史</p>
          </div>
        )}
        {query.trim() && total === 0 && (
          <div className="py-8 text-center text-sm text-neutral-400">没有找到匹配的结果</div>
        )}
        {query.trim() && total > 0 && (
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{total} 个结果</div>
        )}
        {(channelMatches.length > 0 || dmMatches.length > 0) && (
          <div className="mb-5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">频道与私聊</div>
            {[...channelMatches, ...dmMatches].map((item) => (
              <button key={`${item.label}-${item.id}`} onClick={() => onJump(item.id)} className="mb-1 flex w-full items-center gap-3 rounded-lg border border-neutral-100 px-3 py-2 text-left hover:bg-neutral-50">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-neutral-100 text-neutral-500">
                  {item.label === '频道' ? <Hash size={14} /> : <MessageSquare size={14} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900">{item.title}</div>
                  <div className="truncate text-xs text-neutral-400">{item.subtitle}</div>
                </div>
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">{item.label}</span>
              </button>
            ))}
          </div>
        )}
        {messageMatches.length > 0 && (
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">消息</div>
            {messageMatches.map((msg) => (
              <button key={msg.id} onClick={() => onJump(msg.channelId)} className="mb-2 w-full rounded-lg border border-neutral-100 p-3 text-left hover:bg-neutral-50">
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <span>{conversationLabel(msg.channelId, channels, dms, agents)}</span>
                  <span>· {speakerName(msg, agents, currentUser?.username)}</span>
                  <span>· {formatTime(msg.createdAt)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-sm text-neutral-700">{msg.body.slice(0, 180)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityView({ onJump }: { onJump: (channelId: string) => void }) {
  const [filter, setFilter] = useState<'all' | 'unread' | 'mentions'>('all');
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);

  useEffect(() => {
    channelEvents().searchMessages('', 100).then((res) => {
      if (res.ok && res.messages) setRecent(res.messages);
    });
  }, []);

  const allMessages = uniqueMessages([...recent, ...Object.values(messagesByChannel).flat()])
    .filter((m) => m.senderKind !== 'system')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 80);
  const unreadCount = allMessages.filter((m) => !doneIds.has(m.id)).length;
  const visible = allMessages.filter((m) => {
    if (filter === 'unread') return !doneIds.has(m.id);
    if (filter === 'mentions') return m.body.includes(`@${currentUser?.username ?? ''}`) || m.body.includes('@');
    return true;
  });

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-16 items-center justify-between border-b border-neutral-200 px-6">
        <div>
          <h2 className="text-lg font-semibold">活动</h2>
          <p className="text-xs text-neutral-400">{allMessages.length} 条活动 · {unreadCount} 条未读</p>
        </div>
        <button onClick={() => setDoneIds(new Set(allMessages.map((m) => m.id)))} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50">全部标记已读</button>
      </div>
      <div className="flex gap-2 border-b border-neutral-200 px-6 py-2">
        {(['all', 'unread', 'mentions'] as const).map((item) => (
          <button key={item} onClick={() => setFilter(item)} className={`rounded-full px-3 py-1 text-xs font-medium ${filter === item ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'}`}>
            {item === 'all' ? '全部' : item === 'unread' ? '未读' : '提及'}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <div className="py-12 text-center text-sm text-neutral-400">暂无活动</div>
        )}
        {visible.map((msg) => {
          const done = doneIds.has(msg.id);
          return (
            <button key={msg.id} onClick={() => onJump(msg.channelId)} className={`group flex w-full items-start gap-3 border-b border-neutral-100 px-6 py-3 text-left hover:bg-neutral-50 ${done ? 'opacity-60' : ''}`}>
              <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-purple-100 text-xs font-semibold text-purple-700">
                {speakerName(msg, agents, currentUser?.username)[0]?.toUpperCase() ?? 'A'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <span className="font-medium text-neutral-700">{conversationLabel(msg.channelId, channels, dms, agents)}</span>
                  <span>{formatTime(msg.createdAt)}</span>
                  {!done && <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">新</span>}
                </div>
                <div className="mt-1 line-clamp-2 text-sm text-neutral-700">
                  <span className="font-medium text-neutral-900">{speakerName(msg, agents, currentUser?.username)}：</span>
                  {msg.body}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDoneIds((prev) => {
                    const next = new Set(prev);
                    next.add(msg.id);
                    return next;
                  });
                }}
                className="shrink-0 rounded-md border border-neutral-200 px-2 py-1 text-[10px] font-medium text-neutral-500 opacity-0 hover:bg-white group-hover:opacity-100"
              >
                标记完成
              </button>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SavedView({ savedIds, onUnsave, onJump }: { savedIds: Set<string>; onUnsave: (msgId: string) => void; onJump: (channelId: string) => void }) {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);

  useEffect(() => {
    channelEvents().searchMessages('', 200).then((res) => {
      if (res.ok && res.messages) setRecent(res.messages);
    });
  }, []);

  const savedMessages = uniqueMessages([...recent, ...Object.values(messagesByChannel).flat()])
    .filter((m) => savedIds.has(m.id))
    .filter((m) => !query.trim() || m.body.toLowerCase().includes(query.trim().toLowerCase()) || conversationLabel(m.channelId, channels, dms, agents).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-16 flex-col justify-center border-b border-neutral-200 px-6">
        <h2 className="text-lg font-semibold">收藏</h2>
        <p className="text-xs text-neutral-400">{savedIds.size} 条收藏</p>
      </div>
      <div className="border-b border-neutral-200 px-6 py-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索收藏..." className="h-8 w-full rounded-md border border-neutral-200 bg-neutral-50 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {savedMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
            <Bookmark size={32} strokeWidth={1.5} />
            <p className="mt-2 text-sm">{query.trim() ? '没有匹配的收藏' : '暂无收藏消息'}</p>
            <p className="text-xs">点击消息旁的书签图标收藏消息</p>
          </div>
        )}
        {savedMessages.map((msg) => (
          <button key={msg.id} onClick={() => onJump(msg.channelId)} className="group flex w-full items-start gap-3 border-b border-neutral-100 px-6 py-3 text-left hover:bg-neutral-50">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-xs font-semibold text-amber-700">
              <Bookmark size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <span className="font-medium text-neutral-700">{conversationLabel(msg.channelId, channels, dms, agents)}</span>
                <span>{speakerName(msg, agents, currentUser?.username)}</span>
                <span>{formatTime(msg.createdAt)}</span>
              </div>
              <div className="mt-1 line-clamp-3 text-sm text-neutral-700">{msg.body}</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUnsave(msg.id);
              }}
              className="shrink-0 rounded-md border border-neutral-200 px-2 py-1 text-[10px] font-medium text-neutral-500 opacity-0 hover:bg-white group-hover:opacity-100"
            >
              取消收藏
            </button>
          </button>
        ))}
      </div>
    </div>
  );
}
