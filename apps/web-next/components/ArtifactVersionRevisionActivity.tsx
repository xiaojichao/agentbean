'use client';

import React from 'react';
import { FileEdit } from 'lucide-react';
import type { ArtifactVersionRevisionMeta } from '@/lib/artifact-revision';

/**
 * #1062 AC9 讨论串轻量活动卡:展示「某人保存了新 revision」。
 *
 * 只渲染 Server 下发的 meta 快照(collection/version/provenance),不复制 Markdown 全文,
 * 不伪装成 PI/人类发言;保存者与版本号是 Server 事实,客户端不推断。
 */
export function ArtifactVersionRevisionActivity({ meta }: { meta: ArtifactVersionRevisionMeta }) {
  const actor = meta.revisedByName ?? '某成员';
  const title = meta.collectionName ?? meta.collectionId;
  return (
    <div
      className="mt-2 flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
      data-smoke="artifact-version-revision-activity"
    >
      <FileEdit className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
      <div className="min-w-0 text-sm text-neutral-700">
        <span className="font-medium text-neutral-800">{actor}</span>
        <span className="text-neutral-500"> 保存了《{title}》新版本 v{meta.versionNumber}</span>
        {meta.basisReviewId ? (
          <span className="ml-1 text-xs text-neutral-500">（基于此修改）</span>
        ) : null}
      </div>
    </div>
  );
}
