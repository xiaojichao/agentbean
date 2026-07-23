-- System Knowledge 与 User Memory（issue #717，PI MVP 切片 D）。
-- 两表都在 Global DB，与 Team DB 的 memory_items 物理隔离（AC#5/AC#6）。
-- 4 类 formal kind 直接存储（ADR 0047）；状态机 active/expired/superseded，纯人工维护，
-- 无 candidate 流程（AC#2：频道消息/Agent 结果/PI 推断不能自动改写）。

CREATE TABLE IF NOT EXISTS system_knowledge_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'rule', 'preference')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'superseded')),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,
  change_reason TEXT,
  version_family_id TEXT NOT NULL,
  superseded_by_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  valid_from INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (superseded_by_id) REFERENCES system_knowledge_items(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_system_knowledge_status
  ON system_knowledge_items(status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_system_knowledge_family
  ON system_knowledge_items(version_family_id, created_at, id);

CREATE TABLE IF NOT EXISTS user_memory_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'rule', 'preference')),
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'superseded')),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,
  change_reason TEXT,
  version_family_id TEXT NOT NULL,
  superseded_by_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  valid_from INTEGER,
  valid_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  -- AC#3/AC#6 物理双保险：User Memory 的创建者必须是 owner 本人。
  CHECK (owner_user_id = created_by_user_id),
  FOREIGN KEY (superseded_by_id) REFERENCES user_memory_items(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_user_memory_owner
  ON user_memory_items(owner_user_id, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_user_memory_family
  ON user_memory_items(version_family_id, created_at, id);
