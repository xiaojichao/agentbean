import type { CompletionNotificationDto } from '../../../../packages/contracts/src/completion-notification.js';

export interface BrowserPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  expiresAt: number;
}
export interface PushDelivery {
  subscription: BrowserPushSubscription;
  notification: CompletionNotificationDto;
  attempts: number;
}
export interface PushNotificationRepository {
  getPushSubscription(id: string): Promise<BrowserPushSubscription | null>;
  savePushSubscription(subscription: BrowserPushSubscription): Promise<boolean>;
  deletePushSubscription(id: string, userId: string): Promise<void>;
  countPushSubscriptions(userId: string): Promise<number>;
  /** Reserve a bounded batch for 60s before network I/O; callers own the DB transaction. */
  claimPush(now: number, limit: number): Promise<PushDelivery[]>;
  finishPush(notificationId: string, subscriptionId: string, retryAt: number | null): Promise<void>;
}
