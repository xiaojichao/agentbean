-- #947 PR1：Task Offer Requirement-confirmation 标记（ADR-0064 §3）。
-- 向「硬指定 + required requirement 状态 unknown」（manifest 不可得）的目标发出的受限 Offer：
--   发布时已复验不可覆盖硬门槛通过、unknown 状态、不存在明确不满足事实，只披露最小 preview。
--   不当作 eligible——只有 Agent 更新 Manifest 或随 acceptance 提交 per-Task requirement attestation
--   并在 accept/claim 事务通过完整 requirement 与容量复验后才能建立 claim（attestation 路径属 #947 PR2）。
-- requirement_confirmation=1 的 Offer 在 attestation 落地前对 accepted fail-closed（不产 Claim）。
-- manifest_revision 此时为占位 0（无 active manifest；agent 后续更新 manifest revision≥1 → fence
--   0!==rev 使旧确认 Offer 失效，即 ADR path-a）。
-- DEFAULT 0：历史 Offer 均为普通 Offer（非确认），向后兼容；新 Offer 由应用层按 decideHardSpecifiedOfferKind 写入。
ALTER TABLE task_offers
  ADD COLUMN requirement_confirmation INTEGER NOT NULL DEFAULT 0;
