# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-13
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #536，Task coordination schema、repositories 与 Unit of Work
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Yellow | Phase 2 runtime exact tool snapshot 已建立 | 接入真实 Phase 2 executor |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Green | Task `revision`、coordination revision 与 Management Event 共享原子 UoW；memory/SQLite 覆盖 exact optimistic conflict、create/revise rollback、旧库升级、重复 migration 与 ledger failure rollback | 后续 Kernel 必须只通过该 UoW 推进 revision |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Yellow | criterion stable ID、semantic change、retired ID policy 已建立；repository 主键禁止 criterion ID 复用 | 接入原子 claim invalidation 与 late-result isolation |
| P2-07 | Red | Not implemented | capability resolver |
| P2-08 | Red | Not implemented | open/targeted claim broker |
| P2-09 | Yellow | claim policy 已建立；memory/SQLite 强制同一 Task revision/attempt 只有一个 active lease，且只持久化 token hash/fingerprint | 接入 Broker、fake clock 与 disconnect/reconnect transport |
| P2-10 | Red | Not implemented | dependency readiness |
| P2-11 | Red | Not implemented | Task attempt Invocation authority |
| P2-12 | Yellow | SubtaskDelivery persistence 已绑定 revision/attempt/claim lease/Invocation，并强制 Task 级 idempotency key | 接入 delivery command 与 current authority recheck |
| P2-13 | Yellow | canonical evidence snapshot 与 delivery/acceptance refs 已持久化；Team/Task/Invocation 不一致时 fail closed | 接入 Message/Artifact/Workspace Run source resolver 与 drift recheck |
| P2-14 | Yellow | acceptance 决策表、criteria results persistence 与每个 delivery 唯一 canonical decision 已建立 | 接入 manager/human authority 与 Task 状态推进 |
| P2-15 | Red | Not implemented | DAG checkpoint recovery |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。

Issue #536 当前持久化证据：`apps/server-next/tests/task-coordination-unit-of-work.test.ts` 在 memory/SQLite 两套实现覆盖原子 create/revise rollback、optimistic revision、唯一 active claim、delivery idempotency、canonical evidence/acceptance，以及旧数据库升级与 migration ledger rollback；`test:phase2-task-dag` 已纳入完整 `test:server-next`。上述 Yellow 项只代表持久化底座存在，不代表 Broker、source resolver、Kernel、transport 或执行链路已完成。
