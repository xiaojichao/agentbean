'use client';

import React from 'react';
import {
  actionableCommandsFromAttention,
  activityLevelLabel,
  commandActionLabel,
  sortAttentionInbox,
  sortTaskTimeline,
  type NamedActivityActionCommand,
  type SystemActivityItemView,
  type SystemAttentionItemView,
  type ThreadTaskCardView,
} from '@/lib/system-activity';

export interface SystemActivityPanelsProps {
  readonly taskTimeline?: readonly SystemActivityItemView[];
  readonly threadCard?: ThreadTaskCardView | null;
  readonly attentionInbox?: readonly SystemAttentionItemView[];
  readonly projectionNotReady?: boolean;
  readonly onMarkSeen?: (item: SystemAttentionItemView) => void;
  readonly onNamedAction?: (command: NamedActivityActionCommand, item: SystemAttentionItemView) => void;
}

/**
 * #929 最小可操作视图：Task 时间线 / Thread 活动卡 / Inbox attention。
 * 视觉保持克制；不渲染 PI 头像或聊天气泡。
 */
export function SystemActivityPanels(props: SystemActivityPanelsProps) {
  const timeline = sortTaskTimeline(props.taskTimeline ?? []);
  const inbox = sortAttentionInbox(props.attentionInbox ?? []);
  const card = props.threadCard;

  if (props.projectionNotReady) {
    return (
      <div
        data-testid="system-activity-not-ready"
        className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        投影尚未追上（projection not ready），请稍后重试。不会伪装成已读最新写入。
      </div>
    );
  }

  return (
    <div data-testid="system-activity-panels" className="flex flex-col gap-4">
      {card ? (
        <section
          data-testid="thread-task-card"
          className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2"
        >
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span className="rounded bg-white px-1.5 py-0.5 font-medium text-neutral-700">
              Task 活动
            </span>
            <span>{activityLevelLabel(card.currentLevel)}</span>
          </div>
          <p className="mt-1 text-sm text-neutral-900">{card.currentSummary || '暂无里程碑'}</p>
          {card.milestones.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-neutral-200 pt-2">
              {card.milestones.map((m) => (
                <li key={m.projectionId} className="text-xs text-neutral-600">
                  <span className="mr-1 font-medium">{activityLevelLabel(m.level)}</span>
                  {m.summary}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {timeline.length > 0 ? (
        <section data-testid="task-activity-timeline">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            活动时间线
          </h3>
          <ol className="space-y-2">
            {timeline.map((item) => (
              <li
                key={item.projectionId}
                data-testid="timeline-item"
                data-actor-kind={item.actorKind}
                className="rounded border border-neutral-100 bg-white px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <span>{activityLevelLabel(item.level)}</span>
                  <span className="text-neutral-300">·</span>
                  <span>system</span>
                </div>
                <p className="mt-0.5 text-neutral-900">{item.summary}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {inbox.length > 0 ? (
        <section data-testid="attention-inbox">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            责任收件箱
          </h3>
          <ul className="space-y-2">
            {inbox.map((item) => {
              const actions = actionableCommandsFromAttention(item);
              return (
                <li
                  key={item.attentionIdentity}
                  data-testid="attention-item"
                  data-level={item.level}
                  data-unread={item.unread ? 'true' : 'false'}
                  className={`rounded border px-3 py-2 text-sm ${
                    item.level === 'action_required'
                      ? 'border-rose-200 bg-rose-50'
                      : 'border-amber-100 bg-amber-50/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium text-neutral-700">
                          {activityLevelLabel(item.level)}
                        </span>
                        {item.unread ? (
                          <span className="rounded bg-pink-100 px-1.5 py-0.5 text-[10px] text-pink-700">
                            未读
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-neutral-900">{item.summary}</p>
                    </div>
                    {item.unread && props.onMarkSeen ? (
                      <button
                        type="button"
                        data-testid="mark-attention-seen"
                        className="shrink-0 rounded border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
                        onClick={() => props.onMarkSeen?.(item)}
                      >
                        标为已读
                      </button>
                    ) : null}
                  </div>
                  {actions.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {actions.map((command) => (
                        <button
                          key={command}
                          type="button"
                          data-testid={`named-action-${command}`}
                          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white hover:bg-neutral-800"
                          onClick={() => props.onNamedAction?.(command, item)}
                        >
                          {commandActionLabel(command)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-1 text-[10px] text-neutral-400">
                    已读不会结束责任；操作走具名 command。
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
