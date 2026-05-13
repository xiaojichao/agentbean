'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Copy, Terminal } from 'lucide-react';
import { AgentCard } from '@/components/agent-card';
import { ConnectionBanner } from '@/components/connection-banner';
import { authEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';

export default function AgentsPage() {
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const publicAgents = agents.filter((a) => a.visibility === 'public');
  const [inviteCommand, setInviteCommand] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [copied, setCopied] = useState(false);

  const createInvite = async () => {
    setInviteError('');
    const res = await authEvents().inviteCreate({ networkId: 'default', purpose: 'device' });
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
            <span className="text-sm font-medium text-neutral-700">邀请设备加入网络</span>
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
          <p className="text-xs text-neutral-500">生成后在新设备上执行命令，登录即可加入 AgentBean 网络。</p>
        )}
        {inviteError && <p className="mt-2 text-sm text-red-600">{inviteError}</p>}
      </div>

      <h1 className="mb-4 text-2xl font-bold">公开 Agents</h1>
      {publicAgents.length === 0 ? (
        <div className="text-sm text-neutral-500">暂无公开 Agent。可在 Dashboard 中将私有 Agent 发布到公开网络。</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {publicAgents.map((agent) => (
            <Link key={agent.id} href={`/agents/${agent.id}`} className="block hover:shadow-md transition-shadow">
              <AgentCard agent={agent} />
            </Link>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
