import { COMPLETION_NOTIFICATION_PAGE_SIZE, type CompletionNotificationDto } from '../../../../../packages/contracts/src/completion-notification.js';
import type { CompletionNotificationRepository, CompletionSource } from '../../application/completion-notification-repository.js';
import type { SqliteDatabase } from './repositories.js';
import type { BrowserPushSubscription, PushDelivery } from '../../application/push-notification-repository.js';

export function createSqliteCompletionNotifications(db: SqliteDatabase): CompletionNotificationRepository {
  return {
    async getPushSubscription(id) {
      const row = db.prepare('SELECT payload_json FROM browser_push_subscriptions WHERE id=?').get(id) as { payload_json: string } | undefined;
      return row ? JSON.parse(row.payload_json) as BrowserPushSubscription : null;
    },
    async savePushSubscription(subscription) {
      const result = db.prepare('INSERT INTO browser_push_subscriptions(id,user_id,payload_json,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at WHERE user_id=excluded.user_id')
        .run(subscription.id, subscription.userId, JSON.stringify(subscription), subscription.createdAt, subscription.expiresAt) as { changes: number };
      return result.changes > 0;
    },
    async deletePushSubscription(id, userId) {
      db.prepare('DELETE FROM browser_push_subscriptions WHERE id=? AND user_id=?').run(id, userId);
    },
    async countPushSubscriptions(userId) {
      return (db.prepare('SELECT COUNT(*) AS count FROM browser_push_subscriptions WHERE user_id=?').get(userId) as { count: number }).count;
    },
    async prunePushSubscriptions(userId, now) {
      db.prepare('DELETE FROM browser_push_subscriptions WHERE user_id=? AND expires_at<=?').run(userId, now);
    },
    async claimPush(now, limit) {
      const rows = db.prepare(`SELECT n.payload_json AS notification_json, s.payload_json AS subscription_json,
        COALESCE(d.attempts,0)+1 AS attempts
        FROM completion_notifications n JOIN browser_push_subscriptions s ON s.user_id=n.recipient_id
        LEFT JOIN browser_push_deliveries d ON d.notification_id=n.id AND d.subscription_id=s.id
        WHERE n.read_at IS NULL AND n.created_at>=s.created_at AND n.created_at>=?
          AND s.expires_at>? AND COALESCE(d.finished,0)=0 AND COALESCE(d.attempts,0)<5 AND COALESCE(d.next_attempt_at,0)<=?
        ORDER BY n.created_at,n.id,s.id LIMIT ?`).all(now - 86400_000, now, now, limit) as {
          notification_json: string; subscription_json: string; attempts: number;
        }[];
      return rows.map((row): PushDelivery => {
        const notification = JSON.parse(row.notification_json) as CompletionNotificationDto;
        const subscription = JSON.parse(row.subscription_json) as BrowserPushSubscription;
        db.prepare('INSERT INTO browser_push_deliveries(notification_id,subscription_id,attempts,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT(notification_id,subscription_id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at')
          .run(notification.id, subscription.id, row.attempts, now + 60_000);
        return { notification, subscription, attempts: row.attempts };
      });
    },
    async finishPush(notificationId, subscriptionId, retryAt) {
      db.prepare('UPDATE browser_push_deliveries SET finished=?,next_attempt_at=? WHERE notification_id=? AND subscription_id=?')
        .run(retryAt === null ? 1 : 0, retryAt ?? 0, notificationId, subscriptionId);
    },
    async enqueue(source) {
      db.prepare('INSERT OR IGNORE INTO completion_notification_sources(id,team_id,task_id,dispatch_id,revision,created_at,retry_at) VALUES(?,?,?,?,?,?,?)')
        .run(source.id, source.teamId, source.taskId, source.dispatchId, source.revision, source.createdAt, source.retryAt);
    },
    async pending(now, limit) {
      return db.prepare('SELECT id,team_id AS teamId,task_id AS taskId,dispatch_id AS dispatchId,revision,created_at AS createdAt,retry_at AS retryAt FROM completion_notification_sources WHERE processed=0 AND retry_at<=? ORDER BY created_at,id LIMIT ?')
        .all(now, limit) as CompletionSource[];
    },
    async defer(id, retryAt) {
      db.prepare('UPDATE completion_notification_sources SET retry_at=? WHERE id=? AND processed=0').run(retryAt, id);
    },
    async complete(id, items) {
      db.exec('SAVEPOINT completion_notification_projection');
      try {
        for (const item of items) {
          db.prepare('INSERT OR IGNORE INTO completion_notifications(id,team_id,recipient_id,payload_json,created_at,read_at) VALUES(?,?,?,?,?,?)')
            .run(item.id, item.teamId, item.recipientId, JSON.stringify(item), item.createdAt, item.readAt);
        }
        db.prepare('UPDATE completion_notification_sources SET processed=1 WHERE id=?').run(id);
        db.exec('RELEASE completion_notification_projection');
      } catch (error) {
        db.exec('ROLLBACK TO completion_notification_projection');
        db.exec('RELEASE completion_notification_projection');
        throw error;
      }
    },
    async list(teamId, recipientId, cursor) {
      const rows = db.prepare(`SELECT payload_json,read_at FROM completion_notifications WHERE team_id=? AND recipient_id=?
        ${cursor ? 'AND (created_at<? OR (created_at=? AND id>?))' : ''}
        ORDER BY created_at DESC,id LIMIT ?`)
        .all(teamId, recipientId, ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), COMPLETION_NOTIFICATION_PAGE_SIZE + 1) as { payload_json: string; read_at: number | null }[];
      return rows.map((row) => ({ ...JSON.parse(row.payload_json) as CompletionNotificationDto, readAt: row.read_at }));
    },
    async get(teamId, recipientId, id) {
      const row = db.prepare('SELECT payload_json,read_at FROM completion_notifications WHERE id=? AND team_id=? AND recipient_id=?')
        .get(id, teamId, recipientId) as { payload_json: string; read_at: number | null } | undefined;
      return row ? { ...JSON.parse(row.payload_json) as CompletionNotificationDto, readAt: row.read_at } : null;
    },
    async unreadScopes(teamId, recipientId) {
      return db.prepare(`SELECT json_extract(payload_json,'$.channelId') AS channelId,
        json_extract(payload_json,'$.taskId') AS taskId, COUNT(*) AS count FROM completion_notifications
        WHERE team_id=? AND recipient_id=? AND read_at IS NULL GROUP BY channelId,taskId`)
        .all(teamId, recipientId) as Array<{ channelId?: string; taskId?: string; count: number }>;
    },
    async pruneRead(teamId, recipientId, now) {
      db.prepare(`DELETE FROM completion_notifications WHERE team_id=? AND recipient_id=? AND read_at IS NOT NULL
        AND (read_at<? OR id IN (SELECT id FROM completion_notifications WHERE team_id=? AND recipient_id=? AND read_at IS NOT NULL
          ORDER BY read_at DESC,id LIMIT -1 OFFSET 100))`)
        .run(teamId, recipientId, now - 30 * 86400_000, teamId, recipientId);
    },
    async markRead(teamId, recipientId, id, now) {
      const result = db.prepare('UPDATE completion_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND team_id=? AND recipient_id=?')
        .run(now, id, teamId, recipientId) as { changes: number };
      return result.changes > 0;
    },
  };
}
