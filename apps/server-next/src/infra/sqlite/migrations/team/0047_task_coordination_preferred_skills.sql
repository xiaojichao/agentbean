-- #725 F3：preferred Skills 必须随 Task coordination 持久化，供生产分配器只在合格候选间排序。
ALTER TABLE task_coordinations ADD COLUMN preferred_skills_json TEXT;
