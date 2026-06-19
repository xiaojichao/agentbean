'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Activity, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { useAgentBeanStore, useCurrentTeamPath } from '@/lib/store';
import { getWebSocket, agentEvents } from '@/lib/socket';
import type { AgentMetricsSummary } from '@/lib/schema';

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function MetricCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'success' | 'danger' | 'warning';
  icon: React.ReactNode;
}) {
  const toneClass = {
    neutral: 'bg-white border-neutral-200',
    success: 'bg-emerald-50 border-emerald-200',
    danger: 'bg-red-50 border-red-200',
    warning: 'bg-amber-50 border-amber-200',
  }[tone];
  return (
    <div className={`rounded border ${toneClass} px-4 py-3`}>
      <div className="flex items-center gap-2 text-xs text-neutral-500 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function AgentMetricsPanel({
  agentName,
  metrics,
}: {
  agentName: string;
  metrics: AgentMetricsSummary;
}) {
  const successRate =
    metrics.totalRequests > 0
      ? Math.round((metrics.successCount / metrics.totalRequests) * 100)
      : 0;

  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{agentName}</h3>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            successRate >= 90
              ? 'bg-emerald-100 text-emerald-700'
              : successRate >= 70
              ? 'bg-amber-100 text-amber-700'
              : 'bg-red-100 text-red-700'
          }`}
        >
          {successRate}% 成功率
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="总请求"
          value={String(metrics.totalRequests)}
          tone="neutral"
          icon={<Activity size={14} />}
        />
        <MetricCard
          label="成功"
          value={String(metrics.successCount)}
          tone="success"
          icon={<CheckCircle size={14} />}
        />
        <MetricCard
          label="失败"
          value={String(metrics.failCount)}
          tone={metrics.failCount > 0 ? 'danger' : 'neutral'}
          icon={<XCircle size={14} />}
        />
        <MetricCard
          label="平均响应"
          value={formatMs(metrics.avgResponseMs)}
          tone="neutral"
          icon={<Clock size={14} />}
        />
      </div>
      <div className="mt-2 text-xs text-neutral-500">
        P95 响应: {formatMs(metrics.p95ResponseMs)}
      </div>
      {metrics.lastError && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 rounded px-2 py-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">最近错误</div>
            <div className="truncate">{metrics.lastError}</div>
            {metrics.lastErrorAt && (
              <div className="text-red-400 mt-0.5">
                {new Date(metrics.lastErrorAt).toLocaleString('zh-CN')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentMetricsPage() {
  const agents = useAgentBeanStore((s) => s.agents);
  const agentMetrics = useAgentBeanStore((s) => s.agentMetrics);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const np = useCurrentTeamPath();
  const [loading, setLoading] = useState(true);

  const fetchMetrics = async () => {
    const res = await agentEvents().metrics(currentTeamId);
    if (res.ok && res.summaries) {
      useAgentBeanStore.getState().applyAgentMetrics(res.summaries);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!currentTeamId) return;
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [currentTeamId]);

  const metricsList = Object.values(agentMetrics).sort(
    (a, b) => b.totalRequests - a.totalRequests
  );

  const totalRequests = metricsList.reduce((s, m) => s + m.totalRequests, 0);
  const totalSuccess = metricsList.reduce((s, m) => s + m.successCount, 0);
  const totalFail = metricsList.reduce((s, m) => s + m.failCount, 0);
  const overallRate = totalRequests > 0 ? Math.round((totalSuccess / totalRequests) * 100) : 0;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Link
          href={`/${np}/agents`}
          className="flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-800"
        >
          <ArrowLeft size={16} /> 返回
        </Link>
        <h1 className="text-2xl font-bold">Agent 性能看板</h1>
      </div>

      {metricsList.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="rounded border border-neutral-200 bg-white px-4 py-3">
            <div className="text-xs text-neutral-500 mb-1">总请求数</div>
            <div className="text-xl font-bold">{totalRequests}</div>
          </div>
          <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div className="text-xs text-emerald-600 mb-1">成功</div>
            <div className="text-xl font-bold text-emerald-700">{totalSuccess}</div>
          </div>
          <div className="rounded border border-red-200 bg-red-50 px-4 py-3">
            <div className="text-xs text-red-600 mb-1">失败</div>
            <div className="text-xl font-bold text-red-700">{totalFail}</div>
          </div>
          <div className="rounded border border-neutral-200 bg-white px-4 py-3">
            <div className="text-xs text-neutral-500 mb-1">整体成功率</div>
            <div className="text-xl font-bold">{overallRate}%</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-neutral-500">加载指标...</div>
      ) : metricsList.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
          暂无性能数据。Agent 开始处理请求后指标将自动出现。
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {metricsList.map((m) => (
            <AgentMetricsPanel
              key={m.agentId}
              agentName={agents[m.agentId]?.name ?? 'Agent'}
              metrics={m}
            />
          ))}
        </div>
      )}
    </div>
  );
}
