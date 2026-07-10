# Phase -1 Team 术语切换验收矩阵

本矩阵只覆盖 `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` 的 Phase -1。任何必需项没有可复现证据时，Phase -1 都保持 `in_progress`，不得启动 Phase 0。

## 状态定义

- `Not started`：尚未实施。
- `Red`：已有测试或检查证明当前实现不满足。
- `Green local`：本地测试、构建和 smoke 已通过，但尚未发布。
- `Green production`：Release B 已发布，production smoke 与数据校验通过。

## 必需验收项

| ID | 验收项 | 层级 | 必需证据 | 初始状态 |
|---|---|---|---|---|
| P-1-01 | `WEB_EVENTS` 不再暴露第二套 admin 空间事件，只保留 Team events。 | Contracts | `npm run test:contracts`、`npm run build:contracts` | Not started |
| P-1-02 | Server 不注册旧 admin handlers，缺少 `teamId` 时返回 canonical validation error。 | Socket | `socket-handlers.test.ts` | Not started |
| P-1-03 | Device Agent、Admin Agent、Admin Device 响应只包含 `teamId`、`teamName`、`primaryTeamId`、`primaryTeamName`、`visibleTeamIds`。 | UseCase/Socket | `socket-integration.test.ts` | Not started |
| P-1-04 | Fresh global SQLite 使用 `teams`、`team_members` 和 Team snake_case columns。 | Repository | `sqlite-repositories.test.ts`、schema inspection | Not started |
| P-1-05 | 0011 形状的 `device_revocations` 可升级到 snake_case，普通 profile、`NULL profile_id`、主键和索引全部保留。 | Repository/Migration | `device-revocations-repository.test.ts`、`sqlite-repositories.test.ts` | Not started |
| P-1-06 | Web socket/client/store 不再声明、映射或发送旧空间字段。 | Web unit | `socket-client.test.ts`、`npm run build:web-next` | Not started |
| P-1-07 | App Router 动态 segment 为 `[teamPath]`，团队管理入口为 `/:teamPath/teams`。 | Web route | route manifest、Web build、browser smoke | Not started |
| P-1-08 | Release A 首次读取旧 browser key 时写入 `agentbean.teamPath` 并删除旧键，此后不再写旧键。 | Web storage | `team-path.test.ts`、真实浏览器 storage inspection | Not started |
| P-1-09 | Release B 删除旧 browser key 读取和 checker allowlist。 | Web/CI | `team-path.test.ts`、`npm run check:team-terminology` | Not started |
| P-1-10 | Artifact upload proxy 与 Server HTTP 只存在 `/api/teams/:teamId/...`。 | HTTP/Web | route existence test、multipart upload/preview/download smoke | Not started |
| P-1-11 | Device login、invite、list/detail/scan/rename 与 custom Agent create 只使用 Team payload。 | Device/Web/E2E | targeted tests、browser Device flow | Not started |
| P-1-12 | `main` 不再构建、测试、部署或发布 legacy source trees；rollback 使用 Git/Railway/npm artifact。 | Repository/CI/Operations | cutover audit、workflow inspection、rollback runbook、npm dist-tags | Not started |
| P-1-13 | README、AgentBean Next 活动文档和当前 specs 只描述 Team product contract。 | Docs | 活动文档静态扫描零结果 | Not started |
| P-1-14 | CI 静态门禁能拒绝旧字段、事件、route、storage key、schema 和已废弃产品名。 | CI | checker unit tests、PR check | Not started |
| P-1-15 | Contracts、Domain、Server、Daemon、Web tests 与全部 TypeScript builds 通过。 | Regression | root test/build commands、CI run URL | Not started |
| P-1-16 | Release B 后真实 Team switch、Device 接入、Artifact 上传和 SQLite revocation 行为通过 production smoke。 | Production | deploy URL/run、smoke logs、DB backup/upgrade evidence | Not started |

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

Release B 删除一次性 browser migration 后，重复 Release A 全部命令，并再次运行 `npm run check:team-terminology`。Expected: checker 在没有 allowlist 的状态下 exit 0。

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
