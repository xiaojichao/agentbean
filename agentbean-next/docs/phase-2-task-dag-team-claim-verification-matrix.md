# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-14
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #551，retry、reopen、reassign 与根任务汇总
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Green | Phase 2 exact allowlist 与 V2 request/result parser 已接入 daemon/Server；8 个 Task tools 全部路由到 Task Coordination Kernel | 保持 Phase 3/4、coding 与 cwd resources 不可见 |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Green | Task `revision`、coordination revision 与 Management Event 共享原子 UoW；memory/SQLite 覆盖 exact optimistic conflict、create/revise rollback、旧库升级、重复 migration 与 ledger failure rollback | 后续 Kernel 必须只通过该 UoW 推进 revision |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Green | Kernel 在同一 UoW 内推进 Task/coordination revision，保持 criterion stable ID、退休被删除 criterion；失败 attempt 与人类拒绝根交付分别推进 attempt/revision，旧 claim、Invocation、delivery 与 acceptance 保留历史但失去当前 authority | 后续语义变更继续只通过 revision command |
| P2-07 | Green | capability resolver 对 visibility、deleted、device、readiness、explicit capability、channel/dependency access、ancestor loop 与 targeted mismatch 返回明确 diagnostics | 后续新增 capability 必须复用同一 resolver |
| P2-08 | Green | open/targeted Broker、offer/ack、唯一 winner、最小 execution snapshot 与 daemon transport 已由 Issue #542 / PR #543 覆盖；Invocation Gateway 只接受当前 claim holder | 后续执行入口继续复用 claim authority |
| P2-09 | Green | memory/SQLite 唯一 active lease、renew/release/expire/disconnect/reconnect、fencing monotonic、reopen 与 loser zero Dispatch 均有 fake-clock/transport tests；claim 到期后 Task 原子回到 `todo`，同 attempt 可重新 offer，targeted Task 可在 grace/lease 到期后显式重派 | 保持过期 authority 只读可追溯 |
| P2-10 | Green | Gateway 在原子 UoW 内检查 dependency Task `done` 与 canonical accepted delivery，并由 Server 生成 Invocation dependency refs；未闭合或缺少 accepted result 时 fail closed | 保持依赖结果只消费 canonical accepted delivery |
| P2-11 | Green | V2 `agents.invoke` 绑定 current Task revision/attempt/claim lease；target 由 claim holder 派生，同一 Task attempt 的第二个 active Invocation 被拒绝；失败 Dispatch 通过 Server lifecycle bridge 原子关闭当前 authority、推进一个受控 attempt，达到上限后转 `waiting_for_user` | 后续真实 Device smoke 复用同一路径 |
| P2-12 | Green | `agents.invoke` 仅在当前 succeeded Invocation 已有真实 Agent 结果后显式 finalization；delivery 绑定 current Task revision/attempt/claim lease/Invocation；retry/reassign 后旧 claim 被 invalidated，旧 attempt delivery/acceptance 无法成为当前 authority | 保持 current revision/attempt/lease 四元组校验 |
| P2-13 | Green | Message/Artifact/Workspace Run/Invocation/Task resolver 全部校验 Team、channel、dispatch、Agent 与 Task authority；Server canonicalize + SHA-256，存储路径/下载 token 不入快照，客户端 digest mismatch、source hidden/unavailable 与 snapshot drift 均 fail closed | 后续新增 evidence kind 必须复用 Server resolver 与 canonical hash |
| P2-14 | Green | manager acceptance 逐 criterion 校验全量覆盖、passed、required evidence、allowed kind 与 current source hash；accepted 原子推进 `done`，rejected 可显式 retry，高风险/冲突 `needs_human` 原子推进 Run `waiting_for_user`；根交付拒绝创建新 revision 并恢复 Run | 保持 human continuation 不覆盖历史决定 |
| P2-15 | Green | checkpoint 在 Task Coordination UoW 中收集完整 task snapshots、revision/attempt、active claim 与 waiting/completed Invocation；daemon 依据恢复快照启用 Phase 2 exact tools，断线重连后恢复同一 Run/DAG 且不重建子任务 | Task 12 补真实双 Device restart smoke |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。

Issue #551 当前证据：`managed-multi-agent.test.ts` 覆盖失败 Invocation（含 Dispatch emit failure）的受控 attempt、max attempts 后 `waiting_for_user`、双叶子 canonical acceptance、根汇总贡献集 fail closed、根 Task `in_review` 与人类拒绝后 revision 递增且历史 acceptance 不被覆盖；`task-claim-broker.test.ts` 覆盖 claim 到期重开与 fencing 单调；既有 delivery/acceptance 与 Invocation Gateway tests 继续覆盖 stale revision/attempt/lease 隔离。Node 24 下 boundary 5、contracts 35、PI runtime 36、Domain 121、server-next 516 项测试及 `build:phase2-task-dag` 均通过。Phase 2 仍默认关闭；真实双 Agent Device 与 Web surface 尚未完成。
