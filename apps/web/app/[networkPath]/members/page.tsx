'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Circle, ChevronRight, User, Check, MessageSquare } from 'lucide-react';
import { memberEvents, deviceEvents, dmEvents, agentEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { AgentSnapshot } from '@/lib/schema';

type Tab = 'profile' | 'dms' | 'reminders' | 'workspace' | 'activity';

const TABS: { id: Tab; label: string }[] = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'dms', label: 'AGENT DMS' },
  { id: 'reminders', label: 'REMINDERS' },
  { id: 'workspace', label: 'WORKSPACE' },
  { id: 'activity', label: 'ACTIVITY' },
];

interface HumanMember {
  userId: string;
  role: string;
  username: string;
}

export default function MembersPage() {
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const agents = useAgentBeanStore((s) => s.agents);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('profile');
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [humansExpanded, setHumansExpanded] = useState(true);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [humanMembers, setHumanMembers] = useState<HumanMember[]>([]);

  useEffect(() => {
    if (conn !== 'open') return;
    deviceEvents().subscribe();
    const unsubDevices = deviceEvents().onSnapshot((list) => applyDevicesSnapshot(list));
    const unsubStatus = agentEvents().onStatus((snap) => applyAgentStatus(snap));
    memberEvents().list().then((res) => {
      if (res.ok && res.humans) setHumanMembers(res.humans);
      if (res.ok && res.agents) applyAgentsSnapshot(res.agents);
    });
    return () => { unsubDevices(); unsubStatus(); };
  }, [conn, applyDevicesSnapshot, applyAgentsSnapshot, applyAgentStatus]);

  const agentList = useMemo(() => Object.values(agents), [agents]);
  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedAgent = agentList.find((a) => a.id === selectedId);
  const selectedDevice = selectedAgent?.deviceId ? devices[selectedAgent.deviceId] : undefined;
  const selectedHuman = selectedId?.startsWith('user:') ? humanMembers.find((h) => `user:${h.userId}` === selectedId) : undefined;

  return (
    <div className="-m-6 flex h-[calc(100vh-40px)]">
      {/* Left sidebar */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-sm font-semibold">成员</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {/* AGENTS section */}
          <div className="mb-2">
            <button onClick={() => setAgentsExpanded((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700">
              <ChevronRight size={12} className={`shrink-0 transition-transform ${agentsExpanded ? 'rotate-90' : ''}`} />
              智能体成员
              <span className="ml-auto rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{agentList.length}</span>
            </button>
            {agentsExpanded && (
              <div className="mt-0.5 space-y-0.5">
                {agentList.map((agent) => (
                  <div key={agent.id} onClick={() => setSelectedId(agent.id)} className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer ${selectedId === agent.id ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}>
                    <button onClick={(e) => { e.stopPropagation(); toggleCheck(agent.id); }} className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300">
                      {checkedIds.has(agent.id) && <Check size={10} className="text-neutral-700" />}
                    </button>
                    <Circle size={8} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : agent.status === 'busy' ? 'text-amber-500' : 'text-neutral-300'}`} />
                    <span className={`truncate text-sm ${selectedId === agent.id ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>{agent.name}</span>
                  </div>
                ))}
                {agentList.length === 0 && <div className="px-2 py-2 text-xs text-neutral-400">暂无 Agent</div>}
              </div>
            )}
          </div>

          {/* HUMANS section */}
          <div className="mb-2">
            <button onClick={() => setHumansExpanded((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-700">
              <ChevronRight size={12} className={`shrink-0 transition-transform ${humansExpanded ? 'rotate-90' : ''}`} />
              人类成员
              <span className="ml-auto rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-600">{humanMembers.length}</span>
            </button>
            {humansExpanded && (
              <div className="mt-0.5 space-y-0.5">
                {humanMembers.map((h) => (
                  <div key={h.userId} onClick={() => setSelectedId(`user:${h.userId}`)} className={`flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer ${selectedId === `user:${h.userId}` ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}>
                    <button onClick={(e) => { e.stopPropagation(); toggleCheck(`user:${h.userId}`); }} className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-neutral-300">
                      {checkedIds.has(`user:${h.userId}`) && <Check size={10} className="text-neutral-700" />}
                    </button>
                    <Circle size={8} className="shrink-0 fill-current text-purple-500" />
                    <span className={`truncate text-sm ${selectedId === `user:${h.userId}` ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>{h.username}</span>
                  </div>
                ))}
                {humanMembers.length === 0 && <div className="px-2 py-2 text-xs text-neutral-400">暂无用户</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex flex-1 flex-col">
        {/* Tab bar */}
        <div className="flex border-b border-neutral-200">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`border-b-2 px-4 py-2.5 text-xs font-medium tracking-wide ${tab === t.id ? 'border-amber-400 text-neutral-900' : 'border-transparent text-neutral-400 hover:text-neutral-600'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedId && <EmptyState />}
          {selectedId && tab === 'profile' && selectedAgent && <AgentProfile agent={selectedAgent} device={selectedDevice} />}
          {selectedId && tab === 'profile' && !selectedAgent && selectedId?.startsWith('user:') && selectedHuman && <HumanProfile human={selectedHuman} />}
          {tab !== 'profile' && <PlaceholderTab name={TABS.find((t) => t.id === tab)?.label ?? ''} />}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-neutral-400">
      <Bot size={48} strokeWidth={1} />
      <div className="mt-3 text-sm">选择左侧成员查看详情</div>
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-400">{name} 开发中...</div>
  );
}

function AgentProfile({ agent, device }: { agent: AgentSnapshot; device?: { hostname?: string; id: string; status: string } }) {
  const [displayName, setDisplayName] = useState(agent.name);
  const [description, setDescription] = useState('');
  const [dmLoading, setDmLoading] = useState(false);

  const startDm = async () => {
    setDmLoading(true);
    const res = await dmEvents().start(agent.id);
    setDmLoading(false);
    if (res.ok) {
      // Navigate to chat - use router
      window.location.href = window.location.pathname.replace('/members', '/chat');
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-amber-50">
          <Bot size={28} className="text-amber-600" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{agent.name}</h1>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${agent.status === 'online' ? 'bg-emerald-50 text-emerald-700' : agent.status === 'busy' ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-500'}`}>
              <Circle size={6} className="fill-current" /> {agent.status}
            </span>
          </div>
          <div className="mt-0.5 text-sm text-neutral-500">@{agent.name}</div>
        </div>
        <button onClick={startDm} disabled={dmLoading} className="ml-auto flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50">
          <MessageSquare size={12} /> 发起私信
        </button>
      </div>

      {/* Display Name & Description */}
      <section className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500">显示名称</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500">描述</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="添加描述..." className="w-full rounded-md border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400 placeholder:text-neutral-400 resize-none" />
        </div>
      </section>

      {/* INFO */}
      <Section title="基本信息">
        {device && (
          <>
            <InfoRow label="设备" value={
              <span className="flex items-center gap-1.5">
                <Bot size={12} className="text-neutral-400" />
                <span>{device.hostname ?? device.id}</span>
                <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"><Circle size={5} className="fill-current" /> 已连接</span>
              </span>
            } />
          </>
        )}
        {!device && <InfoRow label="设备" value={<span className="text-neutral-400">未连接设备</span>} />}
        <InfoRow label="适配器" value={agent.adapterKind ?? '—'} />
        <InfoRow label="创建时间" value={new Date(agent.lastSeenAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} />
        {agent.ownerId && <InfoRow label="创建者" value={<span className="rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700">{agent.ownerId}</span>} />}
        <InfoRow label="状态" value={agent.status} />
        <InfoRow label="角色" value={agent.role} />
      </Section>

      {/* Runtime Configuration */}
      <Section title="运行时配置">
        <div className="space-y-3">
          {agent.command && <InfoRow label="命令" value={<code className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs">{agent.command}</code>} />}
          {agent.args && agent.args.length > 0 && <InfoRow label="参数" value={<code className="text-xs text-neutral-600">{agent.args.join(' ')}</code>} />}
          {agent.cwd && <InfoRow label="工作目录" value={<code className="text-xs text-neutral-600">{agent.cwd}</code>} />}
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex items-center rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">{agent.adapterKind}</span>
            {agent.category && <span className="inline-flex items-center rounded-md bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700">{agent.category}</span>}
          </div>
          {!agent.command && !agent.args && !agent.cwd && <div className="text-sm text-neutral-400">无运行时配置</div>}
        </div>
      </Section>

      {/* Environment Variables */}
      <Section title="环境变量">
        <div className="text-sm text-neutral-400">未配置环境变量</div>
      </Section>

      {/* Created Agents */}
      <Section title={`创建的 Agent (${0})`}>
        <div className="text-sm text-neutral-400">暂无创建的 Agent</div>
      </Section>

      {/* Skills */}
      <Section title={`技能 (全局: 0)`}>
        <div className="text-sm text-neutral-400">未配置技能</div>
      </Section>
    </div>
  );
}

function HumanProfile({ human }: { human: HumanMember }) {
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const agents = useAgentBeanStore((s) => s.agents);
  const userAgents = Object.values(agents).filter((a) => a.ownerId === human.userId);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-purple-50">
          <User size={28} className="text-purple-600" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{human.username}</h1>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              <Circle size={6} className="fill-current" /> 在线
            </span>
          </div>
          <div className="mt-0.5 text-sm text-neutral-500">@{human.username}</div>
        </div>
      </div>

      <Section title="信息">
        <InfoRow label="用户名" value={human.username} />
        <InfoRow label="角色" value={human.role} />
        <InfoRow label="用户 ID" value={human.userId} />
        {currentUser?.id === human.userId && (
          <InfoRow label="邮箱" value={currentUser.email ?? '未设置'} />
        )}
      </Section>

      {userAgents.length > 0 && (
        <Section title={`创建的 Agent (${userAgents.length})`}>
          <div className="space-y-2">
            {userAgents.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
                <Bot size={16} className="text-neutral-500" />
                <div className="flex-1">
                  <div className="text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-neutral-400">{a.role} · {a.adapterKind}</div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${a.status === 'online' ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'}`}>{a.status}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 py-2 last:border-0">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-800">{value}</span>
    </div>
  );
}
