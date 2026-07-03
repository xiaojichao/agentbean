-- 拆 hostname 列语义过载：新增 name（用户显示名）+ name_source（'user'|'hostname'）。
-- hostname 列回归纯机器名语义。仿 0007 加列模式。
ALTER TABLE devices ADD COLUMN name TEXT;
ALTER TABLE devices ADD COLUMN name_source TEXT;
