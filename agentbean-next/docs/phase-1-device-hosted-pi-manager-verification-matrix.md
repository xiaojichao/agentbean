# Phase 1：Device-hosted PI Manager 单 Agent 调用验证矩阵

- 基线计划：`docs/superpowers/plans/2026-07-12-agentbean-phase-1-device-hosted-pi-manager.md`
- 前置矩阵：`agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`
- 当前实施切片：Task 6（Invocation Gateway 与 Dispatch attempt bridge）
- Phase 1 总体状态：In progress

本矩阵只记录可复现证据，不以观察时长替代验收。初始状态保持 Red/Not implemented；每项只有在对应实现进入 `main` 且 CI/真实链路证据可访问后才能改为 Green。

| ID | 验收项 | 当前状态 | 当前证据 / 后续动作 |
|---|---|---|---|
| P1-01 | PI wrapper 只暴露 Phase 1 effective tools，shadow write tools 仅 dry-run | Green | PR #507 / merge `d216898`：managed/shadow descriptor 精确为 11 个 Phase 1 tools，Phase 2/3 不可见，shadow write 仅记录 SHA-256 intent；main run `29214232850` 全绿。 |
| P1-02 | 真实 provider telemetry 与 typed context 不泄漏 PI 类型/secret | Green | PR #507 / merge `d216898`：冻结 `ManagementSessionContextV1`、AgentBean-owned telemetry、非法 provider content/secret fail-closed；main CI 与三平台 SEA aggregate 全绿。 |
| P1-03 | published daemon 在 clean install 中加载内置 PI runtime | Green | main run `29214232850` 已发布 `@agentbean/pi-management-runtime@0.1.0`、`@agentbean/daemon-next@0.3.7`、`@agentbean/daemon@0.3.7`；canonical `latest=0.3.7`、`legacy=0.1.35`，production smoke 全绿。 |
| P1-04 | management schema/constraints/migrations 可升级且可回滚 | Green（main） | PR #511 / merge `0590dbf`：九张 management 表、唯一/partial constraints、旧库升级、重复 apply 与 migration ledger 失败 rollback 已进入 main；main run `29217437939`、Railway deploy 与 production smoke 全绿。 |
| P1-05 | reservation + Run + first Event 原子且请求幂等 | Green（main） | PR #513 / merge `5d443ee`：memory/SQLite Kernel tests 覆盖 same-key/same-hash existing、different hash conflict 与 Run + first Event 原子创建；main run `29219542259`、Railway deploy 与 production smoke 全绿。 |
| P1-06 | lease acquire/renew/expire/reacquire 与 fencing 正确 | Green（main） | PR #509 的 fake-clock Domain policy 与 PR #513 的 Server clock/lease write authority tests 已覆盖 acquire/renew/release、expiry/reacquire、cross-host 与 stale/future fencing；真实 Socket 断线恢复留待 Task 7/8。 |
| P1-07 | event exact-key validation、sequence、replay 与脱敏正确 | Green（main） | PR #513 / merge `5d443ee`：exact-key validator、canonical SHA-256、递增 sequence、幂等冲突、terminal guard、forbidden payload 与 client diagnostic secret redaction已进入 main。 |
| P1-08 | checkpoint facts 同 snapshot，失效后忽略 hints 并重建 | Green（main） | PR #513 / merge `5d443ee`：同一 UoW snapshot 构造 exact/disjoint waiting/completed Invocation sets，支持历史 revision 幂等读取，authoritative drift 时丢弃全部旧 hints；真实 Worker restart recovery 留待 Task 8。 |
| P1-09 | Invocation immutable，Dispatch attempt 唯一且 status 只派生 | Candidate（local） | Task 6 gateway tests 已覆盖 canonical intent hash、same-key replay/drift conflict、Invocation + Dispatch + attempt + typed events 原子提交/回滚、active attempt guard、显式 retry +1，以及只从 canonical Dispatch rows 派生 view。 |
| P1-10 | Device 重启、断线、ack 丢失与 outbox 重放不重复执行 | Not implemented | Task 8：durable outbox、same-host recovery、one Dispatch/reply assertions。 |
| P1-11 | shadow 除独立决策记录和既有 direct 路径外零管理副作用 | Not implemented | Task 9：before/after repository diff 与 deterministic replay。 |
| P1-12 | barrier 后 Worker/Provider/tool 故障不回退 direct | Not implemented | Task 5、9：failure matrix 与 zero duplicate direct Dispatch。 |
| P1-13 | explicit custom Agent 轻问答真实链路完成且正确归因 | Not implemented | Task 10：browser/socket/Device E2E。 |
| P1-14 | AgentOS adapter 使用同一 Invocation 生命周期 | Candidate（local） | Task 6 gateway 对 `custom` / `agentos-hosted` 使用同一 Invocation/Dispatch lifecycle，并以 authoritative Agent category 校验 target kind；真实 adapter E2E 留待 Task 10。 |
| P1-15 | root Task 只在 management delivery 后 `in_review`，用户确认后完成 | Candidate（local） | Task 6 lifecycle tests 证明 managed external result 不改变 root Task 的 `in_progress`，既有 direct result 仍转 `in_review`；management delivery 与用户确认 E2E 留待 Task 10。 |
| P1-16 | direct 行为、PI 安全边界、build、CI 与 production smoke 不回归 | Not implemented | Task 11：Phase 0/full suite、Node 24 build、SEA、main CI 与 smoke URL。 |

## 固定边界

1. Phase 1 只支持显式点名的单 Agent 调用，不允许 PI 改选或追加执行 Agent。
2. 普通消息与 Task 由显式产品入口/rootTaskId 决定，不由模型自然语言分类。
3. Invocation 是 immutable intent；Dispatch 是 execution attempt 的唯一状态事实。
4. `managed` barrier 越过后禁止 direct fallback。
5. 只有 Phase 1 tools 可进入 managed/shadow Session；shadow write tools 只能记录脱敏 intent/hash，不得调用 Server write executor；coding/Phase 2/3 tools 均不可见。
6. 模型密钥只存在于 Device local credential provider，不进入 Server、event、checkpoint、log、outbox 或 `auth.json`。
7. Phase 1 不实现 Task DAG、claim、Memory、Server-hosted Worker、完整管理 UI 或平台服务安装器。
8. 内置 PI Manager 不作为 Team Agent，不接收普通 @mention。
