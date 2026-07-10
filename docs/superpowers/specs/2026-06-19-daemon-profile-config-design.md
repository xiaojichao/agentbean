# daemon-next 多 profile 与配置：当前结论

- 日期：2026-06-19
- 更新：2026-07-10
- 状态：已实现；原始迁移设计由 Git history 保存

## 文档定位

原始版本对比旧 daemon 与 daemon-next，并包含已退役实现的字段和路径。那些内容不能通过字段替换变成当前事实，因此活动文档只保留已实现的 canonical 合同。

## 当前行为

- saved auth 存在 `~/.agentbean/teams/{profileId}/auth.json`。
- auth 数据保存 `token`、`serverUrl`、`teamId` 与 `ownerId`。
- Device invite 完成后保存 profile；后续启动可直接恢复，不需要重复输入 invite。
- Server 在 hello ack 中续签 device-bound credential；daemon-next 把刷新 token 持久化回当前 profile。
- `--all-profiles` 枚举 saved profiles，并为每个 profile 启动独立连接。
- YAML 配置支持环境变量插值；配置优先级为 CLI > env > YAML > 默认值。
- profile rename、list 与 clear 都有明确错误边界，不静默覆盖目标 profile。
- 每个 profile 有独立 socket、reconnect、rescan 与 scan cache；`--all-profiles` 不把多个 Team 合并成一个共享 session。

## 证据

- `apps/daemon-next/src/profile-paths.ts`
- `apps/daemon-next/src/auth-store.ts`
- `apps/daemon-next/src/config.ts`
- `apps/daemon-next/src/cli.ts`
- `apps/daemon-next/tests/auth-store.test.ts`
- `apps/daemon-next/tests/cli.test.ts`
- `apps/daemon-next/tests/protocol-client.test.ts`
- `agentbean-next/docs/known-gaps.md`
- `agentbean-next/docs/verification-matrix.md`

旧实现对比、曾考虑的依赖方案和当时行号只在 Git history 中保留，不再作为活动实现指南。
