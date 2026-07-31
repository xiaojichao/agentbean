'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { SystemActivityPanels } from '@/components/SystemActivityPanels';
import type {
  NamedActivityActionCommand,
  SystemActivityItemView,
  SystemAttentionItemView,
  ThreadTaskCardView,
} from '@/lib/system-activity';
import {
  loadAttentionInbox,
  loadTaskTimeline,
  loadThreadTaskCard,
  markAttentionSeen,
  prepareNamedAction,
} from '@/lib/system-activity-client';
import { systemActivityEvents, taskEvents } from '@/lib/socket';

/**
 * #998 Task 详情侧：拉取并展示 audience-scoped 活动时间线 + 本任务相关 attention。
 */
export function TaskSystemActivitySection(props: {
  taskId: string;
  channelId?: string | null;
  teamId: string;
  userId: string;
}) {
  const [timeline, setTimeline] = useState<SystemActivityItemView[]>([]);
  const [card, setCard] = useState<ThreadTaskCardView | null>(null);
  const [attention, setAttention] = useState<SystemAttentionItemView[]>([]);
  const [notReady, setNotReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.teamId || !props.userId || !props.taskId) return;
    const [tl, at] = await Promise.all([
      loadTaskTimeline({
        userId: props.userId,
        teamId: props.teamId,
        taskId: props.taskId,
      }),
      loadAttentionInbox({
        userId: props.userId,
        teamId: props.teamId,
        limit: 50,
      }),
    ]);
    setNotReady(Boolean(tl.projectionNotReady || at.projectionNotReady));
    setError(tl.error ?? at.error ?? null);
    setTimeline(tl.items);
    setAttention(at.items.filter((item) => item.taskId === props.taskId));

    if (props.channelId) {
      const thread = await loadThreadTaskCard({
        userId: props.userId,
        teamId: props.teamId,
        taskId: props.taskId,
        channelId: props.channelId,
      });
      setCard(thread.card);
      if (thread.projectionNotReady) setNotReady(true);
    } else {
      setCard(null);
    }
  }, [props.taskId, props.channelId, props.teamId, props.userId]);

  useEffect(() => {
    void refresh();
    const off = systemActivityEvents().onNotice(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const onMarkSeen = async (item: SystemAttentionItemView) => {
    const res = await markAttentionSeen({
      userId: props.userId,
      teamId: props.teamId,
      item,
    });
    if (res.ok) void refresh();
  };

  const onNamedAction = async (command: NamedActivityActionCommand, item: SystemAttentionItemView) => {
    const prepared = prepareNamedAction({
      command,
      taskId: item.taskId,
      attention: item,
    });
    // review 走 task lifecycle cancel/close；remediation 需服务端专用路径——
    // 当前最小接线：cancel/close 直接 taskEvents，其余仅刷新并在控制台提示。
    if (command === 'cancel-task') {
      await taskEvents().cancel(item.taskId, 'system-activity-ui');
    } else if (command === 'close-task') {
      await taskEvents().close(item.taskId, 'system-activity-ui');
    } else {
      if (typeof console !== 'undefined') {
        console.info('[system-activity] named action ready (dispatch via lifecycle/remediation):', prepared);
      }
    }
    void refresh();
  };

  if (error && timeline.length === 0 && attention.length === 0 && !card) {
    return (
      <div className="rounded border border-neutral-100 px-3 py-2 text-[11px] text-neutral-400" data-testid="task-system-activity-empty">
        暂无系统活动投影
      </div>
    );
  }

  return (
    <div data-testid="task-system-activity-section" className="border-t border-neutral-100 pt-3">
      <SystemActivityPanels
        taskTimeline={timeline}
        threadCard={card}
        attentionInbox={attention}
        projectionNotReady={notReady}
        onMarkSeen={onMarkSeen}
        onNamedAction={onNamedAction}
      />
    </div>
  );
}

/**
 * #998 Chat Inbox：责任收件箱（与 Message activity 分层）。
 */
export function ChatAttentionInboxSection(props: {
  teamId: string;
  userId: string;
}) {
  const [items, setItems] = useState<SystemAttentionItemView[]>([]);
  const [notReady, setNotReady] = useState(false);

  const refresh = useCallback(async () => {
    if (!props.teamId || !props.userId) return;
    const res = await loadAttentionInbox({
      userId: props.userId,
      teamId: props.teamId,
      limit: 50,
    });
    setNotReady(res.projectionNotReady);
    setItems(res.items);
  }, [props.teamId, props.userId]);

  useEffect(() => {
    void refresh();
    return systemActivityEvents().onNotice(() => {
      void refresh();
    });
  }, [refresh]);

  if (items.length === 0 && !notReady) {
    return (
      <div className="px-3 py-2 text-[11px] text-neutral-400" data-testid="chat-attention-empty">
        暂无系统责任条目
      </div>
    );
  }

  return (
    <div data-testid="chat-attention-inbox-section" className="border-b border-neutral-100 px-2 py-2">
      <SystemActivityPanels
        attentionInbox={items}
        projectionNotReady={notReady}
        onMarkSeen={async (item) => {
          const res = await markAttentionSeen({
            userId: props.userId,
            teamId: props.teamId,
            item,
          });
          if (res.ok) void refresh();
        }}
        onNamedAction={async (command, item) => {
          if (command === 'cancel-task') await taskEvents().cancel(item.taskId, 'system-activity-ui');
          else if (command === 'close-task') await taskEvents().close(item.taskId, 'system-activity-ui');
          void refresh();
        }}
      />
    </div>
  );
}
