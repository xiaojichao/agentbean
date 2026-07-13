# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-14
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #540，Task Coordination Kernel 与 DAG commands
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Yellow | Phase 2 runtime exact tool snapshot 已建立 | 接入真实 Phase 2 executor |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Green | Task `revision`、coordination revision 与 Management Event 共享原子 UoW；memory/SQLite 覆盖 exact optimistic conflict、create/revise rollback、旧库升级、重复 migration 与 ledger failure rollback | 后续 Kernel 必须只通过该 UoW 推进 revision |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Yellow | Kernel 在同一 UoW 内推进 Task/coordination revision，保持 criterion stable ID、退休被删除 criterion，并原子失效 active claim 与匹配 Invocation | delivery/acceptance 接入后补齐 late result isolation 证据 |
| P2-07 | Red | Not implemented | capability resolver |
| P2-08 | Red | Not implemented | open/targeted claim broker |
| P2-09 | Yellow | claim policy 已建立；memory/SQLite 强制同一 Task revision/attempt 只有一个 active lease；Kernel revision/显式命令可原子失效 claim 并记录匹配 Invocation | 接入 Broker、fake clock 与 disconnect/reconnect transport |
| P2-10 | Yellow | Kernel 复用 `evaluateTaskDag` 原子拒绝 cycle/depth/fan-out/open-node/budget 越界；publish/assign 在依赖未 `done` 时 fail closed | 后续 Broker 与执行器消费同一 readiness authority |
| P2-11 | Red | Not implemented | Task attempt Invocation authority |
| P2-12 | Yellow | SubtaskDelivery persistence 已绑定 revision/attempt/claim lease/Invocation，并强制 Task 级 idempotency key | 接入 delivery command 与 current authority recheck |
| P2-13 | Yellow | canonical evidence snapshot 与 delivery/acceptance refs 已持久化；Team/Task/Invocation 不一致时 fail closed | 接入 Message/Artifact/Workspace Run source resolver 与 drift recheck |
| P2-14 | Yellow | acceptance 决策表、criteria results persistence 与每个 delivery 唯一 canonical decision 已建立 | 接入 manager/human authority 与 Task 状态推进 |
| P2-15 | Red | Not implemented | DAG checkpoint recovery |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。

Issue #540 当前 Kernel 证据：`apps/server-next/tests/task-coordination-kernel.test.ts` 在 memory/SQLite 两套实现覆盖 root/subtask 创建、dependency/revision、publish/assign/state transition、command idempotency conflict、cycle/budget/Event append rollback，以及 revision 与 claim/Invocation 失效的原子性；所有成功命令写入 exact typed Management Event。上述 Yellow 项仍不代表 Broker、source resolver、transport 或执行链路已完成。
