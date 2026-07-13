# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-13
- 状态：实施中
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #531，matrix/static gate + V2 contracts + phase-aware runtime
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Yellow | V1 保持不变；V2 Run/Worker/Session contracts 与协议协商 vocabulary 已建立 | 完成真实 Server/Worker negotiation |
| P2-02 | Yellow | Phase 2 runtime exact tool snapshot 已建立 | 接入真实 Phase 2 executor |
| P2-03 | Red | Not implemented | policy migration 与 owner/admin control |
| P2-04 | Red | Not implemented | Task revision/UoW |
| P2-05 | Red | Not implemented | DAG Domain policy |
| P2-06 | Red | Not implemented | revision invalidation |
| P2-07 | Red | Not implemented | capability resolver |
| P2-08 | Red | Not implemented | open/targeted claim broker |
| P2-09 | Red | Not implemented | claim lease lifecycle |
| P2-10 | Red | Not implemented | dependency readiness |
| P2-11 | Red | Not implemented | Task attempt Invocation authority |
| P2-12 | Red | Not implemented | SubtaskDelivery persistence |
| P2-13 | Red | Not implemented | Server evidence snapshot |
| P2-14 | Red | Not implemented | acceptance policy |
| P2-15 | Red | Not implemented | DAG checkpoint recovery |
| P2-16 | Red | Not implemented | 真实双 Agent Device E2E |
| P2-17 | Red | Not implemented | Web DAG/claim/result surface |
| P2-18 | Red | Not implemented | closeout retained gates、SEA、main CI/CD 与 production smoke |

当前 verdict：**Not ready**。Phase 2 仍默认关闭，Team 继续使用 Phase 1 能力。
