-- #967 Workspace 大文件暂存：以稳定 publish identity 支持续传、幂等结果查询与超时清理。
-- 暂存内容在 commit 前不进入 artifacts / workspace revision / 频道文件索引。

CREATE TABLE IF NOT EXISTS workspace_publish_stagings (
  publish_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  baseline_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'committed', 'failed')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  committed_revision_id TEXT,
  committed_workspace_id TEXT,
  provenance_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_publish_stagings_channel_status
  ON workspace_publish_stagings(team_id, channel_id, status, created_at);

CREATE TABLE IF NOT EXISTS workspace_publish_staging_files (
  publish_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  PRIMARY KEY (publish_id, path),
  FOREIGN KEY (publish_id) REFERENCES workspace_publish_stagings(publish_id) ON DELETE CASCADE
);
