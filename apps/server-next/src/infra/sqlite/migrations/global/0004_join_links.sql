-- Regression migration: join_links 表曾被后加进 0001_first_slice.sql，
-- 但部分生产数据库在 join_links 加入之前就已经应用过 0001（schema_migrations
-- 已记录 global/0001_first_slice.sql 完成），导致这些库缺少 join_links 表，
-- join:create / join:list 因此抛 "no such table: join_links" → INTERNAL_ERROR。
-- 本迁移以独立、幂等方式补建该表，对已有该表的库安全（IF NOT EXISTS）。
CREATE TABLE IF NOT EXISTS join_links (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_join_links_team ON join_links(team_id);
