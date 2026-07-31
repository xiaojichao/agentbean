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
import { systemActivityEvents, taskEvents, taskRemediationEvents } from '@/lib/socket';
import { mapReviewCommandToTaskSocketEvent } from '@/lib/system-activity';

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

  const [actionError, setActionError] = useState<string | null>(null);

  const onNamedAction = async (command: NamedActivityActionCommand, item: SystemAttentionItemView) => {
    setActionError(null);
    const prepared = prepareNamedAction({
      command,
      taskId: item.taskId,
      attention: item,
    });
    const mapped = mapReviewCommandToTaskSocketEvent(command);
    try {
      if (mapped === 'acceptRootDelivery') {
        const res = await taskEvents().acceptRootDelivery({
          taskId: item.taskId,
          expectedTaskRevision: Number(prepared.payload.expectedTaskRevision ?? item.taskRevision ?? 0),
          ...(typeof prepared.payload.deliveryMessageId === 'string'
            ? { deliveryMessageId: prepared.payload.deliveryMessageId }
            : {}),
        });
        if (!res.ok) setActionError(res.error ?? 'accept 失败');
      } else if (mapped === 'rejectRootDelivery') {
        const res = await taskEvents().rejectRootDelivery({
          taskId: item.taskId,
          reason: String(prepared.payload.reason ?? '审查退回'),
          expectedTaskRevision: Number(prepared.payload.expectedTaskRevision ?? item.taskRevision ?? 0),
        });
        if (!res.ok) setActionError(res.error ?? 'reject 失败');
      } else if (mapped === 'cancel') {
        const res = await taskEvents().cancel(item.taskId, String(prepared.payload.reason ?? '用户取消'));
        if (!res.ok) setActionError(res.error ?? 'cancel 失败');
      } else if (mapped === 'close') {
        const res = await taskEvents().close(item.taskId, String(prepared.payload.reason ?? '管理员关闭'));
        if (!res.ok) setActionError(res.error ?? 'close 失败');
      } else if (command === 'retry-attempt') {
        // #1014 remediation 具名 command
        if (!item.confirmationToken) {
          setActionError('缺少 confirmationToken，无法 retry');
        } else {
          const res = await taskRemediationEvents().command({
            envelope: {
              schemaVersion: 1,
              commandName: 'retry-attempt',
              commandSchemaVersion: 1,
              idempotencyKey: `retry:${item.attentionIdentity}:${item.revision}:${Date.now()}`,
            },
            payload: {
              taskId: item.taskId,
              expectedTaskRevision: item.taskRevision ?? 0,
              actionRequiredId: item.attentionIdentity,
              confirmationToken: item.confirmationToken,
              expectedEscalationRevision: item.escalationRevision ?? item.revision,
            },
            userId: props.userId,
            teamId: props.teamId,
          }) as { ok?: boolean; error?: string; response?: { outcome?: string; rejectReason?: string } };
          if (!res?.ok) {
            setActionError(res?.error ?? 'retry 失败');
          } else if (res.response?.outcome === 'rejected') {
            setActionError(res.response.rejectReason ?? 'retry 被拒绝');
          }
        }
      } else {
        setActionError(`未接线的具名 command: ${command}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败');
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
      {actionError ? (
        <div className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700" data-testid="task-system-activity-action-error">
          {actionError}
        </div>
      ) : null}
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
          const prepared = prepareNamedAction({ command, taskId: item.taskId, attention: item });
          const mapped = mapReviewCommandToTaskSocketEvent(command);
          if (mapped === 'acceptRootDelivery') {
            await taskEvents().acceptRootDelivery({
              taskId: item.taskId,
              expectedTaskRevision: Number(prepared.payload.expectedTaskRevision ?? item.taskRevision ?? 0),
            });
          } else if (mapped === 'rejectRootDelivery') {
            await taskEvents().rejectRootDelivery({
              taskId: item.taskId,
              reason: String(prepared.payload.reason ?? '审查退回'),
              expectedTaskRevision: Number(prepared.payload.expectedTaskRevision ?? item.taskRevision ?? 0),
            });
          } else if (mapped === 'cancel') {
            await taskEvents().cancel(item.taskId, String(prepared.payload.reason ?? '用户取消'));
          } else if (mapped === 'close') {
            await taskEvents().close(item.taskId, String(prepared.payload.reason ?? '管理员关闭'));
          } else if (command === 'retry-attempt' && item.confirmationToken) {
            await taskRemediationEvents().command({
              envelope: {
                schemaVersion: 1,
                commandName: 'retry-attempt',
                commandSchemaVersion: 1,
                idempotencyKey: `retry:${item.attentionIdentity}:${item.revision}:${Date.now()}`,
              },
              payload: {
                taskId: item.taskId,
                expectedTaskRevision: item.taskRevision ?? 0,
                actionRequiredId: item.attentionIdentity,
                confirmationToken: item.confirmationToken,
                expectedEscalationRevision: item.escalationRevision ?? item.revision,
              },
              userId: props.userId,
              teamId: props.teamId,
            });
          }
          void refresh();
        }}
      />
    </div>
  );
}
