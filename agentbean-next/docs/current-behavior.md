# 当前行为基线

这是从当前仓库文档和实现中抽取出的紧凑基线。它在实现开始前还应继续细化，但已经足够指导第一条重写切片。

## 产品模型

AgentBean 是一个 local-first 协作产品，人类和 agent 在同一个 team 或 network 中工作。

核心对象：

- User
- Network 或 team
- Network membership
- Device
- Agent
- Runtime
- Channel
- DM
- Thread
- Message
- Task
- Artifact
- Workspace run
- Invite 或 join link

## 进程模型

AgentBean 由三个协作进程组成：

- Web：面向人类用户的 Next.js UI。
- Server：Express 与 Socket.IO 协作中枢。
- Daemon：本地设备桥接进程，负责发现 runtimes 并执行 agents。

当前通信方式：

- Web 连接到 Server 的 `/web`。
- Daemon 连接到 Server 的 `/agent`。
- Web 通过 HTTP routes 上传 artifacts。
- Daemon 在执行后上传或报告生成的 artifacts。

## 身份与成员关系

- 用户使用 username 和 password 注册。
- 注册会创建或加入一个 network。
- 登录返回 user token 和 current network。
- 一个用户可以属于多个 networks。
- Server 会持久化用户的 current network。
- Private channels 只对选中的 members 可见。
- Public channels 对 network 中所有 members 可见。

## Agent 模型

Agent categories：

- `executor-hosted`：Codex、Claude Code、Kimi CLI 等本地 runtimes。
- `agentos-hosted`：Hermes、OpenClaw 等 gateway-backed agents。

Agent sources：

- `self-register`
- `scanned`
- `custom`

重要行为：

- Agents 属于一个 primary network。
- Agents 可以 publish 到额外 networks。
- Agent online status 取决于 daemon/device state 与 heartbeat。
- Custom agent online status 取决于 device online state、runtime availability 和 project directory availability。
- Agent identity 必须对 scan registrations、self-registrations 与 custom-agent representations 做一致去重。

## Device 与 Daemon 行为

Daemon 启动行为：

1. 读取本地 profile/device config。
2. 连接 Server。
3. 上报 device metadata。
4. 扫描本地 runtimes。
5. 扫描 AgentOS gateways。
6. 扫描本地 agent configs。
7. 注册发现的 agents。
8. 周期性重新扫描。
9. 接收 dispatch requests 并执行。

Device invite 行为：

1. Web 创建 device invite。
2. 用户使用该 invite 运行 daemon command。
3. Daemon 等待 token delivery。
4. Browser device-login 完成用户认证。
5. Server 把 token 交付给等待中的 daemon。
6. Daemon 携带 token 重新连接 `/agent`。

## Message 行为

- Channel messages 会被持久化。
- Human messages 的 sender identity 来自已认证 socket。
- 消息开头的 `@AgentName` 会定位匹配的 online agent。
- `@HumanName` 不应 dispatch 给 agents。
- Unknown mentions 不应 fallback 到另一个 agent。
- 没有 mention 的消息 fallback 到第一个符合条件的 online agent。
- 如果没有 agent online，human message 仍然持久化。
- Thread dispatch 不得把当前 prompt 包含两次。

## Dispatch 行为

Server dispatch 职责：

- 决定 target agent。
- 构造 prompt、history、attachments、network/team context。
- 把 request 发送给正确的已连接 daemon 或 AgentOS socket。
- 跟踪 timeout。
- 持久化 reply 或 error。
- 向 web clients 广播 message 与 dispatch status。

Daemon dispatch 职责：

- 解析 runtime command。
- 在相关场景中校验 working directory。
- 执行 adapter。
- 收集生成的 artifacts。
- 上传或报告 artifacts。
- 返回 text、artifact IDs 与 errors。

## Artifact 行为

- Artifacts 上传到 server storage。
- Artifact metadata 与 network/channel/message context 一起持久化。
- Agent replies 可以包含生成的 artifacts。
- Web 可以预览 images 并下载 files。
- Agent workspace views 应展示 runs 生成的 files。

## Task 行为

当前状态：

- UI 已有 task board/list 体验。
- 当前分支中 Server 已有 task persistence 与 socket APIs。
- Tasks 属于 network，并可关联 channels/messages。

必需行为：

- Create、list、update、delete tasks。
- 变更 task status。
- 持久化 task ordering。
- 广播 task updates。

## 当前技术形态

有用的技术选择：

- 全应用使用 TypeScript。
- 使用 Socket.IO 作为 realtime protocol。
- 使用 SQLite 做 local-first persistence。
- 使用 Vitest 做聚焦测试。
- Web 使用 Next.js App Router。

有问题的实现形态：

- Server core 过度集中在 `apps/server/src/index.ts`。
- DB schema 与 repository behavior 过度集中在 `apps/server/src/db.ts`。
- Agent namespace behavior 混合了 transport、persistence、registry 与 dispatch coordination。
- Web socket client 过宽。
- Web store 包含应迁移到 server/domain contracts 的 domain rules。
- 多个大型页面混合 data loading、UI state 与 feature logic。

## 第一切片基线

第一条重写切片应证明：

1. 用户可以登录或注册。
2. 用户拥有 current network。
3. Daemon 可以连接并上报 device。
4. Daemon 可以上报一个 runtime 和一个 agent。
5. Web 可以看到该 device 和 agent。
6. 用户可以创建或加入 channel。
7. 用户可以发送 message。
8. Server dispatch 到 agent。
9. Daemon 返回 reply。
10. Server 持久化并广播 reply。
