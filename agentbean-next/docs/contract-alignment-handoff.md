# 契约对齐与文档回补交接

本文记录 PR #72 之后继续按文档推进开发时发现的契约偏差。它是交接清单，不是实现 PR：本轮只暴露问题、回补明确的文档漏项，并给出推荐修法与验收标准，具体代码修改应由后续开发 PR 拆分完成。

## 范围与结论

- `message:send` 的协议文档漏写当前实现实际要求的 `userId` 与 `teamId`；这是明确文档漏项，本轮已在协议文档与验证矩阵中回补。
- Daemon builtin scanner 的产品决策已确认：扫描到的 CLI runtime 只代表 runtime capability，不应自动生成 visible product agent。只有用户创建或绑定 custom agent 后，才应进入 visible agent list。
- 其余项目是代码契约与文档契约错位，本文给出接手建议，不在本轮直接修改实现代码。

## 1. Agent snapshot refresh 缺少二次 membership gate

### 现象

`apps/server-next/src/transport/socket-server.ts` 中，`agents:subscribe` 的初始订阅会先通过 `listChannels(input)` 做 team membership gate，再调用 `listVisibleAgents({ teamId })` 并记录 active subscription。后续 `refreshAgentSubscribers` 刷新时只按 `teamId` 找订阅者，并直接调用 `listVisibleAgents({ teamId })`，没有重新带 `userId` 校验。

当前 socket 生命周期里通常不会马上出错，但如果用户在 socket 未断开时被移出 team，旧订阅仍可能继续收到 `agents:snapshot`。

### 影响

文档一直强调 server 拥有权限与可见性边界。这里会让 agent snapshot broadcast 在成员关系变化后依赖旧订阅状态，和 channel/device refresh 的 per-user gate 方向不一致。

### 推荐修改

- 在 `refreshAgentSubscribers` 中保留订阅时的 `{ userId, teamId }`，每次刷新前重新执行 team membership gate。
- 或者新增/改造 use case，例如 `listVisibleAgents({ userId, teamId })`，让 agent 可见性查询本身带 user/team gate。
- 如果刷新时发现用户已无权访问 team，应停止向该 socket 推送，并清理当前 agent subscription。

### 验收标准

- 用户订阅 `agents:subscribe` 后，如果成员关系被移除，后续 daemon agent batch 或 dispatch status 变化不再向该 socket 推送 `agents:snapshot`。
- 新增 server/socket 测试覆盖 membership removal after subscribe。
- 未授权用户初始订阅仍返回 `FORBIDDEN` 或等价 failure ack。

## 2. RuntimeDto 文档字段与 public contract 不一致

### 现象

`agentbean-next/docs/contracts-dto.md` 中的 `RuntimeDto` 包含 `installed`、`command`、`cwd`、`normalizedCommandKey`、`normalizedCwdKey`。但 `packages/contracts/src/agent.ts` 的 public `RuntimeDto` 仍只包含 `id`、`deviceId`、`adapterKind`、`name`、`version`、`status`、`lastSeenAt`，`apps/server-next/src/application/usecases.ts` 的 `toRuntimeDto` 也会丢掉 runtime capability 字段。

### 影响

设备详情、`device:runtimes`、web-next 类型层拿不到文档承诺的 runtime capability 信息。第十四切片 scanner 已经上报 `command`、`cwd` 与 `installed`，但这些字段在 server/public DTO 边界被截断。

### 推荐修改

- 将 public `RuntimeDto` 与 `contracts-dto.md` 对齐，补齐 `installed`、`command`、`cwd`、`normalizedCommandKey`、`normalizedCwdKey`。
- 确认 `toRuntimeDto` 不再截断这些字段。
- 确认 device detail、`device:runtimes` socket event、web-next `onDeviceRuntimes` 类型都能读取这些字段。

### 验收标准

- contracts type fixture 能编译包含完整 runtime capability fields 的 `RuntimeDto`。
- daemon 上报 runtime 后，server ack 与 `device:runtimes` event 保留 `installed`、display command/cwd 与 normalized keys。
- web-next 测试能从 runtime event 中读取这些字段。

## 3. message:send 文档漏写 userId/teamId

### 现象

`apps/web-next/src/index.ts` 的 `SendMessageInput` 和 server use case 都要求 `userId`、`teamId`、`channelId`、`body`、`clientMessageId`。原 `agentbean-next/docs/socket-protocol.md` 只列出 `channelId`、`body`、`clientMessageId` 等字段，导致照文档接入会缺少 membership 与 routing input。

### 影响

后续 UI 或客户端开发如果只按协议文档实现，`message:send` 会因为无法完成 team/channel gate 而失败，常见表现是 `FORBIDDEN`、`NOT_FOUND` 或无法正确路由。

### 本轮处理

本轮直接回补协议文档与验证矩阵，明确当前 first-slice socket payload 需要 `userId` 与 `teamId`。这不改变当前 server 行为。

### 后续注意

如果后续引入 authenticated socket session，并决定由 server 从 session 派生 `userId` 或 current team，则必须同时修改 web client、server use case、协议文档与测试，避免重新出现文档/代码分叉。

## 4. DispatchStatus 命名不一致

### 现象

`packages/contracts/src/dispatch.ts` 当前状态是 `queued`、`accepted`、`running`、`completed`、`failed`、`cancelled`、`timeout`。但 `agentbean-next/docs/contracts-dto.md` 与 `agentbean-next/docs/verification-matrix.md` 使用的是 `succeeded` 与 `timed_out`。

### 影响

UI 状态判断、dispatch timeout 测试命名、server repository 状态值和文档验收口径会分裂。后续开发如果按文档写测试，会和 public contract 类型不匹配；如果按代码写 UI，则会偏离文档状态矩阵。

### 推荐修改

- 先由负责人确认 canonical 状态命名。
- 建议优先保留文档中的 `succeeded` 与 `timed_out` 作为目标契约，因为它们比 `completed` 与 `timeout` 更明确地区分成功完成和超时失败。
- 无论最终选择哪套，都必须一次性对齐 `packages/contracts`、server repository/use case、daemon result handling、web state helper、测试 fixture 与所有 docs。

### 验收标准

- `DispatchStatus` 在 public contract、docs、fixtures、server tests、daemon tests、web tests 中只出现一套 canonical 命名。
- Timeout 验收项与实际状态值一致。
- UI dispatch status helper 不需要兼容两套状态名。

## 5. Builtin scanner 应只产出 runtime capability，不自动生成 visible product agent

### 已确认决策

Daemon builtin scanner 扫描到 Claude Code、Codex CLI、Gemini CLI 等 CLI runtime 时，只代表该 device 具备相应 runtime capability。它不应自动生成 `executor-hosted` visible product agent。

Visible product agent 应来自用户创建、导入或显式绑定的 agent 配置；runtime capability 可以作为创建/绑定 custom agent 的候选能力。

### 当前偏差

`apps/daemon-next/src/scanner.ts` 当前在 runtime installed 时会同时 push runtime report 与 `executor-hosted` agent report。`apps/server-next/src/application/usecases.ts` 的 `registerDiscoveredAgents` 会把这些 discovered agents upsert 为 `source: "scanned"` 且对 team 可见的 agents。

因此，只要本机安装了 Codex CLI，就可能自动出现一个可见的 `Codex` product agent。这和已确认的 runtime capability 决策不一致。

### 推荐修改

- daemon builtin scanner 只上报 `runtimes`，不为 installed runtime 自动上报 `agents`。
- server 不应把 runtime report 转换成 visible agent。
- custom agent 创建/绑定流程应引用 runtime capability，例如 adapter kind、command、cwd、normalized keys，但只有用户动作完成后才进入 visible agent list。
- 如果后续仍需要展示“可创建的 runtime 候选”，应放在 device/runtime UI 或 agent creation UI 中，而不是混入 `agents:snapshot`。

### 验收标准

- 安装 Codex CLI 后，`device:runtimes` 显示 Codex CLI installed，但 `agents:snapshot` 不自动出现 `Codex` agent。
- 用户创建或绑定 custom agent 后，对应 agent 才进入 visible agent list，并能引用 runtime capability。
- Daemon scanner 测试覆盖 installed runtime only produces runtime capability。
- Server socket/E2E 测试覆盖 runtime report 不会导致 visible agent snapshot 增加 product agent。

## 6. server-next build 缺少 Node 类型依赖

### 现象

`apps/server-next` 使用 `node:crypto`、`node:fs`、`node:url`、`node:path` 等 Node builtins，但 `apps/server-next/tsconfig.json` 没有 Node types 配置，根 `package.json` 的 devDependencies 也没有 `@types/node`。当前测试可以通过，但干净执行 `npm run build:packages` 时，server-next type build 无法稳定复现通过。

### 影响

状态文档记录的 build 验证会和新 checkout 的实际结果不一致。后续开发者按文档验证时，会在 server-next build 阶段遇到 Node builtin type declaration 缺失。

### 推荐修改

- 在 workspace devDependencies 中补充与当前 Node/TypeScript 兼容的 `@types/node`。
- 在 server-next/daemon-next 相关 tsconfig 中明确 Node types 策略，避免 browser/web 包继承不必要的 Node globals。
- 重新确认 `npm run build:packages` 在干净依赖安装后可通过。

### 验收标准

- 从干净 checkout 安装依赖后，根目录 `npm run build:packages` 通过。
- `apps/server-next` 不再报告 `node:*` module type declarations missing。
- 文档中的验证记录和实际 build 命令一致。

## 建议接手顺序

1. 先修 Node types/build 复现问题，保证后续所有 PR 的基础验证可信。
2. 对齐 `RuntimeDto` 与 `message:send` 这类 DTO/protocol 契约，避免继续扩散到 web-next。
3. 按已确认产品决策修正 scanner runtime capability 与 visible agent 边界。
4. 修正 `agents:subscribe` refresh 的权限二次校验。
5. 最后统一 `DispatchStatus` 命名，并同步迁移测试和 UI 状态判断。

## 建议新增或更新的验证

- `apps/server-next/tests`：agent subscription 在成员关系变化后不再推送 snapshot。
- `packages/contracts/tests`：`RuntimeDto` fixture 包含完整 capability fields。
- `apps/server-next/tests`：runtime report ack 与 device runtime event 保留 normalized fields。
- `apps/daemon-next/tests`：builtin scanner installed runtime 不生成 visible agent report。
- `apps/web-next/tests`：message send client input 与 dispatch status helper 使用 canonical contract。
- 根目录 build：`npm run build:packages` 可在干净依赖安装后通过。
