'use client';

import { useEffect, useState, useRef, useCallback, type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Hash, Search, Plus, Activity, Bookmark, Image, Paperclip, Send, SquareDot, Pencil, Users, BookmarkCheck, Lock, MessageSquare, X, Trash2, FolderOpen, ChevronRight, Smile, LayoutGrid, List, ChevronDown, User, Tag, ExternalLink, Download, ArrowUpDown, Check, Eye, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { uploadArtifact, getResolvedServerUrl, getStoredAuthToken, getWebSocket, dmEvents, channelEvents, memberEvents, taskEvents, messageReactionEvents, emitWithTimeout } from '@/lib/socket';
import { WEB_EVENTS } from '@agentbean/contracts';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import type { AgentSnapshot, AgentStatus, Artifact, ChatMessage, DispatchStatus } from '@/lib/schema';
import { chatArtifactUrl } from '@/lib/chat-artifact-url';
import { ownedAgentsForMember } from '@/lib/agent-list';
import { agentProfileCacheKeys, resolveAgentProfileSnapshot, resolveAgentProfileTitle } from '@/lib/agent-profile';
import { messageSpeakerName, type SpeakerSources } from '@/lib/display-names';
import { inboxActivityMessages, mergeSavedMessages, messagesForVisibleConversations, visibleConversationIds } from '@/lib/chat-scope';
import { loadReadIds, readKey, saveReadIds } from '@/lib/chat-read-state';
import { NewChannelDialog } from '@/components/new-channel-dialog';
import {
  TASK_STATUS_COLUMNS as TASK_COLUMNS,
  TASK_STATUS_MENU_DOT_CLASS,
  TASK_STATUS_MENU_ITEM_CLASS,
  TASK_STATUS_MENU_LABEL_CLASS,
  TASK_STATUS_MENU_PANEL_CLASS,
  TASK_STATUS_MENU_PANEL_STYLE,
  isTaskStatus,
  taskStatusDotClass,
  taskStatusText,
  type TaskStatus,
} from '@/lib/task-status';

type ChatTab = 'chat' | 'tasks' | 'files';
type TaskViewMode = 'board' | 'list';
type SidebarSortMode = 'manual' | 'recent' | 'az';
type ProfileTarget = { kind: 'human' | 'agent'; id: string };
type MentionProfileMember = { id: string; name: string; kind: ProfileTarget['kind'] };
type ChatTaskMenuTarget = { surface: 'main' | 'thread'; messageId: string } | null;
type ComposerAttachmentStatus = 'uploading' | 'ready' | 'failed';

interface SendMessageAck {
  ok?: boolean;
  error?: string;
  message?: ChatMessage;
  dispatches?: Array<{
    id: string;
    messageId: string;
    status?: DispatchStatus;
  }>;
}

interface ComposerAttachment {
  localId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
  status: ComposerAttachmentStatus;
  artifact?: Artifact;
  error?: string;
}

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

interface ChannelMemberEntry {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  role?: string;
  status?: AgentStatus;
}

interface HumanProfile {
  id: string;
  username: string;
  role?: string;
  email?: string | null;
}

function createComposerAttachment(file: File): ComposerAttachment {
  const isImage = file.type.startsWith('image/');
  return {
    localId: `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    previewUrl: isImage && typeof URL !== 'undefined' ? URL.createObjectURL(file) : undefined,
    status: 'uploading',
  };
}

function revokeComposerPreview(attachment: ComposerAttachment) {
  if (attachment.previewUrl?.startsWith('blob:') && typeof URL !== 'undefined') {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

function readyArtifacts(attachments: ComposerAttachment[]): Artifact[] {
  return attachments
    .filter((attachment) => attachment.status === 'ready' && attachment.artifact)
    .map((attachment) => attachment.artifact!);
}

function hasUploadingAttachments(attachments: ComposerAttachment[]): boolean {
  return attachments.some((attachment) => attachment.status === 'uploading');
}

function hasFailedAttachments(attachments: ComposerAttachment[]): boolean {
  return attachments.some((attachment) => attachment.status === 'failed');
}

export default function ChatPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const channels = useAgentBeanStore((s) => s.channels);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const dms = useAgentBeanStore((s) => s.dms);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);
  const applyDispatchStatus = useAgentBeanStore((s) => s.applyDispatchStatus);
  const router = useRouter();
  const params = useParams();
  const np = useCurrentNetworkPath();
  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : np;

  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const dmParam = searchParams.get('dm');
  const chatTabParam = searchParams.get('chatTab');
  const threadParam = searchParams.get('thread');
  const messageParam = searchParams.get('message');
  const profileParam = searchParams.get('profile');
  const routeChannelId = typeof params.channelId === 'string' ? params.channelId : null;
  const routeDmId = typeof params.dmId === 'string' ? params.dmId : null;
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<ChatTab>('chat');
  const [asTask, setAsTask] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showEditChannel, setShowEditChannel] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [channelMembers, setChannelMembers] = useState<ChannelMemberEntry[]>([]);
  const [humanProfiles, setHumanProfiles] = useState<HumanProfile[]>([]);
  const [sidebarView, setSidebarView] = useState<'channels' | 'search' | 'inbox' | 'saved'>('channels');
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [dmsExpanded, setDmsExpanded] = useState(true);
  const [channelSort, setChannelSort] = useState<SidebarSortMode>('manual');
  const [dmSort, setDmSort] = useState<SidebarSortMode>('manual');
  const [openSortMenu, setOpenSortMenu] = useState<'channels' | 'dms' | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // 收藏的单一真源：listSaved 返回的完整消息快照。badge 与收藏列表都基于它，
  // 避免「savedIds 只存 id、列表依赖消息体在内存」导致的 badge 数 ≠ 列表条数。
  const [savedMessages, setSavedMessages] = useState<ChatMessage[]>([]);
  const [loadedSavedKey, setLoadedSavedKey] = useState<string | null>(null);
  const [reactionIds, setReactionIds] = useState<Set<string>>(new Set());
  const [loadedReactionsKey, setLoadedReactionsKey] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [loadedDoneKey, setLoadedDoneKey] = useState<string | null>(null);
  const inboxUnread = inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleConversationIds(channels, dms)).filter((m) => !doneIds.has(m.id)).length;
  const [profileAgentCache, setProfileAgentCache] = useState<Record<string, AgentSnapshot>>({});
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionMembers, setMentionMembers] = useState<{ id: string; name: string; kind: 'human' | 'agent' }[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([]);
  const [threadAttachments, setThreadAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [threadInput, setThreadInput] = useState('');
  const [showBackToBottom, setShowBackToBottom] = useState(false);
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
  const [chatTaskMenuTarget, setChatTaskMenuTarget] = useState<ChatTaskMenuTarget>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadImageInputRef = useRef<HTMLInputElement>(null);
  const threadFileInputRef = useRef<HTMLInputElement>(null);
  const dmsRef = useRef(dms);
  const savedKey = `agentbean:chat:saved:${routeNetworkPath}`;
  const reactionsKey = `agentbean:chat:reactions:${routeNetworkPath}`;

  useEffect(() => {
    dmsRef.current = dms;
  }, [dms]);

  useEffect(() => {
    if (chatTabParam === 'chat' || chatTabParam === 'tasks' || chatTabParam === 'files') {
      setTab(chatTabParam);
    }
  }, [chatTabParam]);

  useEffect(() => {
    setProfileAgentCache({});
  }, [currentTeamId]);

  // Subscribe to channels + DMs
  useEffect(() => {
    if (conn !== 'open' || !currentTeamId) return;
    const socket = getWebSocket();
    channelEvents(socket).subscribe(currentTeamId);
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
  }, [conn, currentTeamId, applyChannelsSnapshot, applyDmsSnapshot, dmParam, routeChannelId, routeDmId]);

  const handleMessage = useCallback((msg: ChatMessage) => {
    appendMessage(msg);
  }, [appendMessage]);

  useEffect(() => {
    if (!activeChannel || conn !== 'open') return;
    const socket = getWebSocket();
    void channelEvents(socket).join(currentTeamId, activeChannel);
    const onHistory = (payload: { channelId: string; messages: ChatMessage[] }) => {
      if (payload.channelId === activeChannel) applyChannelHistory(activeChannel, payload.messages);
    };
    const onDispatchStatus = (dispatch: { messageId: string; channelId: string; status: DispatchStatus; id?: string }) => {
      if (dispatch.channelId === activeChannel) {
        applyDispatchStatus(activeChannel, dispatch.messageId, dispatch.status, dispatch.id);
      }
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', handleMessage);
    socket.on('message:dispatch-status', onDispatchStatus);
    return () => {
      socket.off('channel:history', onHistory);
      socket.off('channel:message', handleMessage);
      socket.off('message:dispatch-status', onDispatchStatus);
    };
  }, [activeChannel, conn, applyChannelHistory, applyDispatchStatus, handleMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesByChannel]);

  useEffect(() => {
    let cancelled = false;
    try {
      const raw = window.localStorage.getItem(savedKey);
      setSavedIds(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setSavedIds(new Set());
    }
    setSavedMessages([]);
    // Hydrate from server
    messageReactionEvents().listSaved().then((res) => {
      if (cancelled) return;
      if (res.ok && res.messages) {
        setSavedMessages(res.messages);
        setSavedIds((prev) => {
          const next = new Set(prev);
          for (const msg of res.messages!) next.add(msg.id);
          return next;
        });
      }
    }).catch(() => {});
    setLoadedSavedKey(savedKey);
    return () => { cancelled = true; };
  }, [savedKey]);

  useEffect(() => {
    if (loadedSavedKey !== savedKey) return;
    try {
      window.localStorage.setItem(savedKey, JSON.stringify([...savedIds]));
    } catch {}
  }, [savedIds, savedKey, loadedSavedKey]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(reactionsKey);
      setReactionIds(new Set(raw ? JSON.parse(raw) : []));
    } catch {
      setReactionIds(new Set());
    }
    setLoadedReactionsKey(reactionsKey);
  }, [reactionsKey]);

  useEffect(() => {
    if (loadedReactionsKey !== reactionsKey) return;
    try {
      window.localStorage.setItem(reactionsKey, JSON.stringify([...reactionIds]));
    } catch {}
  }, [reactionIds, reactionsKey, loadedReactionsKey]);

  useEffect(() => {
    setDoneIds(loadReadIds(routeNetworkPath));
    setLoadedDoneKey(readKey(routeNetworkPath));
  }, [routeNetworkPath]);

  useEffect(() => {
    if (loadedDoneKey !== readKey(routeNetworkPath)) return;
    try {
      saveReadIds(routeNetworkPath, doneIds);
    } catch {}
  }, [doneIds, loadedDoneKey, routeNetworkPath]);

  // Fetch members for @mention
  useEffect(() => {
    if (conn !== 'open' || !currentTeamId) return;
    memberEvents().list({ teamId: currentTeamId }).then((res) => {
      if (!res.ok) return;
      const members: { id: string; name: string; kind: 'human' | 'agent' }[] = [];
      if (res.humans) {
        for (const h of res.humans) members.push({ id: h.userId, name: h.username, kind: 'human' });
        setHumanProfiles(res.humans.map((human) => ({
          id: human.userId,
          username: human.username,
          role: human.role,
          email: human.userId === currentUser?.id ? currentUser.email : null,
        })));
      }
      if (res.agents) {
        for (const a of res.agents) members.push({ id: a.id, name: a.name, kind: 'agent' });
      }
      setMentionMembers(members);
    });
  }, [conn, currentTeamId, currentUser]);

  const loadChannelMembers = useCallback(async (channelId: string | null) => {
    if (!channelId || conn !== 'open') {
      setChannelMembers([]);
      return;
    }
    const dm = dmsRef.current.find((item) => item.id === channelId);
    if (dm) {
      const dmAgent = agents[dm.dmTargetId];
      setChannelMembers([
        ...(currentUser ? [{ id: currentUser.id, name: `${currentUser.username}（你）`, kind: 'human' as const, role: currentUser.role }] : []),
        { id: dm.dmTargetId, name: dmAgent?.name ?? dm.name, kind: 'agent' as const, role: dmAgent?.role, status: dmAgent?.status },
      ]);
      return;
    }
    const res = await channelEvents().members(channelId, currentTeamId);
    if (!res.ok) return;
    const humans = (res.humans ?? []).map((human) => ({
      id: human.userId,
      name: currentUser?.id === human.userId ? `${human.username}（你）` : human.username,
      kind: 'human' as const,
      role: human.role,
    }));
    const agentMembers = (res.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: 'agent' as const,
      role: agent.role,
      status: agents[agent.id]?.status ?? agent.status,
    }));
    setChannelMembers([...agentMembers, ...humans]);
  }, [agents, conn, currentUser]);

  useEffect(() => {
    loadChannelMembers(activeChannel);
  }, [activeChannel, loadChannelMembers]);

  const activeChannelObj = channels.find((c) => c.id === activeChannel);
  const activeName = activeChannelObj?.name ?? '';
  const activeDm = dms.find((d) => d.id === activeChannel);
  const isDm = !!activeDm;
  const isDefaultPublicChannel = !isDm && activeChannelObj?.name === 'all';
  const canManageActiveChannel = Boolean(
    activeChannelObj &&
    currentUser &&
    (isDefaultPublicChannel || activeChannelObj.createdBy === currentUser.id),
  );
  const canManageActiveChannelMembers = Boolean(
    activeChannelObj &&
    currentUser &&
    !isDefaultPublicChannel &&
    activeChannelObj.createdBy === currentUser.id,
  );
  const activeDmAgent = activeDm ? agents[activeDm.dmTargetId] : undefined;
  const activeDmName = activeDmAgent?.name ?? activeDm?.name ?? '';
  const activeDmSubtitle = activeDmAgent?.description?.trim() || activeDmAgent?.role || '智能体私聊';
  const taskParticipants = channelMembers.length > 0
    ? channelMembers.map((member) => ({ id: member.id, name: member.name, kind: member.kind }))
    : [
        ...(currentUser ? [{ id: currentUser.id, name: `${currentUser.username}（你）`, kind: 'human' as const }] : []),
        ...Object.values(agents).map((agent) => ({ id: agent.id, name: agent.name, kind: 'agent' as const })),
      ];
  const visibleMentionMembers = channelMembers.map((member) => ({ id: member.id, name: member.name.replace(/（你）$/, ''), kind: member.kind }));
  const channelMemberCount = isDm ? 2 : channelMembers.length;
  const orderedChannels = sortChannels(channels, channelSort, messagesByChannel);
  const orderedDms = sortDms(dms, dmSort, messagesByChannel, agents);
  const profileTarget = parseProfileParam(profileParam);
  const profileHuman = profileTarget?.kind === 'human'
    ? resolveHumanProfile(profileTarget.id, humanProfiles, currentUser, channelMembers, mentionMembers)
    : null;
  const profileAgent = profileTarget?.kind === 'agent'
    ? resolveAgentProfileSnapshot(profileTarget.id, { agents, channelMembers, mentionMembers, dms, cache: profileAgentCache })
    : null;
  const profileAgentTitle = profileTarget?.kind === 'agent'
    ? resolveAgentProfileTitle(profileTarget.id, profileAgent, { channelMembers, mentionMembers, dms })
    : null;
  const taskNumbers = buildTaskNumberMap(tasks);

  useEffect(() => {
    if (profileTarget?.kind !== 'agent' || !profileAgent) return;
    const keys = agentProfileCacheKeys(profileTarget.id, profileAgent);
    setProfileAgentCache((prev) => {
      if (keys.every((key) => prev[key] === profileAgent)) return prev;
      const next = { ...prev };
      for (const key of keys) next[key] = profileAgent;
      return next;
    });
  }, [profileTarget?.kind, profileTarget?.id, profileAgent]);

  const switchTab = (nextTab: ChatTab) => {
    setTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    if (nextTab === 'chat') params.delete('chatTab');
    else params.set('chatTab', nextTab);
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  };

  const handleArchiveChannel = async (channelId: string) => {
    const res = await channelEvents().archive(channelId, currentTeamId);
    if (!res.ok) return res;
    const fallback = channels.find((channel) => channel.id !== channelId);
    if (fallback) router.push(`/${np}/channel/${fallback.id}`);
    else router.push(`/${np}/chat`);
    return res;
  };

  const handleDeleteChannel = async (channelId: string) => {
    const res = await channelEvents().delete(channelId, currentTeamId);
    if (!res.ok) return res;
    const fallback = channels.find((channel) => channel.id !== channelId);
    if (fallback) router.push(`/${np}/channel/${fallback.id}`);
    else router.push(`/${np}/chat`);
    return res;
  };

  const handleAddChannelMember = async (member: ChannelMemberEntry) => {
    if (!activeChannel) return { ok: false, error: 'NO_CHANNEL' };
    const res = member.kind === 'agent'
      ? await channelEvents().addAgent(activeChannel, member.id, currentTeamId)
      : await channelEvents().addMember(activeChannel, member.id, currentTeamId);
    if (res.ok) await loadChannelMembers(activeChannel);
    return res;
  };

  const handleRemoveChannelMember = async (member: ChannelMemberEntry) => {
    if (!activeChannel) return { ok: false, error: 'NO_CHANNEL' };
    const res = member.kind === 'agent'
      ? await channelEvents().removeAgent(activeChannel, member.id, currentTeamId)
      : await channelEvents().removeMember(activeChannel, member.id, currentTeamId);
    if (res.ok) await loadChannelMembers(activeChannel);
    return res;
  };

  const setThreadUrl = useCallback((messageId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (messageId && activeChannel) {
      params.set('thread', `${activeChannel}:${messageId}`);
      params.delete('message');
    } else {
      params.delete('thread');
    }
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [activeChannel, router, searchParams]);

  const openThread = useCallback((messageId: string) => {
    setThreadRootId(messageId);
    setChatTaskMenuTarget(null);
    setThreadUrl(messageId);
  }, [setThreadUrl]);

  const closeThread = useCallback(() => {
    setThreadRootId(null);
    setThreadInput('');
    setThreadAttachments((prev) => {
      prev.forEach(revokeComposerPreview);
      return [];
    });
    setChatTaskMenuTarget(null);
    setThreadUrl(null);
  }, [setThreadUrl]);

  const openProfile = useCallback((target: ProfileTarget) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('profile', `${target.kind}:${target.id}`);
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [router, searchParams]);

  const closeProfile = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('profile');
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [router, searchParams]);

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
    loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (!activeChannel || conn !== 'open') return;
    const socket = getWebSocket();
    const onTaskUpdated = (task: TaskItem) => {
      if (task.channelId !== activeChannel) return;
      setTasks((prev) => {
        if (prev.some((item) => item.id === task.id)) {
          return prev.map((item) => item.id === task.id ? task : item);
        }
        return [...prev, task];
      });
    };
    socket.on('task:updated', onTaskUpdated);
    return () => { socket.off('task:updated', onTaskUpdated); };
  }, [activeChannel, conn]);

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
    ? visibleMentionMembers.find((m) => m.id === activeDm.dmTargetId)
    : null;

  const filteredMentionMembers = isDm
    ? (dmTargetMember ? [dmTargetMember] : [])
    : (mentionQuery
        ? visibleMentionMembers.filter((m) => m.name.toLowerCase().includes(mentionQuery))
        : visibleMentionMembers);

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
    const selected = Array.from(files).map((file) => ({ file, attachment: createComposerAttachment(file) }));
    const setTargetAttachments = target === 'thread' ? setThreadAttachments : setPendingAttachments;
    setTargetAttachments((prev) => [...prev, ...selected.map((entry) => entry.attachment)]);
    setUploading(true);
    try {
      for (const { file, attachment } of selected) {
        const form = new FormData();
        form.append('channelId', activeChannel);
        form.append('uploaderId', currentUser.id);
        form.append('file', file);
        try {
          const artifact = await uploadArtifact(currentTeamId, form);
          setTargetAttachments((prev) => prev.map((item) => item.localId === attachment.localId
            ? { ...item, status: 'ready', artifact, mimeType: artifact.mimeType || item.mimeType, sizeBytes: artifact.sizeBytes }
            : item));
        } catch (err) {
          setTargetAttachments((prev) => prev.map((item) => item.localId === attachment.localId
            ? { ...item, status: 'failed', error: err instanceof Error ? err.message : 'unknown' }
            : item));
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const appendAckMessage = useCallback((res?: SendMessageAck) => {
    if (!res?.ok || !res.message) return;
    const dispatch = res.dispatches?.find((item) => item.messageId === res.message?.id);
    appendMessage({
      ...res.message,
      ...(dispatch ? { dispatchStatus: dispatch.status ?? 'queued', dispatchId: dispatch.id } : {}),
    });
  }, [appendMessage]);

  const sendMessage = () => {
    const artifacts = readyArtifacts(pendingAttachments);
    if (
      (!input.trim() && artifacts.length === 0)
      || !activeChannel
      || hasUploadingAttachments(pendingAttachments)
      || hasFailedAttachments(pendingAttachments)
    ) return;
    const channelId = activeChannel;
    const body = input.trim();
    const artifactIds = artifacts.map((a) => a.id);
    const createTask = asTask;
    getWebSocket().emit(WEB_EVENTS.message.send, { teamId: currentTeamId, channelId, body: body || '附件', asTask, artifactIds }, (res?: SendMessageAck) => {
      if (res?.ok) {
        appendAckMessage(res);
        if (createTask) setTimeout(() => loadTasks(), 150);
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
    pendingAttachments.forEach(revokeComposerPreview);
    setPendingAttachments([]);
    setAsTask(false);
  };

  const sendThreadMessage = () => {
    const artifacts = readyArtifacts(threadAttachments);
    if (
      (!threadInput.trim() && artifacts.length === 0)
      || !activeChannel
      || !threadRootId
      || hasUploadingAttachments(threadAttachments)
      || hasFailedAttachments(threadAttachments)
    ) return;
    const channelId = activeChannel;
    const body = threadInput.trim() || '附件';
    const artifactIds = artifacts.map((a) => a.id);
    getWebSocket().emit(WEB_EVENTS.message.send, { teamId: currentTeamId, channelId, body, threadId: threadRootId, artifactIds }, (res?: SendMessageAck) => {
      if (res?.ok) {
        appendAckMessage(res);
        return;
      }
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
    threadAttachments.forEach(revokeComposerPreview);
    setThreadAttachments([]);
  };

  const messages = activeChannel ? (messagesByChannel[activeChannel] ?? []) : [];
  const visibleMessages = messages.filter((msg) => !isTaskSystemMessage(msg));
  const threadRoot = threadRootId ? visibleMessages.find((msg) => msg.id === threadRootId) ?? null : null;
  const rootMessages = visibleMessages.filter((msg) => !parentMessageId(msg));
  const threadReplies = threadRootId ? visibleMessages.filter((msg) => parentMessageId(msg) === threadRootId) : [];

  useEffect(() => {
    if (!activeChannel) return;
    const targetMessageId = parseScopedMessageId(messageParam, activeChannel);
    if (!targetMessageId) {
      if (messageParam === null) setSelectedMessageId(null);
      return;
    }
    setTab('chat');
    setThreadRootId(null);
    setThreadInput('');
    setThreadAttachments((prev) => {
      prev.forEach(revokeComposerPreview);
      return [];
    });
    setSelectedMessageId(targetMessageId);
    setChatTaskMenuTarget(null);
    const timer = window.setTimeout(() => {
      document.getElementById(`message-${targetMessageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeChannel, messageParam, visibleMessages.length]);
  const conversationFiles = messages
    .flatMap((msg) => (msg.artifacts ?? []).map((artifact) => ({
      artifact,
      messageId: msg.id,
      createdAt: artifact.createdAt || msg.createdAt,
      senderKind: msg.senderKind,
      senderId: msg.senderId,
    } satisfies ConversationFile)))
    .sort((a, b) => b.createdAt - a.createdAt);
  const toggleSave = (msgId: string) => {
    const isSaved = savedIds.has(msgId);
    // Optimistic update
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
    // 收藏快照同步：取消收藏时从快照移除；新增收藏无需手动加（消息在内存，merge 时兜底）
    setSavedMessages((prev) => (isSaved ? prev.filter((m) => m.id !== msgId) : prev));
    // Persist to server
    messageReactionEvents().save(msgId, !isSaved).catch(() => {
      // Revert on failure
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
        return next;
      });
      // savedMessages 不回滚：savedIds 回滚后，仍在内存的消息会经 merge 自动补回；
      // 极少数不在内存的，下次 listSaved 刷新纠正（远好过原 bug 的静默漏显）。
    });
  };

  // badge 与收藏列表的共同真源：服务端收藏快照 ∪ 内存中命中的收藏（内存版本优先）。
  // 关键——不再套 visibleConversationIds 过滤，故「频道已不可见」的收藏也能显示。
  const savedDisplayMessages = mergeSavedMessages(
    savedMessages,
    uniqueMessages(Object.values(messagesByChannel).flat()).filter((m) => savedIds.has(m.id)),
  );

  const toggleReaction = (msgId: string) => {
    const isReacted = reactionIds.has(msgId);
    // Optimistic update
    setReactionIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
    // Persist to server
    messageReactionEvents().react(msgId, !isReacted).catch(() => {
      // Revert on failure
      setReactionIds((prev) => {
        const next = new Set(prev);
        if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
        return next;
      });
    });
  };

  const updateTaskStatus = async (task: TaskItem, status: TaskStatus) => {
    const maxSort = tasks.filter((item) => item.status === status && item.id !== task.id).reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const optimistic = { ...task, status, sortOrder: maxSort + 1, updatedAt: Date.now() };
    setTasks((prev) => prev.map((item) => item.id === task.id ? optimistic : item));
    setChatTaskMenuTarget(null);
    const res = await taskEvents().update({ id: task.id, status, sortOrder: maxSort + 1 });
    if (res.ok && res.task) {
      setTasks((prev) => prev.map((item) => item.id === task.id ? res.task as TaskItem : item));
    }
  };

  const handleReply = (msg: ChatMessage) => {
    const speaker = resolveMessageSpeaker(msg, agents, { currentUser, humanProfiles, channelMembers, mentionMembers });
    openThread(msg.id);
    setThreadInput((prev) => {
      const prefix = `回复 ${speaker}: `;
      return prev.trim() ? `${prev}\n${prefix}` : prefix;
    });
  };

  const handleThreadReply = (msg: ChatMessage) => {
    const speaker = resolveMessageSpeaker(msg, agents, { currentUser, humanProfiles, channelMembers, mentionMembers });
    setThreadInput((prev) => {
      const prefix = `回复 ${speaker}: `;
      return prev.trim() ? `${prev}\n${prefix}` : prefix;
    });
  };

  const jumpToMessage = (messageId: string) => {
    setTab('chat');
    setThreadRootId(null);
    setThreadInput('');
    setThreadAttachments((prev) => {
      prev.forEach(revokeComposerPreview);
      return [];
    });
    setSelectedMessageId(messageId);
    setChatTaskMenuTarget(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('chatTab');
    params.delete('thread');
    if (activeChannel) params.set('message', `${activeChannel}:${messageId}`);
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
    setTimeout(() => {
      document.getElementById(`message-${messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  const viewThreadRootInChannel = () => {
    if (!threadRootId) return;
    jumpToMessage(threadRootId);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowBackToBottom(false);
  };

  const handleMessageListScroll = () => {
    const el = messageListRef.current;
    if (!el) return;
    setShowBackToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 160);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar — channel list */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-[#F8F5E6]">
        {/* Chat label */}
        <div className="flex h-14 items-center border-b border-neutral-300/40 px-4 text-xs font-semibold uppercase tracking-wider text-neutral-500">聊天</div>

        {/* Search / Activity / Saved buttons */}
        <div className="px-2 py-2 space-y-0.5">
          <button onClick={() => setSidebarView(sidebarView === 'search' ? 'channels' : 'search')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'search' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Search size={14} className="text-neutral-400 shrink-0" />
            <span>搜索</span>
            <span className="ml-auto text-[10px] text-neutral-400">⌘K</span>
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'inbox' ? 'channels' : 'inbox')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'inbox' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Activity size={14} className="text-neutral-400 shrink-0" />
            <span>活动</span>
            {inboxUnread > 0 && (
              <span className="ml-auto rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">{inboxUnread}</span>
            )}
          </button>
          <button onClick={() => setSidebarView(sidebarView === 'saved' ? 'channels' : 'saved')} className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm ${sidebarView === 'saved' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
            <Bookmark size={14} className="text-neutral-400 shrink-0" />
            <span>收藏</span>
            <span className="ml-auto rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{savedDisplayMessages.length}</span>
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
              <SidebarSortButton
                mode={channelSort}
                open={openSortMenu === 'channels'}
                onToggle={(e) => { e.stopPropagation(); setOpenSortMenu(openSortMenu === 'channels' ? null : 'channels'); }}
                onSelect={(mode) => { setChannelSort(mode); setOpenSortMenu(null); }}
              />
              <button onClick={(e) => { e.stopPropagation(); setShowNewChannel(true); }} className="text-neutral-400 hover:text-neutral-700"><Plus size={13} /></button>
            </div>
          </div>
          {channelsExpanded && (
            <div className="space-y-0.5">
              {orderedChannels.map((ch) => (
                <button key={ch.id} onClick={() => { setActiveChannel(ch.id); setSidebarView('channels'); router.push(`/${np}/channel/${ch.id}`); }} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${activeChannel === ch.id && sidebarView === 'channels' ? 'bg-white font-medium text-neutral-900 shadow-sm' : 'text-neutral-600 hover:bg-white/50'}`}>
                  {ch.visibility === 'private' ? <Lock size={14} className="text-neutral-400 shrink-0" /> : <Hash size={14} className="text-neutral-400 shrink-0" />}
                  <span className="truncate">{ch.name}</span>
                </button>
              ))}
              {channels.length === 0 && <div className="px-2 py-2 text-center text-xs text-neutral-400">暂无频道</div>}
            </div>
          )}

          {/* DMs */}
          <div className="mx-2 my-3 border-t border-neutral-300/50" />
          <div className="mb-1">
            <div onClick={() => setDmsExpanded((v) => !v)} className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700">
              <ChevronRight size={10} className={`shrink-0 transition-transform ${dmsExpanded ? 'rotate-90' : ''}`} />
              私聊
              <span className="ml-1 rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{dms.length}</span>
              <SidebarSortButton
                mode={dmSort}
                open={openSortMenu === 'dms'}
                onToggle={(e) => { e.stopPropagation(); setOpenSortMenu(openSortMenu === 'dms' ? null : 'dms'); }}
                onSelect={(mode) => { setDmSort(mode); setOpenSortMenu(null); }}
              />
            </div>
          </div>
          {dmsExpanded && (
            <div className="space-y-0.5">
              {orderedDms.map((dm) => {
                const dmAgent = agents[dm.dmTargetId];
                const dmStatus = dmAgent?.status;
                const dmName = dmAgent?.name ?? dm.name;
                const dmLastMessage = lastLoadedMessage(messagesByChannel[dm.id]);
                const dmSubtitle = dmLastMessage ? displayMessageBody(dmLastMessage) : (dmAgent?.description?.trim() || dmAgent?.role || '智能体私聊');
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
          }} humanProfiles={humanProfiles} />
        ) : sidebarView === 'inbox' ? (
          <ActivityView onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} humanProfiles={humanProfiles} doneIds={doneIds} setDoneIds={setDoneIds} />
        ) : sidebarView === 'saved' ? (
          <SavedView savedMessages={savedDisplayMessages} onUnsave={(msgId) => toggleSave(msgId)} onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} humanProfiles={humanProfiles} />
        ) : (
        <>
        {/* Conversation header */}
        {activeChannel && (
          <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {isDm ? (
                <>
                  <button onClick={() => activeDm && openProfile({ kind: 'agent', id: activeDm.dmTargetId })} className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-purple-100 text-xs font-semibold text-purple-700 hover:ring-2 hover:ring-neutral-900" title="查看智能体资料">
                    {activeDmName[0]?.toUpperCase() ?? 'A'}
                    <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${statusDotClass(activeDmAgent?.status)}`} />
                  </button>
                  <div className="min-w-0">
                    <button onClick={() => activeDm && openProfile({ kind: 'agent', id: activeDm.dmTargetId })} className="block truncate text-left text-sm font-semibold text-neutral-900 hover:underline">{activeDmName}</button>
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
              {canManageActiveChannel && (
                <button onClick={() => setShowEditChannel(true)} className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="编辑频道" data-smoke="channel-edit-open">
                  <Pencil size={14} />
                </button>
              )}
              <button onClick={() => { loadChannelMembers(activeChannel); setShowMembers(true); }} className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100" title="查看参与者" data-smoke="channel-members-open">
                <Users size={14} />
                <span>{channelMemberCount}</span>
              </button>
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
            <div className="relative min-h-0 flex-1">
      <div ref={messageListRef} onScroll={handleMessageListScroll} className="h-full overflow-y-auto px-4 py-3">
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
                  {rootMessages.map((msg) => {
                    const taskId = metaTaskId(msg);
                    const task = taskId ? tasks.find((item) => item.id === taskId) ?? null : null;
                    return (
                      <ChatBubble
                        key={msg.id}
                        msg={msg}
                        task={task}
                        taskNumber={task ? taskNumbers.get(task.id) : undefined}
                        taskAssigneeName={taskAssigneeLabel(msg, task, agents, activeDmAgent, channelMembers)}
                        taskMenuOpen={task ? chatTaskMenuTarget?.surface === 'main' && chatTaskMenuTarget.messageId === msg.id : false}
                        selected={selectedMessageId === msg.id}
                        saved={savedIds.has(msg.id)}
                        reacted={reactionIds.has(msg.id)}
                        humanProfiles={humanProfiles}
                        channelMembers={channelMembers}
                        mentionMembers={mentionMembers}
                        onReply={() => handleReply(msg)}
                        onOpenThread={() => openThread(msg.id)}
                        onOpenProfile={openProfile}
                        onToggleReaction={() => toggleReaction(msg.id)}
                        onToggleSave={() => toggleSave(msg.id)}
                        onTaskMenu={(open) => setChatTaskMenuTarget(open && task ? { surface: 'main', messageId: msg.id } : null)}
                        onTaskStatus={(status) => { if (task) updateTaskStatus(task, status); }}
                        replyCount={messages.filter((item) => parentMessageId(item) === msg.id).length}
                      />
                    );
                  })}
                </div>
                <div ref={messagesEndRef} />
              </div>
              {showBackToBottom && (
                <button onClick={scrollToBottom} className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-md border-2 border-neutral-900 bg-white px-3 py-1.5 text-xs font-semibold text-neutral-700 shadow-sm hover:bg-amber-50">
                  <ChevronDown size={13} />
                  回到底部
                </button>
              )}
            </div>

            {activeChannel && (
              <div className="border-t border-neutral-200 p-3">
                <div className="relative rounded-lg border border-neutral-300 bg-white">
                  {showMention && filteredMentionMembers.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1 max-h-48 w-64 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg z-10">
                      {filteredMentionMembers.map((m, i) => (
                        <button
                          key={m.id}
                          onClick={() => selectMention(m)}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === mentionIndex ? 'bg-blue-50 text-blue-700' : 'hover:bg-neutral-50'}`}
                          data-smoke="mention-candidate"
                          data-member-kind={m.kind}
                          data-member-id={m.id}
                          data-member-name={m.name}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${m.kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>{m.kind === 'agent' ? 'A' : 'H'}</span>
                          <span className="truncate">{m.name}</span>
                          <span className="ml-auto text-[10px] text-neutral-400">{m.kind === 'agent' ? 'Agent' : '人类'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea data-smoke="chat-message-input" ref={textareaRef} value={input} onChange={handleInputChange} onKeyDown={handleInputKeyDown} rows={2} placeholder={isDm ? `私聊 @${activeDmName}` : `发送到 #${activeName}  (输入 @ 提及成员)`} className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400" />
                  {pendingAttachments.length > 0 && (
                    <AttachmentStrip
                      attachments={pendingAttachments}
                      onRemove={(id) => setPendingAttachments((prev) => {
                        const removed = prev.find((item) => item.localId === id);
                        if (removed) revokeComposerPreview(removed);
                        return prev.filter((item) => item.localId !== id);
                      })}
                    />
                  )}
                  <div className="flex items-center justify-between px-2 pb-2">
                    <div className="flex items-center gap-1">
                      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files, 'main'); e.currentTarget.value = ''; }} />
                      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files, 'main'); e.currentTarget.value = ''; }} />
                      <button onClick={() => imageInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded-sm border border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900 hover:bg-amber-50 disabled:opacity-40" title="上传图片"><Image size={16} /></button>
                      <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded-sm border border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900 hover:bg-amber-50 disabled:opacity-40" title="上传附件"><Paperclip size={16} /></button>
                      <label className="ml-1 flex cursor-pointer items-center gap-1 text-neutral-400 hover:text-neutral-600"><input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} className="rounded border-neutral-300" /><span className="text-xs">作为任务</span></label>
                    </div>
                    <button data-smoke="chat-message-send" onClick={sendMessage} disabled={uploading || hasUploadingAttachments(pendingAttachments) || hasFailedAttachments(pendingAttachments) || (!input.trim() && readyArtifacts(pendingAttachments).length === 0)} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40"><Send size={14} /></button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : tab === 'tasks' ? (
          activeChannel ? (
            <ConversationTasks
              tasks={tasks}
              taskNumbers={taskNumbers}
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
            humanProfiles={humanProfiles}
            channelMembers={channelMembers}
            onJump={jumpToMessage}
          />
        )}
        </>
      )}
    </div>

      {profileTarget && (
        <ProfilePanel
          target={profileTarget}
          human={profileHuman}
          agent={profileAgent}
          agentTitle={profileAgentTitle}
          currentUserId={currentUser?.id}
          agents={agents}
          onClose={closeProfile}
          onOpenAgent={(agentId) => openProfile({ kind: 'agent', id: agentId })}
        />
      )}

      {!profileTarget && threadRoot && activeChannel && (
        <ThreadPanel
          root={threadRoot}
          replies={threadReplies}
          agents={agents}
          humanProfiles={humanProfiles}
          title={`讨论串 — ${isDm ? `@${activeDmName}` : `#${activeName}`}`}
          input={threadInput}
          attachments={threadAttachments}
          uploading={uploading}
          imageInputRef={threadImageInputRef}
          fileInputRef={threadFileInputRef}
          savedIds={savedIds}
          reactionIds={reactionIds}
          tasks={tasks}
          taskNumbers={taskNumbers}
          activeDmAgent={activeDmAgent}
          channelMembers={channelMembers}
          mentionMembers={mentionMembers}
          chatTaskMenuTarget={chatTaskMenuTarget}
          onInput={setThreadInput}
          onSend={sendThreadMessage}
          onUpload={(files) => uploadFiles(files, 'thread')}
          onRemoveAttachment={(id) => setThreadAttachments((prev) => {
            const removed = prev.find((item) => item.localId === id);
            if (removed) revokeComposerPreview(removed);
            return prev.filter((item) => item.localId !== id);
          })}
          onReply={handleThreadReply}
          onOpenProfile={openProfile}
          onToggleSave={toggleSave}
          onToggleReaction={toggleReaction}
          onTaskMenu={(messageId) => setChatTaskMenuTarget(messageId ? { surface: 'thread', messageId } : null)}
          onTaskStatus={updateTaskStatus}
          onViewInChannel={viewThreadRootInChannel}
          onClose={closeThread}
        />
      )}

      {showNewChannel && <NewChannelDialog onClose={() => setShowNewChannel(false)} teamId={currentTeamId} networkPath={np} />}
      {showEditChannel && activeChannelObj && (
        <ChannelEditDialog
          channel={activeChannelObj}
          teamId={currentTeamId}
          onClose={() => setShowEditChannel(false)}
          onSaved={() => setShowEditChannel(false)}
          onArchive={handleArchiveChannel}
          onDelete={handleDeleteChannel}
          isDefaultChannel={isDefaultPublicChannel}
        />
      )}
      {showMembers && activeChannelObj && (
        <ChannelMembersDialog
          channelName={activeChannelObj.name}
          members={channelMembers}
          candidates={mentionMembers.map((member) => ({ id: member.id, name: member.name, kind: member.kind }))}
          onAddMember={handleAddChannelMember}
          onRemoveMember={handleRemoveChannelMember}
          onOpenMember={(member) => {
            setShowMembers(false);
            openProfile({ kind: member.kind, id: member.id });
          }}
          canAddMembers={canManageActiveChannelMembers}
          canRemoveMembers={canManageActiveChannelMembers}
          onClose={() => setShowMembers(false)}
        />
      )}
    </div>
  );
}

function ChannelEditDialog({
  channel,
  teamId,
  onClose,
  onSaved,
  onArchive,
  onDelete,
  isDefaultChannel,
}: {
  channel: { id: string; name: string; description?: string | null; visibility?: string };
  teamId: string;
  onClose: () => void;
  onSaved: () => void;
  onArchive: (channelId: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (channelId: string) => Promise<{ ok: boolean; error?: string }>;
  isDefaultChannel: boolean;
}) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const [visibility, setVisibility] = useState<'public' | 'private'>(channel.visibility === 'private' ? 'private' : 'public');
  const [saving, setSaving] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!isDefaultChannel && !name.trim()) return;
    setSaving(true);
    setError(null);
    const res = await channelEvents().update({
      teamId,
      channelId: channel.id,
      name: isDefaultChannel ? undefined : name.trim(),
      description: description.trim() || null,
      visibility: isDefaultChannel ? undefined : visibility,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? '保存失败');
      return;
    }
    onSaved();
  };

  const runDestructiveAction = async () => {
    if (!confirmAction) return;
    setSaving(true);
    setError(null);
    const res = confirmAction === 'archive' ? await onArchive(channel.id) : await onDelete(channel.id);
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? '操作失败');
      return;
    }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-smoke="channel-edit-dialog" data-channel-id={channel.id}>
      <div className="w-[420px] rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">编辑频道</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X size={16} /></button>
        </div>
        <div className="space-y-4">
          {!isDefaultChannel && (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">名称 *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" data-smoke="channel-edit-name" />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">描述（可选）</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="这个频道用于什么？" autoFocus={isDefaultChannel} className="w-full resize-none rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" data-smoke="channel-edit-description" />
          </div>
          {!isDefaultChannel && (
            <div className="flex items-center gap-2">
              <button onClick={() => setVisibility('public')} className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs ${visibility === 'public' ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-neutral-200 text-neutral-500 hover:bg-neutral-50'}`}>
                <Hash size={12} /> 公开
              </button>
              <button onClick={() => setVisibility('private')} className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs ${visibility === 'private' ? 'border-purple-300 bg-purple-50 text-purple-700' : 'border-neutral-200 text-neutral-500 hover:bg-neutral-50'}`}>
                <Lock size={12} /> 私有
              </button>
            </div>
          )}
        </div>
        {error && <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>}
        <div className="mt-5 flex items-center justify-between border-t border-neutral-100 pt-4">
          {!isDefaultChannel && (
            <div className="flex gap-2">
              <button onClick={() => setConfirmAction('archive')} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50" data-smoke="channel-archive-open">归档频道</button>
              <button onClick={() => setConfirmAction('delete')} className="rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50" data-smoke="channel-delete-open">删除频道</button>
            </div>
          )}
          <div className="flex gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100">取消</button>
          <button onClick={handleSave} disabled={saving || (!isDefaultChannel && !name.trim())} className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50" data-smoke="channel-edit-save">
            {saving ? '保存中...' : '保存'}
          </button>
          </div>
        </div>
        {confirmAction && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="text-xs font-medium text-amber-900">{confirmAction === 'archive' ? '确认归档这个频道？' : '确认永久删除这个频道？'}</div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => setConfirmAction(null)} className="rounded-md border border-amber-200 bg-white px-2.5 py-1 text-xs text-amber-700">取消</button>
              <button onClick={runDestructiveAction} disabled={saving} className="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50" data-smoke={`channel-confirm-${confirmAction}`}>确认</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelMembersDialog({
  channelName,
  members,
  candidates,
  onAddMember,
  onRemoveMember,
  onOpenMember,
  canAddMembers,
  canRemoveMembers,
  onClose,
}: {
  channelName: string;
  members: ChannelMemberEntry[];
  candidates: ChannelMemberEntry[];
  onAddMember: (member: ChannelMemberEntry) => Promise<{ ok: boolean; error?: string }>;
  onRemoveMember: (member: ChannelMemberEntry) => Promise<{ ok: boolean; error?: string }>;
  onOpenMember: (member: ChannelMemberEntry) => void;
  canAddMembers: boolean;
  canRemoveMembers: boolean;
  onClose: () => void;
}) {
  const agentMembers = members.filter((member) => member.kind === 'agent');
  const humanMembers = members.filter((member) => member.kind === 'human');
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memberKeys = new Set(members.map((member) => `${member.kind}:${member.id}`));
  const addable = candidates.filter((candidate) => !memberKeys.has(`${candidate.kind}:${candidate.id}`));
  const add = async (member: ChannelMemberEntry) => {
    setAdding(true);
    setError(null);
    const res = await onAddMember(member);
    setAdding(false);
    if (!res.ok) {
      setError(res.error ?? '添加失败');
      return;
    }
    setShowAdd(false);
  };
  const remove = async (member: ChannelMemberEntry) => {
    const key = `${member.kind}:${member.id}`;
    setRemovingKey(key);
    setError(null);
    const res = await onRemoveMember(member);
    setRemovingKey(null);
    if (!res.ok) setError(res.error ?? '移除失败');
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35" data-smoke="channel-members-dialog" data-channel-name={channelName}>
      <div className="w-[380px] rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">成员（{members.length}）</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X size={16} /></button>
        </div>
        <div className="max-h-[260px] overflow-y-auto rounded-lg border border-neutral-200 p-3 pr-2">
          <MemberGroup title="智能体" members={agentMembers} onOpen={onOpenMember} onRemove={canRemoveMembers ? remove : undefined} removingKey={removingKey} />
          <MemberGroup title="人类" members={humanMembers} onOpen={onOpenMember} onRemove={canRemoveMembers ? remove : undefined} removingKey={removingKey} />
          {members.length === 0 && <div className="py-6 text-center text-sm text-neutral-400">#{channelName} 暂无成员</div>}
        </div>
        {error && <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>}
        {canAddMembers && showAdd && (
          <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-neutral-200 p-2">
            {addable.length === 0 ? (
              <div className="py-4 text-center text-xs text-neutral-400">没有可添加的成员</div>
            ) : addable.map((member) => (
              <button
                key={`${member.kind}:${member.id}`}
                onClick={() => add(member)}
                disabled={adding}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-50 disabled:opacity-50"
                data-smoke="channel-member-add-candidate"
                data-member-kind={member.kind}
                data-member-id={member.id}
                data-member-name={member.name}
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold ${member.kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>{member.kind === 'agent' ? 'A' : '人'}</span>
                <span className="truncate">{member.name}</span>
                <span className="ml-auto text-[10px] text-neutral-400">{member.kind === 'agent' ? '智能体' : '人类'}</span>
              </button>
            ))}
          </div>
        )}
        {canAddMembers && (
          <button onClick={() => setShowAdd((v) => !v)} disabled={adding} className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-pink-500 px-3 py-2 text-sm font-medium text-white hover:bg-pink-600 disabled:opacity-50" data-smoke="channel-members-add-toggle">
            <Plus size={14} /> 添加成员
          </button>
        )}
      </div>
    </div>
  );
}

function MemberGroup({
  title,
  members,
  onOpen,
  onRemove,
  removingKey,
}: {
  title: string;
  members: ChannelMemberEntry[];
  onOpen: (member: ChannelMemberEntry) => void;
  onRemove?: (member: ChannelMemberEntry) => void;
  removingKey?: string | null;
}) {
  if (members.length === 0) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{title}</div>
      <div className="space-y-2">
        {members.map((member) => (
          <div
            key={`${member.kind}:${member.id}`}
            className="flex items-center gap-2"
            data-smoke="channel-member-item"
            data-member-kind={member.kind}
            data-member-id={member.id}
            data-member-name={member.name}
          >
            <button
              type="button"
              onClick={() => onOpen(member)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              title={`查看 ${member.name} 资料`}
            >
              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ${member.kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>
                {member.kind === 'agent' ? 'A' : '人'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-800">{member.name}</div>
                {member.kind === 'agent' && (
                  <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(member.status)}`} />
                    <span>{statusLabel(member.status)}</span>
                  </div>
                )}
              </div>
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(member);
                }}
                disabled={removingKey === `${member.kind}:${member.id}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-300 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
                title={`移除 ${member.name}`}
                aria-label={`移除 ${member.name}`}
                data-smoke="channel-member-remove"
                data-member-kind={member.kind}
                data-member-id={member.id}
                data-member-name={member.name}
              >
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConversationTasks({
  tasks,
  taskNumbers,
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
  taskNumbers: Map<string, number>;
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
                  <td className="py-2 pr-4 text-xs text-neutral-400">#{taskNumbers.get(task.id) ?? '任务'}</td>
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
          <div className="text-[11px] text-neutral-400">任务</div>
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
  humanProfiles,
  channelMembers,
  onJump,
}: {
  files: ConversationFile[];
  agents: Record<string, AgentSnapshot>;
  humanProfiles: HumanProfile[];
  channelMembers: ChannelMemberEntry[];
  onJump: (messageId: string) => void;
}) {
  const currentUser = useAgentBeanStore((s) => s.currentUser);
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
            const thumbnail = (
              <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden border border-neutral-200 bg-neutral-50">
                {isImage && previewUrl ? (
                  <img src={previewUrl} alt={file.artifact.filename} className="h-full w-full object-cover" />
                ) : (
                  <Paperclip size={20} className="text-neutral-400" />
                )}
              </span>
            );
            const summary = (
              <>
                <div className="truncate text-sm font-semibold text-neutral-900">{file.artifact.filename}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  <span>{formatFileSize(file.artifact.sizeBytes)}</span>
                  <span className="text-neutral-300">·</span>
                  <span>{formatDateTime(file.createdAt)}</span>
                  <span className="text-neutral-300">·</span>
                  <span>{speakerName({ id: file.messageId, channelId: '', senderKind: file.senderKind, senderId: file.senderId, body: '', createdAt: file.createdAt }, agents, { currentUser, humanProfiles, channelMembers })}</span>
                </div>
              </>
            );
            return (
              <div key={`${file.messageId}-${file.artifact.id}`} className="flex min-h-20 items-center gap-3 border border-neutral-300 bg-white px-3 py-2 hover:border-neutral-900">
                {previewUrl ? <a href={previewUrl} target="_blank" rel="noreferrer" title="预览文件">{thumbnail}</a> : thumbnail}
                {previewUrl ? (
                  <a href={previewUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1" title="预览文件">{summary}</a>
                ) : (
                  <div className="min-w-0 flex-1">{summary}</div>
                )}
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => onJump(file.messageId)} className="flex h-8 w-8 items-center justify-center border border-neutral-900 text-neutral-700 hover:bg-amber-50" title="跳转到原消息">
                    <ExternalLink size={15} />
                  </button>
                  {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="flex h-8 w-8 items-center justify-center border border-neutral-900 text-neutral-700 hover:bg-amber-50" title="下载文件">
                    <Download size={15} />
                  </a>}
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
  humanProfiles,
  title,
  input,
  attachments,
  uploading,
  imageInputRef,
  fileInputRef,
  savedIds,
  reactionIds,
  tasks,
  taskNumbers,
  activeDmAgent,
  channelMembers,
  mentionMembers,
  chatTaskMenuTarget,
  onInput,
  onSend,
  onUpload,
  onRemoveAttachment,
  onReply,
  onOpenProfile,
  onToggleSave,
  onToggleReaction,
  onTaskMenu,
  onTaskStatus,
  onViewInChannel,
  onClose,
}: {
  root: ChatMessage;
  replies: ChatMessage[];
  agents: Record<string, AgentSnapshot>;
  humanProfiles: HumanProfile[];
  title: string;
  input: string;
  attachments: ComposerAttachment[];
  uploading: boolean;
  imageInputRef: RefObject<HTMLInputElement>;
  fileInputRef: RefObject<HTMLInputElement>;
  savedIds: Set<string>;
  reactionIds: Set<string>;
  tasks: TaskItem[];
  taskNumbers: Map<string, number>;
  activeDmAgent?: AgentSnapshot;
  channelMembers: ChannelMemberEntry[];
  mentionMembers: MentionProfileMember[];
  chatTaskMenuTarget: ChatTaskMenuTarget;
  onInput: (value: string) => void;
  onSend: () => void;
  onUpload: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onReply: (msg: ChatMessage) => void;
  onOpenProfile: (target: ProfileTarget) => void;
  onToggleSave: (msgId: string) => void;
  onToggleReaction: (msgId: string) => void;
  onTaskMenu: (taskId: string | null) => void;
  onTaskStatus: (task: TaskItem, status: TaskStatus) => void;
  onViewInChannel: () => void;
  onClose: () => void;
}) {
  const rootTaskId = metaTaskId(root);
  const rootTask = rootTaskId ? tasks.find((task) => task.id === rootTaskId) ?? null : null;
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const subtitle = rootTask
    ? `#${taskNumbers.get(rootTask.id) ?? '任务'} ${rootTask.title}`
    : resolveMessageSpeaker(root, agents, { currentUser, humanProfiles, channelMembers });
  const renderThreadBubble = (msg: ChatMessage, replyCount = 0) => {
    const taskId = metaTaskId(msg);
    const task = taskId ? tasks.find((item) => item.id === taskId) ?? null : null;
    return (
      <ChatBubble
        key={msg.id}
        msg={msg}
        task={task}
        taskNumber={task ? taskNumbers.get(task.id) : undefined}
        taskAssigneeName={taskAssigneeLabel(msg, task, agents, activeDmAgent, channelMembers)}
        taskMenuOpen={task ? chatTaskMenuTarget?.surface === 'thread' && chatTaskMenuTarget.messageId === msg.id : false}
        saved={savedIds.has(msg.id)}
        reacted={reactionIds.has(msg.id)}
        humanProfiles={humanProfiles}
        channelMembers={channelMembers}
        mentionMembers={mentionMembers}
        onReply={() => onReply(msg)}
        onOpenThread={() => {}}
        onOpenProfile={onOpenProfile}
        onToggleReaction={() => onToggleReaction(msg.id)}
        onToggleSave={() => onToggleSave(msg.id)}
        onTaskMenu={(open) => onTaskMenu(open && task ? msg.id : null)}
        onTaskStatus={(status) => { if (task) onTaskStatus(task, status); }}
        replyCount={replyCount}
        showReplyAction={false}
        showReplyCount={false}
      />
    );
  };
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
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭讨论串">
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
            placeholder="回复讨论串"
            className="w-full resize-none px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-neutral-400"
          />
          {attachments.length > 0 && <AttachmentStrip attachments={attachments} onRemove={onRemoveAttachment} />}
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) onUpload(e.target.files); e.currentTarget.value = ''; }} />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) onUpload(e.target.files); e.currentTarget.value = ''; }} />
              <button onClick={() => imageInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded-sm border border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900 hover:bg-amber-50 disabled:opacity-40" title="上传图片">
                <Image size={16} />
              </button>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded-sm border border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900 hover:bg-amber-50 disabled:opacity-40" title="上传附件">
                <Paperclip size={16} />
              </button>
            </div>
            <button onClick={onSend} disabled={uploading || hasUploadingAttachments(attachments) || hasFailedAttachments(attachments) || (!input.trim() && readyArtifacts(attachments).length === 0)} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40">
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ProfilePanel({
  target,
  human,
  agent,
  agentTitle,
  currentUserId,
  agents,
  onClose,
  onOpenAgent,
}: {
  target: ProfileTarget;
  human: HumanProfile | null;
  agent: AgentSnapshot | null | undefined;
  agentTitle?: string | null;
  currentUserId?: string;
  agents: Record<string, AgentSnapshot>;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const title = target.kind === 'agent'
    ? (agent?.name ?? agentTitle ?? 'Agent')
    : (human?.username ?? '成员');
  const createdAgents = target.kind === 'human'
    ? ownedAgentsForMember(agents, target.id)
    : [];

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-neutral-200 bg-white">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ProfileAvatar label={title} kind={target.kind} status={agent?.status} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-neutral-900">{title}</div>
            <div className="truncate text-xs text-neutral-400">
              {target.kind === 'agent' ? statusLabel(agent?.status) : target.id === currentUserId ? '你' : '成员'}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭资料">
          <X size={16} />
        </button>
      </div>

      {target.kind === 'agent' ? (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-4">
            <ProfileAvatar label={title} kind="agent" status={agent?.status} large />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-neutral-950">{title}</div>
              <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(agent?.status)}`} />
                {statusLabel(agent?.status)}
              </div>
            </div>
          </div>
          <ProfileSection title="功能介绍">
            <p className="text-sm leading-6 text-neutral-600">{agent?.description?.trim() || agent?.role || '暂无介绍'}</p>
          </ProfileSection>
          <ProfileSection title="信息">
            <ProfileInfo label="类型" value={agent?.category === 'agentos-hosted' ? 'AgentOS 托管型 Agent' : '自定义 Agent'} />
            <ProfileInfo label="Coding Agent 运行时" value={agent?.adapterKind ?? '未知'} />
            <ProfileInfo label="目录" value={agent?.cwd || '未配置'} />
            <ProfileInfo label="创建者" value={agent?.ownerName || '未知'} />
          </ProfileSection>
          <ProfileSection title="状态">
            <ProfileInfo label="最近在线" value={agent?.lastSeenAt ? formatDateTime(agent.lastSeenAt) : '未知'} />
            {agent?.lastError && <ProfileInfo label="最近错误" value={agent.lastError} />}
          </ProfileSection>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-4">
            <ProfileAvatar label={title} kind="human" large />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-neutral-950">{title}{target.id === currentUserId ? '（你）' : ''}</div>
              <div className="text-xs text-neutral-400">{human?.role === 'admin' ? '所有者' : human?.role || '成员'}</div>
            </div>
          </div>
          <ProfileSection title="描述">
            <p className="text-sm italic text-neutral-400">暂无描述</p>
          </ProfileSection>
          <ProfileSection title="信息">
            <ProfileInfo label="角色" value={human?.role === 'admin' ? '所有者' : human?.role || '成员'} />
            <ProfileInfo label="邮箱" value={human?.email || '未公开'} />
          </ProfileSection>
          <ProfileSection title={`创建的 Agent ${createdAgents.length}`}>
            {createdAgents.length === 0 ? (
              <p className="text-sm text-neutral-400">暂无创建的 Agent</p>
            ) : (
              <div className="space-y-2">
                {createdAgents.map((item) => (
                  <button key={item.id} onClick={() => onOpenAgent(item.id)} className="flex w-full items-center gap-3 border border-neutral-300 bg-white px-3 py-2 text-left hover:border-neutral-900 hover:bg-amber-50/40">
                    <ProfileAvatar label={item.name} kind="agent" status={item.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-neutral-900">{item.name}</div>
                      <div className="truncate text-xs text-neutral-400">{item.adapterKind}</div>
                    </div>
                    <span className={`h-2 w-2 rounded-full ${statusDotClass(item.status)}`} />
                  </button>
                ))}
              </div>
            )}
          </ProfileSection>
        </div>
      )}
    </aside>
  );
}

function ProfileAvatar({ label, kind, status, large }: { label: string; kind: ProfileTarget['kind']; status?: AgentStatus; large?: boolean }) {
  return (
    <div className={`relative flex shrink-0 items-center justify-center border border-neutral-900 font-semibold ${large ? 'h-16 w-16 text-xl' : 'h-8 w-8 text-xs'} ${kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>
      {label[0]?.toUpperCase() ?? (kind === 'agent' ? 'A' : 'H')}
      {kind === 'agent' && <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-white ${statusDotClass(status)}`} />}
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-neutral-200 pt-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{title}</div>
      {children}
    </section>
  );
}

function ProfileInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="min-w-0 break-words text-neutral-700">{value}</div>
    </div>
  );
}

function SidebarSortButton({
  mode,
  open,
  onToggle,
  onSelect,
}: {
  mode: SidebarSortMode;
  open: boolean;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onSelect: (mode: SidebarSortMode) => void;
}) {
  const options: { id: SidebarSortMode; label: string }[] = [
    { id: 'manual', label: '手动' },
    { id: 'recent', label: '最近' },
    { id: 'az', label: 'A-Z' },
  ];
  return (
    <div className="relative ml-auto">
      <button onClick={onToggle} className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-white/70 hover:text-neutral-700" title={`会话排序：${sortModeLabel(mode)}`}>
        <ArrowUpDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-30 w-28 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(option.id);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-50 ${mode === option.id ? 'font-semibold text-neutral-900' : 'text-neutral-600'}`}
            >
              <Check size={12} className={mode === option.id ? 'opacity-100' : 'opacity-0'} />
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentStrip({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 border-t border-neutral-100 px-2 py-2">
      {attachments.map((attachment) => {
        const artifact = attachment.artifact;
        const isImage = attachment.mimeType.startsWith('image/');
        const imageSrc = attachment.previewUrl ?? (artifact ? artifactUrl(artifact.previewUrl) : undefined);
        const statusLabel = attachment.status === 'uploading'
          ? '上传中'
          : attachment.status === 'failed'
            ? '上传失败'
            : attachment.mimeType || '附件文件';
        return (
          <div
            key={attachment.localId}
            className={`group relative flex h-14 overflow-hidden rounded-sm border border-neutral-300 bg-white text-xs shadow-sm ${isImage ? 'w-14' : 'w-44 max-w-full items-center gap-2 px-2'}`}
            title={attachment.error ?? attachment.filename}
          >
            {isImage && imageSrc ? (
              <img src={imageSrc} alt={attachment.filename} className={`h-full w-full object-cover ${attachment.status === 'uploading' ? 'opacity-70' : ''}`} />
            ) : (
              <>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-neutral-200 bg-neutral-50 text-neutral-600">
                  <Paperclip size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-neutral-800">{attachment.filename}</div>
                  <div className={`truncate text-[10px] ${attachment.status === 'failed' ? 'text-red-500' : 'text-neutral-400'}`}>{statusLabel}</div>
                </div>
              </>
            )}
            {isImage && attachment.status !== 'ready' && (
              <div className={`absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[10px] text-white ${attachment.status === 'failed' ? 'bg-red-500/85' : 'bg-neutral-900/70'}`}>
                {statusLabel}
              </div>
            )}
            <button
              onClick={() => onRemove(attachment.localId)}
              className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-sm bg-white/90 text-neutral-500 opacity-0 shadow-sm hover:text-neutral-900 group-hover:opacity-100 focus:opacity-100"
              title="移除附件"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ChatBubble({
  msg,
  task,
  taskNumber,
  taskAssigneeName,
  taskMenuOpen = false,
  selected = false,
  saved,
  reacted,
  humanProfiles = [],
  channelMembers = [],
  mentionMembers = [],
  onReply,
  onOpenThread,
  onOpenProfile,
  onToggleReaction,
  onToggleSave,
  onTaskMenu,
  onTaskStatus,
  replyCount,
  showReplyAction = true,
  showReplyCount = true,
}: {
  msg: ChatMessage;
  task?: TaskItem | null;
  taskNumber?: number;
  taskAssigneeName?: string;
  taskMenuOpen?: boolean;
  selected?: boolean;
  saved: boolean;
  reacted: boolean;
  humanProfiles?: HumanProfile[];
  channelMembers?: ChannelMemberEntry[];
  mentionMembers?: MentionProfileMember[];
  onReply: () => void;
  onOpenThread: () => void;
  onOpenProfile: (target: ProfileTarget) => void;
  onToggleReaction: () => void;
  onToggleSave: () => void;
  onTaskMenu?: (open: boolean) => void;
  onTaskStatus?: (status: TaskStatus) => void;
  replyCount: number;
  showReplyAction?: boolean;
  showReplyCount?: boolean;
}) {
  const agents = useAgentBeanStore((s) => s.agents);
  const agent = msg.senderId ? agents[msg.senderId] : undefined;
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const applyDispatchStatus = useAgentBeanStore((s) => s.applyDispatchStatus);
  const meta = parseMeta(msg);

  if (msg.senderKind === 'system') {
    if (meta.kind === 'task-status-updated') {
      const status = isTaskStatus(meta.status) ? meta.status : 'todo';
      const taskLabel = typeof meta.taskNumber === 'number' ? `#${meta.taskNumber}` : '#任务';
      return (
        <div className="mx-auto my-2 flex max-w-fit items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-600 shadow-sm">
          <span className={`h-2 w-2 rounded-full ${taskStatusDotClass(status)}`} />
          <span>任务 {taskLabel} 状态更新为 {taskStatusText(status)}</span>
        </div>
      );
    }
    return (
      <div className="mx-auto my-1 max-w-prose rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700">
        {msg.body}
      </div>
    );
  }

  const isHuman = msg.senderKind === 'human';
  const speaker = messageSpeakerName(msg, agents, { currentUser, humanProfiles, channelMembers });
  const time = formatTime(msg.createdAt);
  const isOwner = isHuman && currentUser?.id === msg.senderId;
  const taskId = typeof meta.taskId === 'string' ? meta.taskId : null;
  const canOpenProfile = Boolean(msg.senderId && (msg.senderKind === 'human' || msg.senderKind === 'agent'));
  const messageMentionMembers = mergeMentionProfileMembers(channelMembers, mentionMembers);
  const profileTarget = msg.senderKind === 'agent'
    ? { kind: 'agent' as const, id: msg.senderId ?? '' }
    : { kind: 'human' as const, id: msg.senderId ?? '' };
  const dispatch = isHuman ? msg.dispatchStatus : undefined;

  const cancelDispatch = () => {
    if (!msg.dispatchId) return;
    emitWithTimeout(getWebSocket(), WEB_EVENTS.dispatch.cancel, { dispatchId: msg.dispatchId })
      .then((res: { ok?: boolean; dispatch?: { id?: string; status?: DispatchStatus } }) => {
        if (res?.ok && res.dispatch?.status) {
          applyDispatchStatus(msg.channelId, msg.id, res.dispatch.status, res.dispatch.id);
        }
      })
      .catch(() => {});
  };

  const renderDispatchStatus = () => {
    if (!dispatch || dispatch === 'succeeded') return null;
    if (dispatch === 'queued' || dispatch === 'sent' || dispatch === 'accepted' || dispatch === 'running') {
      return (
        <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
          <Loader2 size={12} className="animate-spin text-blue-500" />
          <span>agent 正在处理...</span>
          {msg.dispatchId && (
            <button
              type="button"
              onClick={cancelDispatch}
              className="inline-flex h-5 items-center gap-1 border border-neutral-200 bg-white px-1.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-50"
              title="取消 dispatch"
            >
              <X size={10} />
              <span>取消</span>
            </button>
          )}
        </div>
      );
    }
    if (dispatch === 'cancelled') {
      return <div className="mt-2 text-xs text-neutral-400">已取消</div>;
    }
    if (dispatch === 'failed') {
      return (
        <div className="mt-2 flex items-center gap-1 text-xs text-red-500">
          <AlertCircle size={12} />
          <span>处理失败</span>
        </div>
      );
    }
    if (dispatch === 'timed_out') {
      return <div className="mt-2 text-xs text-amber-600">处理超时</div>;
    }
    return null;
  };

  return (
    <div
      id={`message-${msg.id}`}
      data-smoke="chat-message"
      data-message-body={msg.body}
      data-message-selected={selected ? 'true' : 'false'}
      className={`group relative flex gap-2 rounded-md border px-2 py-2 transition-colors ${
        selected
          ? 'border-amber-400 bg-amber-50/70 shadow-[inset_3px_0_0_#f59e0b]'
          : 'border-transparent hover:border-neutral-900 hover:bg-white'
      }`}
    >
      <div className="pointer-events-none absolute right-2 top-1 z-10 flex items-center gap-0.5 border border-neutral-300 bg-white opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        {showReplyAction && (
          <button onClick={onReply} className="flex h-6 w-6 items-center justify-center border-r border-neutral-200 text-neutral-500 hover:bg-amber-50 hover:text-neutral-900" title="回复讨论串">
            <MessageSquare size={13} />
          </button>
        )}
        <button onClick={onToggleReaction} className={`flex h-6 w-6 items-center justify-center ${showReplyAction ? 'border-r' : ''} border-neutral-200 hover:bg-amber-50 ${reacted ? 'text-pink-600' : 'text-neutral-500 hover:text-neutral-900'}`} title={reacted ? '取消表情' : '添加表情'}>
          <Smile size={13} />
        </button>
        <button onClick={onToggleSave} className={`flex h-6 w-6 items-center justify-center hover:bg-amber-50 ${saved ? 'text-amber-500' : 'text-neutral-500 hover:text-neutral-900'}`} title={saved ? '取消收藏' : '收藏消息'}>
          {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </button>
      </div>
      {/* Avatar */}
      <button
        onClick={() => { if (canOpenProfile) onOpenProfile(profileTarget); }}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700 hover:ring-2 hover:ring-neutral-900"
        title="查看资料"
      >
        {speaker[0].toUpperCase()}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button onClick={() => { if (canOpenProfile) onOpenProfile(profileTarget); }} className="text-sm font-semibold text-neutral-900 hover:underline">{speaker}</button>
          {isOwner && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700">你</span>}
          {!isHuman && agent?.role && <span className="text-xs text-neutral-400">{agent.role}</span>}
          <span className="text-[10px] text-neutral-400">{time}</span>
        </div>
        <MarkdownMessage body={displayMessageBody(msg)} mentionMembers={messageMentionMembers} onOpenMention={onOpenProfile} />
        {renderDispatchStatus()}
        {msg.artifacts && msg.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {msg.artifacts.map((artifact) => (
              <ChatArtifactPreview key={artifact.id} artifact={artifact} teamId={msg.teamId} />
            ))}
          </div>
        )}
        {(taskId || (showReplyCount && replyCount > 0) || reacted || saved) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {taskId && (
              <ChatTaskBadge
                task={task}
                taskNumber={taskNumber}
                assigneeName={taskAssigneeName ?? (agent?.name ?? speaker)}
                open={taskMenuOpen}
                onOpen={onTaskMenu}
                onStatus={onTaskStatus}
              />
            )}
            {showReplyCount && replyCount > 0 && (
              <button onClick={onOpenThread} className="inline-flex h-5 items-center gap-1 border border-sky-200 bg-sky-50 px-1.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100" title="打开讨论串">
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

function ChatTaskBadge({
  task,
  taskNumber,
  assigneeName,
  open,
  onOpen,
  onStatus,
}: {
  task?: TaskItem | null;
  taskNumber?: number;
  assigneeName: string;
  open: boolean;
  onOpen?: (open: boolean) => void;
  onStatus?: (status: TaskStatus) => void;
}) {
  const column = TASK_COLUMNS.find((item) => item.id === task?.status) ?? TASK_COLUMNS[0]!;
  const label = taskNumber ? `#${taskNumber}` : '#任务';
  const canChange = Boolean(task && onStatus);
  return (
    <span className="relative inline-flex">
      <button
        onClick={(event) => {
          event.stopPropagation();
          if (canChange) onOpen?.(!open);
        }}
        className={`inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold leading-none transition-colors ${column.badge} ${canChange ? 'hover:brightness-105' : ''}`}
        title={canChange ? `${column.label} · 更改任务状态` : `${column.label} · 查看任务`}
      >
        {taskBadgeIcon(column.id)}
        <span>{label}</span>
        <span>@{assigneeName}</span>
      </button>
      {open && canChange && (
        <div className={`absolute left-0 top-6 ${TASK_STATUS_MENU_PANEL_CLASS}`} style={TASK_STATUS_MENU_PANEL_STYLE}>
          {TASK_COLUMNS.map((status) => (
            <button
              key={status.id}
              onClick={(event) => {
                event.stopPropagation();
                onStatus?.(status.id);
              }}
              className={TASK_STATUS_MENU_ITEM_CLASS}
            >
              <span className={`${TASK_STATUS_MENU_DOT_CLASS} ${status.dot}`} />
              <span className={TASK_STATUS_MENU_LABEL_CLASS}>{status.menuLabel}</span>
              {task?.status === status.id && <Check size={12} className="text-neutral-500" />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function taskBadgeIcon(status: TaskStatus): ReactNode {
  if (status === 'done' || status === 'closed') {
    return <CheckCircle2 size={11} strokeWidth={2.5} />;
  }
  if (status === 'in_progress') {
    return <SquareDot size={11} strokeWidth={2.5} />;
  }
  return <Eye size={11} strokeWidth={2.5} />;
}

function MarkdownMessage({
  body,
  mentionMembers = [],
  onOpenMention,
}: {
  body: string;
  mentionMembers?: MentionProfileMember[];
  onOpenMention?: (target: ProfileTarget) => void;
}) {
  const markdownOptions = { mentionMembers, onOpenMention };
  return (
    <div className="mt-1 space-y-2 break-words text-sm leading-relaxed text-neutral-700">
      {renderMarkdownBlocks(body, markdownOptions)}
    </div>
  );
}

interface MarkdownRenderOptions {
  mentionMembers?: MentionProfileMember[];
  onOpenMention?: (target: ProfileTarget) => void;
}

function renderMarkdownBlocks(body: string, options: MarkdownRenderOptions = {}): ReactNode[] {
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
      nodes.push(<div key={`heading-${nodes.length}`} className={className}>{renderInlineMarkdown(heading[2]!, options)}</div>);
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
            <p key={idx}>{renderInlineMarkdown(quote, options)}</p>
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
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item, options)}</li>)}
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
          {items.map((item, idx) => <li key={idx}>{renderInlineMarkdown(item, options)}</li>)}
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
      nodes.push(renderMarkdownTable(tableLines, `table-${nodes.length}`, options));
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
    nodes.push(<p key={`p-${nodes.length}`}>{renderParagraphLines(paragraph, options)}</p>);
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

function renderMarkdownTable(lines: string[], key: string, options: MarkdownRenderOptions = {}): ReactNode {
  const header = parseMarkdownTableRow(lines[0] ?? '');
  const rows = lines.slice(2).map(parseMarkdownTableRow);
  return (
    <div key={key} className="overflow-x-auto rounded-md border border-neutral-200">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-neutral-50 text-neutral-900">
          <tr>
            {header.map((cell, index) => (
              <th key={index} className="border-b border-neutral-200 px-2 py-1.5 font-semibold">
                {renderInlineMarkdown(cell, options)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-neutral-100 align-top">
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="px-2 py-1.5 text-neutral-700">
                  {renderInlineMarkdown(row[cellIndex] ?? '', options)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderParagraphLines(lines: string[], options: MarkdownRenderOptions = {}): ReactNode[] {
  return lines.flatMap((line, index) => {
    const inline = renderInlineMarkdown(line, options);
    return index < lines.length - 1
      ? [...inline, <br key={`br-${index}`} />]
      : inline;
  });
}

function renderInlineMarkdown(text: string, options: MarkdownRenderOptions = {}): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+|@[\p{L}\p{N}_-]+)/gu;
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
      nodes.push(<strong key={`strong-${match.index}`} className="font-semibold text-neutral-950">{renderInlineMarkdown(token.slice(2, -2), options)}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      const href = link ? safeMarkdownHref(link[2]!) : null;
      nodes.push(href ? (
        <a key={`link-${match.index}`} href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">
          {renderInlineMarkdown(link![1]!, options)}
        </a>
      ) : token);
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      nodes.push(
        <a key={`url-${match.index}`} href={token} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">
          {token}
        </a>,
      );
    } else {
      const target = resolveMentionTarget(token.slice(1), options.mentionMembers ?? []);
      nodes.push(target && options.onOpenMention ? (
        <button
          key={`mention-${match.index}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            options.onOpenMention?.(target);
          }}
          className="font-medium text-blue-600 underline-offset-2 hover:underline"
          title={`查看 ${token} 资料`}
        >
          {token}
        </button>
      ) : (
        <span key={`mention-${match.index}`} className="font-medium text-blue-600">{token}</span>
      ));
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function mergeMentionProfileMembers(
  channelMembers: ChannelMemberEntry[] = [],
  mentionMembers: MentionProfileMember[] = [],
): MentionProfileMember[] {
  const merged = new Map<string, MentionProfileMember>();
  for (const member of [...channelMembers, ...mentionMembers]) {
    merged.set(`${member.kind}:${member.id}`, {
      id: member.id,
      name: member.name.replace(/（你）$/, ''),
      kind: member.kind,
    });
  }
  return [...merged.values()];
}

function normalizeMentionName(name: string): string {
  return name.replace(/^@/, '').replace(/（你）$/, '').trim().toLowerCase();
}

function resolveMentionTarget(name: string, members: MentionProfileMember[]): ProfileTarget | null {
  const normalized = normalizeMentionName(name);
  if (!normalized) return null;
  const member = members.find((item) => normalizeMentionName(item.name) === normalized);
  return member ? { kind: member.kind, id: member.id } : null;
}

function safeMarkdownHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/api/')) return artifactUrl(trimmed) ?? null;
  return null;
}

function stripEchoedDispatchHistory(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  const marker = normalized.search(/(?:^|\n)\s*#?\s*(?:user|assistant|system):\s+(?:[0-9A-Z]{10,}|system)\b/i);
  if (marker > 0) return normalized.slice(0, marker).trim();
  return normalized;
}

function displayMessageBody(msg: ChatMessage): string {
  const body = stripEchoedDispatchHistory(msg.body);
  if (!msg.artifacts || msg.artifacts.length === 0) return body;
  const filenameByLower = new Map(msg.artifacts.map((artifact) => [artifact.filename.toLowerCase(), artifact.filename]));
  const fileExt = '(?:png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)';
  const localPathRe = new RegExp(`(?:file://)?(?:~|/Users/[^\\s)\\]}>,;:]+|/private/[^\\s)\\]}>,;:]+|/var/[^\\s)\\]}>,;:]+|/tmp/[^\\s)\\]}>,;:]+)[^\\s)\\]}>,;:]*?\\/([^/\\s)\\]}>,;:]+\\.${fileExt})`, 'gi');
  return body.replace(localPathRe, (match, filename: string) => {
    return filenameByLower.get(filename.toLowerCase()) ?? filename ?? match;
  });
}

function artifactUrl(path: string | undefined): string | null {
  if (!path) return null;
  const token = getStoredAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${getResolvedServerUrl()}${path}${sep}token=${encodeURIComponent(token)}`;
}

function messageArtifactUrl(artifact: Artifact, kind: 'preview' | 'download', teamId?: string): string | null {
  return chatArtifactUrl(artifact, kind, {
    serverUrl: getResolvedServerUrl(),
    token: getStoredAuthToken(),
    teamId,
  });
}

function parseMeta(msg: ChatMessage): Record<string, any> {
  if (msg.meta && typeof msg.meta === 'object') return msg.meta;
  if (!msg.metaJson) return {};
  try {
    const parsed = JSON.parse(msg.metaJson);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function metaTaskId(msg: ChatMessage): string | null {
  const meta = parseMeta(msg);
  return typeof meta.taskId === 'string' ? meta.taskId : null;
}

function isTaskSystemMessage(msg: ChatMessage): boolean {
  if (msg.senderKind !== 'system') return false;
  const meta = parseMeta(msg);
  return meta.kind === 'task-created' || meta.kind === 'task-status-updated';
}

function parentMessageId(msg: ChatMessage): string | null {
  if (msg.threadId && msg.threadId !== msg.id) return msg.threadId;
  const meta = parseMeta(msg);
  return typeof meta.parentMessageId === 'string'
    ? meta.parentMessageId
    : typeof meta.inReplyTo === 'string'
      ? meta.inReplyTo
      : null;
}

function parseThreadMessageId(raw: string | null, channelId: string): string | null {
  return parseScopedMessageId(raw, channelId);
}

function parseScopedMessageId(raw: string | null, channelId: string): string | null {
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

function buildTaskNumberMap(tasks: TaskItem[]): Map<string, number> {
  const ordered = [...tasks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return new Map(ordered.map((task, index) => [task.id, index + 1]));
}

function taskAssigneeLabel(
  msg: ChatMessage,
  task: TaskItem | null,
  agents: Record<string, AgentSnapshot>,
  activeDmAgent?: AgentSnapshot,
  channelMembers: ChannelMemberEntry[] = [],
): string {
  const meta = parseMeta(msg);
  const metaAssigneeName = typeof meta.taskAssigneeName === 'string' && meta.taskAssigneeName.trim()
    ? meta.taskAssigneeName.trim()
    : null;
  if (task?.assigneeId) {
    const channelMember = channelMembers.find((member) => member.kind === 'agent' && member.id === task.assigneeId);
    return agents[task.assigneeId]?.name
      ?? (activeDmAgent?.id === task.assigneeId ? activeDmAgent.name : undefined)
      ?? channelMember?.name
      ?? metaAssigneeName
      ?? 'Agent';
  }
  if (activeDmAgent) return activeDmAgent.name;
  if (metaAssigneeName) return metaAssigneeName;
  const mention = msg.body.match(/@([\w-]+)/);
  if (mention?.[1]) return mention[1];
  if (msg.senderKind === 'agent' && msg.senderId) return agents[msg.senderId]?.name ?? 'Agent';
  return 'Agent';
}

function parseProfileParam(raw: string | null): ProfileTarget | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return null;
  const kind = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if ((kind !== 'human' && kind !== 'agent') || !id) return null;
  return { kind, id };
}

function resolveHumanProfile(
  id: string,
  humans: HumanProfile[],
  currentUser: { id: string; username: string; email: string | null; role: 'admin' | 'user' } | null,
  channelMembers: ChannelMemberEntry[],
  mentionMembers: { id: string; name: string; kind: 'human' | 'agent' }[],
): HumanProfile {
  const human = humans.find((item) => item.id === id);
  if (human) return human;
  if (currentUser?.id === id) {
    return {
      id,
      username: currentUser.username,
      email: currentUser.email,
      role: currentUser.role,
    };
  }
  const channelMember = channelMembers.find((item) => item.kind === 'human' && item.id === id);
  if (channelMember) return { id, username: channelMember.name.replace(/（你）$/, ''), role: channelMember.role };
  const mentionMember = mentionMembers.find((item) => item.kind === 'human' && item.id === id);
  if (mentionMember) return { id, username: mentionMember.name };
  return { id, username: '成员' };
}

function latestLoadedMessageAt(channelId: string, messagesByChannel: Record<string, ChatMessage[]>): number {
  return lastLoadedMessage(messagesByChannel[channelId])?.createdAt ?? 0;
}

function lastLoadedMessage(messages?: ChatMessage[]): ChatMessage | null {
  if (!messages || messages.length === 0) return null;
  return messages.reduce((latest, item) => item.createdAt > latest.createdAt ? item : latest, messages[0]!);
}

function sortChannels<T extends { id: string; name: string; createdAt?: number }>(
  channels: T[],
  mode: SidebarSortMode,
  messagesByChannel: Record<string, ChatMessage[]>,
): T[] {
  if (mode === 'manual') return channels;
  return [...channels].sort((a, b) => {
    if (mode === 'az') return a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
    return latestLoadedMessageAt(b.id, messagesByChannel) - latestLoadedMessageAt(a.id, messagesByChannel)
      || (b.createdAt ?? 0) - (a.createdAt ?? 0)
      || a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
  });
}

function sortDms<T extends { id: string; name: string; dmTargetId: string }>(
  dms: T[],
  mode: SidebarSortMode,
  messagesByChannel: Record<string, ChatMessage[]>,
  agents: Record<string, { name: string }>,
): T[] {
  if (mode === 'manual') return dms;
  return [...dms].sort((a, b) => {
    const aName = agents[a.dmTargetId]?.name ?? a.name;
    const bName = agents[b.dmTargetId]?.name ?? b.name;
    if (mode === 'az') return aName.localeCompare(bName, 'zh-CN', { sensitivity: 'base' });
    return latestLoadedMessageAt(b.id, messagesByChannel) - latestLoadedMessageAt(a.id, messagesByChannel)
      || aName.localeCompare(bName, 'zh-CN', { sensitivity: 'base' });
  });
}

function sortModeLabel(mode: SidebarSortMode): string {
  if (mode === 'recent') return '最近';
  if (mode === 'az') return 'A-Z';
  return '手动';
}

function ChatArtifactPreview({ artifact, teamId }: { artifact: Artifact; teamId?: string }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const sizeLabel = formatFileSize(artifact.sizeBytes);
  const previewUrl = messageArtifactUrl(artifact, 'preview', teamId);
  const downloadUrl = messageArtifactUrl(artifact, 'download', teamId);
  const canPreview = Boolean(previewUrl);
  const openViewer = () => {
    if (canPreview) setViewerOpen(true);
  };
  if (artifact.mimeType.startsWith('image/')) {
    return (
      <>
        <div className="group relative block max-w-80">
          {previewUrl ? (
            <button onClick={openViewer} className="block text-left" title="预览图片">
              <img
                src={previewUrl}
                alt={artifact.filename}
                className="max-h-64 rounded-md border border-neutral-200 object-contain transition group-hover:border-neutral-400"
              />
            </button>
          ) : (
            <div className="inline-flex min-h-16 max-w-96 items-center gap-3 border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-700">
              <Paperclip size={15} />
              <span className="truncate">{artifact.filename}</span>
            </div>
          )}
          <div className="pointer-events-none absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {previewUrl && <button onClick={openViewer} className="flex h-7 w-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow-sm hover:bg-neutral-100" title="打开图片">
              <Eye size={14} />
            </button>}
            {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="flex h-7 w-7 items-center justify-center rounded-md bg-white/95 text-neutral-700 shadow-sm hover:bg-neutral-100" title="下载图片">
              <Download size={14} />
            </a>}
          </div>
          <div className="mt-1 truncate text-xs text-neutral-500">{artifact.filename}</div>
        </div>
        {viewerOpen && <ArtifactViewer artifact={artifact} teamId={teamId} onClose={() => setViewerOpen(false)} />}
      </>
    );
  }
  const fileKind = artifactKind(artifact);
  return (
    <>
      <div className="group relative inline-flex min-h-16 max-w-96 border border-neutral-300 bg-white text-xs text-neutral-700 transition hover:border-neutral-500 hover:bg-neutral-50">
        <button onClick={openViewer} disabled={!canPreview} className="inline-flex min-w-0 flex-1 items-center gap-3 px-3 py-2 pr-20 text-left disabled:cursor-default" title={canPreview ? '预览文件' : '文件暂不可预览'}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-500 group-hover:bg-white">
            <Paperclip size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-neutral-900">{artifact.filename}</span>
            <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{fileKind.previewLabel} · {sizeLabel}</span>
            <span className="mt-0.5 block truncate text-[11px] text-neutral-400">{fileKind.documentLabel}</span>
          </span>
        </button>
        <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          {previewUrl && <button onClick={openViewer} className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-neutral-700 shadow-sm hover:bg-neutral-100" title="预览文件">
            <Eye size={14} />
          </button>}
          {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-neutral-700 shadow-sm hover:bg-neutral-100" title="下载文件">
            <Download size={14} />
          </a>}
        </div>
      </div>
      {viewerOpen && <ArtifactViewer artifact={artifact} teamId={teamId} onClose={() => setViewerOpen(false)} />}
    </>
  );
}

function ArtifactViewer({ artifact, teamId, onClose }: { artifact: Artifact; teamId?: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewUrl = messageArtifactUrl(artifact, 'preview', teamId);
  const downloadUrl = messageArtifactUrl(artifact, 'download', teamId);
  const fileKind = artifactKind(artifact);
  const inlineText = isInlineTextArtifact(artifact);

  if (!previewUrl) {
    return null;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!inlineText) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(previewUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(formatArtifactTextPreview(artifact, text));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '预览失败');
      });
    return () => { cancelled = true; };
  }, [artifact, inlineText, previewUrl]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-neutral-950/65">
      <div className="flex h-14 shrink-0 items-center gap-3 bg-white px-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-neutral-900">{artifact.filename}</div>
          <div className="text-[11px] text-neutral-400">{fileKind.previewLabel} · {formatFileSize(artifact.sizeBytes)}</div>
        </div>
        {downloadUrl && <a href={downloadUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50" title="下载">
          <Download size={14} />
          下载
        </a>}
        <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" title="关闭预览">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {artifact.mimeType.startsWith('image/') ? (
          <img src={previewUrl} alt={artifact.filename} className="max-h-full max-w-full rounded-lg bg-white object-contain shadow-2xl" />
        ) : inlineText ? (
          <div className="h-full w-full max-w-5xl overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
            {error ? (
              <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>
            ) : content === null ? (
              <div className="text-sm text-neutral-400">正在加载预览...</div>
            ) : isMarkdownArtifact(artifact) ? (
              <MarkdownMessage body={content} />
            ) : (
              <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-700">{content}</pre>
            )}
          </div>
        ) : (
          <iframe src={previewUrl} title={artifact.filename} className="h-full w-full max-w-5xl rounded-lg border-0 bg-white shadow-2xl" />
        )}
      </div>
    </div>
  );
}

function isMarkdownArtifact(artifact: Artifact): boolean {
  const name = artifact.filename.toLowerCase();
  return artifact.mimeType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown');
}

function isInlineTextArtifact(artifact: Artifact): boolean {
  const name = artifact.filename.toLowerCase();
  return isMarkdownArtifact(artifact)
    || artifact.mimeType.startsWith('text/')
    || artifact.mimeType === 'application/json'
    || name.endsWith('.txt')
    || name.endsWith('.json')
    || name.endsWith('.csv');
}

function formatArtifactTextPreview(artifact: Artifact, text: string): string {
  if (artifact.mimeType !== 'application/json' && !artifact.filename.toLowerCase().endsWith('.json')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function artifactKind(artifact: Artifact): { previewLabel: string; documentLabel: string } {
  const name = artifact.filename.toLowerCase();
  if (artifact.mimeType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown')) {
    return { previewLabel: 'Markdown 预览', documentLabel: 'Markdown 文档' };
  }
  if (artifact.mimeType.startsWith('text/') || name.endsWith('.txt')) {
    return { previewLabel: '文本预览', documentLabel: '文本文件' };
  }
  if (artifact.mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    return { previewLabel: 'PDF 预览', documentLabel: 'PDF 文件' };
  }
  if (name.endsWith('.json') || artifact.mimeType === 'application/json') {
    return { previewLabel: 'JSON 预览', documentLabel: 'JSON 文件' };
  }
  return { previewLabel: '文件预览', documentLabel: '附件文件' };
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
  agents: Record<string, AgentSnapshot>,
  sources: SpeakerSources = {},
): string {
  return messageSpeakerName(msg, agents, sources);
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
  return channel ? `#${channel.name}` : '会话';
}

function speakerName(msg: ChatMessage, agents: Record<string, { name: string }>, sources: SpeakerSources = {}): string {
  return messageSpeakerName(msg, agents, sources);
}

function participantName(id: string, participants: { id: string; name: string }[], currentUserId?: string): string {
  if (id === currentUserId) return '你';
  return participants.find((person) => person.id === id)?.name ?? '未命名成员';
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function SearchView({ onClose, onJump, humanProfiles }: { onClose: () => void; onJump: (channelId: string) => void; humanProfiles: HumanProfile[] }) {
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
                  <span>· {speakerName(msg, agents, { currentUser, humanProfiles })}</span>
                  <span>· {formatTime(msg.createdAt)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-sm text-neutral-700">{displayMessageBody(msg).slice(0, 180)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityView({ onJump, humanProfiles, doneIds, setDoneIds }: { onJump: (channelId: string) => void; humanProfiles: HumanProfile[]; doneIds: Set<string>; setDoneIds: Dispatch<SetStateAction<Set<string>>> }) {
  const [filter, setFilter] = useState<'all' | 'unread' | 'mentions'>('all');
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const upsertMessages = useAgentBeanStore((s) => s.upsertMessages);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const visibleIds = visibleConversationIds(channels, dms);
  const visibleList = [...visibleIds];
  const visibleKey = visibleList.join('\u001f');

  useEffect(() => {
    if (!currentTeamId || visibleList.length === 0) return;
    let cancelled = false;
    Promise.all(visibleList.map((channelId) => channelEvents().join(currentTeamId, channelId, 20))).then((results) => {
      if (cancelled) return;
      const joined: ChatMessage[] = [];
      for (const res of results) {
        if (res.ok && res.messages) joined.push(...res.messages);
      }
      upsertMessages(joined);
    });
    return () => {
      cancelled = true;
    };
  }, [currentTeamId, visibleKey, upsertMessages]);

  const allMessages = inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleIds);
  const unreadCount = allMessages.filter((m) => !doneIds.has(m.id)).length;
  const visible = allMessages.filter((m) => {
    if (filter === 'unread') return !doneIds.has(m.id);
    if (filter === 'mentions') return m.body.includes(`@${currentUser?.username ?? ''}`) || m.body.includes('@');
    return true;
  });

  return (
    <div className="flex flex-1 min-h-0 flex-col">
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.length === 0 && (
          <div className="py-12 text-center text-sm text-neutral-400">暂无活动</div>
        )}
        {visible.map((msg) => {
          const done = doneIds.has(msg.id);
          return (
            <div
              key={msg.id}
              role="button"
              tabIndex={0}
              onClick={() => onJump(msg.channelId)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onJump(msg.channelId);
              }}
              className={`group flex w-full cursor-pointer items-start gap-3 border-b border-neutral-100 px-6 py-3 text-left hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-300 ${done ? 'opacity-60' : ''}`}
            >
              <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-purple-100 text-xs font-semibold text-purple-700">
                {speakerName(msg, agents, { currentUser, humanProfiles })[0]?.toUpperCase() ?? 'A'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <span className="font-medium text-neutral-700">{conversationLabel(msg.channelId, channels, dms, agents)}</span>
                  <span>{formatTime(msg.createdAt)}</span>
                  {!done && <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">新</span>}
                </div>
                <div className="mt-1 line-clamp-2 text-sm text-neutral-700">
                  <span className="font-medium text-neutral-900">{speakerName(msg, agents, { currentUser, humanProfiles })}：</span>
                  {displayMessageBody(msg)}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SavedView({ savedMessages, onUnsave, onJump, humanProfiles }: { savedMessages: ChatMessage[]; onUnsave: (msgId: string) => void; onJump: (channelId: string) => void; humanProfiles: HumanProfile[] }) {
  const [query, setQuery] = useState('');
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);

  // savedMessages 由主组件算好传入（服务端快照 ∪ 内存命中，已去 visibleIds 过滤），
  // 这里只做搜索过滤 + 渲染。
  const filtered = savedMessages
    .filter((m) => !query.trim() || m.body.toLowerCase().includes(query.trim().toLowerCase()) || conversationLabel(m.channelId, channels, dms, agents).toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex h-16 flex-col justify-center border-b border-neutral-200 px-6">
        <h2 className="text-lg font-semibold">收藏</h2>
        <p className="text-xs text-neutral-400">{filtered.length} 条收藏</p>
      </div>
      <div className="border-b border-neutral-200 px-6 py-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索收藏..." className="h-8 w-full rounded-md border border-neutral-200 bg-neutral-50 pl-8 pr-3 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-neutral-400">
            <Bookmark size={32} strokeWidth={1.5} />
            <p className="mt-2 text-sm">{query.trim() ? '没有匹配的收藏' : '暂无收藏消息'}</p>
            <p className="text-xs">点击消息旁的书签图标收藏消息</p>
          </div>
        )}
        {filtered.map((msg) => (
          <button key={msg.id} onClick={() => onJump(msg.channelId)} className="group flex w-full items-start gap-3 border-b border-neutral-100 px-6 py-3 text-left hover:bg-neutral-50">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100 text-xs font-semibold text-amber-700">
              <Bookmark size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <span className="font-medium text-neutral-700">{conversationLabel(msg.channelId, channels, dms, agents)}</span>
                <span>{speakerName(msg, agents, { currentUser, humanProfiles })}</span>
                <span>{formatTime(msg.createdAt)}</span>
              </div>
              <div className="mt-1 line-clamp-3 text-sm text-neutral-700">{displayMessageBody(msg)}</div>
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
