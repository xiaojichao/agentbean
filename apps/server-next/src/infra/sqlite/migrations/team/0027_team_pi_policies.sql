-- #707: Team PI 自动协调开关。每 Team 一行；无行 = 默认开启（getOrDefault）。
-- 取代旧 direct/shadow/managed mode、Phase、placement（旧表保留供旧 Run 恢复读取，不再作为产品设置）。
-- team_id 不加 REFERENCES：teams 表在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK（与 channel_coordination_jobs 同惯例）。
CREATE TABLE team_pi_policies (
  team_id TEXT PRIMARY KEY,
  auto_coordination_enabled INTEGER NOT NULL CHECK (auto_coordination_enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
