'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Bot, Circle, ChevronRight, User } from 'lucide-react';
import { memberEvents, deviceEvents, agentEvents } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { AgentDetail, AgentTopBar, HumanDetail, type AgentMemberTab, type HumanMember } from '@/components/member-detail';

const TABS: { id: AgentMemberTab; label: string }[] = [
  { id: 'profile', label: 'PROFILE' },
  { id: 'permissions', label: 'PERMISSIONS' },
  { id: 'dms', label: 'AGENT DMS' },
  { id: 'reminders', label: 'REMINDERS' },
  { id: 'workspace', label: 'WORKSPACE' },
  { id: 'activity', label: 'ACTIVITY' },
];

export default function MembersPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const np = useCurrentNetworkPath();
  const conn = useAgentBeanStore((s) => s.conn);
  const devices = useAgentBeanStore((s) => s.devices);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const applyDevicesSnapshot = useAgentBeanStore((s) => s.applyDevicesSnapshot);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentMemberTab>('profile');
  const [agentsExpanded, setAgentsExpanded] = useState(true);
  const [humansExpanded, setHumansExpanded] = useState(true);
  const [humanMembers, setHumanMembers] = useState<HumanMember[]>([]);
  const routeAgentId = typeof params.agentId === 'string' ? params.agentId : null;
  const routeUserId = typeof params.userId === 'string' ? params.userId : null;
  const routeTab = searchParams.get('agentTab') as AgentMemberTab | null;

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
              <div className="mt-0.5 space-y-0.5">
                {agentList.map((agent) => (
                  <button key={agent.id} onClick={() => { setSelectedId(agent.id); setTab('profile'); router.push(`/${np}/agent/${agent.id}?agentTab=profile`); }} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selectedId === agent.id ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}>
                    <Bot size={15} className="shrink-0 text-amber-600" />
                    <Circle size={8} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : agent.status === 'busy' ? 'text-amber-500' : 'text-neutral-300'}`} />
                    <span className={`truncate text-sm ${selectedId === agent.id ? 'font-medium text-neutral-900' : 'text-neutral-700'}`}>{agent.name}</span>
                  </button>
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
                  <button key={h.userId} onClick={() => { setSelectedId(`user:${h.userId}`); router.push(`/${np}/human/${h.userId}`); }} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${selectedId === `user:${h.userId}` ? 'bg-pink-100' : 'hover:bg-neutral-100'}`}>
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
      <div className="flex flex-1 flex-col">
        {selectedAgent && <AgentTopBar agent={selectedAgent} />}

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
        <div className="flex-1 overflow-y-auto p-6">
          {!selectedId && <EmptyState />}
          {selectedId && selectedAgent && <AgentDetail agent={selectedAgent} device={selectedDevice} tab={tab} />}
          {selectedId && tab === 'profile' && !selectedAgent && selectedId?.startsWith('user:') && selectedHuman && <HumanDetail human={selectedHuman} currentUser={currentUser} />}
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
