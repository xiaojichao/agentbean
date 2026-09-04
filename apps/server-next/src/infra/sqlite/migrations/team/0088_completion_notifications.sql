CREATE TABLE completion_notification_sources (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT,
  dispatch_id TEXT,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_completion_sources_pending ON completion_notification_sources(processed, retry_at, created_at);

CREATE TABLE completion_notifications (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_completion_notifications_recipient ON completion_notifications(team_id, recipient_id, created_at);

-- A durable source is part of the same SQL statement/outer domain transaction.
-- It is only a wake-up candidate: the consumer rechecks root/revision/access.
CREATE TRIGGER task_completion_notification_source AFTER UPDATE OF status ON tasks
WHEN NEW.status = 'in_review' AND OLD.status <> 'in_review' AND NEW.superseded_by_revision IS NULL
BEGIN
  INSERT OR IGNORE INTO completion_notification_sources(id, team_id, task_id, revision, created_at)
  VALUES ('task:' || NEW.id || ':' || NEW.revision || ':' || NEW.updated_at,
          NEW.team_id, NEW.id, NEW.revision, NEW.updated_at);
END;

-- Only final, committed direct replies carry this marker. Streaming/progress
-- messages and succeeded dispatches without a committed result cannot notify.
CREATE TRIGGER request_completion_notification_source AFTER UPDATE OF meta_json ON messages
WHEN json_extract(NEW.meta_json, '$.completionNotificationReady') = 1
 AND COALESCE(json_extract(OLD.meta_json, '$.completionNotificationReady'), 0) <> 1
BEGIN
  INSERT OR IGNORE INTO completion_notification_sources(id, team_id, dispatch_id, revision, created_at)
  VALUES ('dispatch:' || json_extract(NEW.meta_json, '$.dispatchId'), NEW.team_id,
          json_extract(NEW.meta_json, '$.dispatchId'), 1, NEW.created_at);
END;
