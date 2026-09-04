import type { ServerNextRepositories } from './repositories.js';
import type { WebPushSender } from '../infra/web-push.js';
import { parseBrowserSubscription, pushSubscriptionId } from '../infra/web-push.js';
import { completionNotificationPath } from '../../../../packages/contracts/src/completion-notification.js';
import { createCompletionNotificationService } from './completion-notification-service.js';

export function createPushNotificationService(repositories: ServerNextRepositories, now: () => number, sender?: WebPushSender) {
  const store = repositories.completionNotifications;
  const notifications = createCompletionNotificationService(repositories, now);
  let processing: Promise<void> | null = null;
  return {
    config() { return Promise.resolve({ ok: true as const, publicKey: sender?.publicKey ?? null }); },
    async subscribe(input: { userId: string; subscription: unknown }) {
      if (!sender) return { ok: false, error: 'PUSH_NOT_CONFIGURED' };
      if (!await repositories.users.getById(input.userId)) return { ok: false, error: 'FORBIDDEN' };
      const subscription = parseBrowserSubscription(input.subscription);
      if (!subscription || (subscription.expirationTime != null && subscription.expirationTime <= now())) return { ok: false, error: 'INVALID_PUSH_SUBSCRIPTION' };
      return repositories.taskCoordinationUnitOfWork.run(async () => {
        const id = pushSubscriptionId(subscription.endpoint);
        const existing = await store.getPushSubscription(id);
        if (existing && existing.userId !== input.userId) return { ok: false, error: 'SUBSCRIPTION_OWNED' };
        if (!existing && await store.countPushSubscriptions(input.userId) >= 20) return { ok: false, error: 'SUBSCRIPTION_LIMIT' };
        const saved = await store.savePushSubscription({
          id, userId: input.userId, endpoint: subscription.endpoint, keys: subscription.keys,
          createdAt: existing?.createdAt ?? now(),
          expiresAt: Math.min(subscription.expirationTime ?? Infinity, now() + 30 * 86400_000),
        });
        return { ok: saved };
      });
    },
    async unsubscribe(input: { userId: string; endpoint: unknown }) {
      if (typeof input.endpoint !== 'string' || input.endpoint.length > 4096) return { ok: false, error: 'INVALID_PUSH_SUBSCRIPTION' };
      await store.deletePushSubscription(pushSubscriptionId(input.endpoint), input.userId);
      return { ok: true };
    },
    process(): Promise<void> {
      if (!sender) return Promise.resolve();
      if (processing) return processing;
      processing = (async () => {
        const deliveries = await repositories.taskCoordinationUnitOfWork.run(() => store.claimPush(now(), 10));
        await Promise.all(deliveries.map(async ({ subscription, notification, attempts }) => {
          try {
            const current = await store.getPushSubscription(subscription.id);
            const visible = await notifications.list({ userId: subscription.userId, teamId: notification.teamId });
            const item = visible.ok ? visible.items.find((item) => item.id === notification.id && item.readAt === null) : null;
            const team = item && await repositories.teams.getById(item.teamId);
            if (!current || current.userId !== subscription.userId || current.expiresAt <= now() || !item || !team
              || !await repositories.users.getById(subscription.userId)) {
              await store.finishPush(notification.id, subscription.id, null);
              return;
            }
            const path = completionNotificationPath(team.path, item);
            const url = path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ notice: item.id, noticeTeam: item.teamId });
            await sender.send(current, { id: item.id, recipientId: item.recipientId, url });
            await store.finishPush(item.id, current.id, null);
          } catch (error) {
            const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 0;
            if (status === 404 || status === 410) {
              await store.deletePushSubscription(subscription.id, subscription.userId);
            }
            const permanent = status === 400 || status === 401 || status === 403 || status === 404 || status === 410 || status === 413;
            await store.finishPush(notification.id, subscription.id,
              permanent || attempts >= 5 ? null : now() + Math.min(300_000, 5_000 * 2 ** (attempts - 1)));
            // Do not log endpoints, credentials, task text, or provider response bodies.
            console.warn('[web-push] delivery failed', status || 'NETWORK', 'attempt', attempts);
          }
        }));
      })().finally(() => { processing = null; });
      return processing;
    },
  };
}
