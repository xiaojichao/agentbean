-- #707 AC#8: Decision 被取代（superseded）生命周期状态。
-- superseded_by_decision_id 非 null = 本 Decision 已被该 id 的新 Decision 取代。
-- 与 gate_status 正交（gate_status 是门禁裁决；本字段是后续被取代的生命周期标记）。
-- 简单 ALTER ADD COLUMN，不重建表。
ALTER TABLE channel_coordination_decisions ADD COLUMN superseded_by_decision_id TEXT;
