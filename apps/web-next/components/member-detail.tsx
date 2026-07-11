'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bell,
  Bot,
  Check,
  Circle,
  Code2,
  Copy,
  Cpu,
  Edit3,
  FileText,
  FolderOpen,
  Inbox,
  MessageSquare,
  Shield,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { agentEvents, dmEvents, fetchAgentWorkspace, memberEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { formatRelative } from '@/lib/format-time';
import type { AgentMetricsSummary, AgentSnapshot, AgentWorkspaceRun, DeviceInfo, HumanMember, UserInfo } from '@/lib/schema';
import { agentDeviceDisplayName } from '@/lib/agent-device';
import { ownedAgentsForMember } from '@/lib/agent-list';
import { AgentWorkspaceSection } from '@/components/agent-workspace-section';
import { AgentSkillsSection } from '@/components/agent-skills-section';

export type AgentMemberTab = 'profile' | 'permissions' | 'dms' | 'reminders' | 'workspace' | 'activity';

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  busy: '忙碌',
  offline: '离线',
  connecting: '连接中',
  error: '异常',
};

const CATEGORY_LABEL: Record<string, string> = {
  'agentos-hosted': 'AgentOS 托管型 Agent',
  'executor-hosted': '自定义 Agent',
};

const RUNTIME_LABEL: Record<string, string> = {
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  openclaw: 'Openclaw',
  hermes: 'Hermes',
  standalone: 'Standalone',
};

const PERMISSION_GROUPS = [
  {
    title: '通知 / 收件箱',
    icon: Inbox,
    items: [
      { id: 'inbox:receive', label: '接收通知', description: '允许该 Agent 接收团队收件箱通知。' },
    ],
  },
  {
    title: 'AgentBean CLI 权限',
    icon: Shield,
    items: [
      { id: 'server:read', label: '读取团队信息', description: '读取当前团队、成员与基础配置。' },
      { id: 'channel:read', label: '读取频道成员', description: '查看频道列表和频道成员。' },
      { id: 'channel:join', label: '加入频道', description: '允许 Agent 主动加入公开频道。' },
      { id: 'channel:leave', label: '离开频道', description: '允许 Agent 主动离开频道。' },
      { id: 'thread:unfollow', label: '取消关注讨论串', description: '允许 Agent 停止接收某个讨论串的后续更新。' },
      { id: 'message:read', label: '读取消息', description: '读取频道、私聊和讨论串上下文。' },
      { id: 'message:send', label: '发送消息', description: '代表 Agent 发送回复消息。' },
      { id: 'attachment:upload', label: '上传附件', description: '上传任务产物、图片和文件。' },
      { id: 'attachment:view', label: '查看附件', description: '读取对话中的附件和预览。' },
      { id: 'task:read', label: '读取任务', description: '查看分配给 Agent 的任务。' },
      { id: 'task:write', label: '写入任务', description: '创建、更新和完成任务。' },
      { id: 'action:prepare', label: '准备操作卡片', description: '生成需要用户确认的操作卡片。' },
    ],
  },
];

const DEFAULT_PERMISSIONS = new Set(PERMISSION_GROUPS.flatMap((group) => group.items.map((item) => item.id)));

function statusClass(status?: string): string {
  if (status === 'online') return 'bg-emerald-50 text-emerald-700';
  if (status === 'busy') return 'bg-amber-50 text-amber-700';
  if (status === 'error') return 'bg-rose-50 text-rose-700';
  return 'bg-neutral-100 text-neutral-500';
}

function statusDotClass(status?: string): string {
  if (status === 'online') return 'text-emerald-500';
  if (status === 'busy') return 'text-amber-500';
  if (status === 'error') return 'text-rose-500';
  return 'text-neutral-300';
}

export function AgentTopBar({ agent, device }: { agent: AgentSnapshot; device?: DeviceInfo }) {
  const np = useCurrentTeamPath();
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const [dmLoading, setDmLoading] = useState(false);
  const canManageOnDevice = Boolean(agent.deviceId && currentUser?.id && (
    currentUser.role === 'admin' ||
    agent.ownerId === currentUser.id ||
    device?.userId === currentUser.id
  ));

  const startDm = async () => {
    setDmLoading(true);
    const res = await dmEvents().start(agent.id);
    setDmLoading(false);
    if (res.ok && res.dm?.id) window.location.href = `/${np}/dm/${res.dm.id}`;
  };

  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-neutral-200 bg-white px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-amber-200 bg-amber-50">
          <Bot size={22} className="text-amber-600" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold text-neutral-950">{agent.name}</h1>
            <Circle size={8} className={`shrink-0 fill-current ${statusDotClass(agent.status)}`} />
          </div>
          <div className="truncate text-xs text-neutral-500">{agent.description?.trim() || agent.role || CATEGORY_LABEL[agent.category ?? 'executor-hosted'] || 'Agent'}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button onClick={startDm} disabled={dmLoading} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50">
          <MessageSquare size={14} />
          私聊
        </button>
        {canManageOnDevice && (
          <Link href={`/${np}/devices/${agent.deviceId}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-50">
            <Cpu size={14} />
            在设备中管理
          </Link>
        )}
      </div>
    </div>
  );
}

export function AgentDetail({ agent, device, tab }: { agent: AgentSnapshot; device?: DeviceInfo; tab: AgentMemberTab }) {
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const dms = useAgentBeanStore((s) => s.dms);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const [workspaceRuns, setWorkspaceRuns] = useState<AgentWorkspaceRun[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [metrics, setMetrics] = useState<AgentMetricsSummary | null>(null);

  useEffect(() => {
    if (!agent.id || !currentTeamId) return;
    let cancelled = false;
    setWorkspaceLoading(true);
    fetchAgentWorkspace(currentTeamId, agent.id)
      .then((res) => {
        if (!cancelled && res.ok) setWorkspaceRuns(res.runs ?? []);
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent.id, currentTeamId]);

  useEffect(() => {
    if (!currentTeamId) return;
    let cancelled = false;
    agentEvents().metrics(currentTeamId).then((res) => {
      if (cancelled || !res.ok) return;
      setMetrics(res.summaries?.find((item) => item.agentId === agent.id) ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id, currentTeamId]);

  const relatedDms = dms.filter((dm) => dm.dmTargetId === agent.id);

  if (tab === 'permissions') return <AgentPermissions agentId={agent.id} />;
  if (tab === 'dms') return <AgentDms agent={agent} dms={relatedDms} />;
  if (tab === 'reminders') return <AgentReminders />;
  if (tab === 'workspace') return <AgentWorkspaceTab agent={agent} runs={workspaceRuns} loading={workspaceLoading} />;
  if (tab === 'activity') return <AgentActivity agent={agent} device={device} metrics={metrics} runs={workspaceRuns} />;
  return <AgentProfile agent={agent} device={device} applyAgentStatus={applyAgentStatus} />;
}

function AgentProfile({ agent, device, applyAgentStatus }: { agent: AgentSnapshot; device?: DeviceInfo; applyAgentStatus: (snap: AgentSnapshot) => void }) {
  const np = useCurrentTeamPath();
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const [editing, setEditing] = useState<'name' | 'description' | null>(null);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const isCustomAgent = agent.category === 'executor-hosted' || agent.source === 'custom';
  const deviceName = agentDeviceDisplayName(agent, device);
  const canEditProfile = Boolean(currentUser?.id && (
    currentUser.role === 'admin' ||
    agent.ownerId === currentUser.id ||
    (!agent.ownerId && device?.userId === currentUser.id)
  ));

  useEffect(() => {
    setName(agent.name);
    setDescription(agent.description ?? '');
    setEditing(null);
    setSaveError(null);
  }, [agent.id, agent.name, agent.description]);

  useEffect(() => {
    if (!canEditProfile && editing) setEditing(null);
  }, [canEditProfile, editing]);

  const saveProfile = async () => {
    if (!canEditProfile) return;
    const normalizedName = name.trim().replace(/\s+/g, '-');
    if (!normalizedName) {
      setSaveError('名称不能为空。');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const res = await agentEvents().updateConfig({
      id: agent.id,
      name: normalizedName,
      adapterKind: agent.adapterKind,
      command: agent.command ?? undefined,
      cwd: agent.cwd ?? null,
      description: description.trim() || null,
    });
    setSaving(false);
    if (!res.ok || !res.agent) {
      setSaveError(res.error ?? '保存失败');
      return;
    }
    applyAgentStatus(res.agent);
    setEditing(null);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-amber-50">
            <Bot size={32} className="text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold text-neutral-900">{agent.name}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(agent.status)}`}>
                <Circle size={6} className="fill-current" />
                {STATUS_LABEL[agent.status] ?? agent.status}
              </span>
            </div>
            <div className="mt-1 text-sm text-neutral-500">@{agent.name}</div>
            <p className="mt-3 text-sm leading-6 text-neutral-600">{agent.description?.trim() || '暂无功能介绍。'}</p>
          </div>
        </div>
      </section>

      <Section title="显示名称" icon={<User size={15} />}>
        {editing === 'name' ? (
          <InlineEditor value={name} onChange={setName} onCancel={() => { setName(agent.name); setEditing(null); }} onSave={saveProfile} saving={saving} />
        ) : canEditProfile ? (
          <EditableLine value={agent.name} onEdit={() => setEditing('name')} />
        ) : (
          <ReadOnlyLine value={agent.name} />
        )}
      </Section>

      <Section title="功能介绍" icon={<FileText size={15} />}>
        {editing === 'description' ? (
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-amber-300" />
        ) : canEditProfile ? (
          <EditableLine value={agent.description?.trim() || '暂无功能介绍。'} onEdit={() => setEditing('description')} />
        ) : (
          <ReadOnlyLine value={agent.description?.trim() || '暂无功能介绍。'} />
        )}
        {editing === 'description' && (
          <div className="mt-3 flex items-center gap-2">
            <button onClick={saveProfile} disabled={saving} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
            <button onClick={() => { setDescription(agent.description ?? ''); setEditing(null); }} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50">取消</button>
          </div>
        )}
        {saveError && <div className="mt-2 text-xs text-rose-600">{saveError}</div>}
      </Section>

      <Section title="基本信息" icon={<Shield size={15} />} compactGrid>
        <InfoRow label="类型" value={CATEGORY_LABEL[agent.category ?? 'executor-hosted'] ?? '自定义 Agent'} />
        <InfoRow label="创建者" value={agent.ownerName ?? '未知'} />
        <InfoRow label="设备" value={deviceName} />
        <InfoRow label="最近活跃" value={formatRelative(agent.lastSeenAt)} />
      </Section>

      <Section title="运行时配置" icon={<Cpu size={15} />} compactGrid>
        <InfoRow label={isCustomAgent ? 'Coding Agent 运行时' : '运行时'} value={RUNTIME_LABEL[agent.adapterKind] ?? agent.adapterKind} />
        <InfoRow label="状态" value={STATUS_LABEL[agent.status] ?? agent.status} />
        <InfoRow label="命令" value={agent.command ?? '未配置'} mono={Boolean(agent.command)} />
        <InfoRow label="工作目录" value={agent.cwd ?? '未配置'} mono={Boolean(agent.cwd)} />
      </Section>

      <Section title="环境变量" icon={<Code2 size={15} />}>
        <div className="text-sm text-neutral-500">暂无已公开的环境变量。</div>
      </Section>

      <Section title="创建的智能体" icon={<Users size={15} />}>
        <div className="text-sm text-neutral-500">0 个由该 Agent 创建的子 Agent。</div>
      </Section>

      <AgentSkillsSection agent={agent} />

      <Section title="操作" icon={<Zap size={15} />}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {canEditProfile && agent.deviceId && (
            <Link href={`/${np}/devices/${agent.deviceId}`} className="inline-flex items-center justify-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
              <Cpu size={14} />
              在设备中管理
            </Link>
          )}
          <CopyDiagnosticButton agent={agent} device={device} />
        </div>
        <div className="mt-2 text-xs text-neutral-400">运行时、团队发布和删除在设备页管理。</div>
      </Section>
    </div>
  );
}

function AgentPermissions({ agentId }: { agentId: string }) {
  const storageKey = `agentbean.agentPermissions.${agentId}`;
  const [selected, setSelected] = useState<Set<string>>(DEFAULT_PERMISSIONS);
  const [saved, setSaved] = useState<Set<string>>(DEFAULT_PERMISSIONS);

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey);
    const next = raw ? new Set<string>(JSON.parse(raw)) : new Set(DEFAULT_PERMISSIONS);
    setSelected(next);
    setSaved(new Set(next));
  }, [storageKey]);

  const dirty = useMemo(() => {
    if (selected.size !== saved.size) return true;
    for (const item of selected) if (!saved.has(item)) return true;
    return false;
  }, [selected, saved]);

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = () => {
    window.localStorage.setItem(storageKey, JSON.stringify([...selected]));
    setSaved(new Set(selected));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        当前使用默认权限模板。这里的改动会保存到浏览器本地；后端权限模型接入后可直接替换为团队级配置。
      </div>
      {PERMISSION_GROUPS.map((group) => {
        const Icon = group.icon;
        return (
          <section key={group.title} className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
              <Icon size={15} />
              {group.title}
            </h2>
            <div className="divide-y divide-neutral-100">
              {group.items.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-start gap-3 py-3">
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-amber-500 focus:ring-amber-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-neutral-900">{item.label}</div>
                    <p className="mt-1 text-xs text-neutral-500">{item.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </section>
        );
      })}
      <div className="sticky bottom-0 flex items-center justify-between border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
        <span className="text-xs text-neutral-400">rev {saved.size}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setSelected(new Set(saved))} disabled={!dirty} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 disabled:opacity-40">放弃更改</button>
          <button onClick={save} disabled={!dirty} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">保存权限</button>
        </div>
      </div>
    </div>
  );
}

function AgentDms({ agent, dms }: { agent: AgentSnapshot; dms: Array<{ id: string; name: string; dmTargetId: string; createdAt: number }> }) {
  const np = useCurrentTeamPath();
  const [dmLoading, setDmLoading] = useState(false);

  const startDm = async () => {
    setDmLoading(true);
    const res = await dmEvents().start(agent.id);
    setDmLoading(false);
    if (res.ok && res.dm?.id) window.location.href = `/${np}/dm/${res.dm.id}`;
  };

  return (
    <div className="mx-auto max-w-4xl">
      {dms.length === 0 ? (
        <CenteredEmpty icon={<MessageSquare size={34} />} title="暂无 Agent 私聊" description="还没有与该 Agent 相关的私聊记录。" action={<button onClick={startDm} disabled={dmLoading} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">发起私聊</button>} />
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white">
          {dms.map((dm) => (
            <Link key={dm.id} href={`/${np}/dm/${dm.id}`} className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3 last:border-0 hover:bg-neutral-50">
              <MessageSquare size={16} className="text-neutral-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-900">{dm.name}</div>
                <div className="text-xs text-neutral-500">创建于 {new Date(dm.createdAt).toLocaleString('zh-CN')}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentReminders() {
  return (
    <div className="mx-auto max-w-4xl">
      <CenteredEmpty icon={<Bell size={34} />} title="暂无提醒" description="该 Agent 还没有安排任何提醒。Agent 创建提醒后会实时显示在这里。" />
    </div>
  );
}

function AgentWorkspaceTab({ agent, runs, loading }: { agent: AgentSnapshot; runs: AgentWorkspaceRun[]; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  const workspacePath = agent.cwd ? `${agent.cwd}/.agentbean/${agent.name}` : `~/.agentbean/${agent.name}`;
  const copyPath = () => {
    navigator.clipboard.writeText(workspacePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
        <FolderOpen size={15} className="text-neutral-400" />
        <code className="min-w-0 flex-1 truncate text-xs text-neutral-600">{workspacePath}/</code>
        <button onClick={copyPath} className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
          {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
          复制路径
        </button>
      </div>
      <AgentWorkspaceSection runs={runs} loading={loading} />
    </div>
  );
}

function AgentActivity({ agent, device, metrics, runs }: { agent: AgentSnapshot; device?: DeviceInfo; metrics: AgentMetricsSummary | null; runs: AgentWorkspaceRun[] }) {
  const events = [
    { time: agent.lastSeenAt, status: agent.status, title: STATUS_LABEL[agent.status] ?? agent.status, detail: agent.lastError ?? 'Agent 状态已同步。' },
    ...(device ? [{ time: device.lastSeenAt, status: device.status, title: `设备 ${STATUS_LABEL[device.status] ?? device.status}`, detail: device.name ?? '关联设备' }] : []),
    ...runs.slice(0, 4).map((run) => ({ time: run.updatedAt, status: 'online', title: '工作区已同步', detail: `${run.files.length} 个文件` })),
    ...(metrics?.lastErrorAt ? [{ time: metrics.lastErrorAt, status: 'error', title: '最近错误', detail: metrics.lastError ?? '未知错误' }] : []),
  ].sort((a, b) => b.time - a.time);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">动态诊断</h2>
          <CopyDiagnosticButton agent={agent} device={device} />
        </div>
        {metrics && (
          <div className="grid grid-cols-2 gap-px bg-neutral-100 md:grid-cols-4">
            <Metric label="请求" value={metrics.totalRequests} />
            <Metric label="成功" value={metrics.successCount} />
            <Metric label="失败" value={metrics.failCount} />
            <Metric label="平均耗时" value={`${Math.round(metrics.avgResponseMs)}ms`} />
          </div>
        )}
        {events.length === 0 ? (
          <CenteredEmpty icon={<Zap size={34} />} title="暂无活动" description="启动 Agent 后，这里会显示状态变化、错误和工作区同步记录。" />
        ) : (
          <div className="divide-y divide-neutral-100">
            {events.map((event, index) => (
              <div key={`${event.time}-${index}`} className="flex items-start gap-3 px-4 py-3">
                <div className="mt-1 flex w-16 shrink-0 justify-end text-xs tabular-nums text-neutral-400">{new Date(event.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                <Circle size={9} className={`mt-1.5 shrink-0 fill-current ${statusDotClass(event.status)}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-900">{event.title}</div>
                  <div className="mt-1 break-words text-xs text-neutral-500">{event.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function HumanDetail({
  human,
  teamId,
  currentUser,
  currentMemberRole,
  onUpdated,
}: {
  human: HumanMember;
  teamId?: string;
  currentUser?: UserInfo | null;
  currentMemberRole?: 'owner' | 'admin' | 'member';
  onUpdated?: (human: HumanMember) => void;
}) {
  const np = useCurrentTeamPath();
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const agents = useAgentBeanStore((s) => s.agents);
  const ownedAgents = ownedAgentsForMember(agents, human.userId);
  const payloadTeamId = teamId || currentTeamId || undefined;
  const isSelf = currentUser?.id === human.userId;
  const isOwner = currentMemberRole === 'owner';
  const isAdmin = currentMemberRole === 'admin' || isOwner;
  const canEdit = isSelf || isAdmin;
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(human.description ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'remove' | 'transfer' | null>(null);

  useEffect(() => {
    setDescription(human.description ?? '');
    setEditingDescription(false);
    setSaveError(null);
  }, [human.userId, human.description]);

  const joinedAt = human.joinedAt ?? human.createdAt;
  const saveDescription = async () => {
    setSaving(true);
    setSaveError(null);
    const res = await memberEvents().updateHuman({
      userId: human.userId,
      teamId: payloadTeamId,
      description: description.trim() || null,
    });
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error ?? '保存失败');
      return;
    }
    if (res.human) onUpdated?.(res.human);
    setEditingDescription(false);
  };

  const handleRoleChange = async (role: 'admin' | 'member') => {
    setActionLoading('role');
    setActionError(null);
    const res = await memberEvents().updateRole({ targetUserId: human.userId, teamId: payloadTeamId, role });
    setActionLoading(null);
    if (!res.ok) {
      setActionError(res.error ?? '角色变更失败');
      return;
    }
    onUpdated?.({ ...human, role });
  };

  const handleConfirmAction = async (action: 'remove' | 'transfer') => {
    setActionLoading(action);
    setActionError(null);
    if (action === 'remove') {
      const res = await memberEvents().remove({ targetUserId: human.userId, teamId: payloadTeamId });
      setActionLoading(null);
      if (!res.ok) {
        setActionError(res.error ?? '移除失败');
        return;
      }
      onUpdated?.({ ...human, _removed: true } as any);
    } else if (action === 'transfer') {
      const res = await memberEvents().transferOwner({ targetUserId: human.userId, teamId: payloadTeamId });
      setActionLoading(null);
      if (!res.ok) {
        setActionError(res.error ?? '转让失败');
        return;
      }
      onUpdated?.({ ...human, role: 'owner' });
    }
    setConfirmAction(null);
  };

  return (
    <div
      className="mx-auto max-w-4xl space-y-4"
      data-smoke="human-member-detail"
      data-user-id={human.userId}
      data-username={human.username}
      data-member-role={human.role}
    >
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex items-start gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-purple-50">
            <User size={32} className="text-purple-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-neutral-900">{human.username}</h1>
              {isSelf && <span className="text-sm font-medium text-neutral-500">（你）</span>}
              <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                人类成员
              </span>
            </div>
            <div className="mt-1 text-sm text-neutral-500">@{human.username}</div>
          </div>
        </div>
      </section>

      <Section title="描述" icon={<FileText size={15} />}>
        {editingDescription ? (
          <div className="space-y-3">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="w-full resize-none rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-amber-300" placeholder="写一点这个成员在团队中的职责、偏好或背景。" />
            <div className="flex items-center gap-2">
              <button onClick={saveDescription} disabled={saving} className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                <Check size={13} />
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => { setDescription(human.description ?? ''); setEditingDescription(false); }} className="rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50">取消</button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <p className={`min-w-0 whitespace-pre-wrap text-sm leading-6 ${human.description?.trim() ? 'text-neutral-700' : 'italic text-neutral-400'}`}>
              {human.description?.trim() || '暂无描述。'}
            </p>
            {canEdit && (
              <button onClick={() => setEditingDescription(true)} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
                <Edit3 size={13} />
                编辑
              </button>
            )}
          </div>
        )}
        {saveError && <div className="mt-2 text-xs text-rose-600">{saveError}</div>}
      </Section>

      <Section title="信息" icon={<User size={15} />} compactGrid>
        <InfoRow label="角色" value={<span className="rounded-md bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700">{human.role === 'owner' ? '所有者' : human.role === 'admin' ? '管理员' : '成员'}</span>} />
        <InfoRow label="邮箱" value={human.email ?? (isSelf ? currentUser?.email ?? '未设置' : '未设置')} />
        <InfoRow label="加入时间" value={joinedAt ? new Date(joinedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '未知'} />
      </Section>

      {/* Member management: role change, remove, transfer owner */}
      {isAdmin && !isSelf && human.role !== 'owner' && (
        <Section title="成员管理" icon={<Shield size={15} />}>
          {actionError && <div className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{actionError}</div>}
          {confirmAction && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {confirmAction === 'remove' && <p>确定要从团队中移除 <strong>{human.username}</strong> 吗？此操作不可撤销。</p>}
              {confirmAction === 'transfer' && <p>确定要将团队所有权转让给 <strong>{human.username}</strong> 吗？你将降为管理员。</p>}
              <div className="mt-2 flex gap-2">
              <button
                onClick={() => handleConfirmAction(confirmAction)}
                disabled={!!actionLoading}
                className="rounded-md bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                data-smoke={`member-confirm-${confirmAction}`}
              >
                  {actionLoading ? '处理中...' : '确认'}
                </button>
                <button onClick={() => setConfirmAction(null)} className="rounded-md border border-neutral-200 px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50">取消</button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {/* Role change */}
            {isOwner && human.role !== 'admin' && (
              <button
                onClick={() => handleRoleChange('admin')}
                disabled={!!actionLoading}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                data-smoke="member-role-promote-admin"
              >
                <Shield size={13} />
                设为管理员
              </button>
            )}
            {isAdmin && human.role === 'admin' && (
              <button
                onClick={() => handleRoleChange('member')}
                disabled={!!actionLoading}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                data-smoke="member-role-demote-member"
              >
                <User size={13} />
                设为普通成员
              </button>
            )}
            {/* Remove member */}
            <button
              onClick={() => { setActionError(null); setConfirmAction('remove'); }}
              disabled={!!actionLoading}
              className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
              data-smoke="member-remove-open"
            >
              <X size={13} />
              移除成员
            </button>
            {/* Transfer owner */}
            {isOwner && (
              <button
                onClick={() => { setActionError(null); setConfirmAction('transfer'); }}
                disabled={!!actionLoading}
                className="inline-flex items-center gap-1 rounded-md border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                data-smoke="member-transfer-owner-open"
              >
                <Zap size={13} />
                转让所有权
              </button>
            )}
          </div>
        </Section>
      )}

      <Section title={`创建的智能体 ${ownedAgents.length}`} icon={<Users size={15} />}>
        {ownedAgents.length === 0 ? (
          <div className="text-sm text-neutral-500">暂未创建智能体。</div>
        ) : (
          <div className="divide-y divide-neutral-100 overflow-hidden rounded-md border border-neutral-200">
            {ownedAgents.map((agent) => (
              <Link key={agent.id} href={`/${np}/agent/${agent.id}?agentTab=profile`} className="flex items-center gap-3 bg-white px-3 py-3 hover:bg-neutral-50">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-200 bg-amber-50">
                  <Bot size={18} className="text-amber-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-neutral-900">{agent.name}</div>
                  <div className="truncate text-xs text-neutral-500">{RUNTIME_LABEL[agent.adapterKind] ?? agent.adapterKind}</div>
                </div>
                <Circle size={9} className={`shrink-0 fill-current ${statusDotClass(agent.status)}`} />
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, icon, children, compactGrid = false }: { title: string; icon: React.ReactNode; children: React.ReactNode; compactGrid?: boolean }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {icon}
        {title}
      </h2>
      <div className={compactGrid ? 'grid grid-cols-1 gap-x-8 sm:grid-cols-2' : ''}>
        {children}
      </div>
    </section>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-neutral-100 py-2 last:border-0">
      <span className="shrink-0 text-xs text-neutral-500">{label}</span>
      <span className={`min-w-0 text-right text-sm font-medium text-neutral-800 ${mono ? 'break-all font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function InlineEditor({ value, onChange, onCancel, onSave, saving }: { value: string; onChange: (value: string) => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1 rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-amber-300" />
      <button onClick={onSave} disabled={saving} className="inline-flex items-center justify-center rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
        <Check size={14} className="mr-1" />
        保存
      </button>
      <button onClick={onCancel} className="inline-flex items-center justify-center rounded-md border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
        <X size={14} className="mr-1" />
        取消
      </button>
    </div>
  );
}

function EditableLine({ value, onEdit }: { value: string; onEdit: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-neutral-800">{value}</div>
      <button onClick={onEdit} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50">
        <Edit3 size={13} />
        编辑
      </button>
    </div>
  );
}

function ReadOnlyLine({ value }: { value: string }) {
  return <div className="min-w-0 whitespace-pre-wrap break-words text-sm text-neutral-800">{value}</div>;
}

function CopyDiagnosticButton({ agent, device }: { agent: AgentSnapshot; device?: DeviceInfo }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(JSON.stringify({ agent, device }, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} className="inline-flex items-center justify-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
      {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
      复制诊断信息
    </button>
  );
}

function CenteredEmpty({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center text-center text-neutral-400">
      <div className="mb-4 text-neutral-300">{icon}</div>
      <div className="text-sm font-semibold text-neutral-700">{title}</div>
      <p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-neutral-900">{value}</div>
    </div>
  );
}
