# Phase -1 Team 术语切换验收矩阵

本矩阵只覆盖 `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` 的 Phase -1。任何必需项没有可复现证据时，Phase -1 都保持 `in_progress`，不得启动 Phase 0。

## 状态定义

- `Not started`：尚未实施。
- `Red`：已有测试或检查证明当前实现不满足。
- `Partial local`：已有实现或局部测试证据，但必需的完整 browser/smoke/build gate 尚未全部完成。
- `Green local`：本地测试、构建和 smoke 已通过，但尚未发布。
- `Partial Release A`：实现已随 Release A 发布，但该验收项要求的 production-specific inspection 或行为证据尚未完成。
- `Green Release A`：Release A 已进入 `main`，对应 main-push CI、production deploy 与 Release A smoke 已通过；7 天观察与 Release B 仍未完成。
- `Green production`：Release B 已发布，production smoke 与数据校验通过。

## 必需验收项

| ID | 验收项 | 层级 | 必需证据 | 当前状态 |
|---|---|---|---|---|
| P-1-01 | `WEB_EVENTS` 不再暴露旧 admin Team events，只保留 canonical Team events。 | Contracts | `npm run test:contracts`、`npm run build:contracts` | Green Release A |
| P-1-02 | Server 不注册旧 admin handlers，缺少 `teamId` 时返回 canonical validation error。 | Socket | `socket-handlers.test.ts` | Green Release A |
| P-1-03 | Device Agent、Admin Agent、Admin Device 响应只包含 `teamId`、`teamName`、`primaryTeamId`、`primaryTeamName`、`visibleTeamIds`。 | UseCase/Socket | `socket-integration.test.ts` | Green Release A |
| P-1-04 | Fresh global SQLite 使用 `teams`、`team_members` 和 Team snake_case columns。 | Repository | `sqlite-repositories.test.ts`、schema inspection | Green Release A |
| P-1-05 | 0011 形状的 `device_revocations` 可升级到 snake_case，普通 profile、`NULL profile_id`、主键和索引全部保留。 | Repository/Migration | `device-revocations-repository.test.ts`、`sqlite-repositories.test.ts`、production row/index inspection 与 revoked Device rejection | Green Release A |
| P-1-06 | Web socket/client/store 不再声明、映射或发送 non-canonical Team aliases/fields。 | Web unit | `socket-client.test.ts`、`npm run build:web-next` | Green Release A |
| P-1-07 | App Router 动态 segment 为 `[teamPath]`，团队管理入口为 `/:teamPath/teams`；Release A 的旧收藏 URL 只经过 permanent redirect，不保留旧页面实现。 | Web route | route manifest、redirect test、Web build、browser smoke | Green Release A |
| P-1-08 | Release A 首次读取旧 browser key 时写入 `agentbean.teamPath` 并删除旧键，此后不再写旧键。 | Web storage | `team-path.test.ts`、真实浏览器 storage inspection | Green Release A |
| P-1-09 | Release B 删除旧 browser key 读取、旧 Team 页面 redirect 和全部 checker allowlist。 | Web/CI | `team-path.test.ts`、redirect test、`npm run check:team-terminology` | Not started |
| P-1-10 | Artifact upload proxy 与 Server HTTP 只存在 `/api/teams/:teamId/...`。 | HTTP/Web | route existence test、multipart upload/preview/download smoke | Green Release A |
| P-1-11 | Device list/Agent 查询显式使用 `teamId`；device-bound get/scan/select-directory/delete/rename 只使用 `deviceId`；invite/login/custom Agent create 符合各自 canonical contract。 | Device/Web/E2E | targeted tests、browser Device flow | Green Release A |
| P-1-12 | `main` 不再构建、测试、部署或发布 legacy source trees；rollback 使用 Git/Railway/npm artifact。 | Repository/CI/Operations | cutover audit、workflow inspection、rollback runbook、npm dist-tags | Not started |
| P-1-13 | README、AgentBean Next 活动文档和当前 specs 只描述 Team product contract。 | Docs | 活动文档静态扫描零结果 | Green Release A |
| P-1-14 | CI 静态门禁能拒绝旧字段、事件、route、storage key、schema 和已废弃产品名。 | CI | checker unit tests、PR check | Green Release A |
| P-1-15 | Contracts、Domain、Server、Daemon、Web tests 与全部 TypeScript builds 通过。 | Regression | root test/build commands、CI run URL | Green Release A |
| P-1-16 | Release B 后真实 Team switch、Device 接入、Artifact 上传和 SQLite revocation 行为通过 production smoke。 | Production | deploy URL/run、smoke logs、DB backup/upgrade evidence | Not started |

## 2026-07-10 Release A 本地证据

| 验收项 | 实现提交 | 可复现证据 | 结论 |
|---|---|---|---|
| P-1-01 | `5f3d7b5` | `npm run test:contracts`; `npm run build:contracts` | contracts 已通过本地测试与构建。 |
| P-1-02 / P-1-03 | `ff0ce25`, `16be460` | server-next targeted tests; `npm run test:server-next`; `npm run build:server-next` | canonical admin handler、DTO 与权限回归通过。 |
| P-1-04 / P-1-05 | `3c6d1d8`, `48ddb52` | device revocation / SQLite repository tests; `npm run build:server-next` | fresh schema 与追加迁移通过；production DB 备份恢复尚未演练。 |
| P-1-06 | `cc7a8e9`, `b6521ae`, `d298271`, `68a26ac` | `npm run test:web-next -- --api.host 127.0.0.1`（26 files / 194 tests）; `npm run build:web-next` | Web canonical DTO、payload 与完整 App Router build 通过。 |
| P-1-07 / P-1-08 | `3f3be1c`, `2ed4bdd`, `bd30ceb` | team-path/socket-client tests；Team create/switch/delete/fallback 的显式 current-state 序列；combined browser 39/39；readiness 54/54；Web/Server build | canonical route、308 redirect 与 Team 刷新持久化达到 `Green local`；尚未用真实浏览器从旧 key 启动并检查迁移结果，P-1-08 保持 `Partial local`。 |
| P-1-10 | `d298271`, `b550710` | route existence regression；Web tests 194/194；Web build；Chrome browser smoke 20/20 覆盖 multipart upload、preview、download | canonical Artifact route 与本地真实链路达到 `Green local`。 |
| P-1-11 | `b550710`, `68a26ac`, `bd30ceb` | Device/Agent targeted regressions；Web tests 196/196；combined browser 的 App Router Device flow 覆盖 list/detail、runtime、custom Agent、scan、rename、delete | Device canonical contract 达到 `Green local`。 |
| P-1-13 | 本 Task 9 | 计划给定的 README、AgentBean Next docs 与当前 specs forbidden-token scan 返回零结果；三份被主 PRD 取代的设计已删除 | 活动文档达到 `Green local`。 |
| P-1-14 | `b27d79b` | terminology checker 6/6；18 个默认 roots 全仓扫描通过；CI change-detection 闭包测试通过 | 本地门禁已通过；GitHub-hosted PR check 尚未发生，暂记 `Partial local`。 |
| P-1-15 | `bd30ceb` Release A HEAD | Contracts 9/9、Domain 24/24、Server 372/372、Daemon 222/222（1 个既有 e2e skip）、Web 196/196；五项 TypeScript/Web build；readiness 54/54；persistence 6/6；combined Chrome browser smoke 39/39（preview 20/20 + App Router WebUI 19/19） | 2026-07-11 完整本地门禁通过，达到 `Green local`；尚无 `main` CI 证据。 |

## 2026-07-11 Release A 已发布证据

- Release A 通过 PR #470 squash merge 到 `main`，merge commit 为 `c31ce9d955d0dfb7f9407a6d5724763568a60b7b`。
- main-push [CI/CD Run #996](https://github.com/xiaojichao/agentbean/actions/runs/29134937662) 结论为 `success`：Validate AgentBean Next、Server、Daemon、Web、Deploy production、Publish agent to npm 与 AgentBean Next production smoke jobs 全部成功。
- main-push CI 的 GitHub-hosted combined browser gate 通过 `39/39`，其中 preview `20/20`、App Router WebUI `19/19`；它启动 CI runner 本地 Server，覆盖 Team create/switch/delete/fallback、Device、Agent、Artifact、Task、Run、Settings 与 Admin flow，但不是针对 `https://api.agentbean.dev` 的 production browser smoke。
- Railway production deployment `58e4c03e-1e73-4513-85c7-74705709b488` 于 `2026-07-11T01:39:29.347Z` 创建，实例状态为 `RUNNING`，volume `api-volume` 以 `READY` 状态挂载到 `/data`。
- production strict cutover audit 通过 `12/12`；`https://api.agentbean.dev` 首次 healthcheck 即成功；public entry smoke `4/4`、business smoke `8/8`。
- npm truth 由 strict cutover audit 确认：`@agentbean/contracts@0.2.2`、`@agentbean/daemon-next@0.3.5`、canonical `@agentbean/daemon@0.3.5` 均存在，且 canonical `latest` 指向 `0.3.5`。
- 发布后观察快照于 `2026-07-11T01:57:11Z` 使用 SQLite online backup API 写入 production volume：
  - `/data/agentbean-next/backups/release-a-observation/global.sqlite.release-a-postdeploy-20260711T0157Z.bak`；`827392` bytes；SHA256 `e9d66dc2721713179bad24bb8ad5f6e6b48ba057ba8db6d5ebc94aedeb7401ab`；权限 `0600`；`integrity_check=ok`。
  - `/data/agentbean-next/backups/release-a-observation/team.sqlite.release-a-postdeploy-20260711T0157Z.bak`；`2203648` bytes；SHA256 `b634c14cb01c0afa82638c008f7ba1930372f1a058f88c8bd56c7dbbf6efa340`；权限 `0600`；`integrity_check=ok`。
  - global migration ledger 包含 `global/0014_device_revocations_team_columns.sql`，applied_at 为 `1783734054646`。
- 计划要求的 Release A **发布前** global SQLite backup 没有可验证证据；上述文件是同一 production volume 内的发布后观察快照，不能追溯替代发布前备份，也不能覆盖 volume 丢失或损坏。当前没有 off-volume copy、保留期或恢复演练证据。
- 7 天观察窗口从 production smoke 完成时开始：`2026-07-11 09:41:41` 至 `2026-07-18 09:41:41`（Asia/Shanghai）。窗口结束前禁止执行 Release B。
- 窗口内后续 production deploy 均已记录并通过：PR #471 的 [Run #1000](https://github.com/xiaojichao/agentbean/actions/runs/29136243401)、PR #475 的 [Run 29146998708](https://github.com/xiaojichao/agentbean/actions/runs/29146998708)、PR #476 的 [Run 29147805169](https://github.com/xiaojichao/agentbean/actions/runs/29147805169)、PR #473 的 [Run 29149484675](https://github.com/xiaojichao/agentbean/actions/runs/29149484675) 与 PR #478 的 [Run 29158694977](https://github.com/xiaojichao/agentbean/actions/runs/29158694977) 均为 `success`，对应 `Deploy production` 与 `AgentBean Next production smoke` 成功。
- `2026-07-11 19:09`（Asia/Shanghai）从最新 `main` `8bd3bbbf646518a154f7ccf8d99f719f8ce0c17e` 对 `https://api.agentbean.dev` 执行 production-host combined browser gate，`39/39` 通过，preview/WebUI console 均无 error；[外部观察记录](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945200798) 已写入，本地 artifact 位于 `/private/tmp/agentbean-release-a-current-main-production-browser/`。
- P-1-08 production browser inspection 已完成：同一已登录 context 中只保留 legacy browser path key 后访问 `/login`，页面恢复到 canonical Team chat，最终 `agentbean.teamPath` 写入且旧键删除；console error 为 0。证据见 [Issue #469 observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4944639434)。
- P-1-05 production evidence 已完成：普通 profile 与 `NULL profile_id` Device 删除后重连均返回 `DEVICE_REVOKED`；随后以 `readonly: true` 和 `PRAGMA query_only=ON` 检查 global SQLite，确认 5 行中包含 1 行 NULL profile、复合主键 `(team_id, machine_id, profile_key)`、索引 `idx_revocations_machine(team_id, machine_id)`、migration 0014 ledger 与 `integrity_check=ok`。证据见 [行为记录](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4944639434) 与 [SQLite inspection](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945160676)。临时 Railway SSH key 与本地 key/known_hosts 记录均已删除。
- `device-login` production inspection 已完成：真实 `device-invite:create`、已发布 `@agentbean/daemon@0.3.5` 等待/注册、浏览器账号登录与 canonical Team Device 页面形成完整链路；最终 Device 与 Team browser identity 均写入，旧 browser path key 不存在，相关 RSC 请求为 HTTP 200，console 0 error/0 warning。证据见 [Issue #469 observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4947472515)。
- `2026-07-12 00:21–00:27`（Asia/Shanghai）每日 production observation 已完成：strict cutover audit `12/12`、entry `4/4`、business `8/8`、production-host combined browser `39/39` 均通过，preview/WebUI console 无 error；当前 npm truth 为 `@agentbean/daemon-next@0.3.6`、canonical `@agentbean/daemon@0.3.6` 且 `latest` 指向 `0.3.6`。证据见 [Issue #469 daily observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4947642857)。

当前 Phase -1 仍为 `in_progress`。P-1-05、P-1-08、`device-login` 与 production-host browser 已达到 `Green Release A`；P-1-09、P-1-12 属于 Release B，P-1-16 要求 Release B production evidence。7 天观察尚未结束，production Admin DTO rendering 仍缺受控全局管理员会话下的独立观察证据。Release A 的发布前 backup 证据缺失，old-target schema rollback 当前冻结；发布后观察快照已完成完整性校验，但不是旧 binary 的恢复点。

## Release A 观察台账

观察窗口不是单纯的计时器。每天至少记录一次检查，并在每次 production deploy 或 incident 后追加检查；没有可追溯记录的日期不算已观察。每条记录必须链接到 GitHub run、Railway deployment/log、browser inspection 或 incident 记录，不能只写“正常”。

| 检查时间（Asia/Shanghai） | 信号 | 查询或证据位置 | 通过阈值 | 结果 | deploy / incident | 复核人 |
|---|---|---|---|---|---|---|
| 2026-07-11 09:41:41 | Release A deploy/smoke baseline | main Run #996；Railway deployment `58e4c03e-1e73-4513-85c7-74705709b488`；本节上方 smoke 证据 | CI、deploy、strict audit、entry/business smoke 与 CI-local browser gate 全部通过 | 通过；观察开始；production browser 待检查 | Release A deploy | 待最终复核 |
| 2026-07-11 09:57:11 | SQLite observation snapshot baseline | 本节上方 global/team snapshot 路径、SHA256、权限、`integrity_check` 与 migration ledger | 两份 snapshot 写入完成且 `integrity_check=ok` | 通过；仅为同 volume post-deploy snapshot | none | 待最终复核 |
| 2026-07-11 10:27:46 | PR #471 post-deploy observation | [main Run #1000](https://github.com/xiaojichao/agentbean/actions/runs/29136243401) | CI、deploy 与 production smoke 成功 | 通过 | production deploy | 待最终复核 |
| 2026-07-11 约 10:33 | 首次 production browser incident | [Issue #474](https://github.com/xiaojichao/agentbean/issues/474)；`/private/tmp/agentbean-release-a-day1-production-browser/` | production browser target flow 通过且 console clean | 失败；频道创建因 stale Team 返回 `FORBIDDEN`；已由 PR #475 关闭 | incident | 待最终复核 |
| 2026-07-11 17:04:14 | PR #475 incident fix deploy | [main Run 29146998708](https://github.com/xiaojichao/agentbean/actions/runs/29146998708)；[合并后生产验证](https://github.com/xiaojichao/agentbean/issues/474#issuecomment-4944493640) | CI、deploy、production smoke 与 production browser 全部通过 | 通过；Issue #474 已关闭 | production deploy / incident close | 待最终复核 |
| 2026-07-11 17:34:34 | PR #476 post-deploy observation | [main Run 29147805169](https://github.com/xiaojichao/agentbean/actions/runs/29147805169) | CI、deploy 与 production smoke 成功 | 通过 | production deploy | 待最终复核 |
| 2026-07-11 17:59:42 | 旧 Team path 与旧 browser key 迁移 | [Issue #469 browser observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4944639434)；latest-main production browser gate | 旧 URL 正确 308 跳转；首次读取后只保留 `agentbean.teamPath` | 通过；旧键删除且 canonical Team chat 恢复 | none | 待最终复核 |
| 2026-07-11 18:36:44 | PR #473 post-deploy observation | [main Run 29149484675](https://github.com/xiaojichao/agentbean/actions/runs/29149484675) | CI、deploy 与 production smoke 成功 | 通过 | production deploy | 待最终复核 |
| 2026-07-11 19:07:03 | `device_revocations` production upgrade | [行为记录](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4944639434)；[SQLite inspection](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945160676) | 行与 NULL profile 未丢失；PK/index 正确；已撤销凭据不能重新连接 | 通过；query-only、integrity、rows、PK/index、普通/NULL profile 与双重 `DEVICE_REVOKED` 均符合 | none | 待最终复核 |
| 2026-07-11 19:09 | Production browser（latest main） | [Issue #469 observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945200798)；`npm run smoke:agentbean-next-browser -- --url https://api.agentbean.dev --timeout-ms 90000`；`/private/tmp/agentbean-release-a-current-main-production-browser/` | production host 上的目标 browser flow 通过且 console clean | `39/39` 通过；preview/WebUI console clean | post-deploy observation | 待最终复核 |
| 2026-07-11 23:56:07 | PR #478 post-deploy observation | [main Run 29158694977](https://github.com/xiaojichao/agentbean/actions/runs/29158694977)；merge commit `c12eeaccf455374352fea357d4dbf13b1e108a4c` | CI、deploy 与 production smoke 成功 | 通过；Validate Next/Web/Server/Daemon、Deploy production、Publish agent 与 production smoke 均成功 | production deploy | 待最终复核 |
| 2026-07-12 00:07 | login / device-login redirect | [Issue #469 production device-login observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4947472515)；[安全收口记录](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4948852790) | 无非预期 404；真实 Daemon invite 后进入 canonical Team Device 页面 | 通过；`/login` 已由 production browser 覆盖，真实 `device-login` 写入 Device/Team identity，RSC HTTP 200，console 0 error/0 warning；含测试凭据的临时本地文本工件已销毁，测试账号密码已随机轮换、隔离 Team 已删除，旧凭据复验拒绝；GitHub 脱敏记录为持久证据 | post-deploy observation | 待最终复核 |
| 2026-07-12 00:21–00:27 | Release A 每日 production observation | [Issue #469 daily observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4947642857) | strict audit、entry/business 与 production-host browser 全部通过；无未解释 incident | `12/12`、`4/4`、`8/8`、`39/39` 通过；console clean；incident `none`；Admin flow 仍按 external-target 合同跳过；GitHub 脱敏记录为持久证据 | none | 待最终复核 |
| 2026-07-11 19:09 | Artifact upload | [latest-main production browser observation](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945200798)；`/private/tmp/agentbean-release-a-current-main-production-browser/` | 无非预期 404/403；上传、预览、下载成功 | 通过；upload/preview/download 均成功 | post-deploy observation | 待最终复核 |
| 待填写 | Admin DTO rendering | browser console 与 admin teams/devices/agents 页面记录 | 无 DTO rendering error；页面数据可见 | 待受控 production 全局管理员会话验证；不得猜测口令或临时提升生产用户角色 | 待填写 | 待填写 |
| 2026-07-11 19:07:03 | SQLite migration | [production query-only inspection](https://github.com/xiaojichao/agentbean/issues/469#issuecomment-4945160676) | 无 migration error；`integrity_check=ok` | 通过；0014 ledger 存在、legacy table 不存在、integrity ok | none | 待最终复核 |

Release B 只能在 `2026-07-18 09:41:41` 之后且同时满足以下条件时开始：

1. 观察窗口内每天及每次 production deploy/incident 都有上表或等价外部记录，没有未解释的缺口。
2. P-1-08 的真实旧 browser key migration inspection 已完成并链接证据。
3. 上述七类信号均达到通过阈值，期间所有 incident 已关闭；若没有 incident，也要显式记录 `none`。
4. 重新运行 strict cutover audit、public entry smoke、business smoke 和 production-host browser smoke，并记录 run URL 与结论。
5. 复核观察期 deployment/incident 列表、SQLite snapshot 限制和 old-target rollback 冻结状态，由复核人在本节追加最终 verification-only sign-off。

任一条件缺少证据时，观察窗口保持未完成，不得仅因截止时间已到而执行 Release B。

## Release A 必需命令

```bash
npm run test:contracts
npm run test:domain
npm run test:server-next -- --api.host 127.0.0.1
npm run test:daemon-next -- --api.host 127.0.0.1
npm run test:web-next -- --api.host 127.0.0.1
npm run test:team-terminology
npm run check:team-terminology
npm run build:contracts
npm run build:domain
npm run build:server-next
npm run build:daemon-next
npm run build:web-next
npm run check:agentbean-next-readiness
npm run smoke:agentbean-next-persistence
npm run smoke:agentbean-next-browser
```

## Release B 必需命令

Release B 删除一次性 browser migration、旧 Team 页面 redirect、checker allowlist 和 legacy source 后，重复 Release A 全部命令，并再次运行 `npm run check:team-terminology`。Expected: checker 在没有 allowlist 的状态下 exit 0。

## Production evidence template

完成时在本节追加实际值，不用“已验证”代替证据：

- Release A merge commit：`c31ce9d955d0dfb7f9407a6d5724763568a60b7b`
- Release A `main` CI run：<https://github.com/xiaojichao/agentbean/actions/runs/29134937662>（Run #996，success）
- Release A production deployment：Railway `58e4c03e-1e73-4513-85c7-74705709b488`（RUNNING）
- Release A SQLite backup / snapshot path、size、SHA256：见“2026-07-11 Release A 已发布证据”；仅有同 volume post-deploy observation snapshots，pre-release backup evidence 缺失
- Release A browser smoke：main CI combined browser `39/39`；latest-main production-host combined browser `39/39`（`2026-07-11 19:09`，Asia/Shanghai）
- 7 天观察开始与结束时间：`2026-07-11 09:41:41` 至 `2026-07-18 09:41:41`（Asia/Shanghai）
- Release B merge commit：
- Release B `main` CI run：
- Release B production deployment：
- Release B terminology checker：
- Release B Team/Device/Artifact production smoke：
- npm `@agentbean/daemon` dist-tags 查询结果：
