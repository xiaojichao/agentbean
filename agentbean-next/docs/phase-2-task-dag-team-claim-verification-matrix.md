# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-14
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #544，Phase 2 Task tools、checkpoint 与 Worker recovery
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Green | Phase 2 exact allowlist 与 V2 request/result parser 已接入 daemon/Server；8 个 Task tools 全部路由到 Task Coordination Kernel | 保持 Phase 3/4、coding 与 cwd resources 不可见 |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Green | Task `revision`、coordination revision 与 Management Event 共享原子 UoW；memory/SQLite 覆盖 exact optimistic conflict、create/revise rollback、旧库升级、重复 migration 与 ledger failure rollback | 后续 Kernel 必须只通过该 UoW 推进 revision |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Yellow | Kernel 在同一 UoW 内推进 Task/coordination revision，保持 criterion stable ID、退休被删除 criterion，并原子失效 active claim 与匹配 Invocation | delivery/acceptance 接入后补齐 late result isolation 证据 |
| P2-07 | Green | capability resolver 对 visibility、deleted、device、readiness、explicit capability、channel/dependency access、ancestor loop 与 targeted mismatch 返回明确 diagnostics | 后续新增 capability 必须复用同一 resolver |
| P2-08 | Green | open/targeted Broker、offer/ack、唯一 winner、最小 execution snapshot 与 daemon transport 已由 Issue #542 / PR #543 覆盖 | Invocation Gateway 在 Task 8 消费 claim authority |
| P2-09 | Green | memory/SQLite 唯一 active lease、renew/release/expire/disconnect/reconnect、fencing monotonic、reopen 与 loser zero Dispatch 均有 fake-clock/transport tests | Task 8 继续验证 stale claim 无法创建 Invocation |
| P2-10 | Green | Kernel、Broker 与 `tasks.wait` 共同消费 Server authoritative DAG/dependency/task state；cycle/depth/fan-out/open-node/budget 与 dependency readiness fail closed | 后续 executor 不得引入本地 readiness 推断 |
| P2-11 | Red | Not implemented | Task attempt Invocation authority |
| P2-12 | Yellow | SubtaskDelivery persistence 已绑定 revision/attempt/claim lease/Invocation，并强制 Task 级 idempotency key | 接入 delivery command 与 current authority recheck |
| P2-13 | Yellow | canonical evidence snapshot 与 delivery/acceptance refs 已持久化；Team/Task/Invocation 不一致时 fail closed | 接入 Message/Artifact/Workspace Run source resolver 与 drift recheck |
| P2-14 | Yellow | acceptance 决策表、criteria results persistence 与每个 delivery 唯一 canonical decision 已建立 | 接入 manager/human authority 与 Task 状态推进 |
| P2-15 | Green | checkpoint 在 Task Coordination UoW 中收集完整 task snapshots、revision/attempt、active claim 与 waiting/completed Invocation；daemon 依据恢复快照启用 Phase 2 exact tools，断线重连后恢复同一 Run/DAG 且不重建子任务 | Task 12 补真实双 Device restart smoke |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。

Issue #544 当前证据：`management-tool-executor.test.ts` 逐项锁定 8 个 Task tools 的 kernel routing 与 Server-truth `tasks.wait`；`management-checkpoint.test.ts` 覆盖完整 DAG/revision/attempt/claim/Invocation snapshot；`pi-manager-worker-host.test.ts` 与 `management-worker-protocol.test.ts` 覆盖 V2 envelope、Phase 2 exact allowlist 及同 Run 断线恢复。Task 6 的 Broker/transport 证据由 `task-claim-broker.test.ts`、`management-socket-integration.test.ts`、`task-claim-protocol.test.ts` 和 PR #543 提供。Phase 2 仍默认关闭；Invocation authority、delivery/evidence、真实双 Agent 与 Web surface 尚未完成。
