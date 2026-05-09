'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Copy, Check } from 'lucide-react';
import { agentEvents, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { AgentStatusBadge } from '@/components/agent-status-badge';
import { formatRelative } from '@/lib/format-time';

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agent = useAgentBeanStore((s) => s.agents[params.agentId] ?? null);
  const setAgents = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const upsert = useAgentBeanStore((s) => s.applyAgentStatus);
  const updateAgent = useAgentBeanStore((s) => s.updateAgent);
  const np = useCurrentNetworkPath();
  const [toggling, setToggling] = useState(false);
  const [networkChanging, setNetworkChanging] = useState(false);
  const [copied, setCopied] = useState(false);
  const networks = useAgentBeanStore((s) => s.networks);

  useEffect(() => {
    const socket = getWebSocket();
    const ev = agentEvents(socket);
    const unsubSnapshot = ev.onSnapshot(setAgents);
    const unsubStatus = ev.onStatus(upsert);
    ev.subscribe();
    return () => {
      unsubSnapshot();
      unsubStatus();
    };
  }, [setAgents, upsert]);

  const handleToggleVisibility = () => {
    if (!agent || toggling) return;
    const next = agent.visibility === 'public' ? 'private' : 'public';
    setToggling(true);
    const socket = getWebSocket();
    socket.emit(
      'agent:update',
      { id: agent.id, visibility: next },
      (res: { ok: boolean; error?: string }) => {
        setToggling(false);
        if (res.ok) {
          updateAgent(agent.id, { visibility: next });
        }
      }
    );
  };

  const handleNetworkChange = (networkId: string) => {
    if (!agent || networkChanging || networkId === agent.networkId) return;
    setNetworkChanging(true);
    const socket = getWebSocket();
    socket.emit(
      'agent:update',
      { id: agent.id, networkId },
      (res: { ok: boolean; error?: string }) => {
        setNetworkChanging(false);
        if (res.ok) {
          updateAgent(agent.id, { networkId });
        }
      }
    );
  };

  const handleCopyCommand = () => {
    if (!agent?.connectCommand) return;
    navigator.clipboard.writeText(agent.connectCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!agent) {
    return (
      <div className="p-6 text-sm text-neutral-400">
        正在加载 Agent 信息或该 Agent 还未上线。
      </div>
    );
  }

  const categoryColor: Record<string, string> = {
    coding: 'bg-blue-50 text-blue-600 border-blue-100',
    'agentos-hosted': 'bg-purple-50 text-purple-600 border-purple-100',
    'executor-hosted': 'bg-orange-50 text-orange-600 border-orange-100',
    'standalone-cli': 'bg-neutral-100 text-neutral-600 border-neutral-200',
  };
  const categoryLabel: Record<string, string> = {
    coding: '编程助手',
    'agentos-hosted': 'AgentOS 托管',
    'executor-hosted': '执行器托管',
    'standalone-cli': '独立 CLI',
  };

  return (
    <div className="space-y-4 p-6">
      <Link href={`/${np}/agents`} className="inline-flex items-center text-sm text-neutral-500 hover:text-neutral-900">
        <ArrowLeft className="mr-1 h-4 w-4" />返回 Agent 列表
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-xl font-semibold">{agent.name}</div>
            {agent.category && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${categoryColor[agent.category] ?? categoryColor['standalone-cli']}`}>
                {categoryLabel[agent.category] ?? agent.category}
              </span>
            )}
          </div>
          <div className="text-sm text-neutral-500">{agent.role || '未填写角色'}</div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-neutral-500 w-12">可见性</span>
          <button
            onClick={handleToggleVisibility}
            disabled={toggling}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              agent.visibility === 'public' ? 'bg-emerald-500' : 'bg-neutral-300'
            } ${toggling ? 'opacity-60' : ''}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                agent.visibility === 'public' ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className={agent.visibility === 'public' ? 'text-emerald-600' : 'text-neutral-500'}>
            {agent.visibility === 'public' ? '公开' : '私有'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-neutral-500 w-12">网络</span>
          <select
            value={agent.networkId ?? 'default'}
            onChange={(e) => handleNetworkChange(e.target.value)}
            disabled={networkChanging}
            className="rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-500 focus:outline-none disabled:opacity-50"
          >
            {networks.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
            {networks.length === 0 && (
              <>
                <option value="default">default</option>
                <option value="public">public</option>
              </>
            )}
          </select>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
        <div>
          <dt className="text-neutral-500">最近活跃</dt>
          <dd>{formatRelative(agent.lastSeenAt)}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Adapter</dt>
          <dd className="font-mono text-xs">{agent.adapterKind}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Network ID</dt>
          <dd className="font-mono text-xs">{agent.networkId ?? 'default'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-neutral-500">Agent ID</dt>
          <dd className="font-mono text-xs break-all">{agent.id}</dd>
        </div>
      </dl>

      {agent.lastError && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
          <div className="mb-1 inline-flex items-center text-red-700">
            <AlertTriangle className="mr-1 h-4 w-4" />连接错误
          </div>
          <div className="font-mono text-xs whitespace-pre-wrap break-all">{agent.lastError}</div>
        </div>
      )}

      <section>
        <div className="mb-1 text-sm text-neutral-700 font-medium">接入命令</div>
        <div className="relative">
          <pre className="rounded bg-neutral-900 text-neutral-100 p-3 pr-10 font-mono text-xs whitespace-pre-wrap">
{agent.connectCommand}
          </pre>
          <button
            onClick={handleCopyCommand}
            className="absolute right-2 top-2 text-neutral-400 hover:text-white"
            title="复制"
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          复制该命令到本机终端，即可启动这个 Agent 的本地客户端。
        </div>
      </section>
    </div>
  );
}
