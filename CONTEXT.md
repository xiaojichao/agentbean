# AgentBean 协作执行上下文

本上下文描述 AgentBean 中 PI Manager 与外部 Agent 协作执行的核心语言，避免 Phase 4 设计混用 Device、Server 与用户可见执行概念。

## Manager Worker

负责驱动一次 ManagementRun 的 PI Manager 执行单元，可以运行在用户授权的 Device 上，也可以运行在 AgentBean Server 的受控环境中。
_Avoid_: Agent、普通执行 Agent、Daemon。

## Device Worker

运行在用户授权 Device Service 中的 Manager Worker，能够使用 Device-local credentials 和 local-only context。
_Avoid_: local Agent、Daemon Worker。

## Server-hosted Worker

运行在 AgentBean Server 受控环境中的 Manager Worker，只能使用明确允许进入 Server 的上下文与凭据引用。
_Avoid_: cloud Agent、remote Device。

## Placement

一次 ManagementRun 对 Manager Worker 执行位置的明确选择；Phase 4 第一阶段只开放受控 `managed` placement，`auto` 仍不进入生产默认路径。
_Avoid_: routing、failover（除非明确指 lease 接管）。

## Server-authorized context

允许 Server-hosted Worker 使用的、严格继承发起用户当前 Team/Task/Channel 权限后的上下文；私聊和私有频道可以进入，但不得向原 scope 外扩散。它不包含 Device-local Memory、cwd、local files、Device token 或本地模型凭据。
_Avoid_: full Team context、Device context、shared secret。

## Server credential reference

由 Server 管理、可撤销且不把 secret material 写入 ManagementRun、Event 或 checkpoint 的 provider 凭据引用。
_Avoid_: API key、Device credential、auth token（除非讨论 secret material 本身）。

## Lease takeover

原 Manager Worker 的租约过期后，由另一合法 Worker 以更高 fencing token 接手未完成的 ManagementRun；已完成的事实不重做，未完成部分从 Server checkpoint 继续。
_Avoid_: forced takeover、duplicate retry。

## Managed opt-in

Team owner/admin 显式开启后，Team 才允许使用 Server-hosted Worker；默认不启用，普通成员不能通过单次请求绕过 Team 设置。
_Avoid_: implicit managed、member-level placement override。

## Deployment-managed provider credential

第一阶段由部署方预先配置、Server 统一管理的一套 provider credential；Team 只能使用其引用，不能上传、读取或替换 secret material。
_Avoid_: Team API key、raw credential、Device credential。

## Managed task

需要 PI Manager 协调多个 Agent、具有明确根 Task 的复杂请求；普通聊天和直接点名 Agent 的请求不属于 Managed task。
_Avoid_: every chat、direct dispatch、background retry。

## User-delegated Server Worker

Server-hosted Worker 不拥有独立 Team 成员身份，而是作为发起用户在单个 ManagementRun 内的受限代理；每次读取都绑定并复验 `userId + managementRunId` 的当前权限。
_Avoid_: global Server member、permanent worker identity、ambient authority。

## Managed content consent

用户开启 `managed` 即同意本次 ManagementRun 将完成任务所需的、其当前有权限看到的最小内容发送给 Server provider；该内容不因此成为长期 Memory，也不得扩散给无关 Agent。
_Avoid_: blanket consent、long-term retention、cross-scope broadcast。

## Managed unavailable

`managed` 请求在 Server provider/Worker 不可用时等待或失败，不自动切回 Device；placement 一旦确定，不能因故障改变隐私边界。
_Avoid_: silent fallback、cross-placement retry。

## Managed capacity

Server Worker 使用固定并发上限；容量满时 ManagementRun 排队，超过等待上限后失败，不进行动态成本或价格调度。
_Avoid_: unbounded queue、implicit cost optimization。

## Server Manager runtime

Server Worker 复用现有 PI management runtime，只提供模型协调与受控工具协议，不具备 shell、cwd、文件读写、浏览器或 Device 能力。
_Avoid_: second runtime、server shell、remote Device。

## Managed queue timeout

Server Worker 满载时，ManagedRun 最多等待 5 分钟；期间无可用 Worker 则失败并明确告知用户，不无限排队。
_Avoid_: infinite queue、silent drop。
