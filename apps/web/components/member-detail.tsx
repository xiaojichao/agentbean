'use client';

import { useState } from 'react';
import { Bot, Circle, Code2, Cpu, Folder, MessageSquare, Shield, User, Users } from 'lucide-react';
import { dmEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import type { AgentSnapshot, DeviceInfo, UserInfo } from '@/lib/schema';

export interface HumanMember {
  userId: string;
  role: string;
  username: string;
}

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

function statusClass(status?: string): string {
  if (status === 'online') return 'bg-emerald-50 text-emerald-700';
  if (status === 'busy') return 'bg-amber-50 text-amber-700';
  if (status === 'error') return 'bg-rose-50 text-rose-700';
  return 'bg-neutral-100 text-neutral-500';
}

export function AgentDetail({ agent, device }: { agent: AgentSnapshot; device?: DeviceInfo }) {
  const np = useCurrentNetworkPath();
  const [dmLoading, setDmLoading] = useState(false);

  const startDm = async () => {
    setDmLoading(true);
    const res = await dmEvents().start(agent.id);
    setDmLoading(false);
    if (res.ok && res.dm?.id) {
      window.location.href = `/${np}/dm/${res.dm.id}`;
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-amber-50">
          <Bot size={28} className="text-amber-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-neutral-900">{agent.name}</h1>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(agent.status)}`}>
              <Circle size={6} className="fill-current" />
              {STATUS_LABEL[agent.status] ?? agent.status}
            </span>
          </div>
          <div className="mt-1 text-sm text-neutral-500">@{agent.name}</div>
          {agent.description && <p className="mt-3 text-sm leading-6 text-neutral-600">{agent.description}</p>}
        </div>
        <button onClick={startDm} disabled={dmLoading} className="flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50">
          <MessageSquare size={14} />
          私聊
        </button>
      </div>

      <Section title="基本信息" icon={<Shield size={15} />}>
        <InfoRow label="Agent ID" value={agent.id} mono />
        <InfoRow label="角色" value={agent.role || '未设置'} />
        <InfoRow label="适配器" value={agent.adapterKind} />
        <InfoRow label="类型" value={CATEGORY_LABEL[agent.category ?? 'executor-hosted'] ?? '自定义 Agent'} />
        <InfoRow label="可见性" value={agent.visibility === 'private' ? '私有' : '公开'} />
        <InfoRow label="最后在线" value={new Date(agent.lastSeenAt).toLocaleString('zh-CN')} />
        {agent.ownerId && <InfoRow label="创建者" value={agent.ownerId} mono />}
      </Section>

      <Section title="运行环境" icon={<Cpu size={15} />}>
        <InfoRow label="设备" value={device?.hostname ?? device?.id ?? '未关联设备'} />
        <InfoRow label="设备状态" value={device ? (STATUS_LABEL[device.status] ?? device.status) : '未知'} />
        <InfoRow label="系统" value={[device?.systemInfo?.platform, device?.systemInfo?.arch].filter(Boolean).join(' / ') || '未上报'} />
        <InfoRow label="Node" value={device?.systemInfo?.nodeVersion ?? '未上报'} />
      </Section>

      <Section title="启动配置" icon={<Code2 size={15} />}>
        <InfoRow label="命令" value={agent.command ?? '未配置'} mono={Boolean(agent.command)} />
        <InfoRow label="参数" value={agent.args?.length ? agent.args.join(' ') : '未配置'} mono={Boolean(agent.args?.length)} />
        <InfoRow label="工作目录" value={agent.cwd ?? '未配置'} mono={Boolean(agent.cwd)} />
      </Section>

      <Section title="技能与资源" icon={<Folder size={15} />}>
        <div className="text-sm text-neutral-500">当前未上报技能、知识库或工作区资源。</div>
      </Section>
    </div>
  );
}

export function HumanDetail({ human, currentUser }: { human: HumanMember; currentUser?: UserInfo | null }) {
  const agents = useAgentBeanStore((s) => s.agents);
  const ownedAgents = Object.values(agents).filter((a) => a.ownerId === human.userId);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-purple-50">
          <User size={28} className="text-purple-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-neutral-900">{human.username}</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <Circle size={6} className="fill-current" />
              成员
            </span>
          </div>
          <div className="mt-1 text-sm text-neutral-500">@{human.username}</div>
        </div>
      </div>

      <Section title="个人信息" icon={<User size={15} />}>
        <InfoRow label="用户 ID" value={human.userId} mono />
        <InfoRow label="用户名" value={human.username} />
        <InfoRow label="网络角色" value={human.role} />
        {currentUser?.id === human.userId && <InfoRow label="邮箱" value={currentUser.email ?? '未设置'} />}
      </Section>

      <Section title={`创建的智能体 (${ownedAgents.length})`} icon={<Users size={15} />}>
        {ownedAgents.length === 0 ? (
          <div className="text-sm text-neutral-500">暂未创建智能体。</div>
        ) : (
          <div className="space-y-2">
            {ownedAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-3 rounded-md border border-neutral-200 px-3 py-2">
                <Bot size={16} className="text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900">{agent.name}</div>
                  <div className="text-xs text-neutral-500">{agent.adapterKind} · {agent.role || '未设置角色'}</div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass(agent.status)}`}>
                  {STATUS_LABEL[agent.status] ?? agent.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {icon}
        {title}
      </h2>
      {children}
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
