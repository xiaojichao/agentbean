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
- `docs/first-slice-schema-repositories.md` 定义第一切片的新 SQLite schema 与 repository 接口。
- `docs/migration-plan.md` 给出分阶段实现计划。
- `docs/verification-matrix.md` 将必需测试映射到阶段和来源文档。
- `docs/acceptance-tests.md` 列出应保护本次重建的行为检查。

## 非目标

- 这个目录目前还不包含可运行的应用代码。
- 它还不会替代当前的 `apps/web`、`apps/server` 或 `apps/daemon`。
- 不应因为当前文件形状已经存在，就原样带入重写版。现有代码是参考来源，不是目标架构。

## 第一实现切片

第一个可运行切片应包含：

1. 用户登录或注册。
2. 网络选择与 snapshot。
3. Daemon 注册。
4. Runtime 扫描 snapshot。
5. 频道创建与消息发送。
6. Agent dispatch 与回复持久化。

只有在这个切片稳定之后，才迁移其余功能。
