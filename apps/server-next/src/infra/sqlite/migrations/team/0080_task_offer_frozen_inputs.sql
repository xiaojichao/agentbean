-- #1064：Task-linked @Agent 请求冻结的项目输入（frozen inputs）持久化。
-- 消息发送时刻把 current/final/package 指针解析为具体 artifactVersionId 后随 Offer 冻结：
-- acceptance 事务据此复验 package/version basis（AC6），Invocation intent 据此写入
-- immutable intent（AC7）；Offer 本身不授予输入访问（AC4 最小 preview 见 objective_json）。
-- JSON 列与既有 objective_json 同款策略；NULL = 非 Task-linked 的普通 Offer（向后兼容）。
ALTER TABLE task_offers
  ADD COLUMN frozen_inputs_json TEXT;
