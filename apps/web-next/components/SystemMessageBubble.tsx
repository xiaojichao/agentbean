'use client';

/**
 * System 消息渲染气泡。从 ChatBubble 抽离,使其不依赖 store/40 props 即可单元测试。
 *
 * 三种形态(按优先级):
 * 1. taskStatusEvent —— 任务状态更新药丸(可点击跳转任务)。
 * 2. output-package —— Agent 交付的文件包卡片(meta.kind='output-package')。
 *    server 在 package 成形时追加的 system 消息承载 meta 快照;此前被 system 早返回
 *    吃掉只显示「Agent 交付 N 个文件」药丸,这里渲染为带文件列表/操作按钮的卡片。
 * 3. 兜底 —— 通用 system 事件药丸(只显示 body)。
 */
import { ExternalLink } from 'lucide-react';
import { OutputPackageCard, type ReviseVersionRequest } from '@/components/OutputPackageCard';
import { outputPackageFromMeta } from '@/lib/output-package';
import { taskStatusEventSummary } from '@/lib/task-status-event';
import { taskStatusDotClass, taskStatusText } from '@/lib/task-status';
import { formatMessageDateTime } from '@/lib/chat-message-date';
import type { ChatMessage } from '@/lib/schema';
import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

export interface SystemMessageBubbleProps {
  msg: ChatMessage;
  meta: Record<string, unknown> | null | undefined;
  selected?: boolean;
  onOpenTaskDetailById?: (taskId: string) => void;
  onAddPackageReference?: (selection: ProjectReferenceSelectionRequestDto) => void;
  /** 已含 channelId 的修订回调(与 ChatBubble.onReviseVersion 同签名)。 */
  onReviseVersion?: (request: ReviseVersionRequest & { channelId: string }) => void;
  onContinueWithAgent?: (packageId: string, taskTitle?: string) => void;
  /** 原型对齐:文件包「预览/编辑」浮窗入口;未提供时卡片不渲染该按钮。 */
  onOpenPackagePreview?: (packageMeta: import('@/lib/output-package').OutputPackageMeta, versionId?: string) => void;
}

export function SystemMessageBubble({
  msg,
  meta,
  selected = false,
  onOpenTaskDetailById,
  onAddPackageReference,
  onReviseVersion,
  onContinueWithAgent,
  onOpenPackagePreview,
}: SystemMessageBubbleProps) {
  const anchorProps = {
    id: `message-${msg.id}`,
    'data-smoke': 'chat-message',
    'data-message-selected': selected ? 'true' : 'false',
  };
  const timestamp = formatMessageDateTime(msg.createdAt);
  const statusEventClassName = `mx-auto my-2 flex max-w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-neutral-600 shadow-sm ${
    selected
      ? 'border-amber-400 bg-amber-50/80 shadow-[inset_3px_0_0_#f59e0b]'
      : 'border-neutral-200 bg-white'
  }`;

  // 1. 任务状态更新药丸(taskStatusEventSummary 不接受 null/undefined meta,需 guard)
  const taskStatusEvent = meta ? taskStatusEventSummary(meta) : null;
  if (taskStatusEvent) {
    const canOpenTask = Boolean(taskStatusEvent.taskId && onOpenTaskDetailById);
    const content = (
      <>
        <span className={`h-2 w-2 rounded-full ${taskStatusDotClass(taskStatusEvent.status)}`} />
        <span>任务 {taskStatusEvent.label} 状态更新为 {taskStatusText(taskStatusEvent.status)}</span>
        <span className="text-neutral-400">{timestamp}</span>
        {canOpenTask && <ExternalLink size={12} className="text-neutral-400" />}
      </>
    );
    const taskId = taskStatusEvent.taskId;
    if (canOpenTask && taskId) {
      return (
        <button
          {...anchorProps}
          type="button"
          onClick={() => onOpenTaskDetailById?.(taskId)}
          className={`${statusEventClassName} hover:border-amber-300 hover:bg-amber-50`}
          title="查看任务详情"
        >
          {content}
        </button>
      );
    }
    return <div {...anchorProps} className={statusEventClassName}>{content}</div>;
  }

  // 2. 文件包卡片:server 追加的 output-package system 消息(此前被早返回吃掉)
  const pkg = outputPackageFromMeta(meta);
  if (pkg) {
    return (
      <div {...anchorProps} className="mx-auto my-2 w-full max-w-2xl">
        <div className="mb-1 text-right text-[10px] text-neutral-400">{timestamp}</div>
        <OutputPackageCard
          packageMeta={pkg}
          channelId={msg.channelId}
          onAddReference={onAddPackageReference}
          onReviseVersion={
            onReviseVersion
              ? (request) => onReviseVersion({ ...request, channelId: msg.channelId })
              : undefined
          }
          onOpenTask={onOpenTaskDetailById}
          onContinueWithAgent={onContinueWithAgent}
          onOpenPreview={onOpenPackagePreview ? (versionId) => onOpenPackagePreview(pkg, versionId) : undefined}
        />
      </div>
    );
  }

  // 3. 兜底:通用 system 事件药丸
  return (
    <div
      {...anchorProps}
      className={`mx-auto my-1 max-w-prose rounded border px-3 py-1.5 text-center text-xs text-amber-700 ${
        selected
          ? 'border-amber-400 bg-amber-50 shadow-[inset_3px_0_0_#f59e0b]'
          : 'border-amber-200 bg-amber-50'
      }`}
    >
      <span>{msg.body}</span>
      <span className="ml-2 text-neutral-400">{timestamp}</span>
    </div>
  );
}
