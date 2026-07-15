# AgentBean Phase 3：跨 Agent Memory 实施计划

> 状态：执行中
> 日期：2026-07-15
> 上游设计：`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`、`docs/superpowers/specs/2026-07-06-agentbean-memory-design.md`
> 验收矩阵：`agentbean-next/docs/phase-3-cross-agent-memory-verification-matrix.md`

## 1. 业务目标

让 AgentBean 在多个外部 Agent 协作时，能把当前 Task 真正需要、当前目标 Agent 有权看到的 Memory 作为最小 Capsule 注入；外部 Agent 的新结论先返回 Candidate，由 PI Manager 关联来源、去重和识别冲突，不能直接污染长期记忆。

Phase 3 交付的是可撤销投影，不建立第二套事实源。Message、Task、Artifact、Workspace Run 与 Invocation 仍是事实源。

## 2. 不变量

- 权限过滤先于相关性排序；未知、过期、来源失效或授权漂移一律 fail closed。
- Server Memory scope 只允许 `team/channel/dm/task/agent/user`；`local-workspace/local-agent/local-profile` 只属于 Device。
- Capsule 绑定 `managementRunId`、可选 Task、目标 Agent、来源快照 hash、最终内容 hash、授权版本和期限。
- DM、私有频道、本地内容不得因摘要或跨 Agent 调用扩大可见性；离开原 scope 必须有显式、未撤销的 grant。
- 外部 Agent 只能提交 Candidate，不能直接写入 `active` Memory。
- Phase 3 未完成前，Team 默认仍停在 `maxManagementPhase=1`；Phase 2 opt-in 规则不变，Phase 3 runtime 不提前开放。
- 所有开发、依赖、原生模块、测试与构建统一使用 Node 24。

## 3. 垂直任务

1. **合同与 Domain 安全边界**：冻结 server/local scope、Memory record、Capsule authorization、Candidate 与注入资格；加入 root boundary gate。
2. **Server 存储与来源快照**：实现 SQLite migration、memory/source/tag/grant/audit repositories，保证状态与来源原子更新。
3. **协作 Memory 用例**：实现创建、编辑、停用、替代、删除、显式共享与来源失效处理。
4. **Task scope 检索与排序**：先做权限、状态、来源过滤，再按 Task/Channel/Agent 相关性排序；结果带理由。
5. **Capsule 创建与注入复验**：Server 生成最小 Capsule，create/read/inject/deny/expire 都审计，每次注入重新授权。
6. **Invocation 绑定**：把 Capsule ID 固化进 immutable Invocation intent，并在 checkpoint/recovery 中只恢复仍有效引用。
7. **Phase 3 Worker 与 Memory tools**：实现 `memory.search/create_capsule/propose_candidate/link_sources`，加入 V3 capability/preflight；不向 V1/V2 泄漏工具。
8. **Candidate 生命周期**：接收外部 Agent 结果，关联 Invocation/Task/source snapshots，完成 hash 去重、冲突识别、接受/拒绝/合并。
9. **Device 本地自动积累**：实现 LocalMemoryStore、workspace scan 与 outcome observer；本地内容不默认上传。
10. **运行时注入**：把 server Capsule 与当前 Device/cwd 的 local Memory 合并为可解释上下文，覆盖全部 runtime 路径。
11. **Web 治理面**：提供协作/本地 Memory 治理、Candidate/冲突、来源、授权与执行详情视图。
12. **真实收口**：完成两 Agent 跨 Task Memory smoke、权限负例、main CI/CD、三平台 SEA、Railway/Vercel 与生产浏览器验证。

## 4. 本轮 Task 1 范围

本轮只交付合同和纯 Domain 规则，不创建数据库、不启用 Memory tools、不把 `maxManagementPhase` 扩到 3：

- `MemoryRecordDto` 支持 task scope 与 immutable source snapshot refs。
- `MemoryCapsuleDto` 每个 item 都带结构化 authorization。
- `MemoryCandidateDto` 明确外部 Agent 输出仍是 candidate。
- `evaluateMemoryInjection()` 固定 active/expiry/scope/source 四个硬门槛。
- `evaluateMemoryCapsuleAuthorization()` 固定目标、scope、hash、内容类型、脱敏级别、policy/grant version 与 expiry 复验。
- Phase 3 boundary checker 固定矩阵、合同、Domain、Node 24、Phase 2 不暴露 Memory 以及 CI gate。

## 5. 验证命令

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:phase3-memory
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build:phase3-memory
```

完整收口前还必须执行 `npm run test:ci`、`npm run build:packages` 与对应真实环境 smoke。验收状态只由 Phase 3 矩阵维护。
