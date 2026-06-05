# AgentBean Next

这个目录是 AgentBean 的重写工作区。

这里的目标不是继续在当前实现上打补丁，而是先抽取现有项目中值得保留的部分，再定义一个更干净的目标设计，用更小、可测试的核心来实现。

## 决策

采用 spec-first 的半重建方案：

- 保留产品模型、工作流知识、协议经验、daemon 执行经验，以及那些描述真实行为的现有测试。
- 围绕清晰的领域、用例、仓储和传输适配器，重新构建核心 server 与 client 边界。
- 按垂直功能切片迁移；每个切片先用行为测试证明成立，再替换旧代码。

## 文档

- `docs/current-behavior.md` 总结重写后应保留的当前产品行为。
- `docs/current-protocol-inventory.md` 盘点当前 Socket.IO 与 HTTP 协议表面。
- `docs/current-data-model-inventory.md` 盘点当前 SQLite 数据模型与持久化概念。
- `docs/feature-disposition.md` 将现有功能/事件表面映射到保留、延后、合并或删除决策。
- `docs/agent-identity-rules.md` 定义 Agent 身份、去重、冲突与优先级的规范规则。
- `docs/contracts-dto.md` 定义第一切片的共享 DTO、`Ack` 和 `ErrorCode`。
- `docs/known-gaps.md` 记录产品、协议、数据模型、web、daemon 与测试中的待解决缺口。
- `docs/asset-inventory.md` 列出应保留什么、重写什么，以及原因。
- `docs/target-architecture.md` 描述目标模块边界。
- `docs/socket-protocol.md` 定义重写版初始 `/web` 与 `/agent` 协议表面。
- `docs/implementation-runbook.md` 给出第一切片的逐步开发检查清单。
- `docs/first-slice-status.md` 记录第一切片当前实现、验证证据与剩余边界。
- `docs/second-slice-status.md` 记录第二切片 channel controls 的实现、验证证据与剩余边界。
- `docs/third-slice-status.md` 记录第三切片 channel membership 的实现、验证证据与剩余边界。
- `docs/fourth-slice-status.md` 记录第四切片 daemon protocol hardening 的实现、验证证据与剩余边界。
- `docs/fifth-slice-status.md` 记录第五切片 web realtime boundary 的实现、验证证据与剩余边界。
- `docs/sixth-slice-status.md` 记录第六切片 web reconnect resubscription 的实现、验证证据与剩余边界。
- `docs/seventh-slice-status.md` 记录第七切片 channel member details DTO 的实现、验证证据与剩余边界。
- `docs/eighth-slice-status.md` 记录第八切片 channel snapshot subscription broadcast 的实现、验证证据与剩余边界。
- `docs/ninth-slice-status.md` 记录第九切片 agent snapshot subscription broadcast 的实现、验证证据与剩余边界。
- `docs/tenth-slice-status.md` 记录第十切片 device snapshot 与 runtimes broadcast 的实现、验证证据与剩余边界。
- `docs/eleventh-slice-status.md` 记录第十一切片 device detail shell 的实现、验证证据与剩余边界。
- `docs/first-slice-schema-repositories.md` 定义第一切片的新 SQLite schema 与 repository 接口。
- `docs/migration-plan.md` 给出分阶段实现计划。
- `docs/verification-matrix.md` 将必需测试映射到阶段和来源文档。
- `docs/acceptance-tests.md` 列出应保护本次重建的行为检查。

## 非目标

- 第一切片代码已放在仓库根目录的 `packages/contracts`、`packages/domain`、`apps/server-next`、`apps/daemon-next` 与 `apps/web-next`。
- 第一切片仍不会替代当前生产中的 `apps/web`、`apps/server` 或 `apps/daemon`。
- 不应因为当前文件形状已经存在，就原样带入重写版。现有代码是参考来源，不是目标架构。

## 第一实现切片

第一个可运行切片应包含：

1. 用户登录或注册。
2. Team 选择与 snapshot。
3. Daemon 注册。
4. Runtime 扫描 snapshot。
5. 频道创建与消息发送。
6. Agent dispatch 与回复持久化。

只有在这个切片稳定之后，才迁移其余功能。

## 当前实现状态

第一切片已经具备可运行的最小协议链路，第二切片已经补上 channel controls 的最小行为，第三切片已经补上 channel membership 的最小命令面，第四切片已经补上 daemon protocol hardening 的最小边界，第五切片已经补上 web realtime boundary 的最小客户端边界，第六切片已经补上 web reconnect resubscription 的最小恢复边界，第七切片已经补上 channel member details DTO 的最小数据边界，第八切片已经补上 channel snapshot subscription broadcast 的最小实时边界，第九切片已经补上 agent snapshot subscription broadcast 的最小实时边界，第十切片已经补上 device snapshot 与 runtimes broadcast 的最小实时边界，第十一切片已经补上 device detail shell 的最小数据边界：

- `packages/contracts`：共享 DTO、`Ack<T>`、error codes 与 socket event constants。
- `packages/domain`：message routing、agent identity、status merge、channel visibility 与 creator controls 纯函数。
- `apps/server-next`：SQLite schema/repositories、use cases、Socket.IO namespace adapters、channel controls、channel membership、member detail projections、device detail、channel/agent/device snapshot subscriptions 与 E2E smoke。
- `apps/daemon-next`：daemon protocol client、stub executor、reconnect re-announcement、device/runtimes reports 与 dispatch error/env 边界。
- `apps/web-next`：web socket client、channel create/update/member commands、agent/channel/device subscriptions、message/dispatch/device realtime events、reconnect resubscription 与最小 session/state 边界。

当前本地验证命令：

```bash
npm run test:phase1
npm run build:packages
```

本机如果尚未安装根 workspace 依赖，可临时使用已安装的 `apps/server/node_modules` 运行同等测试；SQLite native module 当前与 Node v24.15.0 ABI 匹配。
