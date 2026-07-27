'use client';

import React from 'react';
import type {
  MessageMetaDto,
  ProjectDocumentInputSetResultDto,
} from '@agentbean/contracts';
import { getResolvedServerUrl, getStoredAuthToken } from '@/lib/socket';

const STATUS_LABEL = {
  unchanged: '未变化',
  committed: '已提交',
  conflict: '有冲突',
  failed: '失败',
} as const;

const STATUS_TONE = {
  unchanged: 'border-neutral-200 bg-neutral-50 text-neutral-600',
  committed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  conflict: 'border-amber-200 bg-amber-50 text-amber-800',
  failed: 'border-red-200 bg-red-50 text-red-700',
} as const;

export function projectDocumentInputSetResultFromMeta(
  meta: MessageMetaDto | undefined,
): ProjectDocumentInputSetResultDto | undefined {
  const candidate = meta?.projectDocumentInputSetResult;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const result = candidate as Partial<ProjectDocumentInputSetResultDto>;
  return result.contractVersion === 1
    && typeof result.inputSetId === 'string'
    && typeof result.invocationId === 'string'
    && Array.isArray(result.items)
    ? result as ProjectDocumentInputSetResultDto
    : undefined;
}

export function ProjectDocumentInputSetResultSummary({
  result,
  teamId,
}: {
  result: ProjectDocumentInputSetResultDto;
  teamId: string;
}) {
  return (
    <section className="mt-2 border border-neutral-200 bg-white/80 p-2" aria-label="项目文档处理结果">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-neutral-800">项目文档处理结果</span>
        <span className="text-neutral-500">{result.items.length} 项</span>
      </div>
      <ul className="space-y-1">
        {result.items.map((item) => (
          <li
            key={`${item.documentId}:${item.baseRevisionId}`}
            className={`flex flex-wrap items-center justify-between gap-2 border px-2 py-1 text-xs ${STATUS_TONE[item.status]}`}
          >
            <span className="min-w-0 truncate font-mono" title={item.documentId}>
              {item.documentId}
            </span>
            <span className="flex items-center gap-2">
              <span>{STATUS_LABEL[item.status]}</span>
              {item.revisionId && <span title={item.revisionId}>新修订</span>}
              {item.status === 'conflict' && item.artifactId && (
                <a
                  className="font-medium underline underline-offset-2"
                  href={artifactDownloadUrl(teamId, item.artifactId)}
                >
                  查看冲突输出
                </a>
              )}
            </span>
            {item.error && <span className="w-full truncate opacity-80" title={item.error}>{item.error}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function artifactDownloadUrl(teamId: string, artifactId: string): string {
  const path = `/api/teams/${encodeURIComponent(teamId)}/artifacts/${encodeURIComponent(artifactId)}/download`;
  const token = getStoredAuthToken();
  return `${getResolvedServerUrl()}${path}?token=${encodeURIComponent(token)}`;
}
