-- issue #716 Formal Memory Center：给 memory_items 增加产品投影与版本化列。
-- 设计原则（§6.5）：复用现有表与状态机，不做破坏性重建。
--   formal_kind      非 NULL 表示这是 Formal Memory（fact/decision/rule/preference）。
--                     存储仍用现有 6 类 kind（fact→semantic, rule→procedural），
--                     formal_kind 仅作产品标记，不改 kind CHECK。
--   change_reason    最近一次人工变更原因（AC#4），区分「手动停用」与「时间过期」。
--   version_family_id 版本族 id（初版=自身 id，supersede 时继承），聚合版本历史。
-- 仅 ALTER ADD COLUMN，不重建表（memory_items 被 sources/tags/capsule_manifests/superseded 引用）。
ALTER TABLE memory_items ADD COLUMN formal_kind TEXT
  CHECK (formal_kind IS NULL OR formal_kind IN ('fact', 'decision', 'rule', 'preference'));
ALTER TABLE memory_items ADD COLUMN change_reason TEXT;
ALTER TABLE memory_items ADD COLUMN version_family_id TEXT;

CREATE INDEX memory_items_formal_idx
  ON memory_items(team_id, formal_kind, version_family_id, status, updated_at DESC);
