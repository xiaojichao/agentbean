'use client';

import React from 'react';
import { Package, FileText } from 'lucide-react';
import type { OutputPackageMeta } from '@/lib/output-package';

/**
 * #1060 讨论串最小文件包卡片。
 *
 * 展示 package 身份、来源与冻结成员(短标识 + 文件名)。成员是交付时冻结快照,
 * 不与 Server 事实漂移;完整事实经 Files/Task 的 listOutputPackages 读取。
 * 卡片不承载任何业务状态、不推进 Task;「交付处理中」由 Server projection 单独展示。
 */
export function OutputPackageCard({ packageMeta }: { packageMeta: OutputPackageMeta }) {
  const title = packageMeta.taskTitle ? `任务「${packageMeta.taskTitle}」交付文件包` : 'Agent 交付文件包';
  return (
    <div
      className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3"
      data-smoke="output-package-card"
      data-package-id={packageMeta.packageId}
    >
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-neutral-600" aria-hidden="true" />
        <span className="text-sm font-medium text-neutral-800">{title}</span>
        <span className="ml-auto text-xs text-neutral-500">
          {packageMeta.memberCount} 个文件
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {packageMeta.members.map((member) => (
          <li key={member.artifactVersionId} className="flex items-center gap-2 text-sm text-neutral-700">
            <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
            <span className="w-8 shrink-0 text-xs font-medium text-neutral-500">{member.shortLabel}</span>
            <span className="truncate">{member.filename}</span>
          </li>
        ))}
      </ul>
      {packageMeta.agentName ? (
        <p className="mt-2 text-xs text-neutral-500">
          交付 Agent：{packageMeta.agentName}
        </p>
      ) : null}
    </div>
  );
}
