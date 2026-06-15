'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Copy, Check, Globe, Lock, Monitor, Terminal, User } from 'lucide-react';
import { agentEvents, fetchAgentWorkspace } from '@/lib/socket';
import { useAgentBeanStore, useCurrentNetworkPath } from '@/lib/store';
import { AgentStatusBadge } from '@/components/agent-status-badge';
import { formatRelative } from '@/lib/format-time';
import type { AgentWorkspaceRun } from '@/lib/schema';
import { AgentWorkspaceSection } from '@/components/agent-workspace-section';

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agent = useAgentBeanStore((s) => s.agents[params.agentId] ?? null);
  const setAgents = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const upsert = useAgentBeanStore((s) => s.applyAgentStatus);
  const np = useCurrentNetworkPath();
  const [publishing, setPublishing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const teams = useAgentBeanStore((s) => s.teams);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const [workspaceRuns, setWorkspaceRuns] = useState<AgentWorkspaceRun[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  useEffect(() => {
    if (!currentTeamId) return;
    const ev = agentEvents();
    const unsubSnapshot = ev.onSnapshot(setAgents);
    const unsubStatus = ev.onStatus(upsert);
    ev.subscribe(currentTeamId);
    return () => {
      unsubSnapshot();
      unsubStatus();
    };
  }, [currentTeamId, setAgents, upsert]);

  useEffect(() => {
    if (!agent?.id || !currentTeamId) return;
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
  }, [agent?.id, currentTeamId]);

  const handleTogglePublish = async (networkId: string) => {
    if (!agent || publishing) return;
    const isPublished = (agent.publishedNetworkIds ?? []).includes(networkId);
    setPublishing(networkId);
    const ev = agentEvents();
    const res = isPublished
      ? await ev.unpublish(agent.id, networkId)
      : await ev.publish(agent.id, networkId);
    setPublishing(null);
    if (res.ok) {
      const updated = isPublished
        ? (agent.publishedNetworkIds ?? []).filter((id) => id !== networkId)
        : [...(agent.publishedNetworkIds ?? []), networkId];
      upsert({ ...agent, publishedNetworkIds: updated });
    }
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
    'executor-hosted': 'bg-violet-50 text-violet-600 border-violet-100',
  };
  const categoryLabel: Record<string, string> = {
    coding: '编程助手',
    'agentos-hosted': 'AgentOS 托管',
    'executor-hosted': '自定义 Agent',
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

      {/* 团队发布 */}
      <section className="rounded-lg border border-neutral-200 p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">团队发布</h3>
        <div className="space-y-2">
          {teams.map((net) => {
            const isHome = net.id === agent.networkId;
            const isPublished = (agent.publishedNetworkIds ?? []).includes(net.id);
            const isBusy = publishing === net.id;
            return (
              <div key={net.id} className="flex items-center justify-between rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  {net.visibility === 'public' ? (
                    <Globe size={14} className="text-blue-500 shrink-0" />
                  ) : (
                    <Lock size={14} className="text-neutral-400 shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate">{net.name}</span>
                  {isHome && (
                    <span className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">主团队</span>
                  )}
                </div>
                {isHome ? (
                  <span className="text-[10px] text-neutral-400">默认可见</span>
                ) : (
                  <button
                    onClick={() => handleTogglePublish(net.id)}
                    disabled={isBusy}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      isPublished ? 'bg-emerald-500' : 'bg-neutral-300'
                    } ${isBusy ? 'opacity-50' : ''}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${isPublished ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                )}
              </div>
            );
          })}
          {teams.length <= 1 && (
            <div className="text-xs text-neutral-400 py-2">仅有一个团队，无需发布管理。</div>
          )}
        </div>
      </section>

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
          <dt className="text-neutral-500">团队</dt>
          <dd>{teams.find((net) => net.id === agent.networkId)?.name ?? '默认团队'}</dd>
        </div>
        {agent.source && (
          <div>
            <dt className="text-neutral-500">来源</dt>
            <dd>
              <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                agent.source === 'custom' ? 'bg-violet-50 text-violet-600' :
                agent.source === 'scanned' ? 'bg-cyan-50 text-cyan-600' :
                'bg-amber-50 text-amber-600'
              }`}>
                {agent.source === 'custom' ? '自定义' : agent.source === 'scanned' ? '自动扫描' : '自注册'}
              </span>
            </dd>
          </div>
        )}
      </dl>

      {/* 设备信息 */}
      <section className="rounded-lg border border-neutral-200 p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
          <Monitor size={14} />设备信息
        </h3>
        {agent.deviceId ? (
          <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
            <div>
              <dt className="text-neutral-500">设备</dt>
              <dd>
                <Link href={`/${np}/devices`} className="text-blue-600 hover:underline">
                  查看关联设备
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">设备状态</dt>
              <dd>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  agent.status === 'online' || agent.status === 'busy' ? 'bg-emerald-50 text-emerald-600' :
                  agent.status === 'error' ? 'bg-red-50 text-red-600' :
                  'bg-neutral-100 text-neutral-500'
                }`}>
                  {agent.status === 'online' ? '在线' : agent.status === 'busy' ? '忙碌' : agent.status === 'error' ? '错误' : '离线'}
                </span>
              </dd>
            </div>
          </dl>
        ) : (
          <div className="text-xs text-neutral-400">此 Agent 未绑定设备（可能为自定义或虚拟 Agent）。</div>
        )}
      </section>

      {/* 运行时配置 */}
      {(agent.command || agent.ownerId) && (
        <section className="rounded-lg border border-neutral-200 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
            <Terminal size={14} />运行时配置
          </h3>
          <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
            {agent.ownerId && (
              <div>
                <dt className="text-neutral-500 flex items-center gap-1"><User size={12} />创建者</dt>
                <dd>{agent.ownerName ?? '未知'}</dd>
              </div>
            )}
            {agent.command && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-500">命令</dt>
                <dd className="font-mono text-xs break-all">{agent.command}</dd>
              </div>
            )}
            {agent.args && agent.args.length > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-500">参数</dt>
                <dd className="font-mono text-xs break-all">{agent.args.join(' ')}</dd>
              </div>
            )}
            {agent.cwd && (
              <div>
                <dt className="text-neutral-500">工作目录</dt>
                <dd className="font-mono text-xs break-all">{agent.cwd}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {agent.lastError && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
          <div className="mb-1 inline-flex items-center text-red-700">
            <AlertTriangle className="mr-1 h-4 w-4" />连接错误
          </div>
          <div className="font-mono text-xs whitespace-pre-wrap break-all">{agent.lastError}</div>
        </div>
      )}

      <AgentWorkspaceSection runs={workspaceRuns} loading={workspaceLoading} />

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
