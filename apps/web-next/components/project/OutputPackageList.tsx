'use client';

import React from 'react';
import { Clock, Package, PackageOpen } from 'lucide-react';
import { reviewStateLabel } from '@/lib/delivery-labels';
import type {
  OutputPackagePendingDeliveryDto,
  OutputPackageSummaryDto,
} from '@agentbean/contracts';

/**
 * #1060 Files/Task 的 OutputPackage 投影。
 *
 * packages:已形成的完整交付(同一 Server identity 与讨论串卡片一致);
 * pendingDeliveries:Workspace revision 已 commit 但 package 暂未形成(Server reconciliation
 * 收敛中)——UI 只显示「交付处理中」,不伪造完整交付(#1060 AC8)。
 * 本组件是纯展示投影,不承载业务状态、不推进 Task。
 */
// #1065 AC11：三处 surface 共享同一组文本标签(server 事实的本地映射)。

export function OutputPackageList({
  packages,
  pendingDeliveries,
  title = '交付文件包',
}: {
  packages: readonly OutputPackageSummaryDto[];
  pendingDeliveries: readonly OutputPackagePendingDeliveryDto[];
  title?: string;
}) {
  return (
    <div data-smoke="output-package-list" className="space-y-2">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-neutral-400" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
      </div>
      {packages.length === 0 && pendingDeliveries.length === 0 ? (
        <p className="text-sm text-neutral-400">暂无交付文件包</p>
      ) : null}
      {packages.map((pkg) => (
        <div
          key={pkg.packageId}
          data-smoke="output-package-item"
          data-package-id={pkg.packageId}
          className="rounded-lg border border-neutral-200 bg-white p-3"
        >
          <div className="flex items-center gap-2">
            <PackageOpen className="h-4 w-4 text-neutral-500" aria-hidden="true" />
            <span className="text-sm font-medium text-neutral-800">
              {pkg.memberCount} 个文件
            </span>
            <span
              className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-neutral-600"
              data-smoke="output-package-review-state"
            >
              {reviewStateLabel(pkg.reviewState)}
            </span>
            <span className="ml-auto text-xs text-neutral-500">
              {pkg.taskBinding === 'managed' && pkg.taskRevision !== undefined
                ? `Task r${pkg.taskRevision} · attempt ${pkg.taskAttempt}`
                : `attempt ${pkg.taskAttempt}`}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {new Date(pkg.createdAt).toLocaleString()}
          </p>
        </div>
      ))}
      {pendingDeliveries.map((pending) => (
        <div
          key={pending.publishId}
          data-smoke="output-package-pending"
          className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-3"
        >
          <Clock className="h-4 w-4 text-neutral-400" aria-hidden="true" />
          <span className="text-sm text-neutral-600">交付处理中</span>
          <span className="ml-auto text-xs text-neutral-400">
            attempt {pending.taskAttempt}
          </span>
        </div>
      ))}
    </div>
  );
}
