# 实现 Runbook

这是构建 AgentBean Next 第一切片的执行检查清单。它比 `migration-plan.md` 更具体，应按顺序执行。

## 基本规则

- 新代码与当前 `apps/web`、`apps/server`、`apps/daemon` 分开构建。
- 不保留旧 Socket.IO event names、旧 SQLite schemas 或旧 module shapes。
- 构建第一切片时，不实现后续切片功能。
- 每一步都必须产出代码，并配套 tests 或 typed contract。
- 如果某一步需要产品决策，先更新 docs，再围绕它写代码。

## 目标工作区

推荐的第一版实现布局：

```text
packages/
  contracts/
    src/
      common.ts
      auth.ts
      team.ts
      device.ts
      agent.ts
      channel.ts
      message.ts
      dispatch.ts
      socket.ts
apps/
  server-next/
  daemon-next/
  web-next/
```

如果仓库还没有 root package/workspace，应先创建，再添加这些 projects。

## Step 1：创建 `packages/contracts`

输入：

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- `docs/agent-identity-rules.md`

构建：

- Shared DTO types。
- `Ack<T>` 与 `ErrorCode`。
- Adapter kind、agent category、agent status、dispatch status。
- 作为 constants 或 typed maps 的 socket event names。

测试：

- 如果引入 validator，添加 type-only 或 runtime schema tests。
- 不从 server、web 或 daemon apps 导入。

完成标准：

- Contracts 可独立 build。
- Server、web 与 daemon 可以导入 contracts 且没有 circular dependencies。
- Contracts 中不存在 database row types。

## Step 2：构建 Domain Pure Functions

输入：

- `docs/agent-identity-rules.md`
- `docs/current-behavior.md`
- `docs/acceptance-tests.md`

构建：

- Message routing：mention、human mention、unknown mention、fallback、no-online。
- Agent identity normalization 与 key generation。
- Agent merge/display/status resolution。
- Channel visibility rules。
- Agent visibility/publication rules。

测试：

- `docs/verification-matrix.md` 中所有 Phase 1 tests。

完成标准：

- Domain tests 不依赖 Socket.IO、Express、Next.js、daemon code 或 SQLite 即可运行。
- Web 不需要自己的 agent dedupe algorithm。

## Step 3：创建 `apps/server-next`

输入：

- `docs/first-slice-schema-repositories.md`
- `docs/contracts-dto.md`
- `docs/socket-protocol.md`

构建：

- App bootstrap。
- SQLite migration runner。
- Global DB connection。
- Team DB/storage manager。
- Repository interfaces 与 SQLite implementations。
- Use-case layer。
- 薄 Socket.IO `/web` 与 `/agent` adapters。

第一批 use cases：

- `registerUser`
- `loginUser`
- `listTeams`
- `switchTeam`
- `deviceHello`
- `reportDeviceRuntimes`
- `registerDiscoveredAgents`
- `listVisibleAgents`
- `createChannel`
- `joinChannel`
- `sendMessage`
- `createDispatch`
- `receiveDispatchResult`
- `receiveDispatchError`

测试：

- 使用 temp SQLite 的 repository tests。
- Use-case tests。
- 使用 test clients 的 socket integration tests。

完成标准：

- Test web client 可以 register/login 并 create/join channel。
- Test daemon client 可以注册 device、runtimes 与一个 agent。
- 发送 message 会创建 persisted dispatch。
- 接收 daemon result 会持久化 agent message。

## Step 4：创建 `apps/daemon-next`

输入：

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- 现有 daemon scanner/adapter behavior 作为参考。

构建：

- CLI bootstrap。
- Agent protocol client。
- Device hello。
- Runtime report。
- Agent register batch。
- Dispatch request listener。
- 先做 stub executor。
- Stub path 通过后，可选迁移一个真实 local adapter。

测试：

- Protocol client tests。
- Stub dispatch result/error tests。
- Reconnect test。
- Runtime normalization tests。

完成标准：

- Daemon-next 可以连接 server-next。
- Daemon-next 上报一个 runtime 与一个 discovered agent。
- Daemon-next 接收 dispatch 并返回 text。
- Server-next 会根据 daemon activity 更新 dispatch 与 agent status。

## Step 5：创建 `apps/web-next`

输入：

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- 现有 UI information architecture 作为参考，而不是代码形状。

构建：

- Session token storage。
- Socket/API client。
- Login/register screen。
- Team shell。
- Device/agent status strip 或 panel。
- Channel list。
- Conversation view。
- Message composer。

测试：

- 使用 fake socket 的 API client tests。
- Session store tests。
- Login、channel list、conversation 与 status 的 component tests。
- 如果 tooling 可用，添加可选 browser smoke test。

完成标准：

- 用户可以 log in/register。
- 用户可以看到 current team。
- 用户可以看到 connected daemon 与 discovered agent。
- 用户可以 create/join channel。
- 用户可以发送 message 并看到 agent reply。

## Step 6：串起端到端 Smoke

构建：

- 一个 script 或 test harness，启动 server-next，并使用 test web/daemon clients。
- 如果 full browser testing 可用，在 protocol smoke 之后添加 minimal Web smoke。

必需场景：

1. Register user。
2. Get current team。
3. Daemon hello。
4. Runtime report。
5. Agent register batch。
6. Create channel。
7. Join channel。
8. Send message。
9. Server creates dispatch。
10. Daemon returns result。
11. Server persists and broadcasts agent reply。

完成标准：

- 该场景本地通过。
- 它能在 CI 中运行，或已有可接入 CI 的 documented command。

## Step 7：冻结第一切片

在实现 deferred features 前：

- 如果代码让某个 contract 或 schema decision 更精确，更新 docs。
- 确认所有 Phase 1-4 verification matrix tests 通过。
- 确认没有引入 old compatibility adapters。
- 确认 web 没有实现 agent dedupe 或 permission decisions。
- 确认 daemon 没有决定 team visibility。

## 暂不实现

第一切片变绿前，不实现：

- Tasks。
- Artifacts。
- Workspace runs。
- Device invite flow。
- User join links。
- Admin。
- Search。
- Channel archive/delete。
- Saved messages/reactions。
- Metrics UI。
