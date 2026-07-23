-- #712 切片 C 后续：Task Offer 持久化。
-- 对应 domain task-offer-policy（已合 a47320da）：PI → Agent 的结构化 Offer + 四类显式响应。
-- team_id 不加 REFERENCES：teams 在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK
--   （同 team_pi_policies / agent_exposure_manifests / channel_coordination_* 惯例）。
--
-- AC#1：objective_json 冻结 objective/inputs/deliverables/constraints/risk/required Cap+Skill/
--   preferred Skill；task_revision / manifest_revision 为发布时冻结的 fence。
-- AC#3：status 状态机（CHECK 约束枚举）；ACK 不改状态，仅响应/失效转移（domain 保证 +
--   本表 updateStatus 的 expectedStatus CAS 兜底）。
-- AC#5：rejected/needs_info/counter_proposed/expired/invalidated/overtaken 仅记录状态，不产 Lease。
-- AC#6：并发接受单赢家由 task-claim-policy 保证；本表用 updateStatus 的 expectedStatus='open'
--   CAS 让败者的 open→accepted 影响 0 行（与 claimLeases.update 同款乐观并发）。
-- AC#8：hard_specified 仅元数据；本表只存储，不影响任何约束。
--
-- 最新响应内联（response_kind/detail/responded_at）：domain 状态机保证每 offer 至多一个
-- 终态响应，内联即满足 AC#7「Task 视图可见 Offer 状态和 Agent 响应」；response_* 仅在
-- status 为 accepted/rejected/needs_info/counter_proposed 时非空（应用层保证，DB 不强约束
-- response 与 status 的组合，避免迁移期兼容性脆性）。
CREATE TABLE task_offers (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  task_attempt INTEGER NOT NULL,
  manifest_revision INTEGER NOT NULL,
  objective_json TEXT NOT NULL,
  offer_ttl_ms INTEGER NOT NULL,
  offer_expires_at INTEGER NOT NULL,
  hard_specified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'accepted', 'rejected', 'needs_info', 'counter_proposed',
    'expired', 'invalidated', 'overtaken'
  )),
  response_kind TEXT CHECK (response_kind IS NULL OR response_kind IN (
    'accepted', 'rejected', 'needs_info', 'counter_proposed'
  )),
  response_detail TEXT,
  responded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AC#7 Task 视图：按 task 列出 offers（含状态过滤）。
CREATE INDEX idx_task_offers_task
  ON task_offers(team_id, task_id, status, created_at);

-- AC#7/AC#8 Agent 视图：按 agent 列出待响应 offers（优先询问对象）。
CREATE INDEX idx_task_offers_agent
  ON task_offers(team_id, agent_id, status, offer_expires_at);
