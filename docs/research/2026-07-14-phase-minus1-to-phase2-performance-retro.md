# AgentBean Phase -1 至 Phase 2 任务耗时复盘与后续提速方案

日期：2026-07-14  
范围：Phase -1、Phase 0、Phase 1、Phase 2 的全部计划任务，共 43 项  
证据范围：仓库 plan/spec/matrix、Git commit、GitHub PR/Actions API 与失败日志；不使用二手总结

## 结论先行

这四个阶段“每个任务半小时到一小时以上”的主因，不是单一的 Agent 执行慢，而是以下五类时间叠加：

1. **计划把绝大多数任务排成 merge-to-main 后才开始下一个任务的串行链。** Phase 0 约 9 小时 52 分、Phase 1 约 21 小时 7 分、Phase 2 到功能收口约 24 小时 33 分；但多数 PR 打开后只需 5–18 分钟合并，长间隔主要发生在 PR 之前、跨夜或等待环节。
2. **CI 门禁按 Phase 叠加，而不是按 package 去重。** 最新 main run `29339934281` 的 Validate job 用时 7 分 18 秒，其中 Phase 测试 186 秒、重复 build 102 秒、browser smoke 79 秒。`test:phase1-management` 内再次运行完整 `test:phase1`，`test:phase2-task-dag` 又重复 contracts/runtime/domain/server；build 同样重复。
3. **后续阶段的完整测试面越来越大，并被本地和 PR/main CI 重复执行。** Phase 2 closeout 本地一次跑了 contracts、runtime、domain、server、daemon、web、Phase 0/1/2 boundary、SEA、readiness 和两个 build；这是必要的最终证据，但不应在每个中间 Task 都全量重复。
4. **少数“8 小时 PR”其实是等待，不是编码。** 例如 Phase 1 Task 2 的 [PR #507](https://github.com/xiaojichao/agentbean/pull/507) 在 15:39 UTC 已全部检查成功，23:54 UTC 才合并，约 8 小时 15 分是绿灯后的等待。Phase -1 的生产观察 PR #475/#480 也把真实观察窗口计入 PR open time。
5. **真正返工集中在跨层边界与发布收口。** Phase -1 Release A 是 95 文件、29 commits 的原子 PR，review 后又补了 test config、WebUI build、Team state race；Phase 2 #532/#545/#555 分别返工 exact-key/SEA source、旧 Phase 护栏、browser 默认频道；Phase 2 完成后又以 #560 补 canonical daemon 发布。

因此，后续阶段最有效的提速不是放松 correctness，而是：**并行开发可独立 lane、每个 package suite/build 只跑一次、把 full closeout 延后到 integration PR、CI 绿灯后自动推进、把发布闭包提前写成机器门禁。**

## 方法与时间口径

### 使用的一手资料

- 总设计与阶段门禁：[`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`](../../docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md)
- 四份实施计划：
  - [`Phase -1 plan`](../../docs/superpowers/plans/2026-07-10-agentbean-phase-minus-1-team-terminology.md)
  - [`Phase 0 plan`](../../docs/superpowers/plans/2026-07-12-agentbean-phase-0-pi-contract-compatibility.md)
  - [`Phase 1 plan`](../../docs/superpowers/plans/2026-07-12-agentbean-phase-1-device-hosted-pi-manager.md)
  - [`Phase 2 plan`](../../docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md)
- 四份验收矩阵：
  - [`Phase -1 matrix`](../../agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md)
  - [`Phase 0 matrix`](../../agentbean-next/docs/phase-0-pi-contract-compatibility-verification-matrix.md)
  - [`Phase 1 matrix`](../../agentbean-next/docs/phase-1-device-hosted-pi-manager-verification-matrix.md)
  - [`Phase 2 matrix`](../../agentbean-next/docs/phase-2-task-dag-team-claim-verification-matrix.md)
- GitHub PR API：`created_at`、`merged_at`、commits、files、additions/deletions、review/check 时间线。
- GitHub Actions API：main run、job、step 起止时间；失败 run 使用官方 job log。

### 本文采用三种耗时

- **PR open**：`created_at → merged_at`，精确，但包含 review/等待，不等于编码时间。
- **merge cadence**：上一个计划 PR merge → 当前 PR merge，是严格串行流程下用户感知的交付间隔上界；包含本地开发、休息、其他任务和等待。
- **CI**：GitHub Actions `created_at/run_started_at → updated_at` 或 job/step 起止时间，精确。

仓库没有记录每项 Task 的 `started_at`、本地测试起止、Agent token/runtime、人工 review 等待开始/结束，因此**无法精确计算纯开发耗时、纯 Agent 推理耗时、纯本地验证耗时**。本文不会把 merge cadence 冒充纯执行时间。

### 逐任务耗时分类索引

下列标签是依据 PR commit/check/review/merge/production 时间线作出的主导因素分类；`active` 只表示代码/测试工作主导，不代表已有精确 active timer。

| 阶段 | Task 分类 |
|---|---|
| Phase -1 | T1 `active`；T2 `active + review follow-up`；T3 `active/migration`；T4 `active/integration`；T5 `active/browser integration`；T6 `active + bug rework`；T7 `active/verification`；T8 `observation gate 后的 release`；T9 `active + unknown gap`；T10 `active + CI integration rework`；T11 `observation gate + production incident + review wait` |
| Phase 0 | T1–T3 `active/bundled`；T4–T5 `active/bundled`；T6 `active/local verification`；T7 `active + cross-platform CI`；T8 `active + CI integration rework`；T9 `CI/main evidence` |
| Phase 1 | T1 `active`；T2 `review wait` 主导；T3 `active + CI queue wait`；T4 `active/migration`；T5 `active/state-machine tests`；T6 `unknown pre-PR gap`；T7 `active/integration`；T8 `active/recovery`；T9 `active`；T10 `active/E2E`；T11 `active full closeout + CI` |
| Phase 2 | T1–T2 `active + review follow-up`；T3 `active + external deploy failure`；T4 `active + superseded CI`；T5 `active`；T6 `paused/off-hours + active`；T7 `active + review rework`；T8–T10 `active`；T11 `unknown pre-PR gap + browser rework`；T12 `active full closeout + superseded CI` |

## 阶段总览

| 阶段 | 计划任务 | 可验证的阶段窗口 | 主要交付 | 主要长耗时来源 |
|---|---:|---:|---|---|
| Phase -1 | 11 | plan 首 commit `f93bb9b` → #487：约 **42h** | Release A #470、Release B #485、closeout #487 | 95 文件原子切换、生产观察、真实 incident、Release B 强门禁 |
| Phase 0 | 9 | #489 → #503：**9h51m53s** | #493/#495/#497/#499/#501/#503 | Runtime/contract 两个大切片、本地全量验证、CI integration 返工 |
| Phase 1 | 11 | #505 → #528：**21h06m49s** | #507–#528 | #507 绿灯后等待约 8h15m、串行依赖、Device/outbox/recovery 大切片 |
| Phase 2 | 12 | #530 → #557：**24h33m**；到 #560：**25h24m** | #532–#557，release #560 | 两个跨夜/长空档、每 PR 全量门禁、review follow-up、发布闭包遗漏 |

## Phase -1：每项任务复盘

计划的 Release A 把 Tasks 1–7、9–10 与 Task 11 前半部分放在同一 release branch；Task 8 和 Task 11 后半部分只能等生产证据后进入 Release B。该结构见 Phase -1 plan 的 `Execution Order and Review Gates`。因此这里本来就不是 11 个独立、可准确计时的 PR。

### Release A 任务（PR #470）

[PR #470](https://github.com/xiaojichao/agentbean/pull/470) 共 29 commits、95 files、`+2834/-3853`；首个 task commit authored at `2026-07-10 10:30 UTC`，合并于 `2026-07-11 01:36 UTC`，跨度约 15 小时 7 分；PR open 4 小时 35 分。main [run 29134937662](https://github.com/xiaojichao/agentbean/actions/runs/29134937662) 只用 4 分 54 秒，因此这次长耗时主要不在 main CI。

| Task | 内容 | 实际映射与可测时间 | 为什么变长 | 后续优化 |
|---|---|---|---|---|
| 1 | contracts admin 空间事件 | #470 commits `ff8db73`；到下一 task commit 约 11m | 窄合同改动，本身不长 | 保持独立 contract test；无需全量 Web/Server build |
| 2 | Server handler 与 DTO | `c62aa30`、`8eefee9`；约 20m 到下一 task | review 又补全局管理员删除权限，说明授权边界与 DTO 同时变化 | 在 task intake 列出 auth + projection 两张检查表，分别做 targeted test |
| 3 | revocation schema | `c008f8f`、`3b8c54d`；约 18m | 升级与 rollback index 都要验证，属于必要 migration 成本 | 使用共享 migration harness，一次覆盖 fresh/upgrade/rollback，不重复启动全套 Server |
| 4 | Web model/socket Team 字段 | `bbb4c87`、`fe187c8`；约 16m | contracts 与 consumer 原子切换，无法单独部署 | 可并行开发，最后在 integration branch 原子合并；不要要求开发也串行 |
| 5 | route tree、Team 管理入口、browser key | `633c2fa` 到下一主任务约 2h34m（上界） | App Router 路径、storage migration、redirect、刷新恢复跨层，且容易出现全局状态 race | 先写 browser migration harness + route manifest test；Web lane 独立 worktree 并行 |
| 6 | artifact/device-login/agent-create 兼容参数 | `f6cacb8` 后又出现 3 个 Agent scan correctness commits；约 52m | 移除兼容字段暴露了 scanned/custom Agent 语义 bug，实际 scope 超出参数改名 | 把 compatibility removal 与 Agent category invariant 作为同一预检；先跑 source→DTO→UI 纵向 contract test |
| 7 | readiness/browser/入口验收 | `46a6425`、`71adf59`；约 23m 到文档任务 | browser smoke 首次真正触达多个用户路径，发现晚集成问题 | smoke skeleton 在 Task 1 建立，每个 lane 只补场景；不要到 Task 7 才第一次组合 |
| 9 | 活动文档和 Phase -1 证据 | `30bf379`、`bf4b9a4`、`01ca6ea`；到 T10 commit 约 4h56m（含不可判定空档） | 文档要求与真实实现同步，不能提前做；空档不能证明是执行慢 | 从机器可读 manifest 生成状态表，人工只写解释，减少反复 scan |
| 10 | 静态术语门禁与 CI | `421cf45` 起，后续还补 crash window、runtime 字段和 browser CI | 门禁晚接入，一次暴露 test config、dist/source 和 WebUI build 问题 | checker 在 Task 1 先以 allowlist 方式落地，逐 task 缩 allowlist；CI 集成不留到最后 |

### Release/观察任务

| Task | 内容 | 实际映射与可测时间 | 为什么变长 | 后续优化 |
|---|---|---|---|---|
| 8 | Release B 退役 legacy source | [PR #485](https://github.com/xiaojichao/agentbean/pull/485)，231 files、`-54266`；PR open 18m20s；main [29177487834](https://github.com/xiaojichao/agentbean/actions/runs/29177487834) 6m20s | 删除量大，但真正等待来自“Release A 生产证据成立后才能做”的风险门禁 | 不能取消门禁；可预生成 deletion manifest、rollback manifest 和 dry-run checker，证据一到即提交 |
| 11 | Release A→观察→Release B→closeout | #470、#471、#475、#476、#473、#478、#480、#485、[#487](https://github.com/xiaojichao/agentbean/pull/487) | 这是阶段最大耗时源。Release A→B 约 25h19m；中间真实发现 stale Team race 并由 #475/#476 修复；#475 单 commit 但 open 6h13m，#480 open 5h26m，均含等待/观察 | UI 明确显示 `awaiting_production_observation`，不要算作 Agent running；并行跑 Team/Device/Artifact/browser 四类 observation；证据自动汇总到 artifact/issue |

补充：#470 review 后继续加入 `7798591/fa8438a/9020476`（测试配置、Web test source、WebUI build）与 `7dcc2fd/a6ed1eb`（Team 创建/侧边栏状态 race）。这说明大原子 PR 的问题不是 main CI 慢，而是**跨层集成太晚、review 面太大**。

## Phase 0：每项任务复盘

Plan 明确的 PR 切片是：Tasks 1–3→#493，Tasks 4–5→#495，Task 6→#497，Task 7→#499，Task 8→#501，Task 9→#503；#489 是计划 PR。

| Task | 内容 | PR / merge cadence / PR open | 主要耗时原因 | 优化 |
|---|---|---|---|---|
| 1 | matrix 与 dependency guard | 与 T2/T3 同属 [#493](https://github.com/xiaojichao/agentbean/pull/493)；无法单独计时 | 3 tasks 被打成 `+4665/19 files` 单 PR | Matrix/checker 可先单独合并；runtime API 确认后 T2/T3 并行 |
| 2 | 唯一 PI wrapper package | #493；上一个计划 merge→#493 为 2h03m；PR open 1h24m | 新 package、依赖锁、public API、测试、build 同时建立 | 提供 package template；dependency/lockfile 只 install 一次；先冻结 API snapshot |
| 3 | hermetic loader 与 tool catalog | #493，共用上面时间 | negative resource/tool 安全测试较多，但不能从 PR 元数据拆分纯耗时 | 与 wrapper 实现并行写测试；最终只做一次 package build |
| 4 | Management/Invocation/Event/Checkpoint contracts | 与 T5 同属 [#495](https://github.com/xiaojichao/agentbean/pull/495)；merge cadence 2h46m；PR open 18m | 17 files、`+1482`，大部分时间发生在 PR 前 | contracts lane 与 Domain lane 在 vocabulary 冻结后并行；独立 worktree/stacked PR |
| 5 | rollout/idempotency/checkpoint Domain rules | #495，共用上面时间 | 与 T4 串行写会把可并行纯函数测试变成单链 | contracts draft 确认后立即并行写 table-driven Domain tests |
| 6 | 锁定现有 execution truth | [#497](https://github.com/xiaojichao/agentbean/pull/497)；cadence 1h04m；open 7m52s | PR 很快，时间主要是 PR 前 targeted/full regression | 每次 task 只跑相关 Server regression + matching build；full suite 留 integration |
| 7 | Node SEA 三平台 | [#499](https://github.com/xiaojichao/agentbean/pull/499)；cadence 44m；open 16m52s；main SEA [29190495361](https://github.com/xiaojichao/agentbean/actions/runs/29190495361) 2m46s | 三平台 native 验证本身复杂，但 CI 已并行，实际不是阶段最大瓶颈 | 保留三平台并行；只在 runtime/package/lockfile/SEA scripts 改动时触发 |
| 8 | root CI integration | [#501](https://github.com/xiaojichao/agentbean/pull/501)；cadence 2h52m；open 17m51s | 3 commits，后两次专门修 Windows CRLF；大量时间在 PR 前整合和本地全量门禁 | workflow/parser 从一开始就做 LF/CRLF fixture；CI 配置修改先跑 Node cross-platform unit test |
| 9 | matrix 与 Phase 1 handoff | [#503](https://github.com/xiaojichao/agentbean/pull/503)；cadence 21m49s；open 11m04s | verification-only，实际较快 | 由 CI 生成 run/commit/verdict JSON，closeout 只消费 JSON，目标 <10m |

Phase 0 总体最值得优化的是 Tasks 1–5：plan 本身已经允许 Contract boundary 与 SEA 在 Runtime boundary 后并行，但实际仍按 merge 链推进。#493、#495 的 PR open 合计仅约 1h43m，二者从计划 merge 到 #495 merge 却用了约 4h49m，说明主要成本在本地串行实现/验证，不在 GitHub checks。

## Phase 1：每项任务复盘

| Task | 内容 | PR / merge cadence / PR open | 主要耗时原因 | 优化 |
|---|---|---|---|---|
| 1 | matrix 与静态门禁 | [#505](https://github.com/xiaojichao/agentbean/pull/505)；距 Phase 0 closeout 25m；open 8m38s | 本身不长 | 计划、matrix、checker skeleton 一次生成 |
| 2 | wrapper/provider/package | [#507](https://github.com/xiaojichao/agentbean/pull/507)；cadence 9h；open 8h19m | checks 15:39 UTC 全绿，23:54 才 merge；约 8h15m 是绿灯后等待，不是执行；另有 `+1294/26 files` 发布面 | 开启 green+无未解决 review 自动合并；任务状态切到 `awaiting_review`，停止计 Agent runtime |
| 3 | Worker/lease/tool RPC + Domain | [#509](https://github.com/xiaojichao/agentbean/pull/509)；cadence 53m44s；open 15m17s | 合同与 pure Domain 共 2042 行；main run `29216070463` 创建后约 13m38s 才真正开始，属于 runner/concurrency 等待 | contracts/domain 可并行；记录 Actions queue time 并单独展示；不要归因 Agent |
| 4 | schema/repositories/UoW | [#511](https://github.com/xiaojichao/agentbean/pull/511)；cadence 39m23s；open 4m19s | migration、9 表、rollback/constraints，PR 前验证为主 | 复用 migration matrix generator；memory/SQLite repository contract tests 参数化 |
| 5 | Server kernel/event/checkpoint | [#513](https://github.com/xiaojichao/agentbean/pull/513)；cadence 59m54s；open 4m56s | 原子性、exact-key、sequence、replay、脱敏多维组合 | 用 property/table-driven harness 一次枚举，不重复搭 Server fixture |
| 6 | Invocation→Dispatch attempt | [#515](https://github.com/xiaojichao/agentbean/pull/515)；cadence 3h23m；open 4m58s | PR 本身极快；长间隔发生在 PR 前且无任务 start 证据，不能断言为编码慢 | 增加本地 `task_started_at/first_test_at/pr_opened_at`；在无证据前将 3h18m标为 unknown gap |
| 7 | Worker transport/scheduler | [#517](https://github.com/xiaojichao/agentbean/pull/517)；cadence 1h16m；open 5m39s | transport + socket + lease ACK 联调 | 与 T8 的 Device host 部分并行，先共用协议 fake server |
| 8 | DeviceServiceCore/credential/outbox/WorkerHost | [#519](https://github.com/xiaojichao/agentbean/pull/519)；cadence 2h07m；open 8m08s；`+1763/21 files` | durable outbox、restart、reconnect、fencing 是本阶段最复杂真实状态机 | 拆为 outbox persistence lane 与 WorkerHost composition lane，最后跑一个 recovery integration test |
| 9 | Team policy/shadow/managed routing | [#521](https://github.com/xiaojichao/agentbean/pull/521)；cadence 1h07m；open 4m43s | zero-side-effect 与 fail-closed 需要 repository diff | 提供 reusable before/after repository snapshot assertion |
| 10 | 单 Agent/root Task vertical | [#523](https://github.com/xiaojichao/agentbean/pull/523)；cadence 54m05s；open 6m09s | 首次整链验证，暴露 barrier/review lifecycle | vertical smoke skeleton 在 T4 后建立，后续逐步填充，不到 T10 才组装 |
| 11 | CI/live Device/closeout | [#528](https://github.com/xiaojichao/agentbean/pull/528)；cadence 45m15s；open 6m06s；main [29248263193](https://github.com/xiaojichao/agentbean/actions/runs/29248263193) 9m49s | clean install、native binding、全部 packages tests/build、browser、SEA 都集中在最后 | 只有 closeout 做 clean install/full matrix；中间 task 使用 Node24 预热环境与 targeted gates |

Phase 1 的 21 小时总窗口被两个事实显著放大：#507 的 8 小时多绿灯后等待，以及 #515 前 3 小时多 unknown gap。两者都不能用“Agent 执行慢”解释。真正复杂的编码切片是 T8，但它的 PR open 仅 8 分钟，说明本地 pre-PR 工作才是需要新增 telemetry 的区域。

## Phase 2：每项任务复盘

| Task | 内容 | PR / merge cadence / PR open | 主要耗时原因 | 优化 |
|---|---|---|---|---|
| 1 | matrix/static gate | 与 T2 同属 [#532](https://github.com/xiaojichao/agentbean/pull/532)；cadence 58m；open 35m | 3 commits、8 条 review；门禁与合同一起审，review 面偏大 | checker skeleton 单独先合；contract PR 只审 DTO/parser/tool surface |
| 2 | V2 contracts/runtime | #532，共用上面时间 | review 后收紧 exact-key/tool inputs，并修 SEA 对 workspace contract source 的解析 | 固化 `exactKeys()` helper 和 workspace-source-vs-dist test 模板，PR 前自动跑 retained Phase 0/1 guards |
| 3 | DAG/revision/claim Domain rules | [#534](https://github.com/xiaojichao/agentbean/pull/534)；cadence 56m51s；open 6m51s；main [29259249975](https://github.com/xiaojichao/agentbean/actions/runs/29259249975) failure | 代码 Validate 成功；失败发生在 Railway，3 次均 `Failed to retrieve build log`，是外部部署故障，不是代码返工 | feature-disabled internal PR 不阻塞于生产 deploy；将 deploy failure 与 code validation 分栏；后续成功 descendant run 可自动继承证明 |
| 4 | schema/repositories/UoW | [#538](https://github.com/xiaojichao/agentbean/pull/538)；cadence 1h01m；open 6m46s；main run `29263583579` 被后续 push 取消 | 持久化本身复杂；main run cancellation 来自并发策略，不等于失败 | 对 superseded run 识别成功 descendant SHA，不要求人工重跑；migration/UoW 使用参数化 harness |
| 5 | Coordination Kernel | [#541](https://github.com/xiaojichao/agentbean/pull/541)；cadence 1h10m；open 7m17s | revision/criterion/attempt/history 原子推进 | 和 T6 的 capability resolver 可在 stable kernel API 后并行 |
| 6 | capability/Claim Broker/transport | [#543](https://github.com/xiaojichao/agentbean/pull/543)；cadence 8h23m；open 7m59s | 约 8h15m 在 PR 前/跨夜，PR 与 CI 很快；无证据证明 Agent 连续运行 8h | 标记 `paused/off-hours`；恢复时从 checkpoint 继续，running SLA 不计暂停 |
| 7 | Phase 2 tools/recovery/checkpoint | [#545](https://github.com/xiaojichao/agentbean/pull/545)；cadence 1h14m；open 28m26s | 3 commits；review 后恢复 Phase 1 graph guard并修 Task 协调问题，属于真实回归返工 | 每个新 phase PR 强制跑 `retained-boundaries` 小门禁；review checklist 明列 previous-phase invariants |
| 8 | claim authority→Gateway | [#548](https://github.com/xiaojichao/agentbean/pull/548)；cadence 49m22s；open 7m16s | 跨 claim/dependency/invocation authority，但 PR 流程快 | 保持小纵切；只跑 gateway/claim targeted suite + matching build |
| 9 | delivery/evidence/acceptance | [#550](https://github.com/xiaojichao/agentbean/pull/550)；cadence 1h03m；open 7m31s | evidence canonicalization + criterion acceptance 组合多 | evidence resolver/acceptance 使用 shared scenario DSL，减少重复 fixture |
| 10 | retry/reopen/reassign/root aggregate | [#552](https://github.com/xiaojichao/agentbean/pull/552)；cadence 1h08m；open 10m19s | 多 Agent lifecycle 状态空间大，2 commits | 在 Domain 层 model-based test，一次生成 retry/reopen/reassign sequence |
| 11 | rollout policy + Web DAG | [#555](https://github.com/xiaojichao/agentbean/pull/555)；cadence 5h45m；open 22m03s | 约 5h23m 在 PR 前；review 后补 browser smoke 默认频道，说明 Web fixture 太晚接真实入口 | Web lane 可从 T5 后基于 mock DTO 并行；browser fixture 在 T1 固定 default Team/channel |
| 12 | 双 Agent E2E/CI/closeout | [#557](https://github.com/xiaojichao/agentbean/pull/557)；cadence 2h05m；open 10m59s | 本地一次性跑 64 closeout + contracts/runtime/domain/server/daemon/web + retained phases + SEA + browser/build；main CI 又被后续 main push取消；PR 在自动 review 提交 P2 finding 前约 2 分钟已合并 | closeout harness 从 T6 起增量维护；CI 按 package 去重；superseded main run 由 descendant run证明；自动合并必须等待 required review 完成 |

阶段结束后还有 [PR #560](https://github.com/xiaojichao/agentbean/pull/560)（50 additions、32 deletions、7 files，open 17m08s）发布包含 Phase 2 Worker runtime 的 canonical daemon；main [29339934281](https://github.com/xiaojichao/agentbean/actions/runs/29339934281) 与 SEA [29339934519](https://github.com/xiaojichao/agentbean/actions/runs/29339934519) 成功。这个 follow-up 说明 T12 的“完成定义”没有把 canonical published artifact 闭包完全前置。

此外，当前 Phase 2 matrix 仍写着 P2-18 Yellow/Not ready，这是合并前快照；GitHub truth 已前进到 #557/#560 与成功 main/SEA runs。状态文档滞后会制造重复核查和“到底完成没有”的沟通成本。

## CI 的确定性重复成本

### 当前脚本为什么越到后期越慢

[`package.json`](../../package.json) 当前定义：

- `test:phase1`：contracts + domain + server + daemon + web。
- `test:phase0`：runtime + contracts + domain + Phase 0 boundary/check + Server boundary。
- `test:phase1-management`：Phase 1 boundary/check + runtime + **完整 `test:phase1`**。
- `test:phase2-task-dag`：Phase 2 boundary/check + contracts + runtime + domain + server。
- `build:phase0`：contracts + domain + runtime + server。
- `build:phase1-management`：**完整 `build:packages`**。
- `build:phase2-task-dag`：contracts + domain + runtime + daemon + server。
- CI 最后又运行一次 **完整 `build:packages`**。

[`ci-cd.yml`](../../.github/workflows/ci-cd.yml) 114–148 行严格串行调用上述所有脚本。

最新 main [run 29339934281](https://github.com/xiaojichao/agentbean/actions/runs/29339934281) 的 `Validate AgentBean Next` job（job `87108702792`）精确耗时：

| Step | 秒 |
|---|---:|
| npm ci | 42 |
| baseline phase tests | 52 |
| Phase 0 gates | 21 |
| Phase 1 gates | 62 |
| Phase 2 gates | 49 |
| Phase 2 E2E | 2 |
| Phase 0 build | 11 |
| Phase 1 build | 43 |
| Phase 2 build | 13 |
| final build packages | 35 |
| daemon install smoke | 15 |
| preview smoke | 2 |
| browser smoke | 79 |
| Validate job 总计 | 438（7m18s） |

测试的 186 秒里，contracts/domain/server/runtime 被多次运行；build 的 102 秒里，完整 packages 与多个子集被确定性重复。即使不引入缓存，只把 CI 改成“每个 package suite/build 一次 + 各 Phase 只跑 boundary/E2E”，保守也能减少约 90–140 秒，Validate 有机会从 7m18s 降到约 5m 左右。browser smoke 79 秒和 `npm ci` 42 秒随后才成为下一批优化目标。

PI SEA workflow 三个平台并行是正确的；但 [`pi-sea-compatibility.yml`](../../.github/workflows/pi-sea-compatibility.yml) 的 path filter 包含宽泛的 `package.json`/`package-lock.json`，每个平台各自 `npm ci` + contract tests + SEA。应继续保留真实三平台 verdict，但将触发条件缩到 runtime/SEA/package-version 相关变更，普通 Domain/Server PR 不重复触发。

## 后续阶段提速方案

### 2026-07-14 第一批推进结果

Issue [#562](https://github.com/xiaojichao/agentbean/issues/562) 已按本文第一项建议实施 CI 去重：新增 `test:packages`、`test:retained-boundaries` 与唯一 CI 入口 `test:ci`，保留原有阶段级本地脚本；CI build 收敛为一次 `build:packages`，readiness 与 Phase 2 checker 同步防止重复门禁回流。

Node 24.18.0 本地实测：

| 门禁 | 改造前 main CI | 改造后本地实测 | 减少 |
|---|---:|---:|---:|
| package + Phase tests | 186s | 46.84s | 139.16s |
| package builds | 102s | 27.81s | 74.19s |
| 合计 | 288s | 74.65s | **213.35s** |

若 GitHub runner 的其他 step 持平，Validate 可由 7m18s 降至约 3m45s；最终以 PR/main Actions 实测为准。

### 立即实施：不降正确性的四刀

1. **把 CI 从 phase 聚合改成 package 去重。**

   新建一个 `test:all-once`：contracts、runtime、domain、server、daemon、web 各一次；`test:phase0/1/2` 改为只跑各自 boundary/check/smoke。build 只执行一次 `build:packages`。PR/main 都复用同一命令图。

2. **区分状态与 SLA，并把 review completion 设为合并前置。**

   Task timeline 至少记录：`started_at`、`first_test_at`、`pr_opened_at`、`checks_green_at`、`review_completed_at`、`merged_at`、`main_validated_at`、`deployed_at`；状态区分 `running`、`awaiting_review`、`awaiting_ci`、`awaiting_production_observation`、`paused`。#507/#475/#480 这类等待不能继续显示为“Agent 正在处理”；#557 这类 review 晚于 merge 的情况则必须由 required check 阻止。

3. **同一阶段采用 contract spine + 并行 lanes。**

   contract PR 合并后，至少并行：

   - Domain/policy lane；
   - persistence/UoW lane；
   - Device/transport lane；
   - Web/smoke/observability lane。

   每个 lane 独立 worktree；integration PR 才组合。Phase 0 plan 已明确 PR2/PR4 可并行，Phase 1 plan 也明确 T7/T8 可与 T6 部分并行，但实际没有充分利用。

4. **中间 Task targeted，integration/closeout 才 full。**

   中间 PR 只要求 changed package targeted tests + repository contract规定的 matching build + retained-boundary mini gate；每个 lane 合并前跑一次 package full suite；integration/closeout 才跑 clean install、全部 packages、browser、SEA、production smoke。

### 防返工：把四类 recurring failure 机器化

- exact-key parser 与 forbidden extra keys：共享 helper + contract snapshot。
- previous-phase invariant：`retained-boundaries` 独立快速 job，防 #545 类回归。
- workspace source vs built dist：clean worktree/source resolution test，防 #532 类 SEA 假绿/假红。
- browser default Team/channel/storage：固定 seeded fixture，防 #470/#555 类晚期入口 race。

### 发布闭包

- 若 daemon/runtime/package 内容变化，closeout gate 必须同时验证：版本已 bump、lock/audit fixture同步、`npm pack` tarball 含目标 runtime、canonical `@agentbean/daemon@latest` 可 clean install/load。
- feature 默认关闭的内部 Phase PR，main 只需 Validate，不必每个 PR 都 publish/deploy/smoke；只在 rollout、closeout、release PR 执行 production chain。
- main run 被后续 push取消时，如果成功 descendant commit 包含该 merge commit，自动记为 `superseded-success`，避免人工重跑/误判。

### 目标预算

| 环节 | 当前观察 | 后续目标 |
|---|---:|---:|
| 中间 Task 本地验证 | 常见 30–90m，缺少细分 | targeted test + matching build ≤15m |
| PR open（无 review finding） | 多数 5–18m | ≤10m，CI 与 required review 都完成后自动合并 |
| Validate CI | 7m18s | ≤5m；进一步缓存后 ≤4m |
| 中间 main | Validate + publish/deploy/smoke | 只 Validate；production chain 仅 rollout/closeout |
| full closeout | 45m–2h，且最后才组装 | harness 持续增量；最终增量收口 ≤30m |
| 用户可见“运行中” | 混入跨夜/review/观察 | 只计算 active execution；等待分栏显示 |

## 推荐的下一阶段执行模板

1. Task 0：冻结 contracts + matrix skeleton + boundary checker + E2E skeleton。
2. Contracts merge 后同时启动 3–4 个独立 worktree lane。
3. Lane PR：targeted tests、matching build、retained-boundaries；不做生产发布。
4. Integration PR：package suites 各一次、完整 E2E/browser；review findings在此收敛。
5. Rollout PR：feature flag/policy/Web exposure；跑 production deploy/smoke。
6. Release/closeout PR：canonical package tarball、三平台 SEA、证据 JSON、matrix 自动回填。

这样保留当前阶段合同、原子 UoW、真实 browser/Device/production 验证，却能同时砍掉三种无价值等待：**开发串行、重复 test/build、绿灯后无人推进。**

## 无法精确回答的字段

- 每个 Task 的 Agent 真正开始/结束时间。
- 本地 test/build 每条命令的起止、重跑次数、失败日志。
- 人工 review、休息、跨夜、其他任务占用各自多少时间。
- PR 打开前的纯编码时间与纯推理时间。
- Phase -1 #470 内 29 commits 之间的空档究竟是工作、等待还是其他任务。

要让下一次复盘从“上界推断”升级为“精确瓶颈分析”，必须先落上文的阶段时间事件；否则任何把 8 小时 merge gap 说成 8 小时 Agent runtime 的结论都不可靠。
