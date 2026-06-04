# 第一切片实现状态

本文记录 AgentBean Next 第一切片当前已经落地的代码、验证证据与剩余边界。

## 已实现

- `packages/contracts`
  - `Ack<T>`、`ErrorCode`、基础 DTO 与 first-slice socket event constants。
  - 统一使用 `team` 概念，不引入旧事件别名。
- `packages/domain`
  - Mention routing、unknown/human mention、fallback 与 no-online routing。
  - Agent adapter/path/name normalization、identity key、merge/display/status 规则。
  - Private channel visibility 纯函数。
- `apps/server-next`
  - Global/team SQLite first-slice migrations。
  - User、team、channel、device、runtime、agent、message、dispatch repositories。
  - Register/login/list teams/list channels/device hello/runtime report/agent batch/message send/dispatch result/error/timeout use cases。
  - `/web` 与 `/agent` Socket.IO namespace adapters。
- `apps/daemon-next`
  - Protocol client：device hello、runtime report、agent batch、dispatch request -> stub result。
- `apps/web-next`
  - Web socket client。
  - Session 只保存 token 与 current team。
  - Snapshot reducer 只替换 server projection，不做 agent dedupe。

## 已验证

覆盖范围：

- Phase 1 contracts/domain tests。
- Phase 2 server repository/use-case/socket tests。
- Phase 3 daemon protocol/stub executor tests。
- Phase 4 web protocol/state boundary tests。
- E2E gates：
  - Register -> daemon hello -> runtime report -> agent batch -> message send -> dispatch result -> agent reply visible。
  - No-online agent 非致命路径。
  - Daemon reconnect 后不 clone agent。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

环境备注：

- 当前本机根目录未必已经安装 workspace dependencies。
- 如果直接运行根脚本前尚未安装依赖，可先安装 workspace dependencies；临时验证时可使用 `apps/server/node_modules` 中已安装的 Vitest/TypeScript/Socket.IO。
- SQLite 测试依赖 `better-sqlite3` native module；当前已验证可用的本机 Node 是 `/Users/shaw/.nvm/versions/node/v22.22.0/bin/node`。

## 暂未实现

这些不属于第一切片冻结前必需项：

- 真实 daemon adapter 迁移。
- 浏览器 UI shell 与组件渲染。
- Device invite flow、user join links、tasks、artifacts、search、admin、metrics、saved messages 与 reactions。
- 生产部署脚本与 CI workflow 接入。
