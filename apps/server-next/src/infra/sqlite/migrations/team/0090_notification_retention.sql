CREATE INDEX idx_completion_notifications_page ON completion_notifications(team_id, recipient_id, created_at DESC, id);
CREATE INDEX idx_completion_notifications_read ON completion_notifications(team_id, recipient_id, read_at DESC, id) WHERE read_at IS NOT NULL;
CREATE INDEX idx_completion_notifications_unread ON completion_notifications(team_id, recipient_id) WHERE read_at IS NULL;
CREATE INDEX idx_browser_push_deliveries_subscription ON browser_push_deliveries(subscription_id);

-- 投递记录与投影/订阅一起删除；保留来源去重记录，避免重放已清理提醒。
CREATE TRIGGER cleanup_push_subscription_deliveries AFTER DELETE ON browser_push_subscriptions
BEGIN
  DELETE FROM browser_push_deliveries WHERE subscription_id=OLD.id;
END;
CREATE TRIGGER cleanup_notification_push_deliveries AFTER DELETE ON completion_notifications
BEGIN
  DELETE FROM browser_push_deliveries WHERE notification_id=OLD.id;
END;
DELETE FROM browser_push_deliveries WHERE subscription_id NOT IN (SELECT id FROM browser_push_subscriptions)
  OR notification_id NOT IN (SELECT id FROM completion_notifications);
