'use client';

import React from 'react';
import { FileEdit } from 'lucide-react';
import type { ArtifactVersionRevisionMeta } from '@/lib/artifact-revision';

/**
 * #1062 历史兼容：曾用于聊天流「某人保存了新 revision」活动卡。
 *
 * 现行策略不再向聊天投影该消息（isHiddenSystemMessage 过滤）；组件保留以免旧代码路径
 * 引用断裂。只渲染 meta 快照，不承载业务事实。
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
