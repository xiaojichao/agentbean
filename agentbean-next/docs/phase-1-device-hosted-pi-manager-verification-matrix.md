# Phase 1：Device-hosted PI Manager 单 Agent 调用验证矩阵

- 基线计划：`docs/superpowers/plans/2026-07-12-agentbean-phase-1-device-hosted-pi-manager.md`
- 前置矩阵：`agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md`
- 当前实施切片：Task 11（CI integration、真实 Device smoke 与 closeout）
- Phase 1 总体状态：Candidate（Task 1-10 已进入 `main`；Task 11 等待 PR/main 验证）

本矩阵只记录可复现证据，不以观察时长替代验收。初始状态保持 Red/Not implemented；每项只有在对应实现进入 `main` 且 CI/真实链路证据可访问后才能改为 Green。

| ID | 验收项 | 当前状态 | 当前证据 / 后续动作 |
|---|---|---|---|
| P1-01 | PI wrapper 只暴露 Phase 1 effective tools，shadow write tools 仅 dry-run | Green | PR #507 / merge `d216898`：managed/shadow descriptor 精确为 11 个 Phase 1 tools，Phase 2/3 不可见，shadow write 仅记录 SHA-256 intent；main run `29214232850` 全绿。 |
| P1-02 | 真实 provider telemetry 与 typed context 不泄漏 PI 类型/secret | Green | PR #507 / merge `d216898`：冻结 `ManagementSessionContextV1`、AgentBean-owned telemetry、非法 provider content/secret fail-closed；main CI 与三平台 SEA aggregate 全绿。 |
| P1-03 | published daemon 在 clean install 中加载内置 PI runtime | Green | main run `29214232850` 已发布 `@agentbean/pi-management-runtime@0.1.0`、`@agentbean/daemon-next@0.3.7`、`@agentbean/daemon@0.3.7`；Task 11 又在 Node 24.18.0 clean `npm ci` 后实际加载 `better-sqlite3`、PI runtime 与 postject。 |
| P1-04 | management schema/constraints/migrations 可升级且可回滚 | Green（main） | PR #511 / merge `0590dbf`：九张 management 表、唯一/partial constraints、旧库升级、重复 apply 与 migration ledger 失败 rollback 已进入 main；main run `29217437939`、Railway deploy 与 production smoke 全绿。 |
| P1-05 | reservation + Run + first Event 原子且请求幂等 | Green（main） | PR #513 / merge `5d443ee`：memory/SQLite Kernel tests 覆盖 same-key/same-hash existing、different hash conflict 与 Run + first Event 原子创建；main run `29219542259`、Railway deploy 与 production smoke 全绿。 |
| P1-06 | lease acquire/renew/expire/reacquire 与 fencing 正确 | Green（main） | PR #509、#513、#517 / merge `ab20adb` 已覆盖 fake-clock policy、Server write authority、真实 Socket lease ACK、disconnect、expiry 后 fencing token `1 → 2` 的 reconnect recovery。 |
| P1-07 | event exact-key validation、sequence、replay 与脱敏正确 | Green（main） | PR #513 / merge `5d443ee`：exact-key validator、canonical SHA-256、递增 sequence、幂等冲突、terminal guard、forbidden payload 与 client diagnostic secret redaction已进入 main。 |
| P1-08 | checkpoint facts 同 snapshot，失效后忽略 hints 并重建 | Green（main） | PR #513 / merge `5d443ee`：同一 UoW snapshot 构造 exact/disjoint waiting/completed Invocation sets，支持历史 revision 幂等读取，authoritative drift 时丢弃全部旧 hints；真实 Worker restart recovery 留待 Task 8。 |
| P1-09 | Invocation immutable，Dispatch attempt 唯一且 status 只派生 | Green（main） | PR #515 / merge `fd4e0ce`：canonical intent hash、same-key replay/drift conflict、Invocation + Dispatch + attempt 原子提交/回滚、active attempt guard、显式 retry `+1` 与 canonical Dispatch projection 已进入 main。 |
| P1-10 | Device 重启、断线、ack 丢失与 outbox 重放不重复执行 | Green（main） | PR #519 / merge `90f6db0`：真实 `DeviceServiceCore` composition、per-profile durable outbox、same-host replay、reconnect/reacquire、完成态清理与 one-command assertions 已进入 main。 |
| P1-11 | shadow 除独立决策记录和既有 direct 路径外零管理副作用 | Green（main） | PR #521 / merge `1bdc945`：shadow 只写独立 request namespace decision；repository before/after diff 证明 Run、lease、event、checkpoint、Invocation、attempt 均为零副作用。 |
| P1-12 | barrier 后 Worker/Provider/tool 故障不回退 direct | Green（main） | PR #519、#521、#523：credential/preflight fail-closed，barrier 后 offline、provider/session、tool、timeout、cancel 均进入 managed terminal/recovery；replay 仍只有一个 Dispatch。 |
| P1-13 | explicit custom Agent 轻问答真实链路完成且正确归因 | Candidate（Task 11 local） | PR #523 / merge `77cf680` 已完成 managed vertical；Task 11 `phase-1-managed-device-smoke.test.ts` 又通过真实 Socket.IO、`DeviceServiceCore`、WorkerHost、durable outbox 和 custom Agent 产生唯一 Agent sender/reply。 |
| P1-14 | AgentOS adapter 使用同一 Invocation 生命周期 | Green（contract）/ Live Not Run | PR #515、#523 已证明 `custom` / `agentos-hosted` 共用 Invocation/Dispatch lifecycle，并按 authoritative category 冻结 target kind；本轮没有可授权的真实 AgentOS managed 环境，因此不伪造 live verdict。 |
| P1-15 | root Task 只在 management delivery 后 `in_review`，用户确认后完成 | Green（main） | PR #523 / merge `77cf680`：Agent 原始结果保持 root Task `in_progress`；`review.submit_root_delivery` 生成唯一 system management delivery 并转 `in_review`，仅 human `done` 完成 Task/Run。 |
| P1-16 | direct 行为、PI 安全边界、build、CI 与 production smoke 不回归 | Candidate（Task 11 local） | Node 24.18.0：runtime 31、contracts 25、domain 68、server 441、daemon 244（另 1 个既有 skip）、Web 199 全量测试通过；`build:phase1-management`、readiness 64/64、真实 browser smoke、macOS arm64 SEA executable smoke 全绿。Task 10 main CI/CD `29245642149` 与 PI SEA `29245642141` 已全绿；Task 11 main URL 待合并后记录。 |

## 固定边界

1. Phase 1 只支持显式点名的单 Agent 调用，不允许 PI 改选或追加执行 Agent。
2. 普通消息与 Task 由显式产品入口/rootTaskId 决定，不由模型自然语言分类。
3. Invocation 是 immutable intent；Dispatch 是 execution attempt 的唯一状态事实。
4. `managed` barrier 越过后禁止 direct fallback。
5. 只有 Phase 1 tools 可进入 managed/shadow Session；shadow write tools 只能记录脱敏 intent/hash，不得调用 Server write executor；coding/Phase 2/3 tools 均不可见。
6. 模型密钥只存在于 Device local credential provider，不进入 Server、event、checkpoint、log、outbox 或 `auth.json`。
7. Phase 1 不实现 Task DAG、claim、Memory、Server-hosted Worker、完整管理 UI 或平台服务安装器。
8. 内置 PI Manager 不作为 Team Agent，不接收普通 @mention。

## Task 11 本地 closeout 证据

- Node：官方/本机 Node `24.18.0`；根 `engines.node=24.x`、`.nvmrc=v24.18.0`，所有 CI/deploy/SEA `setup-node` 均锁定 `24.18.0`。
- clean install：Node 24 `npm ci` 成功，`better-sqlite3` 创建 `:memory:` 数据库成功；Node 26 不再参与任何后续 gate。
- test：Phase 1 boundary 11/11、PI runtime 31/31、contracts 25/25、domain 68/68、server 441/441、daemon 244/244（1 个既有 PTY E2E skip）、Web 199/199。
- build：contracts、domain、PI runtime、server-next、daemon-next、web-next/Next production build 全绿。
- live Device：真实 Socket.IO + Device Service + WorkerHost + custom Agent managed 调用通过；唯一 Agent reply、tool result succeeded、outbox `0`、active lease `0`。
- SEA：Node 24 legacy blob + postject 链在 macOS arm64 生成、签名、clean-directory 执行真实 PI Session，8 个 verdict checks 全绿；Linux x64/Windows x64 由 PR workflow 给出最终平台 verdict。
- regression：完整 server/browser smoke 保留 direct 路径；shadow zero-side-effect、disconnect/restart/outbox/fencing/idempotency 均由进入 main 的专用回归测试覆盖。
