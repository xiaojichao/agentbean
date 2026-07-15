# AgentBean Phase 3：跨 Agent Memory 验收矩阵

> 更新日期：2026-07-15
> 当前 verdict：**Not ready**
> 原因：合同、Domain 安全边界、Server 持久化、协作 Memory 用例层（CRUD/状态机/显式共享）、权限优先检索排序、最小 Capsule 创建与事实源失效处理已完成；Capsule inject 复验/explicit-grant、Candidate、Web 治理面、socket wiring 与真实跨 Agent 验证尚未完成。Phase 3 runtime 必须保持关闭。

状态定义：`Green` 已有自动化或真实证据；`Yellow` 已实现但证据未收口；`Red` 尚未实现或缺关键证据。

| ID | 状态 | 验收项 | 当前证据 / 缺口 |
| --- | --- | --- | --- |
| P3-01 | Green | Memory/Capsule/Candidate 合同与 server/local scope 隔离 | `packages/contracts/src/management-memory.ts`；contracts tests |
| P3-02 | Green | 注入资格与 Capsule 授权复验 fail closed | `packages/domain/src/memory-policy.ts`；Domain table tests |
| P3-03 | Green | Server SQLite schema、repository 与原子事务 | `0015_management_phase_3_memory.sql`；memory/SQLite parity 与 rollback tests |
| P3-04 | Green | 协作 Memory CRUD、显式共享、替代与删除 | `apps/server-next/src/application/collaborative-memory-service.ts`（PR#579 09437c9 已合并）：createMemory/updateMemory/activateCandidate/rejectCandidate/expireMemory/supersedeMemory/deleteMemory + issueGrant/revokeGrant；状态机、去重、乐观并发、跨 Team fail-closed、正文-free 审计；in-memory/sqlite parity（32 用例） |
| P3-05 | Green | task scope 检索、权限先行与可解释排序 | `collaborative-memory-search-service.ts` + `packages/domain/src/memory-ranking.ts`（`scoreMemoryRelevance`/`rankMemories`）（PR#591 de51e82 已合并）；权限先行硬门、可解释排序理由、双后端 parity |
| P3-06 | Yellow | 最小 Capsule 创建、内容脱敏与访问审计 | `memory-capsule-service.ts`：createCapsule 复用 #591 检索→冻结 scope-policy 最小集（脱敏 none + 逐项 authorization：sourceScope/hash/kind/policyVersion/grant 决策 + binding managementRunId/task/target/expiry + capsule-created system 审计）；投影不持久化；双后端 parity 10 用例。待补：explicit-grant item（多 grant→单 authorization 映射，与 P3-07 协同）、脱敏分级与 inject 接线 |
| P3-07 | Red | 每次 inject 复验成员、scope、hash、policy/grant 与 expiry | 仅有 Domain 规则，Server 接线未实现 |
| P3-08 | Red | Capsule 与 immutable Invocation intent/checkpoint 绑定 | 仅有既有引用字段，未形成端到端链路 |
| P3-09 | Red | V3 Worker capability/preflight 与四个 Memory tools | 工具元数据存在，但 Phase 3 runtime 未开放 |
| P3-10 | Red | 外部 Agent 结果进入 Candidate 生命周期 | 仅有合同，未实现持久化与用例 |
| P3-11 | Red | 来源关联、projection hash 去重与冲突识别 | 未实现 |
| P3-12 | Red | Device LocalMemoryStore、workspace scan 与 outcome observer | 未实现 |
| P3-13 | Red | server Capsule + 当前 cwd local Memory 的 runtime 注入 | 未实现 |
| P3-14 | Red | Web Memory/Candidate/冲突/来源/执行详情治理 | 未实现 |
| P3-15 | Yellow | grant 撤销、来源失效、expire/delete 与审计闭环 | revokeGrant 版本链 + expireMemory/deleteMemory 审计（PR#579）；message/task/artifact/workspace-run/invocation 来源失效反应式级联 `memory-source-invalidation-service.ts`（删除 best-effort 触发，本批失效 + 其余事实源可用性复查，无可用来源时主动 expired + system audit；覆盖分次删除、Task 与频道级联删除，双后端 parity）。待补：完整 E2E 闭环 |
| P3-16 | Red | checkpoint/recovery 不恢复无效 Capsule/Candidate | 未实现 |
| P3-17 | Red | 两个真实外部 Agent 跨 Task Memory 正负 smoke | 未执行 |
| P3-18 | Red | Node 24 root gates、main CI/CD、SEA、Railway/Vercel、生产浏览器收口 | 未执行 |

## 当前放行边界

- Team 默认保持 `maxManagementPhase=1`。
- Phase 2 继续只允许受控 opt-in，且其 exact tool allowlist 不包含 `memory.*`。
- Phase 3 没有 V3 capability/preflight 前，不能通过配置或 fallback 进入。
- 本地 Workspace Memory 只允许 Device-only，不进入 Server Memory record 或 Server-hosted Capsule。

只有 P3-01..P3-18 全部 Green，且真实环境证据与代码版本一致，verdict 才能改为 Green / Ready。
