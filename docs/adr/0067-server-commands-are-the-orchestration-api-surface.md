---
status: accepted
---

# Server command 是消息与编排的权威 API 面

消息投递与 PI 协作编排的对外实现合同以具名 Server command / query 为权威读写面，而不是资源 CRUD、客户端 event-sourcing 或传输专属协议。写路径按 `human.*` / `pi.*` / `agent.*` / `daemon.*` 分角色命名空间，使用瘦 command envelope（schemaVersion、command、commandId、idempotencyKey、actor、作用域与 per-command CAS/凭证），并在 `actor × command 族 × 主资源` 上做业务幂等：同键同指纹回放，冲突硬失败，相关 revision 世代使旧键失效。

成功写入追加不可变 domain fact event；用户可见内容走 audience-scoped projection。同步结果统一为 accepted / rejected / held，并带稳定 code 与 retryClass。引用统一为 Resource ref（可选 pin，fact 物化 pin）。权威 snapshot query 对同 actor 提供 read-your-writes；投影 query 使用 cursor/asOf。合同传输无关，进程内 PI 也不得绕过同一门禁。本票冻结能力目录与横切语义，不写死全量字段 schema；它落实并连接 ADR-0062 至 ADR-0066 的具名边、幂等恢复与分层投影要求，供后续 OpenAPI/实施直接对齐。
