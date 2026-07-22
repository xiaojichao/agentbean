-- #709 Task 不可变 revision：重建 tasks 表，PK 从单列 (id) 改为复合 (id, team_id, revision)，
-- 允许同 id 不同 revision 的多行共存（append-only）。目标/范围/验收的重大变化创建新 revision 行，
-- 旧行标记 superseded 保留历史（AC4）；旧 Claim/Invocation/delivery/acceptance 因复合外键锚定
-- 旧 revision 自动 stale 为历史证据（AC5）。
--
-- 复用 0021/0028 重建惯例（disableForeignKeys）：SQLite 不能 ALTER 改 PK，故 create-new+copy+drop+rename。
-- 唯一子表 FK task_coordinations(task_id,team_id,task_revision)→tasks(id,team_id,revision) 由新复合 PK
-- 满足 UNIQUE；DEFERRABLE + FK off 期间重建无虞，重建后 FK 自动重新指向新 tasks 表。
-- getById/list/update 仅取 superseded_by_revision IS NULL 的当前行 → 下游调用点无需改。

CREATE TABLE tasks_new (
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  assignee_id TEXT,
  channel_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  superseded_by_revision INTEGER,
  superseded_at INTEGER,
  superseded_reason_code TEXT,
  PRIMARY KEY (id, team_id, revision),
  CHECK (superseded_by_revision IS NULL OR superseded_by_revision > revision)
);

INSERT INTO tasks_new (
  id, team_id, title, description, status, creator_id, assignee_id, channel_id,
  tags_json, sort_order, created_at, updated_at, revision,
  superseded_by_revision, superseded_at, superseded_reason_code
)
SELECT id, team_id, title, description, status, creator_id, assignee_id, channel_id,
  tags_json, sort_order, created_at, updated_at, revision, NULL, NULL, NULL
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_team_channel ON tasks(team_id, channel_id);
CREATE INDEX idx_tasks_team_status ON tasks(team_id, status);
CREATE INDEX tasks_current_revision_idx ON tasks(team_id, id) WHERE superseded_by_revision IS NULL;
