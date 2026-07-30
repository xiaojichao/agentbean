-- #947 PR2（AC3）：Task Offer accepted response 携带的 per-Task requirement attestation 持久化。
-- Requirement-confirmation Offer 经 attestation 接受时，记录 Agent 提交的 attested capability/skill 名
-- （审计「该 claim 凭 attestation 授予」）。仅确认 Offer 的 accepted response 非空；其余 response 为 NULL。
-- 与 response_kind/detail/responded_at 同组（response 内联策略，domain 状态机保证每 offer 至多一个终态响应）。
-- ADR-0064 §3；attestation 绑定 task revision 由 Offer 的 taskRevision fence 保证（claim 事务校验）。
ALTER TABLE task_offers
  ADD COLUMN response_attestation_json TEXT;
