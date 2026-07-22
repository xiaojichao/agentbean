'use client';

import { useEffect, useState } from 'react';
import { agentExposureEvents } from '@/lib/socket';
import type { AgentTeamCoverageEntryDto } from '@agentbean/contracts';

/**
 * #710 PI Team 只读 coverage 面板（AC#5）。
 * 任意团队成员可读：每个 Agent 的公开 capability、Team 收紧与约束。
 * 不含 sourcePath/工具/权限（AC#6）。
 */
export function PiTeamCoveragePanel({ teamId }: { teamId: string }) {
  const [entries, setEntries] = useState<readonly AgentTeamCoverageEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    agentExposureEvents()
      .getTeamCoverage(teamId)
      .then((result) => {
        if (!live) return;
        if (result.ok && result.coverage) {
          setEntries(result.coverage.entries);
          setError(null);
        } else {
          setError(result.error ?? '读取 coverage 失败');
        }
        setLoading(false);
      });
    return () => { live = false; };
  }, [teamId]);

  return (
    <section className="rounded-lg border border-neutral-200 p-5" data-smoke="pi-team-coverage-panel">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">Agent 能力覆盖</h3>
      {loading ? (
        <p className="text-sm text-neutral-400">读取中…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-400">当前 Team 暂无可见 Agent。</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.agentId} className="rounded border border-neutral-100 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-800">{entry.agentName}</span>
                <span className={`text-xs ${entry.hasActive ? (entry.available ? 'text-emerald-600' : 'text-amber-600') : 'text-neutral-400'}`}>
                  {!entry.hasActive ? '未发布' : entry.available ? '可用' : '不可用'}
                  {entry.activeRevision !== null ? ` · r${entry.activeRevision}` : ''}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {entry.exposedCapabilities.length === 0 ? (
                  <span className="text-xs text-neutral-400">无公开 capability</span>
                ) : (
                  entry.exposedCapabilities.map((capability) => (
                    <span
                      key={capability}
                      className={`rounded px-2 py-0.5 text-xs ${entry.disabledCapabilities.includes(capability) ? 'bg-red-50 text-red-500 line-through' : 'bg-neutral-100 text-neutral-700'}`}
                    >
                      {capability}
                    </span>
                  ))
                )}
              </div>
              {entry.constraints.length > 0 && (
                <div className="mt-1 text-xs text-neutral-500">
                  约束：{entry.constraints.map((constraint) => constraint.kind).join('、')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
