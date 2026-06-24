# 验收测试

这些测试定义半重建后必须保留下来的行为。它们以产品级场景编写，而不是当前实现测试。

## Auth 与 Team

### 注册会创建 Private Team

前提：新用户使用 username 和 password 注册，
当：注册成功，
结果：用户收到 session token，
并且创建一个 private team，
且该 team 成为用户的 current team。

### 登录会恢复 Current Team

前提：用户属于多个 teams，
并且用户之前切换到了其中一个 team，
当：用户再次登录，
结果：如果用户仍是该 team 的 member，server 返回已保存的 current team。

### Invite Join 会添加 Team Membership

前提：某 team 的 invite code，
当：新用户通过该 invite 注册，
结果：用户被加入受邀 team，
该受邀 team 成为用户的 current team，
并且登录或 `whoami` 后可以恢复该 current team。

### 已有用户可通过 Join Link 加入 Team

前提：某已登录用户不属于目标 team，
并且目标 team member 创建了 user join link，
当：该用户登录时提供 join code，
结果：server 将该用户加入目标 team，
并把 current team 切换到受邀 team。

### Join Link Validate 可在注册前预览 Team

前提：某 team 存在可用 user join link，
当：anonymous browser session 校验该 code，
结果：server 返回目标 team 的展示信息；
当：code 无效、过期或已耗尽，
结果：server 返回稳定 invite error code。

## Device 与 Daemon

### Device Invite 会把 Token 交付给 Daemon

前提：daemon 正携带 device invite code 等待，
当：已登录用户在 browser 中完成 device login，
结果：server 将 device token 交付给等待中的 daemon session，
并且 daemon 携带该 token 重新连接 `/agent`。

### Daemon 会注册 Runtimes 与 Agents

前提：daemon 使用有效 device token 连接，
当：它发送 device hello、runtimes 与 discovered agents，
结果：server 持久化 device，
存储 runtime metadata，
对 agents 去重，
并向 web clients 广播更新后的 device 与 agent snapshots。

### Missing Agent 会变成 Offline

前提：daemon 之前上报过某 agent，
当：后续扫描漏掉该 agent，
结果：server 将该 agent 标记为 offline，而不是删除它的历史 identity。

## Agent Identity

### Scanned 与 Self-Registered Agent 会去重

前提：daemon 通过 scan path 与 self-register path 上报同一个 agent，
当：两份报告共享 device 与 logical name 或 runtime identity，
结果：UI 看到一个 logical agent，而不是重复项。

### AgentOS Gateway 会去重

前提：发现了 Hermes 或 OpenClaw gateway agent，
当：gateway 也暴露 concrete hosted agents，
结果：generic gateway entries 不会覆盖同一 logical hosted agent 上更好的 display entries。

### Custom Agent 使用 Device Runtime

前提：用户在某 device 上创建 custom agent，
当：device 上报 compatible runtimes，
结果：dispatch 使用最佳可用 runtime command，
并在 runtime 或 working directory 不可用时报告清晰 error。

## Channels 与 Messages

### Public Channel 对 Team Members 可见

前提：某 team 中存在 public channel，
当：任意 team member 列出 channels，
结果：该 channel 可见。

### Private Channel 只对 Members 可见

前提：存在只选择了部分 human members 的 private channel，
当：非 member 列出 channels 或尝试 join，
结果：server 拒绝访问。

### Message Send 会持久化 Human Sender

前提：已登录用户发送 channel message，
当：message 被持久化，
结果：`senderKind` 是 `human`，
并且 `senderId` 是已认证 user ID，
而不是 client 提供的值。

### Mention 会路由到 Target Agent

前提：channel 中有 online agents，
当：用户发送以 `@AgentName` 开头的 message，
结果：server 只 dispatch 给匹配的 online agent。

### Unknown Mention 不会 Fallback

前提：channel 中有 online agents，
当：用户发送以未知 `@Name` 开头的 message，
结果：server 不会 dispatch 给 fallback agent。

### Human Mention 不会 Dispatch 给 Agent

前提：channel 中有人类 members 和 agents，
当：用户按姓名 mention human member，
结果：server 持久化该 message，
并且不会 dispatch 给 agent。

### Fallback Dispatch 使用第一个 Online Agent

前提：channel 中有 online agents，
当：message 没有 mention，
结果：server dispatch 给第一个符合条件的 online agent。

### Agent DM 会建立或恢复 Direct Channel

前提：team member 选择某个对该 team 可见的 agent，
当：用户调用 `dm:start`，
结果：server 创建或复用一个 private `direct` channel，
该 channel 只包含该 human user 与目标 agent，
并且 `dm:list` / `dm:snapshot` 可以恢复该 DM 与历史消息。

### DM Message 会路由到目标 Agent

前提：用户已经与某 agent 建立 DM，
当：用户在该 DM 中发送不带 mention 的 message，
结果：server 持久化 human message，
并 dispatch 给该 DM target agent；
当：非 DM human member 尝试 snapshot 该 DM，
结果：server 拒绝访问。

### No Online Agent 是非致命状态

前提：channel 中没有 online agents，
当：用户发送 message，
结果：human message 仍会持久化，
并且 server 返回 no-online dispatch result，而不是让 send 失败。

### Thread Dispatch 不会重复 Current Prompt

前提：用户在 thread 内回复，
当：server 构造 dispatch history，
结果：previous messages 会作为 history 包含，
并且当前 user input 只作为 dispatch prompt 出现一次。

## Dispatch 与 Replies

### Dispatch Timeout 对用户可见

前提：server dispatch 到 agent，
当：daemon 在 timeout 前没有返回，
结果：dispatch 被标记为 `timed_out`，并带有 `DISPATCH_TIMEOUT`，
且原始 human message 保持持久化。

### Agent Reply 会携带 Artifacts 持久化

前提：agent 返回 text 与 artifact IDs，
当：server 收到 dispatch result，
结果：它持久化一条 agent message，
把 artifacts 绑定到该 message，
并向 web clients 广播该 message。

### Agent Error 会更新 Status

前提：daemon 上报 execution failure，
当：server 收到 error，
结果：它记录 dispatch failure，
更新 agent last error，
并通知 web clients。

## Artifacts 与 Workspace

### Artifact Upload 必须认证

前提：artifact upload request，
当：token 缺失或无效，
结果：server 拒绝 upload。

### Artifact Metadata 带有 Team Scope

前提：为 channel message 上传了一个 file，
当：另一个 team 尝试 fetch 它，
结果：access 被拒绝。

### 执行详情可回链到 Agent

前提：daemon 在 agent run 期间创建 files，
当：它上传 artifacts，
结果：server 可以从 agent workspace view 列出这些 artifacts。

## Tasks

### Task Create 会持久化 Team Scope

前提：用户在某 team 中创建 task，
当：列出 tasks，
结果：它只出现在该 team 中。

### Task 可以关联 Channel

前提：从 channel context 创建 task，
当：加载 channel task list，
结果：该 task 出现在该 channel 中。

### Task Status Update 会广播

前提：task 已存在，
当：用户把它移动到另一个 status，
结果：server 持久化 new status，并广播 `task:updated`。

## Web 冒烟测试

### 第一条端到端切片

前提：server-next、daemon-next 与 web-next 正在运行，
当：用户登录、选择 team、连接 daemon、打开 channel 并发送 message，
结果：用户能看到：

- 已连接 device
- 已发现 agent
- 已发送 human message
- 已持久化 agent reply

### Reconnect 保持 UI 一致

前提：web client 失去并恢复 socket connection，
当：它重新订阅 current team，
结果：agents、devices、channels、DMs、tasks 与 messages 都从 server snapshots 重新加载。

## 来自当前测试的回归种子

现有测试应被审查并迁移，其中描述产品行为的测试尤其重要：

- `apps/server/tests/routing.test.ts`
- `apps/server/tests/channels.test.ts`
- `apps/server/tests/agent-namespace.test.ts`
- `apps/server/tests/web-namespace.test.ts`
- `apps/server/tests/artifact-routes.test.ts`
- `apps/server/tests/db.test.ts`
- `apps/daemon/tests/scanner.test.ts`
- `apps/daemon/tests/device-daemon.test.ts`
- `apps/daemon/tests/workspace-manager.test.ts`
- `apps/web/tests/socket.test.ts`
- `apps/web/tests/store-agent-dedupe.test.ts`
- `apps/web/tests/task-status.test.ts`
- `apps/web/tests/chat-scope.test.ts`
