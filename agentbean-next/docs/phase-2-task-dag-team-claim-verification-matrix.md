# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-13
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #533，Task DAG/revision/claim/acceptance 纯 Domain rules
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Yellow | Phase 2 runtime exact tool snapshot 已建立 | 接入真实 Phase 2 executor |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Yellow | integer revision、optimistic conflict 与 exact revision authority 的纯 Domain policy 已建立 | 接入 Task schema、coordination UoW 与 rollback tests |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Yellow | criterion stable ID、semantic change、retired ID 与 stale/future revision policy 已建立 | 接入原子 revision event、claim invalidation 与 late-result isolation |
| P2-07 | Red | Not implemented | capability resolver |
| P2-08 | Red | Not implemented | open/targeted claim broker |
| P2-09 | Yellow | claim acquire/renew/release/expire/reopen、唯一 winner、fencing 与 ancestor-Agent loop 的纯 Domain policy 已建立 | 接入原子 repository、broker、disconnect/reconnect transport |
| P2-10 | Red | Not implemented | dependency readiness |
| P2-11 | Red | Not implemented | Task attempt Invocation authority |
| P2-12 | Red | Not implemented | SubtaskDelivery persistence |
| P2-13 | Red | Not implemented | Server evidence snapshot |
| P2-14 | Yellow | criteria 全覆盖、evidence kind/visibility/drift、high-risk/conflict 的 fail-closed 决策表已建立 | 接入 delivery/evidence service 与 manager/human authority |
| P2-15 | Red | Not implemented | DAG checkpoint recovery |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。

Issue #533 当前 Domain 证据：`packages/domain/tests/{task-dag,task-revision,task-claim,subtask-acceptance}-policy.test.ts` 共 52 个测试；`test:phase2-task-dag` 与 `build:phase2-task-dag` 已纳入 Domain gate。上述 Yellow 项只代表纯决策规则存在，不代表 persistence、broker、transport 或执行链路已完成。
