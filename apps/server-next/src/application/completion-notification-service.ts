import { COMPLETION_NOTIFICATION_PAGE_SIZE, type CompletionNotificationCursor, type CompletionNotificationDto, type CompletionNotificationWake } from '../../../../packages/contracts/src/completion-notification.js';
import type { ServerNextRepositories } from './repositories.js';
import type { CompletionSource } from './completion-notification-repository.js';
import { ensureUserCanViewChannel } from './channel-access.js';
import type { TaskCoordinationTransactionRepositories } from './task-coordination-unit-of-work.js';

/** Owns recipient selection, replay, and access checks; transport only sends a wake. */
export function createCompletionNotificationService(repositories: ServerNextRepositories, now: () => number) {
  const store = repositories.completionNotifications;
  let processing: Promise<CompletionNotificationWake[]> | null = null;

  async function canRead(item: Pick<CompletionNotificationDto, 'teamId' | 'recipientId' | 'channelId' | 'taskId'>) {
    if (!await repositories.teams.isMember(item.teamId, item.recipientId)) return false;
    if (item.channelId && !(await ensureUserCanViewChannel(repositories, {
      teamId: item.teamId, userId: item.recipientId, channelId: item.channelId,
    })).ok) return false;
    if (item.taskId) {
      const task = await repositories.tasks.getById(item.taskId);
      if (!task || task.teamId !== item.teamId) return false;
      if (task.channelId && !(await ensureUserCanViewChannel(repositories, {
        teamId: item.teamId, userId: item.recipientId, channelId: task.channelId,
      })).ok) return false;
    }
    return true;
  }

  async function project(source: CompletionSource, transaction: TaskCoordinationTransactionRepositories): Promise<CompletionNotificationDto[]> {
    if (source.taskId) {
      const task = await repositories.tasks.getById(source.taskId);
      if (!task || task.teamId !== source.teamId || task.revision !== source.revision
        || task.status !== 'in_review') return [];
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      // Internal deliveries are aggregated by the root. Do not notify on every worker.
      if (coordination?.nodeKind === 'subtask') return [];
      const run = await repositories.management.runs.getByRootTaskId(task.id);
      const requester = run?.initiatedByUserId ?? task.creatorId;
      const recipients = [...new Set([requester, ...(coordination?.humanAcceptanceAuthorityIds ?? [])])];
      const notifications: CompletionNotificationDto[] = [];
      for (const recipientId of recipients) {
        const item: CompletionNotificationDto = {
          id: source.id + ':' + recipientId, teamId: task.teamId, recipientId,
          kind: 'delivery_ready', title: task.title.slice(0, 160) + '已交付，待验收',
          taskId: task.id, ...(task.channelId ? { channelId: task.channelId } : {}),
          threadId: run?.rootMessageId ?? task.id,
          createdAt: source.createdAt, readAt: null,
        };
        if (await canRead(item)) notifications.push(item);
      }
      return notifications;
    }
    if (!source.dispatchId) return [];
    const dispatch = await repositories.dispatches.getById(source.dispatchId);
    if (!dispatch || dispatch.teamId !== source.teamId || dispatch.status !== 'succeeded') return [];
    if (await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id)) return [];
    if (await transaction.promotion.handoffs.getBySourceDispatchId(dispatch.id)) return [];
    const origin = await repositories.messages.getById(dispatch.messageId);
    if (!origin || origin.senderKind !== 'human' || origin.teamId !== source.teamId) return [];
    // A tracked direct task has its own delivery notification.
    if (typeof origin.meta?.taskId === 'string') return [];
    const reply = (await repositories.messages.listByDispatch(dispatch.id))
      .find((message) => message.senderKind === 'agent' && message.senderId === dispatch.agentId
        && message.meta?.completionNotificationReady === true);
    if (!reply) throw new Error('COMPLETION_RESULT_NOT_READY');
    const agent = await repositories.agents.getById(dispatch.agentId);
    const item: CompletionNotificationDto = {
      id: source.id + ':' + origin.senderId, teamId: source.teamId, recipientId: origin.senderId,
      kind: 'request_completed', title: (agent?.name ?? 'Agent') + '已完成：' + origin.body.slice(0, 120),
      channelId: dispatch.channelId, threadId: origin.threadId ?? origin.id, messageId: reply.id,
      createdAt: source.createdAt, readAt: null,
    };
    return await canRead(item) ? [item] : [];
  }

  async function get(input: { teamId: string; userId: string; id: string }) {
    if (typeof input.id !== 'string' || !input.id || input.id.length > 1024) return null;
    const item = await store.get(input.teamId, input.userId, input.id);
    return item && await canRead(item) ? item : null;
  }

  return {
    get,
    process(): Promise<CompletionNotificationWake[]> {
      if (processing) return processing;
      processing = repositories.taskCoordinationUnitOfWork.run(async (transaction) => {
        const wakes = new Map<string, CompletionNotificationWake>();
        for (const source of await store.pending(now(), 100)) {
          try {
            const items = await project(source, transaction);
            await store.complete(source.id, items);
            for (const item of items) wakes.set(item.teamId + ':' + item.recipientId, {
              teamId: item.teamId, recipientId: item.recipientId,
            });
          } catch (error) {
            // A single bad source must not starve newer completions.
            await store.defer(source.id, now() + 5_000);
            console.warn('[completion-notifications] projection deferred', source.id,
              error instanceof Error ? error.message : 'UNKNOWN');
          }
        }
        return [...wakes.values()];
      }).finally(() => { processing = null; });
      return processing;
    },
    async list(input: { teamId: string; userId: string; cursor?: CompletionNotificationCursor }) {
      if (!await repositories.teams.isMember(input.teamId, input.userId)) return { ok: false as const, error: 'FORBIDDEN' };
      const cursor = input.cursor;
      if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor.createdAt)
        || cursor.createdAt < 0 || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 1024)) {
        return { ok: false as const, error: 'INVALID_CURSOR' };
      }
      await store.pruneRead(input.teamId, input.userId, now());
      const rows = await store.list(input.teamId, input.userId, cursor);
      const hasMore = rows.length > COMPLETION_NOTIFICATION_PAGE_SIZE;
      const page = rows.slice(0, COMPLETION_NOTIFICATION_PAGE_SIZE);
      const last = page.at(-1);
      // 按权限范围聚合未读数，同一频道/任务只校验一次，不加载历史正文。
      const access = new Map<string, Promise<boolean>>();
      const visible = (row: { channelId?: string; taskId?: string }) => {
        const key = JSON.stringify([row.channelId ?? null, row.taskId ?? null]);
        if (!access.has(key)) access.set(key, canRead({ ...row, teamId: input.teamId, recipientId: input.userId }));
        return access.get(key)!;
      };
      const items: CompletionNotificationDto[] = [];
      for (const row of page) if (await visible(row)) items.push(row);
      let unreadCount = 0;
      for (const group of await store.unreadScopes(input.teamId, input.userId)) if (await visible(group)) unreadCount += group.count;
      return { ok: true as const, items, unreadCount,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null };
    },
    async markRead(input: { teamId: string; userId: string; id: string }) {
      if (typeof input.id !== 'string' || !input.id) return { ok: false as const, error: 'INVALID_NOTIFICATION' };
      const item = await get(input);
      if (!item) return { ok: false as const, error: 'NOT_FOUND' };
      await store.markRead(input.teamId, input.userId, input.id, now());
      await store.pruneRead(input.teamId, input.userId, now());
      return { ok: true as const };
    },
  };
}
