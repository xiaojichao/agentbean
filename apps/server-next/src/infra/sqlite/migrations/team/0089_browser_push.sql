CREATE TABLE browser_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_browser_push_user ON browser_push_subscriptions(user_id, expires_at);
CREATE TABLE browser_push_deliveries (
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(notification_id, subscription_id)
);
