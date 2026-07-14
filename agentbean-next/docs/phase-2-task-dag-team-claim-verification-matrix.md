# Phase 2 Task DAG 与团队认领验收矩阵

- 日期：2026-07-14
- 状态：Phase 2 合并后生产验收已完成，最终 verdict 为 Green
- 实施计划：`docs/superpowers/plans/2026-07-13-agentbean-phase-2-task-dag-team-claim.md`
- 当前切片：Issue #558，合并后生产验收与最终 verdict 冻结
- 工具链：Node 24.18.0

> 本矩阵只记录已获得的证据。尚未实现或尚未完成真实验证的能力保持 Red，不以类型声明或计划文本代替运行时证据。

| ID | 状态 | 当前证据 | 后续动作 |
|---|---|---|---|
| P2-01 | Green | daemon 注册真实 `ManagementWorkerRegisterV2`；Server Socket 独立解析 V1/V2 capability，Phase 2 preflight 与调度只选择声明 `[1, 2]` protocol/phase 的 V2 Device worker，V1 worker 继续只承接 Phase 1 | 保持 V1/V2 negotiation fail closed |
| P2-02 | Green | Phase 2 exact allowlist 与 V2 request/result parser 已接入 daemon/Server；8 个 Task tools 全部路由到 Task Coordination Kernel | 保持 Phase 3/4、coding 与 cwd resources 不可见 |
| P2-03 | Green | Team policy migration、默认 Phase 1、owner/admin 显式启用 Phase 2 与红灯不创建 Run 已由 routing、SQLite migration、socket integration tests 覆盖；Node 24 下 server-next 521 项全量通过 | 保持未通过 preflight 时 zero Run/zero fallback |
| P2-04 | Green | Task `revision`、coordination revision 与 Management Event 共享原子 UoW；memory/SQLite 覆盖 exact optimistic conflict、create/revise rollback、旧库升级、重复 migration 与 ledger failure rollback | 后续 Kernel 必须只通过该 UoW 推进 revision |
| P2-05 | Green | 单根 DAG 的 identity、无环、深度 3、fan-out 8、open-node 20 与 Invocation budget 规则由 13 个表驱动测试覆盖 | 后续 kernel 复用该 policy，不复制图规则 |
| P2-06 | Green | Kernel 在同一 UoW 内推进 Task/coordination revision，保持 criterion stable ID、退休被删除 criterion；失败 attempt 与人类拒绝根交付分别推进 attempt/revision，旧 claim、Invocation、delivery 与 acceptance 保留历史但失去当前 authority | 后续语义变更继续只通过 revision command |
| P2-07 | Green | capability resolver 对 visibility、deleted、device、readiness、explicit capability、channel/dependency access、ancestor loop 与 targeted mismatch 返回明确 diagnostics | 后续新增 capability 必须复用同一 resolver |
| P2-08 | Green | open/targeted Broker、offer/ack、唯一 winner、最小 execution snapshot 与 daemon transport 已由 Issue #542 / PR #543 覆盖；Invocation Gateway 只接受当前 claim holder | 后续执行入口继续复用 claim authority |
| P2-09 | Green | memory/SQLite 唯一 active lease、renew/release/expire/disconnect/reconnect、fencing monotonic、reopen 与 loser zero Dispatch 均有 fake-clock/transport tests；claim 到期后 Task 原子回到 `todo`，同 attempt 可重新 offer，targeted Task 可在 grace/lease 到期后显式重派 | 保持过期 authority 只读可追溯 |
| P2-10 | Green | Gateway 在原子 UoW 内检查 dependency Task `done` 与 canonical accepted delivery，并由 Server 生成 Invocation dependency refs；未闭合或缺少 accepted result 时 fail closed | 保持依赖结果只消费 canonical accepted delivery |
| P2-11 | Green | V2 `agents.invoke` 绑定 current Task revision/attempt/claim lease；target 由 claim holder 派生，同一 Task attempt 的第二个 active Invocation 被拒绝；失败 Dispatch 通过 Server lifecycle bridge 原子关闭当前 authority、推进一个受控 attempt，达到上限后转 `waiting_for_user` | 后续真实 Device smoke 复用同一路径 |
| P2-12 | Green | `agents.invoke` 仅在当前 succeeded Invocation 已有真实 Agent 结果后显式 finalization；delivery 绑定 current Task revision/attempt/claim lease/Invocation；retry/reassign 后旧 claim 被 invalidated，旧 attempt delivery/acceptance 无法成为当前 authority | 保持 current revision/attempt/lease 四元组校验 |
| P2-13 | Green | Message/Artifact/Workspace Run/Invocation/Task resolver 全部校验 Team、channel、dispatch、Agent 与 Task authority；Server canonicalize + SHA-256，存储路径/下载 token 不入快照，客户端 digest mismatch、source hidden/unavailable 与 snapshot drift 均 fail closed | 后续新增 evidence kind 必须复用 Server resolver 与 canonical hash |
| P2-14 | Green | manager acceptance 逐 criterion 校验全量覆盖、passed、required evidence、allowed kind 与 current source hash；accepted 原子推进 `done`，rejected 可显式 retry，高风险/冲突 `needs_human` 原子推进 Run `waiting_for_user`；根交付拒绝创建新 revision 并恢复 Run | 保持 human continuation 不覆盖历史决定 |
| P2-15 | Green | checkpoint 在 Task Coordination UoW 中收集完整 task snapshots、revision/attempt、active claim 与 waiting/completed Invocation；daemon 依据恢复快照启用 Phase 2 exact tools，断线重连后恢复同一 Run/DAG 且不重建子任务 | 保持 recovery/replay 与 reconnect 回归 |
| P2-16 | Green | `phase-2-managed-team-smoke.test.ts` 使用真实 Web/Agent Socket、两个 `DeviceServiceCore`、标准 claim clients 与 V2 `WorkerHost`：open claim 竞态只有一个 winner，另一 Agent 承接 targeted/dependency Task；每个 Agent 恰好一次 Invocation/Dispatch，随后完成 delivery、acceptance、根交付 `in_review` 与人工 `done`；重复 invoke、stale revision 与 late Dispatch result 均被隔离 | CI 保留 `test:phase2-closeout` 独立 gate |
| P2-17 | Green | `webui-phase2-task-dag-business-flow` 通过真实 Web/Agent Socket 注册 V2 worker、启用 Team Phase 2 policy、创建 managed 根 Task，再由 App Router 浏览器打开该 Task 并命中真实 `task-dag-panel`；既有 component、revision guard、permission-filtered DAG 与 evidence refs tests 保持全绿 | 保持 browser smoke 与 readiness marker 同步 |
| P2-18 | Green | Node 24 clean install 与 `better-sqlite3` load 已验证；最终 main commit `b008fb3c82209bf20fa2077f37d642b59db9f94f` 的 CI/CD、Railway deploy、strict audit、public entry 4/4、business smoke 8/8 与 Vercel deployment 全绿；Linux/macOS/Windows SEA aggregate 全绿；npm 官方 registry 与独立生产 Chrome 40/40 复验均通过 | 保持 Team 默认 `maxManagementPhase=1`；仅 owner/admin 显式启用、根 Task 与 V2 Device preflight 同时满足时进入 Phase 2 |

当前 verdict：**Green / Ready（受控 opt-in）**。Phase 2 的 Task DAG 与团队认领能力已完成代码、CI、三平台 SEA、npm、Railway、Vercel 和生产浏览器闭环；但这不表示默认开放。Team 默认继续使用 `maxManagementPhase=1`，只有 owner/admin 显式把指定 Team 的 policy 设为 Phase 2、请求绑定根 Task，且 V2 Device worker preflight 为 Green 时才允许进入；任一条件缺失均 fail closed，不回退成重复 direct Dispatch。

Issue #551 当前证据：`managed-multi-agent.test.ts` 覆盖失败 Invocation（含 Dispatch emit failure）的受控 attempt、max attempts 后 `waiting_for_user`、双叶子 canonical acceptance、根汇总贡献集 fail closed、根 Task `in_review` 与人类拒绝后 revision 递增且历史 acceptance 不被覆盖；`task-claim-broker.test.ts` 覆盖 claim 到期重开与 fencing 单调；既有 delivery/acceptance 与 Invocation Gateway tests 继续覆盖 stale revision/attempt/lease 隔离。Node 24 下 boundary 5、contracts 35、PI runtime 36、Domain 121、server-next 516 项测试及 `build:phase2-task-dag` 均通过。Phase 2 仍默认关闭；真实双 Agent Device 与 Web surface 尚未完成。

Task 11 历史证据：Team rollout policy 与 Task DAG Web surface 已完成；Node 24 下 server-next 521 项、web-next 208 项、Phase 2 boundary 6 项全量通过，`build:contracts`、`build:domain`、`build:daemon-next`、`build:server-next`、web client/app production build、Phase 1/2 boundary checks 与 browser smoke syntax check 均通过。P2-03 在该切片转 Green；Task 12 随后补齐真实双 Agent 与浏览器链路，使 P2-17 转 Green。

Task 12 本地证据：Node 24.18.0 clean install 后 `better-sqlite3` 原生 binding 可加载；定向 closeout 64/64、Phase 2 boundary 6/6、contracts 35/35、PI runtime 36/36、Domain 121/121、server-next 520/520、daemon-next 250/250（另 1 个平台 PTY E2E 跳过）、web-next 208/208、Phase 1 boundary 11/11、Phase 0 boundary 14/14、SEA verdict checker 7/7 与 readiness 66/66 全绿。`build:phase2-task-dag`、`build:web-next` 和真实 `smoke:agentbean-next-browser -- --skip-build` 通过。

合并后生产证据：最终 main commit [`b008fb3`](https://github.com/xiaojichao/agentbean/commit/b008fb3c82209bf20fa2077f37d642b59db9f94f) 的 [CI/CD run 29345773056](https://github.com/xiaojichao/agentbean/actions/runs/29345773056) 全绿，包含 Phase 0/1/2 gates、matching builds、真实双 Agent、browser smoke、Railway deploy、strict audit、public entry 4/4 与 business smoke 8/8；[SEA run 29339934519](https://github.com/xiaojichao/agentbean/actions/runs/29339934519) 的 Linux/macOS/Windows 与 aggregate 全绿。npm 官方 registry 为 `@agentbean/contracts@0.2.4`、`@agentbean/pi-management-runtime@0.1.1`、`@agentbean/daemon-next@0.3.9`、`@agentbean/daemon@0.3.9`，canonical dist-tag 为 `latest=0.3.9`、`legacy=0.1.35`；独立安装 registry tarball 后确认 Phase 2 worker exports 与 19 个 tools 可用。生产入口 [`https://api.agentbean.dev/`](https://api.agentbean.dev/) 健康，合并后的脚本再次执行真实生产 Chrome smoke 为 40/40，包含 `webui-phase2-task-dag-business-flow`；最终 commit 的 [Vercel deployment](https://vercel.com/xiaojichaos-projects/web/Bb1Ym6nTrsS4seWZsKQWZ4uAFDXN) 为 success。
