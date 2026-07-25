-- #724：收缩旧 PI path。将旧 team_management_policies 数据迁移到新 team_pi_policies。
-- 旧表保留仅供历史 Run 恢复读取，不再写入新行（新 Team 默认 auto_coordination_enabled=1）。
-- 迁移规则：
--   mode='direct' → auto_coordination_enabled=0（曾显式选择不启用管理）
--   mode='shadow'|'managed' → auto_coordination_enabled=1
--   NULL（无旧行）→ 由 getOrDefault 默认返回 1（新 Team 自动启用）

INSERT OR IGNORE INTO team_pi_policies (team_id, auto_coordination_enabled, updated_by, updated_at)
SELECT
  tmp.team_id,
  CASE WHEN tmp.mode = 'direct' THEN 0 ELSE 1 END,
  COALESCE(tmp.updated_by, '_system'),
  COALESCE(tmp.updated_at, CAST(strftime('%s', 'now') * 1000 AS INTEGER))
FROM team_management_policies tmp
WHERE true;
