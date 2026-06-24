'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bookmark,
  BookmarkCheck,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Hash,
  Image,
  LayoutGrid,
  List,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Send,
  Smile,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { uploadArtifact, getResolvedServerUrl, getStoredAuthToken, getWebSocket, channelEvents, dmEvents, memberEvents, taskEvents, messageReactionEvents } from '@/lib/socket';
import { WEB_EVENTS } from '@agentbean/contracts';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import type { AgentSnapshot, Artifact, ChannelSummary, ChatMessage } from '@/lib/schema';
import {
  TASK_STATUS_BY_ID as STATUS_BY_ID,
  TASK_STATUS_COLUMNS as STATUS_COLUMNS,
  TASK_STATUS_MENU_DOT_CLASS,
  TASK_STATUS_MENU_ITEM_CLASS,
  TASK_STATUS_MENU_LABEL_CLASS,
  TASK_STATUS_MENU_PANEL_CLASS,
  TASK_STATUS_MENU_PANEL_STYLE,
  type TaskStatus,
} from '@/lib/task-status';

type TaskViewMode = 'board' | 'list';

interface Task {
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

interface Participant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

interface FilterOption {
  id: string;
  name: string;
  icon?: ReactNode;
  muted?: boolean;
}

const ME_FILTER = '__me__';
const UNASSIGNED_FILTER = '__unassigned__';

export default function TasksPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const applyDmsSnapshot = useAgentBeanStore((s) => s.applyDmsSnapshot);
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);
  const np = useCurrentNetworkPath();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<TaskViewMode>(() => searchParams.get('view') === 'list' ? 'list' : 'board');
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [selectedCreators, setSelectedCreators] = useState<Set<string>>(new Set());
  const [selectedAssignees, setSelectedAssignees] = useState<Set<string>>(new Set());
  const [openFilter, setOpenFilter] = useState<'channel' | 'creator' | 'assignee' | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<TaskStatus>>(() => new Set(STATUS_COLUMNS.filter((column) => column.collapsedByDefault).map((column) => column.id)));
  const [dragId, setDragId] = useState<string | null>(null);
  const [statusMenuFor, setStatusMenuFor] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createChannelId, setCreateChannelId] = useState('');
  const [createAssigneeId, setCreateAssigneeId] = useState('');
  const [createTags, setCreateTags] = useState('');
  const [creating, setCreating] = useState(false);
  const [humans, setHumans] = useState<Participant[]>([]);
  const [threadInput, setThreadInput] = useState('');
  const [threadAttachments, setThreadAttachments] = useState<Artifact[]>([]);
  const [uploading, setUploading] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [reactionIds, setReactionIds] = useState<Set<string>>(new Set());
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const savedKey = `agentbean:tasks:saved:${np}`;
  const reactionsKey = `agentbean:tasks:reactions:${np}`;

  const threadTarget = parseThreadParam(searchParams.get('thread'));
  const threadChannelId = threadTarget?.channelId ?? null;

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await taskEvents().list();
      if (res.ok && res.tasks) setTasks(res.tasks as Task[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (conn !== 'open' || !currentTeamId) return;
    const socket = getWebSocket();
    channelEvents(socket).subscribe(currentTeamId);
    const onChannels = (list: ChannelSummary[]) => applyChannelsSnapshot(list);
    socket.on('channels:snapshot', onChannels);
    const unsubscribeTasks = taskEvents(socket).onSnapshot((list) => setTasks(list as Task[]));
    const unsubscribeDms = dmEvents(socket).onSnapshot(applyDmsSnapshot);
    loadTasks();
    memberEvents().list({ teamId: currentTeamId }).then((res) => {
      if (!res.ok) return;
      const members = (res.humans ?? []).map((member) => ({ id: member.userId, name: member.username, kind: 'human' as const }));
      setHumans(members);
    });
    return () => {
      socket.off('channels:snapshot', onChannels);
      unsubscribeTasks();
      unsubscribeDms();
    };
  }, [conn, currentTeamId, applyChannelsSnapshot, applyDmsSnapshot, loadTasks]);

  useEffect(() => {
    const next = searchParams.get('view') === 'list' ? 'list' : 'board';
    setView(next);
  }, [searchParams]);

  useEffect(() => {
    try {
      setSavedIds(new Set(JSON.parse(window.localStorage.getItem(savedKey) ?? '[]')));
    } catch {
      setSavedIds(new Set());
    }
  }, [savedKey]);

  useEffect(() => {
    try {
      setReactionIds(new Set(JSON.parse(window.localStorage.getItem(reactionsKey) ?? '[]')));
    } catch {
      setReactionIds(new Set());
    }
  }, [reactionsKey]);

  useEffect(() => {
    try { window.localStorage.setItem(savedKey, JSON.stringify([...savedIds])); } catch {}
  }, [savedIds, savedKey]);

  useEffect(() => {
    try { window.localStorage.setItem(reactionsKey, JSON.stringify([...reactionIds])); } catch {}
  }, [reactionIds, reactionsKey]);

  useEffect(() => {
    const targetChannelId = threadChannelId;
    if (!targetChannelId || conn !== 'open') return;
    const socket = getWebSocket();
    void channelEvents(socket).join(currentTeamId, targetChannelId);
    const onHistory = (payload: { channelId: string; messages: ChatMessage[] }) => {
      if (payload.channelId === targetChannelId) applyChannelHistory(targetChannelId, payload.messages);
    };
    const onMessage = (msg: ChatMessage) => {
      if (msg.channelId === targetChannelId) appendMessage(msg);
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', onMessage);
    return () => {
      socket.off('channel:history', onHistory);
      socket.off('channel:message', onMessage);
    };
  }, [threadChannelId, conn, applyChannelHistory, appendMessage]);

  const participants = useMemo(() => {
    const map = new Map<string, Participant>();
    if (currentUser) map.set(currentUser.id, { id: currentUser.id, name: currentUser.username, kind: 'human' });
    for (const human of humans) map.set(human.id, human);
    for (const agent of Object.values(agents)) {
      map.set(agent.id, { id: agent.id, name: agent.name, kind: 'agent' });
    }
    for (const task of tasks) {
      if (task.creatorId && !map.has(task.creatorId)) map.set(task.creatorId, { id: task.creatorId, name: '成员', kind: 'human' });
      if (task.assigneeId && !map.has(task.assigneeId)) map.set(task.assigneeId, { id: task.assigneeId, name: 'Agent', kind: 'agent' });
    }
    return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }, [agents, currentUser, humans, tasks]);

  const channelOptions = useMemo<FilterOption[]>(() => channels.map((channel) => ({
    id: channel.id,
    name: `#${channel.name}`,
    icon: <Hash size={13} className="text-neutral-400" />,
  })), [channels]);

  const creatorOptions = useMemo<FilterOption[]>(() => [
    { id: ME_FILTER, name: '我创建的', icon: <User size={13} className="text-emerald-600" /> },
    ...participants.map((person) => ({
      id: person.id,
      name: person.name,
      icon: <ParticipantIcon kind={person.kind} />,
    })),
  ], [participants]);

  const assigneeOptions = useMemo<FilterOption[]>(() => [
    { id: ME_FILTER, name: '分配给我', icon: <User size={13} className="text-emerald-600" /> },
    { id: UNASSIGNED_FILTER, name: '未分配', icon: <User size={13} className="text-neutral-400" />, muted: true },
    ...participants.map((person) => ({
      id: person.id,
      name: person.name,
      icon: <ParticipantIcon kind={person.kind} />,
    })),
  ], [participants]);

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    if (selectedChannels.size > 0 && (!task.channelId || !selectedChannels.has(task.channelId))) return false;
    if (selectedCreators.size > 0) {
      const creatorIds = expandSpecialFilters(selectedCreators, currentUser?.id);
      if (!creatorIds.has(task.creatorId)) return false;
    }
    if (selectedAssignees.size > 0) {
      const assigneeIds = expandSpecialFilters(selectedAssignees, currentUser?.id);
      const wantsUnassigned = selectedAssignees.has(UNASSIGNED_FILTER);
      if (!task.assigneeId) return wantsUnassigned;
      if (!assigneeIds.has(task.assigneeId)) return false;
    }
    return true;
  }), [currentUser?.id, selectedAssignees, selectedChannels, selectedCreators, tasks]);

  const channelTaskCount = useMemo(() => new Set(tasks.map((task) => task.channelId).filter(Boolean)).size, [tasks]);
  const taskNumbers = useMemo(() => {
    const byChannel = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = task.channelId ?? 'global';
      byChannel.set(key, [...(byChannel.get(key) ?? []), task]);
    }
    const map = new Map<string, number>();
    for (const [, list] of byChannel) {
      list.sort((a, b) => a.createdAt - b.createdAt).forEach((task, index) => map.set(task.id, index + 1));
    }
    return map;
  }, [tasks]);

  const threadMessages = threadChannelId ? (messagesByChannel[threadChannelId] ?? []) : [];
  const selectedTask = useMemo(() => {
    if (!threadTarget) return null;
    const direct = tasks.find((task) => task.channelId === threadTarget.channelId && task.id === threadTarget.itemId);
    if (direct) return direct;
    const root = threadMessages.find((msg) => msg.id === threadTarget.itemId);
    const taskId = root ? metaTaskId(root) : null;
    return taskId ? tasks.find((task) => task.id === taskId) ?? null : null;
  }, [tasks, threadMessages, threadTarget]);
  const threadRoot = selectedTask ? findTaskRootMessage(selectedTask, threadMessages) : null;
  const threadParentId = threadRoot?.id ?? selectedTask?.id ?? null;
  const threadReplies = threadParentId ? threadMessages.filter((msg) => parentMessageId(msg) === threadParentId) : [];

  const setViewParam = (nextView: TaskViewMode) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextView === 'list') params.set('view', 'list');
    else params.delete('view');
    router.replace(`/${np}/tasks${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  const openTaskThread = (task: Task) => {
    if (!task.channelId) return;
    const root = findTaskRootMessage(task, messagesByChannel[task.channelId] ?? []);
    const params = new URLSearchParams(searchParams.toString());
    params.set('thread', `${task.channelId}:${root?.id ?? task.id}`);
    router.replace(`/${np}/tasks?${params.toString()}`, { scroll: false });
  };

  const closeThread = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('thread');
    setThreadInput('');
    setThreadAttachments([]);
    router.replace(`/${np}/tasks${params.toString() ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  const updateTaskStatus = async (task: Task, status: TaskStatus) => {
    const maxSort = tasks.filter((item) => item.status === status && item.id !== task.id).reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const optimistic = { ...task, status, sortOrder: maxSort + 1, updatedAt: Date.now() };
    setTasks((prev) => prev.map((item) => item.id === task.id ? optimistic : item));
    setStatusMenuFor(null);
    const res = await taskEvents().update({ id: task.id, status, sortOrder: maxSort + 1 });
    if (res.ok && res.task) {
      setTasks((prev) => prev.map((item) => item.id === task.id ? res.task as Task : item));
    }
  };

  const moveTaskToTop = async (task: Task) => {
    const sameStatus = tasks.filter((item) => item.status === task.status && item.id !== task.id);
    const nextSortOrder = sameStatus.length > 0
      ? Math.min(...sameStatus.map((item) => item.sortOrder)) - 1
      : task.sortOrder;
    const previousTasks = tasks;
    const optimistic = { ...task, sortOrder: nextSortOrder, updatedAt: Date.now() };
    setTasks(sortTasksForDisplay(previousTasks.map((item) => item.id === task.id ? optimistic : item)));
    const res = await taskEvents().reorder(task.id, nextSortOrder);
    if (res.ok) return;
    setTasks(previousTasks);
  };

  const deleteTask = async (taskId: string) => {
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
    const res = await taskEvents().delete(taskId);
    if (!res.ok) {
      setTasks(previousTasks);
      return;
    }
    if (selectedTask?.id === taskId) closeThread();
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!createTitle.trim()) return;
    setCreating(true);
    try {
      const tags = createTags.split(',').map((tag) => tag.trim()).filter(Boolean);
      const res = await taskEvents().create({
        title: createTitle.trim(),
        description: createDescription.trim() || undefined,
        status: 'todo',
        assigneeId: createAssigneeId || undefined,
        channelId: createChannelId || undefined,
        tags,
      });
      if (res.ok && res.task) {
        setTasks((prev) => [res.task as Task, ...prev]);
        setCreateTitle('');
        setCreateDescription('');
        setCreateTags('');
        setCreateAssigneeId('');
        setShowCreate(false);
      }
    } finally {
      setCreating(false);
    }
  };

  const sendThreadMessage = () => {
    if ((!threadInput.trim() && threadAttachments.length === 0) || !selectedTask?.channelId || !threadParentId) return;
    const channelId = selectedTask.channelId;
    const body = threadInput.trim() || '附件';
    const artifactIds = threadAttachments.map((artifact) => artifact.id);
    getWebSocket().emit(WEB_EVENTS.message.send, { teamId: currentTeamId, channelId, body, threadId: threadParentId, artifactIds }, (res?: { ok?: boolean; error?: string }) => {
      if (res?.ok) return;
      appendMessage({
        id: `local-task-thread-error-${Date.now()}`,
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

  const uploadFiles = async (files: FileList | File[]) => {
    if (!selectedTask?.channelId || !currentUser || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: Artifact[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('channelId', selectedTask.channelId);
        form.append('uploaderId', currentUser.id);
        form.append('file', file);
        uploaded.push(await uploadArtifact(currentTeamId, form));
      }
      setThreadAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      appendMessage({
        id: `local-task-upload-error-${Date.now()}`,
        channelId: selectedTask.channelId,
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

  return (
    <div className="flex flex-1 overflow-hidden bg-white">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-600">
              <Check size={16} />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-neutral-950">任务</h1>
              <p className="truncate text-xs text-neutral-400">{channelTaskCount} 个频道任务</p>
            </div>
          </div>
          <button data-smoke="tasks-create-open" onClick={() => setShowCreate((value) => !value)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900">
            <Plus size={13} />
            新建任务
          </button>
        </header>

        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4">
          <FilterButton
            title="频道"
            icon={<Hash size={13} />}
            options={channelOptions}
            selected={selectedChannels}
            open={openFilter === 'channel'}
            onToggle={() => setOpenFilter(openFilter === 'channel' ? null : 'channel')}
            onChange={setSelectedChannels}
            summary={filterSummary('频道', selectedChannels, channelOptions)}
          />
          <FilterButton
            title="创建者"
            icon={<User size={13} />}
            options={creatorOptions}
            selected={selectedCreators}
            open={openFilter === 'creator'}
            onToggle={() => setOpenFilter(openFilter === 'creator' ? null : 'creator')}
            onChange={setSelectedCreators}
            summary={filterSummary('创建者', selectedCreators, creatorOptions)}
          />
          <FilterButton
            title="执行人"
            icon={<User size={13} />}
            options={assigneeOptions}
            selected={selectedAssignees}
            open={openFilter === 'assignee'}
            onToggle={() => setOpenFilter(openFilter === 'assignee' ? null : 'assignee')}
            onChange={setSelectedAssignees}
            summary={filterSummary('执行人', selectedAssignees, assigneeOptions)}
          />
          <div className="flex-1" />
          <div className="flex overflow-hidden rounded-md border border-neutral-200 bg-white">
            <button onClick={() => setViewParam('board')} className={`inline-flex h-8 items-center gap-1 border-r border-neutral-200 px-2.5 text-xs font-medium ${view === 'board' ? 'bg-neutral-100 text-neutral-900' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}>
              <LayoutGrid size={13} />
              看板
            </button>
            <button onClick={() => setViewParam('list')} className={`inline-flex h-8 items-center gap-1 px-2.5 text-xs font-medium ${view === 'list' ? 'bg-neutral-100 text-neutral-900' : 'bg-white text-neutral-500 hover:bg-neutral-50'}`}>
              <List size={13} />
              列表
            </button>
          </div>
        </div>

        {showCreate && (
          <form data-smoke="tasks-create-form" onSubmit={handleCreate} className="grid shrink-0 grid-cols-[minmax(160px,1fr)_minmax(180px,1.4fr)_150px_150px_minmax(120px,0.8fr)_auto] items-end gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
            <Field label="标题">
              <input data-smoke="tasks-create-title" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} autoFocus placeholder="任务标题" className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500" />
            </Field>
            <Field label="描述">
              <input data-smoke="tasks-create-description" value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} placeholder="补充说明" className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500" />
            </Field>
            <Field label="频道">
              <select value={createChannelId} onChange={(e) => setCreateChannelId(e.target.value)} className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm outline-none focus:border-neutral-500">
                <option value="">无频道</option>
                {channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </select>
            </Field>
            <Field label="执行人">
              <select value={createAssigneeId} onChange={(e) => setCreateAssigneeId(e.target.value)} className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm outline-none focus:border-neutral-500">
                <option value="">未分配</option>
                {participants.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </Field>
            <Field label="标签">
              <input data-smoke="tasks-create-tags" value={createTags} onChange={(e) => setCreateTags(e.target.value)} placeholder="聊天, 设计" className="h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm outline-none focus:border-neutral-500" />
            </Field>
            <div className="flex items-center gap-1">
              <button data-smoke="tasks-create-submit" type="submit" disabled={!createTitle.trim() || creating} className="h-9 rounded-md bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50">{creating ? '创建中' : '创建'}</button>
              <button type="button" onClick={() => setShowCreate(false)} className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200" title="取消"><X size={15} /></button>
            </div>
          </form>
        )}

        {view === 'board' ? (
          <TaskBoard
            tasks={filteredTasks}
            allTasks={tasks}
            channels={channels}
            participants={participants}
            currentUserId={currentUser?.id}
            taskNumbers={taskNumbers}
            loading={loading}
            dragId={dragId}
            collapsedColumns={collapsedColumns}
            statusMenuFor={statusMenuFor}
            onOpen={openTaskThread}
            onDragStart={setDragId}
            onDragEnd={() => setDragId(null)}
            onToggleColumn={(status) => setCollapsedColumns((prev) => toggleSet(prev, status))}
            onMove={updateTaskStatus}
            onReorderTop={moveTaskToTop}
            onDelete={deleteTask}
            onStatusMenu={setStatusMenuFor}
          />
        ) : (
          <TaskList
            tasks={filteredTasks}
            channels={channels}
            participants={participants}
            currentUserId={currentUser?.id}
            taskNumbers={taskNumbers}
            loading={loading}
            collapsedColumns={collapsedColumns}
            statusMenuFor={statusMenuFor}
            onOpen={openTaskThread}
            onToggleColumn={(status) => setCollapsedColumns((prev) => toggleSet(prev, status))}
            onMove={updateTaskStatus}
            onReorderTop={moveTaskToTop}
            onDelete={deleteTask}
            onStatusMenu={setStatusMenuFor}
          />
        )}
      </main>

      {selectedTask && (
        <TaskThreadPanel
          task={selectedTask}
          root={threadRoot}
          replies={threadReplies}
          channel={channels.find((channel) => channel.id === selectedTask.channelId)}
          agents={agents}
          currentUsername={currentUser?.username}
          input={threadInput}
          attachments={threadAttachments}
          uploading={uploading}
          imageInputRef={imageInputRef}
          fileInputRef={fileInputRef}
          savedIds={savedIds}
          reactionIds={reactionIds}
          onInput={setThreadInput}
          onSend={sendThreadMessage}
          onUpload={uploadFiles}
          onRemoveAttachment={(id) => setThreadAttachments((prev) => prev.filter((artifact) => artifact.id !== id))}
          onToggleSave={(id) => {
            const isSaved = savedIds.has(id);
            setSavedIds((prev) => toggleSet(prev, id));
            messageReactionEvents().save(id, !isSaved).catch(() => setSavedIds((prev) => toggleSet(prev, id)));
          }}
          onToggleReaction={(id) => {
            const isReacted = reactionIds.has(id);
            setReactionIds((prev) => toggleSet(prev, id));
            messageReactionEvents().react(id, !isReacted).catch(() => setReactionIds((prev) => toggleSet(prev, id)));
          }}
          onReply={(msg) => setThreadInput((prev) => appendReplyPrefix(prev, speakerName(msg, agents, currentUser?.username)))}
          onClose={closeThread}
          onViewInChannel={() => {
            if (!selectedTask.channelId || !threadRoot?.id) return;
            const routeKind = dms.some((dm) => dm.id === selectedTask.channelId) ? 'dm' : 'channel';
            router.push(`/${np}/${routeKind}/${selectedTask.channelId}?message=${encodeURIComponent(`${selectedTask.channelId}:${threadRoot.id}`)}`);
          }}
        />
      )}
    </div>
  );
}

function TaskBoard({
  tasks,
  allTasks,
  channels,
  participants,
  currentUserId,
  taskNumbers,
  loading,
  dragId,
  collapsedColumns,
  statusMenuFor,
  onOpen,
  onDragStart,
  onDragEnd,
  onToggleColumn,
  onMove,
  onReorderTop,
  onDelete,
  onStatusMenu,
}: {
  tasks: Task[];
  allTasks: Task[];
  channels: ChannelSummary[];
  participants: Participant[];
  currentUserId?: string;
  taskNumbers: Map<string, number>;
  loading: boolean;
  dragId: string | null;
  collapsedColumns: Set<TaskStatus>;
  statusMenuFor: string | null;
  onOpen: (task: Task) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onToggleColumn: (status: TaskStatus) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onReorderTop: (task: Task) => void;
  onDelete: (id: string) => void;
  onStatusMenu: (id: string | null) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto bg-neutral-50/60 p-4">
      {STATUS_COLUMNS.map((column) => {
        const colTasks = tasks.filter((task) => task.status === column.id);
        const collapsed = collapsedColumns.has(column.id);
        return (
          <section key={column.id} className={`${collapsed ? 'w-72' : 'w-72'} shrink-0 rounded-lg border border-neutral-200 bg-white shadow-sm`}>
            <button onClick={() => onToggleColumn(column.id)} className="flex h-10 w-full items-center gap-2 border-b border-neutral-100 bg-white px-3 text-left hover:bg-neutral-50">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${column.badge}`}>{column.label}</span>
              <span className="text-[11px] text-neutral-400">{colTasks.length}</span>
              <ChevronDown size={14} className={`ml-auto text-neutral-500 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
            </button>
            {!collapsed && (
              <div
                className="min-h-40 space-y-2 p-2"
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  const task = allTasks.find((item) => item.id === dragId);
                  if (task) onMove(task, column.id);
                  onDragEnd();
                }}
              >
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    channels={channels}
                    participants={participants}
                    currentUserId={currentUserId}
                    number={taskNumbers.get(task.id) ?? 1}
                    statusMenuOpen={statusMenuFor === task.id}
                    onOpen={() => onOpen(task)}
                    onDragStart={() => onDragStart(task.id)}
                    onDragEnd={onDragEnd}
                    onMove={(status) => onMove(task, status)}
                    onReorderTop={() => onReorderTop(task)}
                    onDelete={() => onDelete(task.id)}
                    onStatusMenu={(open) => onStatusMenu(open ? task.id : null)}
                  />
                ))}
                {colTasks.length === 0 && (
                  <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-neutral-200 bg-neutral-50/70 text-xs text-neutral-400">
                    {loading ? '加载中...' : column.empty}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskList({
  tasks,
  channels,
  participants,
  currentUserId,
  taskNumbers,
  loading,
  collapsedColumns,
  statusMenuFor,
  onOpen,
  onToggleColumn,
  onMove,
  onReorderTop,
  onDelete,
  onStatusMenu,
}: {
  tasks: Task[];
  channels: ChannelSummary[];
  participants: Participant[];
  currentUserId?: string;
  taskNumbers: Map<string, number>;
  loading: boolean;
  collapsedColumns: Set<TaskStatus>;
  statusMenuFor: string | null;
  onOpen: (task: Task) => void;
  onToggleColumn: (status: TaskStatus) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onReorderTop: (task: Task) => void;
  onDelete: (id: string) => void;
  onStatusMenu: (id: string | null) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-neutral-50/60 p-4">
      <div className="space-y-3">
        {STATUS_COLUMNS.map((column) => {
          const colTasks = tasks.filter((task) => task.status === column.id);
          const collapsed = collapsedColumns.has(column.id);
          return (
            <section key={column.id} className="overflow-visible rounded-lg border border-neutral-200 bg-white shadow-sm">
              <button onClick={() => onToggleColumn(column.id)} className="flex h-10 w-full items-center gap-2 border-b border-neutral-100 px-3 text-left hover:bg-neutral-50">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${column.badge}`}>{column.label}</span>
                <span className="text-[11px] text-neutral-400">{colTasks.length}</span>
                <ChevronDown size={14} className={`ml-auto text-neutral-500 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
              </button>
              {!collapsed && (
                <div className="divide-y divide-neutral-200">
                  {colTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      channels={channels}
                      participants={participants}
                      currentUserId={currentUserId}
                      number={taskNumbers.get(task.id) ?? 1}
                      statusMenuOpen={statusMenuFor === task.id}
                      onOpen={() => onOpen(task)}
                      onMove={(status) => onMove(task, status)}
                      onReorderTop={() => onReorderTop(task)}
                      onDelete={() => onDelete(task.id)}
                      onStatusMenu={(open) => onStatusMenu(open ? task.id : null)}
                    />
                  ))}
                  {colTasks.length === 0 && (
                    <div className="flex h-16 items-center justify-center text-xs text-neutral-400">
                      {loading ? '加载中...' : column.empty}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard(props: {
  task: Task;
  channels: ChannelSummary[];
  participants: Participant[];
  currentUserId?: string;
  number: number;
  statusMenuOpen: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (status: TaskStatus) => void;
  onReorderTop: () => void;
  onDelete: () => void;
  onStatusMenu: (open: boolean) => void;
}) {
  const channelName = channelLabel(props.task.channelId, props.channels);
  return (
    <article data-smoke="task-card" data-task-id={props.task.id} data-task-title={props.task.title} data-task-status={props.task.status} data-task-sort-order={props.task.sortOrder} draggable onClick={props.onOpen} onDragStart={props.onDragStart} onDragEnd={props.onDragEnd} className="group cursor-pointer rounded-md border border-neutral-200 bg-white p-3 shadow-sm transition-colors hover:border-neutral-300 hover:bg-neutral-50 active:cursor-grabbing">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-neutral-400">{channelName} #{props.number}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm font-semibold leading-5 text-neutral-900">{props.task.title}</div>
        </div>
        <TaskActionButtons onReorderTop={props.onReorderTop} onDelete={props.onDelete} />
      </div>
      {props.task.description && <div className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-500">{props.task.description}</div>}
      <TaskMeta task={props.task} participants={props.participants} currentUserId={props.currentUserId} />
      <StatusButton task={props.task} open={props.statusMenuOpen} onOpen={props.onStatusMenu} onMove={props.onMove} />
    </article>
  );
}

function TaskRow(props: {
  task: Task;
  channels: ChannelSummary[];
  participants: Participant[];
  currentUserId?: string;
  number: number;
  statusMenuOpen: boolean;
  onOpen: () => void;
  onMove: (status: TaskStatus) => void;
  onReorderTop: () => void;
  onDelete: () => void;
  onStatusMenu: (open: boolean) => void;
}) {
  return (
    <article data-smoke="task-row" data-task-id={props.task.id} data-task-title={props.task.title} data-task-status={props.task.status} data-task-sort-order={props.task.sortOrder} onClick={props.onOpen} className="group grid cursor-pointer grid-cols-[minmax(220px,1fr)_180px_140px_120px_64px] items-center gap-3 bg-white px-3 py-2 transition-colors hover:bg-neutral-50">
      <div className="min-w-0">
        <div className="truncate text-[11px] font-medium text-neutral-400">{channelLabel(props.task.channelId, props.channels)} #{props.number}</div>
        <div className="truncate text-sm font-semibold text-neutral-900">{props.task.title}</div>
        {props.task.description && <div className="truncate text-xs text-neutral-500">{props.task.description}</div>}
      </div>
      <div className="truncate text-xs text-neutral-600">{participantName(props.task.creatorId, props.participants, props.currentUserId)}</div>
      <div className="truncate text-xs text-neutral-600">{props.task.assigneeId ? participantName(props.task.assigneeId, props.participants, props.currentUserId) : '未分配'}</div>
      <StatusButton task={props.task} open={props.statusMenuOpen} onOpen={props.onStatusMenu} onMove={props.onMove} compact />
      <TaskActionButtons onReorderTop={props.onReorderTop} onDelete={props.onDelete} compact />
    </article>
  );
}

function TaskActionButtons({ onReorderTop, onDelete, compact }: {
  onReorderTop: () => void;
  onDelete: () => void;
  compact?: boolean;
}) {
  const size = compact ? 'h-7 w-7' : 'h-6 w-6';
  return (
    <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
      <button
        data-smoke="task-reorder-top"
        onClick={(event) => { event.stopPropagation(); onReorderTop(); }}
        className={`flex ${size} items-center justify-center text-neutral-300 hover:bg-blue-50 hover:text-blue-600`}
        title="移到顶部"
      >
        <ArrowUp size={compact ? 14 : 13} />
      </button>
      <button
        data-smoke="task-delete"
        onClick={(event) => { event.stopPropagation(); onDelete(); }}
        className={`flex ${size} items-center justify-center text-neutral-300 hover:bg-red-50 hover:text-red-500`}
        title="删除任务"
      >
        <Trash2 size={compact ? 14 : 13} />
      </button>
    </div>
  );
}

function TaskMeta({ task, participants, currentUserId }: { task: Task; participants: Participant[]; currentUserId?: string }) {
  return (
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
  );
}

function StatusButton({ task, open, compact, onOpen, onMove }: { task: Task; open: boolean; compact?: boolean; onOpen: (open: boolean) => void; onMove: (status: TaskStatus) => void }) {
  const status = STATUS_BY_ID[task.status];
  return (
    <div className={`relative inline-block ${compact ? '' : 'mt-3'}`} onClick={(event) => event.stopPropagation()}>
      <button data-smoke="task-status-trigger" onClick={() => onOpen(!open)} className={`inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-semibold ${status.badge}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
        {status.label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`absolute left-0 top-8 ${TASK_STATUS_MENU_PANEL_CLASS}`} style={TASK_STATUS_MENU_PANEL_STYLE}>
          {STATUS_COLUMNS.map((column) => (
            <button key={column.id} data-smoke={`task-status-option-${column.id}`} onClick={() => onMove(column.id)} className={TASK_STATUS_MENU_ITEM_CLASS}>
              <span className={`${TASK_STATUS_MENU_DOT_CLASS} ${column.dot}`} />
              <span className={TASK_STATUS_MENU_LABEL_CLASS}>{column.menuLabel}</span>
              {task.status === column.id && <Check size={12} className="text-neutral-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterButton({
  title,
  icon,
  options,
  selected,
  open,
  summary,
  onToggle,
  onChange,
}: {
  title: string;
  icon: ReactNode;
  options: FilterOption[];
  selected: Set<string>;
  open: boolean;
  summary: string;
  onToggle: () => void;
  onChange: (next: Set<string>) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = options.filter((option) => option.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="relative">
      <button onClick={onToggle} className={`flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium ${selected.size > 0 ? 'border-neutral-300 bg-neutral-100 text-neutral-900' : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'}`}>
        {icon}
        <span>{summary}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-40 w-64 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
          <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{title}</div>
          <div className="mb-2 flex h-8 items-center gap-2 rounded-md border border-neutral-200 px-2">
            <Search size={13} className="text-neutral-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索..." className="min-w-0 flex-1 text-sm outline-none placeholder:text-neutral-400" />
          </div>
          <button onClick={() => onChange(new Set())} className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-50 ${selected.size === 0 ? 'font-medium text-neutral-900' : 'text-neutral-500'}`}>
            <Check size={13} className={selected.size === 0 ? 'opacity-100' : 'opacity-0'} />
            全部
          </button>
          <div className="max-h-64 overflow-y-auto">
            {visible.map((option) => (
              <button key={option.id} onClick={() => onChange(toggleSet(selected, option.id))} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-50 ${option.muted ? 'text-neutral-400' : 'text-neutral-700'}`}>
                <span className="flex h-4 w-4 items-center justify-center">
                  {selected.has(option.id) && <Check size={13} />}
                </span>
                {option.icon}
                <span className="truncate">{option.name}</span>
              </button>
            ))}
            {visible.length === 0 && <div className="px-2 py-4 text-center text-xs text-neutral-400">没有匹配项</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskThreadPanel({
  task,
  root,
  replies,
  channel,
  agents,
  currentUsername,
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
  onToggleSave,
  onToggleReaction,
  onReply,
  onClose,
  onViewInChannel,
}: {
  task: Task;
  root: ChatMessage | null;
  replies: ChatMessage[];
  channel?: ChannelSummary;
  agents: Record<string, AgentSnapshot>;
  currentUsername?: string;
  input: string;
  attachments: Artifact[];
  uploading: boolean;
  imageInputRef: React.RefObject<HTMLInputElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  savedIds: Set<string>;
  reactionIds: Set<string>;
  onInput: (value: string) => void;
  onSend: () => void;
  onUpload: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onToggleSave: (id: string) => void;
  onToggleReaction: (id: string) => void;
  onReply: (msg: ChatMessage) => void;
  onClose: () => void;
  onViewInChannel: () => void;
}) {
  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-neutral-200 bg-white">
      <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-900">讨论串 — {channel ? `#${channel.name}` : '任务'}</div>
          <div className="truncate text-xs text-neutral-400">{task.title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={onViewInChannel} disabled={!task.channelId || !root} className="inline-flex h-8 items-center gap-1 rounded-md border border-neutral-200 px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-40" title="在频道中查看">
            <ExternalLink size={13} />
            <span>在频道中查看</span>
          </button>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" title="关闭讨论串">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {root ? (
          <ThreadMessage
            msg={root}
            agents={agents}
            currentUsername={currentUsername}
            saved={savedIds.has(root.id)}
            reacted={reactionIds.has(root.id)}
            replyCount={replies.length}
            onReply={() => onReply(root)}
            onToggleSave={() => onToggleSave(root.id)}
            onToggleReaction={() => onToggleReaction(root.id)}
          />
        ) : (
          <TaskThreadRoot task={task} />
        )}
        <div className="border-t border-neutral-100 pt-3 text-center text-[11px] text-neutral-400">
          <div>回复的开头</div>
          <div>{replies.length === 0 ? '暂无回复' : `${replies.length} 条回复`}</div>
        </div>
        {replies.map((msg) => (
          <ThreadMessage
            key={msg.id}
            msg={msg}
            agents={agents}
            currentUsername={currentUsername}
            saved={savedIds.has(msg.id)}
            reacted={reactionIds.has(msg.id)}
            replyCount={0}
            onReply={() => onReply(msg)}
            onToggleSave={() => onToggleSave(msg.id)}
            onToggleReaction={() => onToggleReaction(msg.id)}
          />
        ))}
      </div>
      <div className="border-t border-neutral-200 p-3">
        <div className="rounded-lg border border-neutral-300 bg-white">
          <textarea
            value={input}
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
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
              <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { if (event.target.files) onUpload(event.target.files); event.currentTarget.value = ''; }} />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) onUpload(event.target.files); event.currentTarget.value = ''; }} />
              <button onClick={() => imageInputRef.current?.click()} disabled={uploading || !task.channelId} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件图片"><Image size={16} /></button>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading || !task.channelId} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-40" title="附件文件"><Paperclip size={16} /></button>
            </div>
            <button onClick={onSend} disabled={uploading || !task.channelId || (!input.trim() && attachments.length === 0)} className="flex h-7 w-7 items-center justify-center rounded-md bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-40">
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function ThreadMessage({
  msg,
  agents,
  currentUsername,
  saved,
  reacted,
  replyCount,
  onReply,
  onToggleSave,
  onToggleReaction,
}: {
  msg: ChatMessage;
  agents: Record<string, AgentSnapshot>;
  currentUsername?: string;
  saved: boolean;
  reacted: boolean;
  replyCount: number;
  onReply: () => void;
  onToggleSave: () => void;
  onToggleReaction: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  if (msg.senderKind === 'system') {
    return <div className="mx-auto max-w-prose rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700">{msg.body}</div>;
  }
  const speaker = speakerName(msg, agents, currentUsername);
  const handleCopy = () => {
    navigator.clipboard.writeText(msg.body);
    setCopied(true);
    setShowMenu(false);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative flex gap-2 rounded-md border border-transparent px-2 py-2 transition-colors hover:border-neutral-900 hover:bg-white">
      <div className="pointer-events-none absolute right-2 top-1 z-10 flex items-center gap-0.5 border border-neutral-300 bg-white opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <button onClick={onReply} className="flex h-6 w-6 items-center justify-center border-r border-neutral-200 text-neutral-500 hover:bg-amber-50 hover:text-neutral-900" title="回复讨论串"><MessageSquare size={13} /></button>
        <button onClick={onToggleReaction} className={`flex h-6 w-6 items-center justify-center border-r border-neutral-200 hover:bg-amber-50 ${reacted ? 'text-pink-600' : 'text-neutral-500 hover:text-neutral-900'}`} title={reacted ? '取消表情' : '添加表情'}><Smile size={13} /></button>
        <button onClick={onToggleSave} className={`flex h-6 w-6 items-center justify-center border-r border-neutral-200 hover:bg-amber-50 ${saved ? 'text-amber-500' : 'text-neutral-500 hover:text-neutral-900'}`} title={saved ? '取消收藏' : '收藏消息'}>
          {saved ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
        </button>
        <div className="relative">
          <button onClick={() => setShowMenu((value) => !value)} className="flex h-6 w-6 items-center justify-center text-neutral-500 hover:bg-amber-50 hover:text-neutral-900" title="更多操作"><MoreHorizontal size={13} /></button>
          {showMenu && (
            <div className="absolute right-0 top-7 z-20 w-28 rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
              <button onClick={handleCopy} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"><Copy size={12} /> {copied ? '已复制' : '复制'}</button>
            </div>
          )}
        </div>
      </div>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700">{speaker[0]?.toUpperCase() ?? 'A'}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-900">{speaker}</span>
          <span className="text-[10px] text-neutral-400">{formatTime(msg.createdAt)}</span>
        </div>
        <MarkdownMessage body={msg.body} />
        {msg.artifacts && msg.artifacts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {msg.artifacts.map((artifact) => <ArtifactPreview key={artifact.id} artifact={artifact} />)}
          </div>
        )}
        {(replyCount > 0 || reacted || saved) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {replyCount > 0 && <span className="inline-flex h-5 items-center gap-1 border border-sky-200 bg-sky-50 px-1.5 text-[11px] font-medium text-sky-700"><MessageSquare size={11} />{replyCount} 条回复</span>}
            {reacted && <button onClick={onToggleReaction} className="inline-flex h-5 items-center gap-1 border border-pink-200 bg-pink-50 px-1.5 text-[11px] font-medium text-pink-700 hover:bg-pink-100">❤️ 1</button>}
            {saved && <span className="inline-flex h-5 items-center gap-1 border border-amber-200 bg-amber-50 px-1.5 text-[11px] font-medium text-amber-700"><BookmarkCheck size={11} />已收藏</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskThreadRoot({ task }: { task: Task }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="text-[11px] font-medium text-neutral-400">任务根消息</div>
      <div className="mt-1 text-sm font-semibold text-neutral-900">{task.title}</div>
      {task.description && <div className="mt-2 text-sm leading-6 text-neutral-600">{task.description}</div>}
      <div className="mt-3">
        <span className={`inline-flex h-6 items-center gap-1.5 rounded border px-2 text-xs font-semibold ${STATUS_BY_ID[task.status].badge}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_BY_ID[task.status].dot}`} />
          {STATUS_BY_ID[task.status].label}
        </span>
      </div>
    </div>
  );
}

function MarkdownMessage({ body }: { body: string }) {
  return <div className="mt-1 space-y-2 break-words text-sm leading-relaxed text-neutral-700">{renderMarkdownBlocks(body)}</div>;
}

function renderMarkdownBlocks(body: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed) { i += 1; continue; }
    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(<pre key={`code-${nodes.length}`} className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-950 px-3 py-2 text-xs leading-relaxed text-neutral-100"><code>{codeLines.join('\n')}</code></pre>);
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      nodes.push(<div key={`heading-${nodes.length}`} className="text-sm font-semibold text-neutral-950">{renderInlineMarkdown(heading[2]!)}</div>);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test((lines[i] ?? '').trim())) {
        items.push((lines[i] ?? '').trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      nodes.push(<ul key={`ul-${nodes.length}`} className="list-disc space-y-1 pl-5">{items.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? '').trim())) {
        items.push((lines[i] ?? '').trim().replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      nodes.push(<ol key={`ol-${nodes.length}`} className="list-decimal space-y-1 pl-5">{items.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() && !/^```/.test((lines[i] ?? '').trim()) && !/^[-*]\s+/.test((lines[i] ?? '').trim()) && !/^\d+[.)]\s+/.test((lines[i] ?? '').trim())) {
      paragraph.push((lines[i] ?? '').trim());
      i += 1;
    }
    nodes.push(<p key={`p-${nodes.length}`}>{paragraph.flatMap((line, index) => index < paragraph.length - 1 ? [...renderInlineMarkdown(line), <br key={`br-${index}`} />] : renderInlineMarkdown(line))}</p>);
  }
  return nodes.length > 0 ? nodes : [<p key="empty" />];
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+]\([^)]+\)|https?:\/\/[^\s)]+|@[\w-]+)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`code-${match.index}`} className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.92em] text-neutral-900">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`strong-${match.index}`} className="font-semibold text-neutral-950">{renderInlineMarkdown(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      const href = link ? safeHref(link[2]!) : null;
      nodes.push(href ? <a key={`link-${match.index}`} href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">{renderInlineMarkdown(link![1]!)}</a> : token);
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      nodes.push(<a key={`url-${match.index}`} href={token} target="_blank" rel="noreferrer" className="font-medium text-blue-600 underline-offset-2 hover:underline">{token}</a>);
    } else {
      nodes.push(<span key={`mention-${match.index}`} className="font-medium text-blue-600">{token}</span>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function AttachmentStrip({ attachments, onRemove }: { attachments: Artifact[]; onRemove: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-neutral-100 px-2 py-2">
      {attachments.map((artifact) => (
        <div key={artifact.id} className="inline-flex max-w-56 items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-600">
          {artifact.mimeType.startsWith('image/') ? <Image size={12} /> : <Paperclip size={12} />}
          <span className="truncate">{artifact.filename}</span>
          <button onClick={() => onRemove(artifact.id)} className="text-neutral-400 hover:text-neutral-700" title="移除附件"><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const downloadUrl = artifactUrl(artifact.downloadUrl);
  const previewUrl = artifactUrl(artifact.previewUrl);
  if (artifact.mimeType.startsWith('image/') && downloadUrl && previewUrl) {
    return (
      <a href={downloadUrl} target="_blank" rel="noreferrer" className="block max-w-80">
        <img src={previewUrl} alt={artifact.filename} className="max-h-64 rounded-md border border-neutral-200 object-contain" />
        <div className="mt-1 truncate text-xs text-neutral-500">{artifact.filename}</div>
      </a>
    );
  }
  if (!downloadUrl) {
    return (
      <span className="group inline-flex min-h-16 max-w-96 items-center gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-500"><FileText size={15} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-neutral-900">{artifact.filename}</span>
          <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{formatFileSize(artifact.sizeBytes)}</span>
        </span>
      </span>
    );
  }
  return (
    <a href={downloadUrl} target="_blank" rel="noreferrer" className="group inline-flex min-h-16 max-w-96 items-center gap-3 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-500 group-hover:bg-white"><FileText size={15} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-neutral-900">{artifact.filename}</span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{formatFileSize(artifact.sizeBytes)}</span>
      </span>
      <Download size={14} className="shrink-0 text-neutral-400 group-hover:text-neutral-700" />
    </a>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function ParticipantIcon({ kind }: { kind: Participant['kind'] }) {
  return <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${kind === 'agent' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>{kind === 'agent' ? 'A' : 'H'}</span>;
}

function filterSummary(fallback: string, selected: Set<string>, options: FilterOption[]): string {
  if (selected.size === 0) return fallback;
  const first = options.find((option) => selected.has(option.id))?.name ?? fallback;
  return selected.size === 1 ? first : `${first} +${selected.size - 1}`;
}

function expandSpecialFilters(filters: Set<string>, currentUserId?: string): Set<string> {
  const ids = new Set<string>();
  for (const id of filters) {
    if (id === ME_FILTER) {
      if (currentUserId) ids.add(currentUserId);
    } else if (id !== UNASSIGNED_FILTER) {
      ids.add(id);
    }
  }
  return ids;
}

function toggleSet<T>(source: Set<T>, value: T): Set<T> {
  const next = new Set(source);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function sortTasksForDisplay(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    const statusDelta = STATUS_COLUMNS.findIndex((column) => column.id === a.status) - STATUS_COLUMNS.findIndex((column) => column.id === b.status);
    if (statusDelta !== 0) return statusDelta;
    const sortDelta = a.sortOrder - b.sortOrder;
    if (sortDelta !== 0) return sortDelta;
    return b.createdAt - a.createdAt;
  });
}

function channelLabel(channelId: string | null, channels: ChannelSummary[]): string {
  if (!channelId) return '#无频道';
  return `#${channels.find((channel) => channel.id === channelId)?.name ?? '未知频道'}`;
}

function participantName(id: string, participants: Participant[], currentUserId?: string): string {
  if (id === currentUserId) return '你';
  return participants.find((person) => person.id === id)?.name ?? '未命名成员';
}

function parseThreadParam(raw: string | null): { channelId: string; itemId: string } | null {
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const index = decoded.indexOf(':');
  if (index === -1) return null;
  const channelId = decoded.slice(0, index);
  const itemId = decoded.slice(index + 1);
  return channelId && itemId ? { channelId, itemId } : null;
}

function parseMeta(msg: ChatMessage): Record<string, unknown> {
  if (msg.meta && typeof msg.meta === 'object') return msg.meta;
  if (!msg.metaJson) return {};
  try {
    const parsed = JSON.parse(msg.metaJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function metaTaskId(msg: ChatMessage): string | null {
  const meta = parseMeta(msg);
  return typeof meta.taskId === 'string' ? meta.taskId : null;
}

function parentMessageId(msg: ChatMessage): string | null {
  if (msg.threadId && msg.threadId !== msg.id) return msg.threadId;
  const meta = parseMeta(msg);
  if (typeof meta.parentMessageId === 'string') return meta.parentMessageId;
  if (typeof meta.inReplyTo === 'string') return meta.inReplyTo;
  return null;
}

function findTaskRootMessage(task: Task, messages: ChatMessage[]): ChatMessage | null {
  return messages.find((msg) => metaTaskId(msg) === task.id) ?? null;
}

function appendReplyPrefix(input: string, speaker: string): string {
  const prefix = `回复 ${speaker}: `;
  return input.trim() ? `${input}\n${prefix}` : prefix;
}

function speakerName(msg: ChatMessage, agents: Record<string, { name: string }>, currentUsername?: string): string {
  if (msg.senderKind === 'human') return currentUsername ?? '用户';
  if (msg.senderKind === 'agent') return agents[msg.senderId ?? '']?.name ?? 'Agent';
  return '系统';
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/api/')) return artifactUrl(trimmed) ?? null;
  return null;
}

function artifactUrl(path: string | undefined): string | null {
  if (!path) return null;
  const token = getStoredAuthToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${getResolvedServerUrl()}${path}${sep}token=${encodeURIComponent(token)}`;
}
