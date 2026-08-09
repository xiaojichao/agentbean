'use client';

import React from 'react';
import { CircleDot, Package, ShieldCheck, Tag, Trash2, User } from 'lucide-react';
import type { ChannelTaskWorkspaceEntryV1, TaskStatus } from '@agentbean/contracts';
import { reviewStateLabel } from '@/lib/delivery-labels';
import { TASK_STATUS_COLUMNS } from '@/lib/task-status';

export function ChannelTaskCard({
  entry,
  creatorName,
  assigneeName,
  reviewerLabel,
  onDelete,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenDetail,
}: {
  entry: ChannelTaskWorkspaceEntryV1;
  creatorName: string;
  assigneeName: string;
  reviewerLabel: string;
  onDelete: () => void;
  onMove: (status: TaskStatus) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpenDetail: () => void;
}) {
  const { task, governance, responsibilityFocus, delivery, stage } = entry;
  const managed = governance.mode === 'managed';
  return (
    <article
      draggable={governance.allowDirectStatusMutation}
      onDragStart={governance.allowDirectStatusMutation ? onDragStart : undefined}
      onDragEnd={governance.allowDirectStatusMutation ? onDragEnd : undefined}
      className={`group border-2 border-neutral-900 bg-white p-3 shadow-sm ${governance.allowDirectStatusMutation ? 'cursor-grab active:cursor-grabbing' : ''}`}
      data-smoke="channel-task-card"
      data-governance={governance.mode}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <span>任务</span>
            {managed ? <span className="border border-violet-200 bg-violet-50 px-1 text-violet-700">受管</span> : null}
            {stage ? <span className="truncate border border-sky-200 bg-sky-50 px-1 text-sky-700">阶段：{stage.name}</span> : null}
          </div>
          <button
            type="button"
            onClick={onOpenDetail}
            data-smoke="task-card-open-detail"
            className="mt-1 whitespace-pre-wrap text-left text-sm font-semibold leading-5 text-neutral-900 hover:text-amber-700 hover:underline"
            title="打开任务详情"
          >
            {task.title}
          </button>
        </div>
        {governance.allowDirectDelete ? (
          <button onClick={onDelete} className="flex h-6 w-6 shrink-0 items-center justify-center text-neutral-300 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100" title="删除任务">
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>

      {task.description ? <div className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-500">{task.description}</div> : null}

      {managed ? (
        <div className="mt-3 space-y-1.5 border-y border-neutral-100 py-2 text-[11px] text-neutral-600">
          <div className="flex items-start gap-1.5" data-smoke="task-card-focus">
            <CircleDot size={11} className="mt-0.5 shrink-0 text-pink-500" />
            <span>{responsibilityFocus.detail}</span>
          </div>
          {stage && (!stage.executionAllowed || stage.blockingReasons.length > 0 || stage.missingRequiredInputs.length > 0) ? (
            <div className="flex items-start gap-1.5 text-amber-700" data-smoke="task-card-blockers">
              <ShieldCheck size={11} className="mt-0.5 shrink-0" />
              <span>
                {stage.missingRequiredInputs.length > 0
                  ? `缺少输入：${stage.missingRequiredInputs.map((item) => item.label || item.key).join('、')}`
                  : `存在 ${stage.blockingReasons.length || 1} 个执行阻塞点`}
              </span>
            </div>
          ) : null}
          <div className="flex items-start gap-1.5" data-smoke="task-card-delivery">
            <Package size={11} className="mt-0.5 shrink-0 text-violet-600" />
            <span>
              {delivery.packageCount > 0
                ? `交付包 ${delivery.packageCount} 个${delivery.focusReviewState ? ` · ${reviewStateLabel(delivery.focusReviewState)}` : ''}`
                : '暂无交付包'}
              {delivery.pendingDeliveryCount > 0 ? ` · ${delivery.pendingDeliveryCount} 批处理中` : ''}
            </span>
          </div>
          <div data-smoke="task-card-reviewer">
            审核人：{reviewerLabel}
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        <span className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
          <User size={10} />
          创建者：{creatorName}
        </span>
        {!managed ? (
          <span className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
            <User size={10} />
            负责人：{assigneeName}
          </span>
        ) : null}
        {task.tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
            <Tag size={9} />
            {tag}
          </span>
        ))}
      </div>

      {governance.allowDirectStatusMutation ? (
        <select value={task.status} onChange={(event) => onMove(event.target.value as TaskStatus)} className="mt-3 h-7 w-full border border-neutral-300 bg-white px-2 text-xs font-medium text-neutral-700">
          {TASK_STATUS_COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
        </select>
      ) : (
        <div className="mt-3 border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[11px] text-neutral-500" data-smoke="task-card-governed-status">
          状态由任务执行与验收流程推进
        </div>
      )}
    </article>
  );
}
