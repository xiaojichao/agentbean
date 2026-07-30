'use client';

import { useEffect, useState } from 'react';

import { fetchMemoryAttribution } from '@/lib/socket';
import type { ActiveMemoryAttributionEntryDto, ActiveMemorySourceCode } from '@agentbean/contracts';

/**
 * #965 AC#4：向有权用户展示本次 PI 协调使用的 Active Memory 来源说明。
 *
 * 只展示来源作用域的中文标签（如「Team 记忆」「频道记忆」），绝不展示正文、记忆 id 或
 * ranking 分数。服务端已对未授权读取 fail-closed 返回 null——本组件收到 null/空/失败时
 * 不渲染任何内容（不泄露归因是否存在）。
 */
const SOURCE_LABEL: Record<ActiveMemorySourceCode, string> = {
  team_formal_memory: 'Team 记忆',
  channel_formal_memory: '频道记忆',
  task_fact: '任务记忆',
  agent_projection: 'Agent 投影',
  experience_pack: '经验包',
};

function summarizeEntries(entries: readonly ActiveMemoryAttributionEntryDto[]): string | null {
  if (entries.length === 0) return null;
  // 同一来源去重后按固定枚举顺序输出，保持稳定、最小披露。
  const seen = new Set<ActiveMemorySourceCode>();
  const ordered: ActiveMemorySourceCode[] = [
    'team_formal_memory',
    'channel_formal_memory',
    'task_fact',
    'agent_projection',
    'experience_pack',
  ];
  for (const entry of entries) seen.add(entry.source);
  const labels = ordered.filter((source) => seen.has(source)).map((source) => SOURCE_LABEL[source]);
  return labels.length > 0 ? labels.join('、') : null;
}

export function MemoryAttributionSources({ teamId, jobId }: { teamId: string; jobId: string }) {
  const [label, setLabel] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLabel(undefined);
    fetchMemoryAttribution({ teamId, jobId })
      .then((res) => {
        if (cancelled) return;
        const attribution = res?.ok ? (res.attribution ?? null) : null;
        setLabel(attribution ? summarizeEntries(attribution.entries) : null);
      })
      .catch(() => {
        if (!cancelled) setLabel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, jobId]);

  // 加载中或无归因（含未授权 fail-closed）→ 不渲染，避免泄露存在性。
  if (!label) return null;
  return <div className="mt-1 text-[11px] leading-tight text-neutral-500">记忆来源：{label}</div>;
}
