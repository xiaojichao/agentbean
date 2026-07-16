# AgentBean Phase 3：跨 Agent Memory 验收矩阵

> 更新日期：2026-07-16
> 当前 verdict：**Not ready**
> 原因：合同、Domain 安全边界、Server 持久化、协作 Memory 用例层、权限优先检索排序、最小 Capsule 创建、事实源失效处理、Capsule 注入复验、Capsule↔Invocation/checkpoint 绑定、Memory Candidate 生命周期、Phase 3 Memory 工具定义地基，以及 Device 本地 Memory 与实际 runtime 注入合并已完成；V3 capability/preflight 接线 + handler、explicit-grant Capsule、Candidate 的 worker/checkpoint 接线、Web 治理面、socket wiring 与真实跨 Agent 验证尚未完成。Phase 3 runtime 必须保持关闭。

状态定义：`Green` 已有自动化或真实证据；`Yellow` 已实现但证据未收口；`Red` 尚未实现或缺关键证据。

| ID | 状态 | 验收项 | 当前证据 / 缺口 |
| --- | --- | --- | --- |
| P3-01 | Green | Memory/Capsule/Candidate 合同与 server/local scope 隔离 | `packages/contracts/src/management-memory.ts`；contracts tests |
| P3-02 | Green | 注入资格与 Capsule 授权复验 fail closed | `packages/domain/src/memory-policy.ts`；Domain table tests |
| P3-03 | Green | Server SQLite schema、repository 与原子事务 | `0015_management_phase_3_memory.sql`；memory/SQLite parity 与 rollback tests |
| P3-04 | Green | 协作 Memory CRUD、显式共享、替代与删除 | `apps/server-next/src/application/collaborative-memory-service.ts`（PR#579 09437c9 已合并）：createMemory/updateMemory/activateCandidate/rejectCandidate/expireMemory/supersedeMemory/deleteMemory + issueGrant/revokeGrant；状态机、去重、乐观并发、跨 Team fail-closed、正文-free 审计；in-memory/sqlite parity（32 用例） |
| P3-05 | Green | task scope 检索、权限先行与可解释排序 | `collaborative-memory-search-service.ts` + `packages/domain/src/memory-ranking.ts`（`scoreMemoryRelevance`/`rankMemories`）（PR#591 de51e82 已合并）；权限先行硬门、可解释排序理由、双后端 parity |
| P3-06 | Yellow | 最小 Capsule 创建、内容脱敏与访问审计 | `memory-capsule-service.ts`：createCapsule 复用 #591 检索→冻结 scope-policy 最小集（脱敏 none + 逐项 authorization：sourceScope/hash/kind/policyVersion/grant 决策 + binding managementRunId/task/target/expiry + capsule-created system 审计）；无正文重建 manifest 由 P3-13 持久化；双后端 parity。待补：explicit-grant item（多 grant→单 authorization 映射，与 P3-07 协同）与脱敏分级 |
| P3-07 | Yellow | 每次 inject 复验成员、scope、hash、policy/grant 与 expiry | `capsule-injection-validator.ts`：validateCapsuleForInjection 两检查合取——`evaluateMemoryInjection`（fresh status + 全来源可用）+ `evaluateMemoryCapsuleAuthorization`（当前事实源与冻结投影双重 hash、policyVersion/grant/expiry）+ Team/当前 Memory scope/逐来源 scope 复验；capsule 过期全拒并逐 item 写 capsule-denied 审计；P3-13 已接入真实 dispatch runtime。待补：explicit-grant item |
| P3-08 | Green | Capsule 与 immutable Invocation intent/checkpoint 绑定 | slice 1 持久化地基（migration 0016 + capsuleRefs repo，PR#596）+ slice 2 接线：createCapsule 写权威 capsuleRef（toCapsuleRefRecord）+ intent 固化 `memoryCapsuleRef?: MemoryCapsuleRefDto`（替 memoryCapsuleId，hashCapsuleItems 聚合 hash）+ Phase 2 `agents.invoke` wire/parser/schema 透传 + Gateway 仅接受 Team/Run/Task/Agent 完整匹配且仍有效的权威 ref，replay 逐字段比对 + 注入拒绝同步 `deniedAt` + `collectManagementCheckpointFacts` 查 capsule_refs 表（存在+未过期+未 deny）填 validMemoryCapsuleIds（memory 可选，向后兼容）。checkpoint service 现仅测试用（未接生产 run 流程）。双后端 parity。 |
| P3-09 | Yellow | V3 Worker capability/preflight 与四个 Memory tools | slice 1 工具定义 + slice 2a 请求合同层（Phase3 输入/请求/响应合同 + parser）+ slice 2b **V3 capability 门禁接线**：worker register contract 精确接受 `[1,2]` 或 `[1,2,3]` + executor 按 `request.managementPhase === 3` 分发 phase3Handlers（修 `2 as const` echo→实际 phase；Phase3ToolHandlers 类型；readTools 加 memory.search）+ scheduler `managementPhase3Preflight`（只选择显式 `[1,2,3]` capability，socket integration 覆盖 V2 负例/V3 正例）+ adapter `effectiveToolNames` route phase3→PHASE_3（assertSessionContext 接 V2 2|3）+ contracts context `managementPhase: 2|3`。**V3 session 现可列出 4 个 memory 工具**（pi-runtime 测试验证）。待补 slice 2c：daemon 注册/transport/host 贯通 + 4 handler 接 search/capsule/candidate service（依赖 #604 改过的 service）+ dev-server 接线 + readiness 2→3 |
| P3-10 | Green | 外部 Agent 结果进入 Candidate 生命周期 | domain 状态机 `evaluateCandidateTransition`（`packages/domain/src/memory-candidate-policy.ts`，5 态 candidate→accepted/rejected/merged/conflict，终态/自迁/conflict→candidate 非法）+ 独立表 `memory_candidates`/`memory_candidate_sources`（`0016_memory_candidates.sql`，scope 仅 server 6 态、source_visibility 无 local-only，schema 级 fail-closed）+ `MemoryRepositories.candidates` 子接口（create/getById/findByProjectionHash/update）+ `memory-candidate-service.ts` proposeCandidate/acceptCandidate/rejectCandidate/mergeCandidate（unitOfWork 原子、`assertDecideAuthority` 仅用户/系统、外部 Agent 只能 propose、无正文 audit candidate-created/candidate-decided）；双后端 parity 测试 + boundary gate `P3_CANDIDATE_LIFECYCLE_INVALID`。待补：worker `memory.propose_candidate` 接线（P3-09）、checkpoint `validMemoryCapsuleIds` 接真实查询（P3-08） |
| P3-11 | Green | 来源关联、projection hash 去重与冲突识别 | `projectionHash` 复用 domain `memory-hashing.ts` 单一源 `computeProjectionHash`（proposedContent + sourceRefs + scope + contentKind，故意不 normalize，严格字节去重）；幂等：`findByProjectionHash` 查未决 candidate 命中即返回、不新建 active Memory；来源冲突：candidate 来源经 `sources.listBySource` 命中 active Memory 且 projectionHash 不同 → `conflict` 态（conflictMemoryIds），accept 遇冲突 throw `CANDIDATE_HAS_CONFLICT` 引导 merge，merge 在 unitOfWork 内复用 supersede 范式取代冲突项；双后端 parity 覆盖幂等/冲突/跨 Team fail-closed（`CANDIDATE_NOT_FOUND` 不泄漏存在性）。待补：内容相似度启发式（设计决议留 follow-up，初版只做精确来源冲突） |
| P3-12 | Yellow | Device LocalMemoryStore、workspace scan 与 outcome observer | PR #592 已完成核心：`apps/daemon-next/src/memory/` 提供按 profile/cwd/agent 隔离的可恢复 store、安全 workspace scan、确定性 outcome observer、敏感信息 fail-closed 与 Node 24 定向证据；dispatch 完成后的自动 observer 接线与脱敏摘要回传仍待后续切片。 |
| P3-13 | Green | server Capsule + 当前 cwd local Memory 的 runtime 注入 | `memory_capsule_item_manifests` 只持久化无正文重建清单；`server-capsule-runtime-context-service.ts` 从 Invocation-bound ref 和当前事实源重建、逐项复验、整体 hash fail-closed 并写 body-free read/injected audit；daemon `runtime-memory-context.ts` 每次执行重新读取当前 profile/cwd/agent 本地 Memory，Server 优先确定性去重并保留 provenance/selectionReason；`buildRuntimePrompt()` 在 executor 公共入口覆盖 generic stdin、argv、promptOnStdin 与 Codex PTY。双后端 6 项 + Device/direct/managed/shadow/restart/reconnect/损坏态与 executor 30 项定向测试通过。 |
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
