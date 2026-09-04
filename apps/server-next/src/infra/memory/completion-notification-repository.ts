import { COMPLETION_NOTIFICATION_PAGE_SIZE, type CompletionNotificationDto } from '../../../../../packages/contracts/src/completion-notification.js';
import type { CompletionSource, CompletionNotificationRepository } from '../../application/completion-notification-repository.js';
import type { BrowserPushSubscription, PushDelivery } from '../../application/push-notification-repository.js';

export function createMemoryCompletionNotifications() {
  const sources = new Map<string, CompletionSource>();
  const completed = new Set<string>();
  const items = new Map<string, CompletionNotificationDto>();
  const subscriptions = new Map<string, BrowserPushSubscription>();
  const deliveries = new Map<string, { attempts: number; retryAt: number | null }>();
  const deleteDeliveries = (id: string, part: number) => {
    for (const key of deliveries.keys()) if (JSON.parse(key)[part] === id) deliveries.delete(key);
  };
  const repository: CompletionNotificationRepository = {
    async getPushSubscription(id) { return subscriptions.get(id) ?? null; },
    async savePushSubscription(subscription) {
      const previous = subscriptions.get(subscription.id);
      if (previous && previous.userId !== subscription.userId) return false;
      subscriptions.set(subscription.id, subscription);
      return true;
    },
    async deletePushSubscription(id, userId) {
      if (subscriptions.get(id)?.userId === userId) {
        subscriptions.delete(id); deleteDeliveries(id, 1);
      }
    },
    async countPushSubscriptions(userId) { return [...subscriptions.values()].filter((s) => s.userId === userId).length; },
    async prunePushSubscriptions(userId, now) {
      for (const sub of subscriptions.values()) if (sub.userId === userId && sub.expiresAt <= now) {
        subscriptions.delete(sub.id); deleteDeliveries(sub.id, 1);
      }
    },
    async claimPush(now, limit) {
      const result: PushDelivery[] = [];
      for (const notification of [...items.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (notification.readAt !== null || notification.createdAt < now - 86400_000) continue;
        for (const subscription of subscriptions.values()) {
          if (subscription.userId !== notification.recipientId || subscription.expiresAt <= now || notification.createdAt < subscription.createdAt) continue;
          const key = JSON.stringify([notification.id, subscription.id]);
          const previous = deliveries.get(key);
          if (previous && (previous.retryAt === null || previous.retryAt > now || previous.attempts >= 5)) continue;
          const attempts = (previous?.attempts ?? 0) + 1;
          deliveries.set(key, { attempts, retryAt: now + 60_000 });
          result.push({ subscription, notification, attempts });
          if (result.length >= limit) return result;
        }
      }
      return result;
    },
    async finishPush(notificationId, subscriptionId, retryAt) {
      const key = JSON.stringify([notificationId, subscriptionId]);
      const previous = deliveries.get(key);
      if (previous) deliveries.set(key, { ...previous, retryAt });
    },
    async enqueue(source) {
      if (!completed.has(source.id) && !sources.has(source.id)) sources.set(source.id, source);
    },
    async pending(now, limit) {
      return [...sources.values()].filter((source) => source.retryAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, limit);
    },
    async defer(id, retryAt) {
      const source = sources.get(id);
      if (source) sources.set(id, { ...source, retryAt });
    },
    async complete(id, notifications) {
      if (completed.has(id)) return;
      for (const item of notifications) if (!items.has(item.id)) items.set(item.id, item);
      completed.add(id);
      sources.delete(id);
    },
    async list(teamId, recipientId, cursor) {
      return [...items.values()].filter((item) => item.teamId === teamId && item.recipientId === recipientId)
        .filter((item) => !cursor || item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id > cursor.id))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, COMPLETION_NOTIFICATION_PAGE_SIZE + 1);
    },
    async get(teamId, recipientId, id) {
      const item = items.get(id);
      return item?.teamId === teamId && item.recipientId === recipientId ? item : null;
    },
    async unreadScopes(teamId, recipientId) {
      const groups = new Map<string, { channelId?: string; taskId?: string; count: number }>();
      for (const item of items.values()) {
        if (item.teamId !== teamId || item.recipientId !== recipientId || item.readAt !== null) continue;
        const key = JSON.stringify([item.channelId ?? null, item.taskId ?? null]);
        const group = groups.get(key) ?? { channelId: item.channelId, taskId: item.taskId, count: 0 };
        group.count++; groups.set(key, group);
      }
      return [...groups.values()];
    },
    async pruneRead(teamId, recipientId, now) {
      const read = [...items.values()].filter((item) => item.teamId === teamId && item.recipientId === recipientId && item.readAt !== null)
        .sort((a, b) => b.readAt! - a.readAt! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      read.forEach((item, index) => {
        if (index >= 100 || item.readAt! < now - 30 * 86400_000) {
          items.delete(item.id); deleteDeliveries(item.id, 0);
        }
      });
    },
    async markRead(teamId, recipientId, id, now) {
      const item = items.get(id);
      if (!item || item.teamId !== teamId || item.recipientId !== recipientId) return false;
      items.set(id, { ...item, readAt: item.readAt ?? now });
      return true;
    },
  };
  return {
    repository,
    snapshot: () => ({ sources: new Map(sources), completed: new Set(completed), items: new Map(items), subscriptions: new Map(subscriptions), deliveries: new Map(deliveries) }),
    restore(snapshot: { sources: Map<string, CompletionSource>; completed: Set<string>; items: Map<string, CompletionNotificationDto>;
      subscriptions: Map<string, BrowserPushSubscription>; deliveries: Map<string, { attempts: number; retryAt: number | null }> }) {
      sources.clear(); snapshot.sources.forEach((value, key) => sources.set(key, value));
      completed.clear(); snapshot.completed.forEach((value) => completed.add(value));
      items.clear(); snapshot.items.forEach((value, key) => items.set(key, value));
      subscriptions.clear(); snapshot.subscriptions.forEach((value, key) => subscriptions.set(key, value));
      deliveries.clear(); snapshot.deliveries.forEach((value, key) => deliveries.set(key, value));
    },
  };
}
