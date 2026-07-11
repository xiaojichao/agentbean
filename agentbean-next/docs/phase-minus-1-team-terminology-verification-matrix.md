# Phase -1 Team 术语切换验收矩阵

本矩阵只覆盖 `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` 的 Phase -1。任何必需项没有可复现证据时，Phase -1 都保持 `in_progress`，不得启动 Phase 0。

## 状态定义

- `Not started`：尚未实施。
- `Red`：已有测试或检查证明当前实现不满足。
- `Partial local`：已有实现或局部测试证据，但必需的完整 browser/smoke/build gate 尚未全部完成。
- `Green local`：本地测试、构建和 smoke 已通过，但尚未发布。
- `Green Release A`：Release A 已进入 `main`，对应 main-push CI、production deploy 与 Release A smoke 已通过；7 天观察与 Release B 仍未完成。
- `Green production`：Release B 已发布，production smoke 与数据校验通过。

## 必需验收项

| ID | 验收项 | 层级 | 必需证据 | 当前状态 |
|---|---|---|---|---|
| P-1-01 | `WEB_EVENTS` 不再暴露旧 admin Team events，只保留 canonical Team events。 | Contracts | `npm run test:contracts`、`npm run build:contracts` | Green local |
| P-1-02 | Server 不注册旧 admin handlers，缺少 `teamId` 时返回 canonical validation error。 | Socket | `socket-handlers.test.ts` | Green local |
| P-1-03 | Device Agent、Admin Agent、Admin Device 响应只包含 `teamId`、`teamName`、`primaryTeamId`、`primaryTeamName`、`visibleTeamIds`。 | UseCase/Socket | `socket-integration.test.ts` | Green local |
| P-1-04 | Fresh global SQLite 使用 `teams`、`team_members` 和 Team snake_case columns。 | Repository | `sqlite-repositories.test.ts`、schema inspection | Green Release A |
| P-1-05 | 0011 形状的 `device_revocations` 可升级到 snake_case，普通 profile、`NULL profile_id`、主键和索引全部保留。 | Repository/Migration | `device-revocations-repository.test.ts`、`sqlite-repositories.test.ts` | Green Release A |
| P-1-06 | Web socket/client/store 不再声明、映射或发送 non-canonical Team aliases/fields。 | Web unit | `socket-client.test.ts`、`npm run build:web-next` | Green local |
| P-1-07 | App Router 动态 segment 为 `[teamPath]`，团队管理入口为 `/:teamPath/teams`；Release A 的旧收藏 URL 只经过 permanent redirect，不保留旧页面实现。 | Web route | route manifest、redirect test、Web build、browser smoke | Green local |
| P-1-08 | Release A 首次读取旧 browser key 时写入 `agentbean.teamPath` 并删除旧键，此后不再写旧键。 | Web storage | `team-path.test.ts`、真实浏览器 storage inspection | Partial local |
| P-1-09 | Release B 删除旧 browser key 读取、旧 Team 页面 redirect 和全部 checker allowlist。 | Web/CI | `team-path.test.ts`、redirect test、`npm run check:team-terminology` | Not started |
| P-1-10 | Artifact upload proxy 与 Server HTTP 只存在 `/api/teams/:teamId/...`。 | HTTP/Web | route existence test、multipart upload/preview/download smoke | Green local |
| P-1-11 | Device list/Agent 查询显式使用 `teamId`；device-bound get/scan/select-directory/delete/rename 只使用 `deviceId`；invite/login/custom Agent create 符合各自 canonical contract。 | Device/Web/E2E | targeted tests、browser Device flow | Green local |
| P-1-12 | `main` 不再构建、测试、部署或发布 legacy source trees；rollback 使用 Git/Railway/npm artifact。 | Repository/CI/Operations | cutover audit、workflow inspection、rollback runbook、npm dist-tags | Not started |
| P-1-13 | README、AgentBean Next 活动文档和当前 specs 只描述 Team product contract。 | Docs | 活动文档静态扫描零结果 | Green local |
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
- GitHub-hosted combined browser smoke 通过 `39/39`，其中 preview `20/20`、App Router WebUI `19/19`；覆盖 Team create/switch/delete/fallback、Device、Agent、Artifact、Task、Run、Settings 与 Admin flow。
- Railway production deployment `58e4c03e-1e73-4513-85c7-74705709b488` 于 `2026-07-11T01:39:29.347Z` 创建，实例状态为 `RUNNING`，volume `api-volume` 以 `READY` 状态挂载到 `/data`。
- production strict cutover audit 通过 `12/12`；`https://api.agentbean.dev` 首次 healthcheck 即成功；public entry smoke `4/4`、business smoke `8/8`。
- npm truth 由 strict cutover audit 确认：`@agentbean/contracts@0.2.2`、`@agentbean/daemon-next@0.3.5`、canonical `@agentbean/daemon@0.3.5` 均存在，且 canonical `latest` 指向 `0.3.5`。
- 发布后观察期基线备份于 `2026-07-11T01:57:11Z` 使用 SQLite online backup API 写入 production volume：
  - `/data/agentbean-next/backups/release-a-observation/global.sqlite.release-a-postdeploy-20260711T0157Z.bak`；`827392` bytes；SHA256 `e9d66dc2721713179bad24bb8ad5f6e6b48ba057ba8db6d5ebc94aedeb7401ab`；权限 `0600`；`integrity_check=ok`。
  - `/data/agentbean-next/backups/release-a-observation/team.sqlite.release-a-postdeploy-20260711T0157Z.bak`；`2203648` bytes；SHA256 `b634c14cb01c0afa82638c008f7ba1930372f1a058f88c8bd56c7dbbf6efa340`；权限 `0600`；`integrity_check=ok`。
  - global migration ledger 包含 `global/0014_device_revocations_team_columns.sql`，applied_at 为 `1783734054646`。
- 计划要求的 Release A **发布前** global SQLite backup 没有可验证证据；上述文件是发布后回滚基线，不能追溯替代发布前备份。该缺口保持显式记录。
- 7 天观察窗口从 production smoke 完成时开始：`2026-07-11 09:41:41` 至 `2026-07-18 09:41:41`（Asia/Shanghai）。窗口结束前禁止执行 Release B。

当前 Phase -1 仍为 `in_progress`。P-1-08 尚缺真实旧键迁移的浏览器 storage inspection；P-1-09、P-1-12 属于 Release B；P-1-16 要求 Release B production evidence。Release A 的发布前 backup 证据缺失，发布后基线备份已完成并验证。

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
- Release A SQLite backup path / size / SHA256：见“2026-07-11 Release A 已发布证据”；仅有 post-deploy baseline，pre-release backup evidence 缺失
- Release A browser smoke：main CI combined browser `39/39`
- 7 天观察开始与结束时间：`2026-07-11 09:41:41` 至 `2026-07-18 09:41:41`（Asia/Shanghai）
- Release B merge commit：
- Release B `main` CI run：
- Release B production deployment：
- Release B terminology checker：
- Release B Team/Device/Artifact production smoke：
- npm `@agentbean/daemon` dist-tags 查询结果：
