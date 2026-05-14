'use client';
import { Copy } from 'lucide-react';
import type { AgentSnapshot, AgentCategory } from '@/lib/schema';
import { formatRelative } from '@/lib/format-time';
import { AgentStatusBadge } from './agent-status-badge';

const CATEGORY_LABEL: Record<string, string> = {
  'executor-hosted': '自定义 Agent',
  'agentos-hosted': 'AgentOS 托管',
};

const CATEGORY_STYLE: Record<string, string> = {
  'executor-hosted': 'bg-violet-50 text-violet-600 border-violet-100',
  'agentos-hosted': 'bg-purple-50 text-purple-600 border-purple-100',
};

export function AgentCard({ agent }: { agent: AgentSnapshot }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-lg font-bold text-neutral-600">
            {agent.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <div className="font-semibold text-sm">{agent.name}</div>
              {agent.visibility && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  agent.visibility === 'public'
                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                    : 'bg-neutral-100 text-neutral-500 border border-neutral-200'
                }`}>
                  {agent.visibility === 'public' ? '公开' : '私有'}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              {agent.category && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border ${CATEGORY_STYLE[agent.category]}`}>
                  {CATEGORY_LABEL[agent.category]}
                </span>
              )}
              {agent.networkId && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-neutral-100 text-neutral-500 border border-neutral-200">
                  {agent.networkId}
                </span>
              )}
            </div>
            <div className="text-xs text-neutral-500">{agent.role}</div>
          </div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-500">
        <div>Adapter: <span className="font-mono text-neutral-700">{agent.adapterKind}</span></div>
        <div>上次活跃: {formatRelative(agent.lastSeenAt)}</div>
      </div>

      {agent.status === 'online' && (
        <div className="mt-3 flex items-center gap-2 rounded bg-neutral-50 px-2 py-1.5 text-xs font-mono text-neutral-600">
          <span className="truncate flex-1">{agent.connectCommand}</span>
          <button
            className="shrink-0 text-neutral-400 hover:text-neutral-700"
            onClick={() => navigator.clipboard.writeText(agent.connectCommand)}
            title="复制"
          >
            <Copy size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
