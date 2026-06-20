'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Copy, Terminal } from 'lucide-react';
import { AgentCard } from '@/components/agent-card';
import { ConnectionBanner } from '@/components/connection-banner';
import { agentVisibleInNetwork } from '@/lib/agent-scope';
import { authEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function AgentsPage() {
  const params = useParams();
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const teams = useAgentBeanStore((s) => s.teams);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const routeNetworkPath = typeof params.networkPath === 'string' ? params.networkPath : '';
  const routeTeam = teams.find((team) => team.path === routeNetworkPath || team.id === routeNetworkPath);
  const agentsTeamId = routeTeam?.id ?? currentTeamId;
  const visibleAgents = agents.filter((agent) => agentVisibleInNetwork(agent, agentsTeamId));
  const [inviteCommand, setInviteCommand] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [copied, setCopied] = useState(false);

  const createInvite = async () => {
    setInviteError('');
    const res = await authEvents().inviteCreate({ networkId: agentsTeamId, purpose: 'device' });
    if (res.ok && res.invite?.command) {
      setInviteCommand(res.invite.command);
    } else {
      setInviteError(`生成失败：${res.error ?? 'unknown'}`);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-14 items-center border-b border-neutral-200 px-4 text-sm font-semibold">Agent</div>
      <div className="flex-1 overflow-y-auto p-6">
      <ConnectionBanner />

      <div className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-neutral-500" />
            <span className="text-sm font-medium text-neutral-700">邀请设备加入团队</span>
          </div>
          <button onClick={createInvite} className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">
            生成设备邀请
          </button>
        </div>
        {inviteCommand ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-900 px-3 py-2 text-sm text-emerald-400">
              {inviteCommand}
            </code>
            <button onClick={() => copy(inviteCommand)} className="rounded border border-neutral-300 p-2 hover:bg-neutral-100" title="复制命令">
              <Copy size={16} className={copied ? 'text-emerald-500' : 'text-neutral-500'} />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">生成后在新设备上执行命令，登录即可加入 AgentBean 团队。</p>
        )}
        {inviteError && <p className="mt-2 text-sm text-red-600">{inviteError}</p>}
      </div>

      <h1 className="mb-4 text-2xl font-bold">Agents</h1>
      {visibleAgents.length === 0 ? (
        <div className="text-sm text-neutral-500">暂无 Agent。可先在设备页创建自定义 Agent，或等待设备上报运行时。</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleAgents.map((agent) => (
            <Link key={agent.id} href={`/${routeNetworkPath || 'default'}/agents/${agent.id}`} className="block hover:shadow-md transition-shadow" data-smoke="agent-list-item" data-agent-id={agent.id} data-agent-name={agent.name}>
              <AgentCard agent={agent} />
            </Link>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
