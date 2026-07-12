# Phase 0：PI 契约与兼容性验证矩阵

- 基线计划：`docs/superpowers/plans/2026-07-12-agentbean-phase-0-pi-contract-compatibility.md`
- 当前实施切片：PR 1，PI Runtime 边界（Tasks 1–3）
- Phase 0 总体状态：进行中

本矩阵记录可复现证据，不用日期或观察时长代替验收。只有 P0-01 至 P0-10、P0-12 全绿，且 P0-11 已形成明确 verdict，才允许进入 Phase 1。

| ID | 验收项 | 当前状态 | 当前证据 / 后续动作 |
|---|---|---|---|
| P0-01 | PI 依赖只存在于 wrapper package，精确锁定 `0.80.6` | Green（本地） | `npm run test:phase0-boundary`（12 项）；`npm run check:phase0-pi-boundary`；`package-lock.json`。checker 扫描 repo-wide 受控源码与 manifests，缺失/陈旧 lock 均失败。`pi-ai` 是构造受控流式 provider 所需的直接类型/事件流依赖，`pi-coding-agent` 未重导出该能力，二者均精确锁定。`npm audit --omit=dev` 未把任何当前 advisory 归因到 PI 依赖链。 |
| P0-02 | AgentBean package 不暴露原始 PI SDK 类型或实例 | Green（本地） | `npm run build:pi-management-runtime`；`public-api.test.ts` 构建并扫描 declarations，再用 compile-negative fixture 证明 `AgentSession` 不能从 package import。 |
| P0-03 | Session 支持 event、prompt、steer、followUp、compaction、abort、dispose | Green（本地） | wrapper 共 4 个 test files / 21 项测试，使用真实 `createAgentSession` 与零网络 deterministic model adapter；覆盖结构化 tool loop、脱敏 tool lifecycle、active abort、并发 Session、并发 dispose 与失败补偿清理。只有 PI 明确的短上下文/已压缩错误映射为 `not_needed`。 |
| P0-04 | effective tools 与 management allowlist 完全相等 | Green（本地） | `tool-boundary.test.ts`；固定 23 项 metadata snapshot；Session 创建后及每次 model call 前检查无重复集合等值，缺失、额外或 coding tool 均 fail closed；完整 descriptor/schema 进入 AgentBean model seam。 |
| P0-05 | 不加载 coding tools、PI 全局/项目资源或 cwd | Green（本地） | `packages/pi-management-runtime/tests/resource-loader.test.ts` 在恶意 HOME/cwd fixture 下验证只有显式 system prompt 和固定工具进入模型上下文。 |
| P0-06 | Management contracts typed/versioned，禁止敏感 payload | Not started | 后续 Contract boundary PR。 |
| P0-07 | rollout policy 与 fallback barrier 是纯领域规则 | Not started | 后续 Domain policy PR。 |
| P0-08 | Invocation intent immutable 且幂等冲突规则固定 | Not started | 后续 Contract/Domain PR。 |
| P0-09 | authoritative refs 失效时拒绝 context hints | Not started | 后续 Contract/Domain PR。 |
| P0-10 | 现有 direct Dispatch/Task/Artifact/Workspace Run 行为不变 | Not started | 后续 Existing behavior lock PR。 |
| P0-11 | SEA 跨平台形成 `compatible` 或 `blocked-for-phase5` verdict | Unknown | 后续独立 SEA verdict PR；当前不升级生产 Node。 |
| P0-12 | Phase 0 root scripts、build、readiness、既有全量 suite 与 CI 通过 | In progress | 本 PR 提供 runtime boundary scripts/build；待本地全量验证与 PR CI，完整 Phase 0 CI gate 在后续 CI integration PR 收口。 |

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
- 固定 `/` cwd/agentDir 的 Windows 与 SEA 行为尚未裁决，只能由 P0-11 三平台 matrix 形成 `compatible` 或 `blocked-for-phase5` verdict。
