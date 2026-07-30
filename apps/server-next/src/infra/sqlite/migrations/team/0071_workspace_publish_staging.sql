-- #967 Workspace 大文件暂存：以稳定 publish identity 支持续传、幂等结果查询与超时清理。
-- 暂存内容在 commit 前不进入 artifacts / workspace revision / 频道文件索引。
-- publish identity 以 (team_id, publish_id) 为作用域，避免跨租户互斥。

CREATE TABLE IF NOT EXISTS workspace_publish_stagings (
  team_id TEXT NOT NULL,
  publish_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  baseline_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'failed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_revision_id TEXT,
  committed_workspace_id TEXT,
  provenance_json TEXT,
  PRIMARY KEY (team_id, publish_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_publish_stagings_channel_status
  ON workspace_publish_stagings(team_id, channel_id, status, created_at);

CREATE TABLE IF NOT EXISTS workspace_publish_staging_files (
  team_id TEXT NOT NULL,
  publish_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  PRIMARY KEY (team_id, publish_id, path),
  FOREIGN KEY (team_id, publish_id) REFERENCES workspace_publish_stagings(team_id, publish_id) ON DELETE CASCADE
);
