'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Bot, Circle, ChevronRight, Monitor, User } from 'lucide-react';
import { memberEvents, deviceEvents, agentEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { AgentDetail, AgentTopBar, HumanDetail, type AgentMemberTab, type HumanMember } from '@/components/member-detail';
import type { AgentSnapshot } from '@/lib/schema';
import { agentDeviceDisplayName } from '@/lib/agent-device';

const TABS: { id: AgentMemberTab; label: string }[] = [
  { id: 'profile', label: '资料' },
  { id: 'permissions', label: '权限' },
  { id: 'dms', label: '智能体私聊' },
  { id: 'reminders', label: '提醒' },
  { id: 'workspace', label: '工作区' },
  { id: 'activity', label: '动态' },
];

const RUNTIME_LABEL: Record<string, string> = {
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  standalone: 'Standalone',
};

function agentStatusClass(status?: string): string {
  if (status === 'online') return 'text-emerald-500';
  if (status === 'busy') return 'text-amber-500';
  if (status === 'error') return 'text-rose-500';
  return 'text-neutral-300';
}

function agentSubtitle(agent: AgentSnapshot): string {
  return agent.description?.trim()
    || RUNTIME_LABEL[agent.adapterKind]
    || agent.role
    || 'Agent';
}

export default function MembersPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const np = useCurrentNetworkPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const agents = useAgentBeanStore((s) => s.agents);
  const teams = useAgentBeanStore((s) => s.teams);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyDeviceStatus = useAgentBeanStore((s) => s.applyDeviceStatus);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentMemberTab>('profile');
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [humansExpanded, setHumansExpanded] = useState(true);
  const [humanMembers, setHumanMembers] = useState<HumanMember[]>([]);
  const routeAgentId = typeof params.agentId === 'string' ? params.agentId : null;
  const routeUserId = typeof params.userId === 'string' ? params.userId : null;
  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : np;
  const routeTeamId = teams.find((team) => team.path === routeNetworkPath || team.id === routeNetworkPath)?.id;
  const memberTeamId = routeTeamId ?? (routeNetworkPath === 'default' ? currentTeamId : '');
  const routeTab = searchParams.get('agentTab') as AgentMemberTab | null;

  useEffect(() => {
    if (conn !== 'open' || !memberTeamId) return;
    deviceEvents().subscribe(memberTeamId);
    const unsubDevices = deviceEvents().onSnapshot((list) => applyDevicesSnapshot(list));
    const unsubDeviceStatus = deviceEvents().onStatus((device) => applyDeviceStatus(device));
    const unsubStatus = agentEvents().onStatus((snap) => applyAgentStatus(snap));
    memberEvents().list({ teamId: memberTeamId }).then((res) => {
      if (res.ok && res.humans) setHumanMembers(res.humans);
      if (res.ok && res.agents) applyAgentsSnapshot(res.agents);
    });
    return () => { unsubDevices(); unsubDeviceStatus(); unsubStatus(); };
  }, [conn, memberTeamId, applyDevicesSnapshot, applyDeviceStatus, applyAgentsSnapshot, applyAgentStatus]);

  const agentList = useMemo(() => Object.values(agents), [agents]);

  useEffect(() => {
    if (routeAgentId) {
      setSelectedId(routeAgentId);
      setTab(TABS.some((t) => t.id === routeTab) ? routeTab! : 'profile');
      return;
    }
    if (routeUserId) {
      setSelectedId(`user:${routeUserId}`);
      setTab('profile');
    }
  }, [routeAgentId, routeUserId, routeTab]);

  const selectedAgent = agentList.find((a) => a.id === selectedId);
  const selectedDevice = selectedAgent?.deviceId ? devices[selectedAgent.deviceId] : undefined;
  const selectedHuman = selectedId?.startsWith('user:') ? humanMembers.find((h) => `user:${h.userId}` === selectedId) : undefined;
  const agentGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; agents: AgentSnapshot[] }>();
    for (const agent of [...agentList].sort((a, b) => {
      const aDevice = (a.deviceName ?? (a.deviceId ? devices[a.deviceId]?.hostname : '') ?? '').toLowerCase();
      const bDevice = (b.deviceName ?? (b.deviceId ? devices[b.deviceId]?.hostname : '') ?? '').toLowerCase();
      return aDevice.localeCompare(bDevice) || a.name.localeCompare(b.name);
    })) {
      const label = agentDeviceDisplayName(agent, agent.deviceId ? devices[agent.deviceId] : undefined);
      const key = agent.deviceId ?? `unknown:${label}`;
      const group = groups.get(key) ?? { key, label, agents: [] };
      group.agents.push(agent);
      groups.set(key, group);
    }
    return Array.from(groups.values());
  }, [agentList, devices]);
  const setAgentTab = (nextTab: AgentMemberTab) => {
    setTab(nextTab);
    if (selectedAgent) router.replace(`/${np}/agent/${selectedAgent.id}?agentTab=${nextTab}`);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar */}
      <div className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
        <div className="flex h-14 items-center border-b border-neutral-200 px-4">
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
              <div className="mt-0.5 space-y-2">
                {agentGroups.map((group) => (
                  <div key={group.key}>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-neutral-400">
                      <Monitor size={11} className="shrink-0" />
                      <span className="truncate">{group.label}</span>
                    </div>
                    <div className="space-y-0.5">
                      {group.agents.map((agent) => (
                        <button key={agent.id} onClick={() => { setSelectedId(agent.id); setTab('profile'); router.push(`/${np}/agent/${agent.id}?agentTab=profile`); }} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selectedId === agent.id ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}>
                          <Bot size={15} className="shrink-0 text-amber-600" />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className={`truncate text-sm ${selectedId === agent.id ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>{agent.name}</span>
                              <Circle size={7} className={`shrink-0 fill-current ${agentStatusClass(agent.status)}`} />
                            </div>
                            <div className="truncate text-[11px] leading-tight text-neutral-400">{agentSubtitle(agent)}</div>
                          </div>
                        </button>
                      ))}
                    </div>
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
                  <button
                    key={h.userId}
                    onClick={() => { setSelectedId(`user:${h.userId}`); router.push(`/${np}/human/${h.userId}`); }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selectedId === `user:${h.userId}` ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}
                    data-smoke="human-member-item"
                    data-user-id={h.userId}
                    data-username={h.username}
                    data-member-role={h.role}
                  >
                    <User size={15} className="shrink-0 text-purple-600" />
                    <Circle size={8} className="shrink-0 fill-current text-purple-500" />
                    <span className={`truncate text-sm ${selectedId === `user:${h.userId}` ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>
                      {h.username}{currentUser?.id === h.userId ? '（你）' : ''}
                    </span>
                  </button>
                ))}
                {humanMembers.length === 0 && <div className="px-2 py-2 text-xs text-neutral-400">暂无用户</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedAgent && <AgentTopBar agent={selectedAgent} device={selectedDevice} />}

        {/* Tab bar */}
        {selectedAgent && (
          <div className="flex h-10 shrink-0 items-center border-b border-neutral-200 bg-white">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setAgentTab(t.id)} className={`flex h-full items-center border-b-2 px-4 text-[11px] font-semibold tracking-wide ${tab === t.id ? 'border-amber-400 bg-amber-50 text-neutral-900' : 'border-transparent text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Tab content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {!selectedId && <EmptyState />}
          {selectedId && selectedAgent && <AgentDetail agent={selectedAgent} device={selectedDevice} tab={tab} />}
          {selectedId && tab === 'profile' && !selectedAgent && selectedId?.startsWith('user:') && selectedHuman && (
            <HumanDetail
              human={selectedHuman}
              teamId={memberTeamId}
              currentUser={currentUser}
              currentMemberRole={humanMembers.find((h) => h.userId === currentUser?.id)?.role as 'owner' | 'admin' | 'member' | undefined}
              onUpdated={(next) => {
                if ((next as any)._removed) {
                  setHumanMembers((members) => members.filter((m) => m.userId !== next.userId));
                  setSelectedId(null);
                } else {
                  setHumanMembers((members) => members.map((member) => member.userId === next.userId ? { ...member, ...next } : member));
                }
              }}
            />
          )}
          {selectedId && !selectedAgent && tab !== 'profile' && <PlaceholderTab name={TABS.find((t) => t.id === tab)?.label ?? ''} />}
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
