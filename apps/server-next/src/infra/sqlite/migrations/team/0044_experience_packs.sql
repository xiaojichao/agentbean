-- issue #722 Reusable Experience Pack：新建 experience_packs、experience_pack_sources
-- 和 channel_experience_attachments 三张表（§6.5）。
-- Pack 不是单条 Memory（ADR 0047）；生命周期 draft→approved→source_invalid|withdrawn。

CREATE TABLE experience_packs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'source_invalid', 'withdrawn')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT,
  source_channel_id TEXT NOT NULL,
  applicability_conditions TEXT,
  exclusion_conditions TEXT,
  conclusions TEXT,
  limitations TEXT,
  approved_by_user_id TEXT,
  created_by_user_id TEXT,
  source_invalid_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX experience_packs_team_status_idx
  ON experience_packs(team_id, status, updated_at DESC);

-- 来源快照（AC#2）：冻结提出时依赖的频道消息/任务等来源。
CREATE TABLE experience_pack_sources (
  pack_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'task', 'artifact', 'workspace-run', 'invocation', 'memory', 'manual'
  )),
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) > 0),
  source_scope_type TEXT NOT NULL,
  source_scope_ref TEXT NOT NULL CHECK (length(source_scope_ref) > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, source_kind, source_id),
  FOREIGN KEY (pack_id, team_id)
    REFERENCES experience_packs(id, team_id) ON DELETE CASCADE
);

CREATE INDEX experience_pack_sources_pack_idx
  ON experience_pack_sources(team_id, pack_id);

-- 频道关联（ADR 0006 第二次确认）：Pack 被批准后可关联到目标频道。
CREATE TABLE channel_experience_attachments (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  attached_by_user_id TEXT NOT NULL,
  attached_at INTEGER NOT NULL,
  FOREIGN KEY (pack_id, team_id)
    REFERENCES experience_packs(id, team_id) ON DELETE CASCADE,
  UNIQUE (pack_id, channel_id)
);

CREATE INDEX channel_experience_attachments_channel_idx
  ON channel_experience_attachments(team_id, channel_id);
