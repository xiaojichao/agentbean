# AgentBean 业务上下文地图

本地图用于在修改代码、编写 Issue、设计协议或命名测试前，定位需要读取的领域术语。当前业务 glossary 仍集中在根 [`CONTEXT.md`](./CONTEXT.md)；只读取与任务相关的章节，不要把整个文件默认注入每个任务。

## 上下文路由

| 业务上下文 | 先读入口 | 典型代码范围 |
| --- | --- | --- |
| Device 与本地执行 | [`Device Service`](./CONTEXT.md#device-service)、[`Supported user device platform`](./CONTEXT.md#supported-user-device-platform)、[`Device-local Agent Memory`](./CONTEXT.md#device-local-agent-memory) | `apps/daemon-next`、设备安装/升级、Workspace 与本地执行 |
| Message、Inbox 与 Attention | [`Message delivery`](./CONTEXT.md#message-delivery)、[`Inbox item`](./CONTEXT.md#inbox-item)、[`System attention item`](./CONTEXT.md#system-attention-item) | Server message/inbox、socket 投影、Web 消息与未读体验 |
| Command、Authority 与外部副作用 | [`Command registry`](./CONTEXT.md#command-registry)、[`Command outcome`](./CONTEXT.md#command-outcome)、[`Invocation authorization`](./CONTEXT.md#invocation-authorization)、[`Action approval`](./CONTEXT.md#action-approval) | `packages/contracts`、`packages/domain`、Server command handlers 与审计 |
| PI promotion 与根任务编排 | [`PI Manager`](./CONTEXT.md#pi-manager)、[`Server Manager runtime`](./CONTEXT.md#server-manager-runtime)、[`Promotion gate`](./CONTEXT.md#promotion-gate)、[`PI orchestration run`](./CONTEXT.md#pi-orchestration-run)、[`Root Task lifecycle`](./CONTEXT.md#root-task-lifecycle) | PI 管理运行时、根 Task、DAG、调度、恢复与系统活动投影 |
| 子任务分配与执行 | [`Task allocation`](./CONTEXT.md#task-allocation)、[`Agent execution claim`](./CONTEXT.md#agent-execution-claim)、[`Executable subtask contract`](./CONTEXT.md#executable-subtask-contract)、[`Task acceptance contract`](./CONTEXT.md#task-acceptance-contract) | Offer/accept/claim、attempt、SLA、retry、delivery 与验收 |
| Memory 与经验复用 | [`Team-scoped Agent Memory`](./CONTEXT.md#team-scoped-agent-memory)、[`Active Memory Context`](./CONTEXT.md#active-memory-context)、[`Formal Memory`](./CONTEXT.md#formal-memory)、[`Memory governance access`](./CONTEXT.md#memory-governance-access) | Memory contracts、Server persistence、PI context、治理界面 |
| Agent 能力、Skill 与候选匹配 | [`Agent Capability`](./CONTEXT.md#agent-capability)、[`Agent Skill`](./CONTEXT.md#agent-skill)、[`Agent Exposure Manifest`](./CONTEXT.md#agent-exposure-manifest)、[`Agent eligibility`](./CONTEXT.md#agent-eligibility) | Agent exposure、候选过滤/排序、Team/Channel eligibility |
| 文件、Artifact 与交付审核 | [`Artifact source root`](./CONTEXT.md#artifact-source-root)、[`Channel file index`](./CONTEXT.md#channel-file-index)、[`Output package`](./CONTEXT.md#output-package)、[`Task delivery acceptance`](./CONTEXT.md#task-delivery-acceptance) | Channel Files、artifact/version、OutputPackage、review/final/acceptance |
| PI Provider 与系统管理 | [`Active PI Model`](./CONTEXT.md#active-pi-model)、[`PI Provider Card`](./CONTEXT.md#pi-provider-card)、[`System Admin Console`](./CONTEXT.md#system-admin-console)、[`PI Management`](./CONTEXT.md#pi-management) | System Admin、provider/card/model、rollout、health 与治理 |
| 迁移与 legacy coordination | [`PI authority epoch`](./CONTEXT.md#pi-authority-epoch)、[`PI authority cutover`](./CONTEXT.md#pi-authority-cutover)、[`Legacy coordination fact`](./CONTEXT.md#legacy-coordination-fact) | legacy coordination 只读兼容、cutover、drain 与 recovery |

## 使用规则

1. 先按任务语义选择一至两个上下文，再读取对应章节及附近 `_Avoid_` 约束。
2. 跨上下文改动同时检查 `docs/adr/` 中的系统级 ADR；局部 ADR 只约束其所属 context。
3. 一个术语若无法归入上表，先判断是新领域概念还是已有术语的别名；确属缺口时使用 `domain-modeling` 更新 glossary 和本地图。
4. 从根 `CONTEXT.md` 拆出局部 `CONTEXT.md` 时，先更新本地图，再迁移内容，并保留必要的兼容链接，避免旧 Issue、ADR 和任务材料失去入口。
