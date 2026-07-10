# Phase -1 Team 术语切换验收矩阵

本矩阵只覆盖 `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` 的 Phase -1。任何必需项没有可复现证据时，Phase -1 都保持 `in_progress`，不得启动 Phase 0。

## 状态定义

- `Not started`：尚未实施。
- `Red`：已有测试或检查证明当前实现不满足。
- `Partial local`：已有实现或局部测试证据，但必需的完整 browser/smoke/build gate 尚未全部完成。
- `Green local`：本地测试、构建和 smoke 已通过，但尚未发布。
- `Green production`：Release B 已发布，production smoke 与数据校验通过。

## 必需验收项

| ID | 验收项 | 层级 | 必需证据 | 当前状态 |
|---|---|---|---|---|
| P-1-01 | `WEB_EVENTS` 不再暴露旧 admin Team events，只保留 canonical Team events。 | Contracts | `npm run test:contracts`、`npm run build:contracts` | Green local |
| P-1-02 | Server 不注册旧 admin handlers，缺少 `teamId` 时返回 canonical validation error。 | Socket | `socket-handlers.test.ts` | Green local |
| P-1-03 | Device Agent、Admin Agent、Admin Device 响应只包含 `teamId`、`teamName`、`primaryTeamId`、`primaryTeamName`、`visibleTeamIds`。 | UseCase/Socket | `socket-integration.test.ts` | Green local |
| P-1-04 | Fresh global SQLite 使用 `teams`、`team_members` 和 Team snake_case columns。 | Repository | `sqlite-repositories.test.ts`、schema inspection | Green local |
| P-1-05 | 0011 形状的 `device_revocations` 可升级到 snake_case，普通 profile、`NULL profile_id`、主键和索引全部保留。 | Repository/Migration | `device-revocations-repository.test.ts`、`sqlite-repositories.test.ts` | Green local |
| P-1-06 | Web socket/client/store 不再声明、映射或发送 non-canonical Team aliases/fields。 | Web unit | `socket-client.test.ts`、`npm run build:web-next` | Green local |
| P-1-07 | App Router 动态 segment 为 `[teamPath]`，团队管理入口为 `/:teamPath/teams`；Release A 的旧收藏 URL 只经过 permanent redirect，不保留旧页面实现。 | Web route | route manifest、redirect test、Web build、browser smoke | Green local |
| P-1-08 | Release A 首次读取旧 browser key 时写入 `agentbean.teamPath` 并删除旧键，此后不再写旧键。 | Web storage | `team-path.test.ts`、真实浏览器 storage inspection | Partial local |
| P-1-09 | Release B 删除旧 browser key 读取、旧 Team 页面 redirect 和全部 checker allowlist。 | Web/CI | `team-path.test.ts`、redirect test、`npm run check:team-terminology` | Not started |
| P-1-10 | Artifact upload proxy 与 Server HTTP 只存在 `/api/teams/:teamId/...`。 | HTTP/Web | route existence test、multipart upload/preview/download smoke | Green local |
| P-1-11 | Device list/Agent 查询显式使用 `teamId`；device-bound get/scan/select-directory/delete/rename 只使用 `deviceId`；invite/login/custom Agent create 符合各自 canonical contract。 | Device/Web/E2E | targeted tests、browser Device flow | Partial local |
| P-1-12 | `main` 不再构建、测试、部署或发布 legacy source trees；rollback 使用 Git/Railway/npm artifact。 | Repository/CI/Operations | cutover audit、workflow inspection、rollback runbook、npm dist-tags | Not started |
| P-1-13 | README、AgentBean Next 活动文档和当前 specs 只描述 Team product contract。 | Docs | 活动文档静态扫描零结果 | Green local |
| P-1-14 | CI 静态门禁能拒绝旧字段、事件、route、storage key、schema 和已废弃产品名。 | CI | checker unit tests、PR check | Partial local |
| P-1-15 | Contracts、Domain、Server、Daemon、Web tests 与全部 TypeScript builds 通过。 | Regression | root test/build commands、CI run URL | Green local |
| P-1-16 | Release B 后真实 Team switch、Device 接入、Artifact 上传和 SQLite revocation 行为通过 production smoke。 | Production | deploy URL/run、smoke logs、DB backup/upgrade evidence | Not started |

## 2026-07-10 Release A 本地证据

| 验收项 | 实现提交 | 可复现证据 | 结论 |
|---|---|---|---|
| P-1-01 | `5f3d7b5` | `npm run test:contracts`; `npm run build:contracts` | contracts 已通过本地测试与构建。 |
| P-1-02 / P-1-03 | `ff0ce25`, `16be460` | server-next targeted tests; `npm run test:server-next`; `npm run build:server-next` | canonical admin handler、DTO 与权限回归通过。 |
| P-1-04 / P-1-05 | `3c6d1d8`, `48ddb52` | device revocation / SQLite repository tests; `npm run build:server-next` | fresh schema 与追加迁移通过；production DB 备份恢复尚未演练。 |
| P-1-06 | `cc7a8e9`, `b6521ae`, `d298271`, `68a26ac` | `npm run test:web-next -- --api.host 127.0.0.1`（26 files / 194 tests）; `npm run build:web-next` | Web canonical DTO、payload 与完整 App Router build 通过。 |
| P-1-07 / P-1-08 | `3f3be1c`, `2ed4bdd` | team-path/socket-client tests; browser smoke unit 16/16; readiness 54/54; `npm run build:web-next`; `npm run build:server-next` | canonical route、308 redirect 与 Team 子流程两次通过，P-1-07 达到 `Green local`；尚未用真实浏览器从旧 key 启动并检查迁移结果，P-1-08 保持 `Partial local`。 |
| P-1-10 | `d298271`, `b550710` | route existence regression；Web tests 194/194；Web build；Chrome browser smoke 20/20 覆盖 multipart upload、preview、download | canonical Artifact route 与本地真实链路达到 `Green local`。 |
| P-1-11 | `b550710`, `68a26ac` | Device/Agent targeted regressions；Web tests 194/194；Chrome browser smoke 覆盖 Device、runtime 与 custom Agent | 单元与 preview browser 证据已具备；完整 App Router 长 smoke 未到达 Device 阶段，暂记 `Partial local`。 |
| P-1-13 | 本 Task 9 | 计划给定的 README、AgentBean Next docs 与当前 specs forbidden-token scan 返回零结果；三份被主 PRD 取代的设计已删除 | 活动文档达到 `Green local`。 |
| P-1-14 | `b27d79b` | terminology checker 6/6；18 个默认 roots 全仓扫描通过；CI change-detection 闭包测试通过 | 本地门禁已通过；GitHub-hosted PR check 尚未发生，暂记 `Partial local`。 |
| P-1-15 | `b27d79b` 后 Release A HEAD | Contracts 9/9、Domain 24/24、Server 367/367、Daemon 222/222（1 个既有 e2e skip）、Web 194/194；五项 TypeScript/Web build；readiness 54/54；persistence 6/6；Chrome browser smoke 20/20 | 2026-07-11 完整本地门禁通过，达到 `Green local`；尚无 `main` CI 证据。 |

当前 Phase -1 仍为 `in_progress`。P-1-08 尚缺真实旧键迁移的浏览器 storage inspection；P-1-09、P-1-12 属于 Release B；P-1-14 尚缺 GitHub-hosted PR check；P-1-16 尚无 Release B production evidence。

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

- Release A merge commit：
- Release A `main` CI run：
- Release A production deployment：
- Release A SQLite backup path / size / SHA256：
- Release A browser smoke：
- 7 天观察开始与结束时间：
- Release B merge commit：
- Release B `main` CI run：
- Release B production deployment：
- Release B terminology checker：
- Release B Team/Device/Artifact production smoke：
- npm `@agentbean/daemon` dist-tags 查询结果：
