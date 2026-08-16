'use client';

/**
 * 新版原型（#1194，origin/main `f8d88a48` 版）review-panel 对齐：
 * 任务卡片只做状态摘要和入口，不直接审核文件。
 *
 * - 摘要行：焦点包文件审核覆盖（X 通过 / Y 待审核 / Z 要修改）+ 交付验收 gating；
 * - 三入口：查看交付文件（→文件页输出包概览）、审核交付文件（→共享预览/编辑浮窗，
 *   初始选中第一个待处理文件版本）、打开讨论串（→绑定讨论串，纯导航不写状态）。
 * 按钮可见性消费 Server availableActions 投影；逐文件审核只发生在预览/编辑浮窗。
 */
import { useEffect, useState } from 'react';
import type {
  OutputPackageDto,
  PackageMemberAvailableActionsDto,
} from '@agentbean/contracts';

import { projectEvents } from '@/lib/socket';

export interface TaskCardReviewProjection {
  readonly package: OutputPackageDto;
  readonly availableActions: readonly PackageMemberAvailableActionsDto[];
  readonly threadRootMessageId?: string;
}

export function TaskCardReviewEntryPanel({
  channelId,
  focusPackageId,
  archived,
  onViewFiles,
  onReviewFiles,
  onOpenThread,
  onProjection,
}: {
  channelId: string;
  focusPackageId: string | null;
  archived: boolean;
  onViewFiles: () => void;
  /** firstPendingVersionId 为焦点包内第一个待处理成员版本；无待处理成员时为 undefined。 */
  onReviewFiles: (firstPendingVersionId: string | undefined) => void;
  onOpenThread: (threadRootMessageId: string | undefined) => void;
  onProjection?: (projection: TaskCardReviewProjection | null) => void;
}) {
  const [projection, setProjection] = useState<TaskCardReviewProjection | null>(null);

  useEffect(() => {
    if (!focusPackageId || archived) {
      setProjection(null);
      onProjection?.(null);
      return;
    }
    let alive = true;
    let requestId = 0;
    const load = () => {
      const currentRequestId = ++requestId;
      projectEvents().getOutputPackage({ channelId, packageId: focusPackageId }).then((result) => {
        if (!alive || currentRequestId !== requestId) return;
        if (result.ok && result.package && result.availableActions) {
          const next: TaskCardReviewProjection = {
            package: result.package,
            availableActions: result.availableActions,
            ...(result.threadRootMessageId ? { threadRootMessageId: result.threadRootMessageId } : {}),
          };
          setProjection(next);
          onProjection?.(next);
        }
        // 投影拉取失败保留旧投影；卡片摘要仍可用，不阻塞渲染。
      }).catch(() => { /* 软失败：等待事件刷新 */ });
    };
    load();
    const stopProject = projectEvents().onUpdated(channelId, load);
    const stopArtifacts = projectEvents().onArtifactsUpdated(channelId, load);
    return () => {
      alive = false;
      stopProject();
      stopArtifacts();
    };
  // onProjection 由父级内联传入时引用不稳定，刻意不加入依赖（只在投影变化时回调）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, focusPackageId, archived]);

  if (archived || !focusPackageId) return null;
  if (!projection) return null;

  const firstPending = projection.availableActions.find(
    (entry) => entry.reviewState === 'pending' || entry.reviewState === 'changes_requested',
  );

  return (
    <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50/70 p-2.5" data-smoke="task-card-review-entry">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          data-smoke="task-card-review-entry-action"
          data-action="view-files"
          onClick={onViewFiles}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          查看交付文件
        </button>
        <button
          type="button"
          data-smoke="task-card-review-entry-action"
          data-action="review-files"
          disabled={!firstPending}
          title={firstPending ? undefined : '当前焦点包没有待处理文件版本'}
          onClick={() => onReviewFiles(firstPending?.versionId)}
          className="rounded-md bg-sky-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          审核交付文件
        </button>
        <button
          type="button"
          data-smoke="task-card-review-entry-action"
          data-action="open-thread"
          onClick={() => onOpenThread(projection.threadRootMessageId)}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          打开讨论串
        </button>
      </div>
    </div>
  );
}
