-- issue #723：channel_experience_attachments 三态生命周期（pending → attached → revoked）。
-- 存量行默认 'attached'（向后兼容 #722 已创建的关联）。
-- 新列 recommended_by_user_id / recommended_at 替换旧的 attached_by_user_id / attached_at 语义。

ALTER TABLE channel_experience_attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'attached'
  CHECK (status IN ('pending', 'attached', 'revoked'));
ALTER TABLE channel_experience_attachments ADD COLUMN recommended_by_user_id TEXT;
ALTER TABLE channel_experience_attachments ADD COLUMN recommended_at INTEGER;
ALTER TABLE channel_experience_attachments ADD COLUMN confirmed_by_user_id TEXT;
ALTER TABLE channel_experience_attachments ADD COLUMN confirmed_at INTEGER;
ALTER TABLE channel_experience_attachments ADD COLUMN revoked_by_user_id TEXT;
ALTER TABLE channel_experience_attachments ADD COLUMN revoked_at INTEGER;
