# Phase 0：PI 契约与兼容性验证矩阵

- 基线计划：`docs/superpowers/plans/2026-07-12-agentbean-phase-0-pi-contract-compatibility.md`
- 当前实施切片：收口与 Phase 1 handoff（Task 9）
- Phase 0 总体状态：完成

本矩阵记录可复现证据，不用日期或观察时长代替验收。只有 P0-01 至 P0-10、P0-12 全绿，且 P0-11 已形成明确 verdict，才允许进入 Phase 1。

| ID | 验收项 | 当前状态 | 当前证据 / 后续动作 |
|---|---|---|---|
| P0-01 | PI 依赖只存在于 wrapper package，精确锁定 `0.80.6` | Green（main） | `npm run test:phase0-boundary`（13 项）和 `npm run check:phase0-pi-boundary` 已进入 root CI，并校验唯一 import/manifest 边界及 manifest/lock 版本。`package-lock.json` 记录两项依赖的 registry tarball integrity 与 [MIT license](https://github.com/earendil-works/pi/blob/main/LICENSE)，版本均精确锁定为 `0.80.6`；上游源码为 [earendil-works/pi](https://github.com/earendil-works/pi)。`npm audit --omit=dev` 未把当前 advisory 归因到 PI 依赖链。 |
| P0-02 | AgentBean package 不暴露原始 PI SDK 类型或实例 | Green（main） | `public-api.test.ts` 对构建后的 declaration 执行 snapshot 式边界扫描：公开面只有 `createManagementRuntimeFactory`、`MANAGEMENT_TOOL_NAMES` 和 26 个 AgentBean-owned types；compile-negative fixture 证明 `AgentSession` 不能从 package import，declaration 不含 `@earendil-works` 或 PI 原始类型。 |
| P0-03 | Session 支持 event、prompt、steer、followUp、compaction、abort、dispose | Green（main） | wrapper 共 4 个 test files / 21 项测试，使用真实 `createAgentSession` 与零网络 deterministic model adapter；覆盖结构化 tool loop、脱敏 tool lifecycle、active abort、并发 Session、并发 dispose 与失败补偿清理。只有 PI 明确的短上下文/已压缩错误映射为 `not_needed`。 |
| P0-04 | effective tools 与 management allowlist 完全相等 | Green（main） | `tool-boundary.test.ts` 固定 23 项 metadata snapshot；Session 创建后及每次 model call 前检查无重复集合等值，缺失、额外或 coding tool 均 fail closed；完整 descriptor/schema 进入 AgentBean model seam。 |
| P0-05 | 不加载 coding tools、PI 全局/项目资源或 cwd | Green（main） | `resource-loader.test.ts` 在恶意 HOME/cwd fixture 下验证只有显式 system prompt 和固定工具进入模型上下文，PI 全局/项目资源及 coding tools 均未加载。 |
| P0-06 | Management contracts typed/versioned，禁止敏感 payload | Green（main） | Contracts 15 项通过；Management、Task coordination、Invocation、Event、Checkpoint、Memory reference 均使用显式类型和 `schemaVersion: 1`。compile-negative fixture 证明 public schema 不声明自由 `Record<string, unknown>` payload 或敏感字段，并拒绝 `direct/shadow` Run 与 Invocation intent mutation；declaration scan 拒绝 PI SDK import。 |
| P0-07 | rollout policy 与 fallback barrier 是纯领域规则 | Green（main） | Domain 57 项通过（含既有 24 项）；纯函数覆盖 direct 零 management side effect、shadow namespaced decision record、managed 五项 preflight、受控单 Agent 回退、reservation 前置命令、全部八类持久副作用后的不可逆 barrier，以及“已有副作用但缺 reservation”强制 recovery。 |
| P0-08 | Invocation intent immutable 且幂等冲突规则固定 | Green（main） | Contracts + Domain gates 覆盖 readonly intent compile contract、稳定 canonical serialization，以及同一 ManagementRun 内 same-key/same-hash existing、same-key/different-hash conflict，不同 Run 的同名 key 互不冲突。Phase 0 不实现数据库唯一约束。 |
| P0-09 | authoritative refs 失效时拒绝 context hints | Green（main） | Domain gate 覆盖 ManagementRun、event sequence、task graph revision、open Task、waiting/completed Invocation 分类和有效 Memory Capsule；任一 authoritative fact 不一致即 `rebuild_required`，返回值不含 `contextHints`。 |
| P0-10 | 现有 direct Dispatch/Task/Artifact/Workspace Run 行为不变 | Green（main） | `phase-0-management-boundary.test.ts` 通过公开 Server use cases 与 repository read seam 锁定：channel/DM direct 只创建 Dispatch；Message 只在读路径投影 repository 中的 `dispatchId/dispatchStatus`；agent delivery 进入 `in_review` 后由 human Task update 转 `done`；Task CRUD 不变；Artifact/Workspace Run 继续只关联 `dispatchId`。同一测试与 readiness 静态门禁确认 Socket、repository、SQLite migration 均无 management execution surface。 |
| P0-11 | SEA 跨平台形成 `compatible` 或 `blocked-for-phase5` verdict | Green（compatible） | [main PI SEA compatibility run #29195633845](https://github.com/xiaojichao/agentbean/actions/runs/29195633845) 在 Node 26.5.0 原生 runner 上完成 Linux x64、macOS arm64、Windows x64 的 bundle、executable build、平台签名、clean-directory execution 与真实 PI Session smoke；三份平台 verdict 和 aggregate artifact 均为 `compatible`，`diagnosticCodes: []`。生产与常规 CI 的 Node 24 基线未改变。 |
| P0-12 | Phase 0 root scripts、build、readiness、既有全量 suite 与 CI 通过 | Green（main） | PR #501 merge commit `1ff28f1` 的 [main CI run #29195633840](https://github.com/xiaojichao/agentbean/actions/runs/29195633840) 已通过 Validate AgentBean Next：Node 24.18 下 `test:phase1` 884 项通过、1 项既有 PTY E2E 跳过；Server 390/390；`test:phase0` 112 项、SEA tests 14 项、readiness 60/60、`build:phase0`、`build:packages`、Team 术语检查和 browser smoke 全部通过。 |

## Runtime 边界不变量

1. 只有 `packages/pi-management-runtime` 可以声明或 import `@earendil-works/pi-*`。
2. Server、Device、Contracts、Domain、Web 只依赖 AgentBean 的 `ManagementRuntimeFactory` / `ManagementSession` 类型。
3. PI 使用 in-memory auth、model registry、settings 和 session manager；不读取用户 PI credential/config/session。
4. 资源加载器不发现 extension、skill、prompt template、theme、`AGENTS.md`、`CLAUDE.md` 或 cwd 文件。
5. 只有固定 management tool catalog 可进入 PI Session；内建 coding tools 被禁用，effective tool set 必须精确相等。
6. 管理工具 executor 由后续阶段注入；本切片不连接 Server，不产生真实管理副作用。
7. model seam 保留结构化 assistant tool call 与 tool result 关联，但使用 AgentBean 自有类型，不把 PI `Context`、`Model` 或 `ToolDefinition` 暴露给调用方。

## 已知后续门禁

- 当前 deterministic model response 的 usage/cost 固定为零。真实 provider 接线前必须扩展 AgentBean-owned usage、finish reason 与 response model，不能让 Server 或 Device 直接读取 PI 类型。
- Phase 1 的 checkpoint、权限过滤 context 和 Memory Capsule 必须以 typed session input 扩展，不得拼成长 prompt，也不得暴露 PI `ResourceLoader`。
- TypeScript event DTO 只冻结 public schema；Phase 1 Server append 边界必须增加 exact-key runtime validator 与脱敏，不能依赖 structural typing 阻止额外敏感字段。
- Phase 1 组装 checkpoint facts 时必须使用同一数据库快照，并补 exact/disjoint set 校验；Dispatch rows 到 Invocation view 只能有一套纯派生规则，不得增加独立 Invocation status writer。
- P0-11 已证明固定 `/` cwd/agentDir、完整 management allowlist 与自定义 resource loader 在三平台 SEA 中 compatible；若未来启用 PI 内建 themes/docs/skills 或 package assets，必须新增 asset-aware SEA gate，不能沿用本次 verdict 扩大兼容承诺。

## Phase 1 handoff

Phase 0 只证明 AgentBean-owned contract、PI wrapper、现有 direct 路径和目标打包方式具备进入下一阶段的条件，不代表 PI 管理能力已向用户开放。Phase 1 可以从 Device-hosted PI Manager 单 Agent 调用开始，但必须继续遵守以下边界：

1. Server、Device、Contracts、Domain 与 Web 不得直接 import 或暴露 PI 类型。
2. 只有 `managed` 路径可以产生 ManagementRun/Invocation 管理副作用；`direct` 与 `shadow` 继续服从已冻结的 rollout/fallback 规则。
3. 管理工具必须通过 AgentBean executor、权限、lease、幂等与 event append 边界，不得把 PI tool execution 直接接到 repository。
4. Phase 1 不以 SEA 自包含发布为前置条件；SEA verdict 只保留给 Phase 5 打包决策，并在资产加载边界变化时重新验证。
