# AgentBean 多智能体协作与交接架构设计

- 日期：2026-07-13
- 状态：设计草案，待评审
- 范围：`packages/contracts`、`packages/domain`、`apps/server-next`、`apps/daemon-next`、`packages/pi-management-runtime`、`apps/web-next`
- 相关文档：
  - `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`
  - `docs/superpowers/specs/2026-07-08-agent-task-thread-claim-prd.md`
  - `docs/superpowers/specs/2026-07-06-agentbean-memory-design.md`

---

## 1. 背景

用户希望在一个频道里放多个智能体。下文统一使用 `Agent A` 和 `Agent B` 描述，不绑定任何具体 Agent 品牌或运行时。人类可以在频道中 `@Agent A` 发起任务：

> 我今天主要完成小红书剪藏效果优化。你根据今天的工作内容，问问 @Agent B 日报格式是什么，根据日报格式梳理今天的日报。

理想行为不是简单让两个 Agent 在频道里互相刷消息，而是：

1. 用户点名 `Agent A`，系统确认这是一个需要外部 Agent 处理的任务。
2. `Agent A` 基于自己在频道和任务中的上下文，可以直接总结并输出结果。
3. 如果 `Agent A` 需要 `Agent B` 的信息、格式、审核或后续执行，它可以在自己的执行结果里返回结构化协作建议，由 Manager / Server 校验后把任务的一部分或后续接管权交给 `Agent B`。
4. `Agent B` 在权限允许的频道上下文内执行，并把结果、证据和产物回传。
5. `Agent A` 可以基于 `Agent B` 的结果继续完成最终输出；如果交接类型是接管，`Agent B` 可以成为后续任务 owner。
6. 最终交付进入同一个任务线程，贡献 Agent、交接原因、证据和状态都可追溯。

当前感觉“有卡点”的原因，是 AgentBean 已经有点名路由和 Phase 1 managed 单 Agent 链路，但还没有把“一个 Agent 需要另一个 Agent 继续干活”建模为可持久化、可恢复、可审计的协作事实。

本文档不是替代既有 PI 管理 Agent 设计，而是补齐它之后的下一层：从“可靠调用一个外部 Agent”推进到“在同一个 `ManagementRun` 内可靠调用多个 Agent，并保存结构化交接”。

用户也可以显式拆开这件事：先 `@Agent B` 让它给出日报格式，再 `@Agent A` 说“你看一下这个格式，出一下今天的日报”。这属于人类手动编排，不要求系统自动推断跨消息 handoff。本文档要解决的是更强的能力：任一 Agent 在执行过程中，可以提出让另一个 Agent 接管或继续处理的结构化建议，Server / Manager 能把该建议转成可恢复、可授权、可追踪的交接事实。

## 2. 当前实现事实

### 2.1 已有点名路由，但它是单次 dispatch 路由

`packages/domain/src/routing.ts` 的 `routeMessage()` 解析消息开头的 `@name`，在在线、团队可见、频道成员等条件满足时返回单个 `{ kind: 'dispatch', agentId, reason: 'mention' }`。无 `@` 时选择第一个 eligible online Agent 作为 fallback。

这解决了“用户点名哪个 Agent 起手”问题，但没有表达：

- 当前任务是否需要多个 Agent。
- 第一位 Agent 是否可以把工作交给另一位 Agent。
- 交接内容、依赖结果、验收标准和证据是什么。
- 后续消息应该进入哪个运行、哪个任务节点、哪个当前 owner。

### 2.2 Phase 1 已有 managed 单 Agent 垂直链路

`apps/server-next/src/application/usecases.ts` 的 `sendMessage()` 已经在创建 direct dispatch 前调用 `managementRouter.route()`。当 Team policy 进入 managed 模式时，消息会进入 `ManagementRun`，而不是直接创建普通 dispatch。

`packages/contracts/src/management.ts` 已定义 `ManagementRunDto`、`ManagementRunStatus`、`ManagerPlacementPolicyDto` 和 `ManagementBudgetDto`。`packages/contracts/src/invocation.ts` 已定义 `AgentInvocationIntentV1`、`DependencyResultRefDto`、`AgentInvocationViewDto` 和 `AgentInvocationResultDto`。

`apps/server-next/src/application/management/management-tool-executor.ts` 已提供 Phase 1 管理工具：

- `context.get_root_message`
- `context.get_root_task`
- `context.get_visible_thread`
- `context.get_management_state`
- `agents.list_capabilities`
- `agents.get_status`
- `agents.invoke`
- `agents.cancel_invocation`
- `channel.post_management_status`
- `user.request_input`
- `review.submit_root_delivery`

其中 `agents.invoke` 当前只允许调用 `run.frozenTarget`，并传入 `allowedTargetAgentIds: [target.agentId]`。因此 Phase 1 的真实能力是“内置管理 Agent 围绕用户点名的单个外部 Agent 做可靠调用、等待和交付”，不是频道多 Agent 协作。

### 2.3 现有管理事件已经覆盖协作骨架，但缺少 handoff 语义

`packages/contracts/src/management-event.ts` 已有：

- `task-created`
- `task-claimed`
- `subtask-delivered`
- `task-acceptance-decided`
- `invocation-created`
- `dispatch-attempt-started`
- `dispatch-attempt-completed`
- `root-delivery-submitted`

这些事件足以支撑任务图、调用和交付，但还没有一个事件能明确表达：

- “Agent A 请求把一部分工作交给 Agent B”。
- “交接是咨询、子任务委派，还是任务接管”。
- “Agent B 拿到的是完整线程、裁剪后的上下文、上游产物引用，还是临时 context capsule”。
- “Agent B 的结果应该回到 Agent A、管理 Agent、频道，还是直接交给用户”。

### 2.4 当前卡点

系统现在同时存在两条模型：

1. **聊天路由模型**：频道消息通过 `@` 找到一个 Agent，然后创建 direct dispatch。
2. **管理运行模型**：`ManagementRun` 由 PI 管理 Agent 用工具调用外部 Agent。

多 Agent 交接不能只在聊天路由模型上叠加自然语言，因为那会导致：

- Server 不知道任务当前 owner。
- 重试、取消、超时和恢复无法归因到具体交接。
- 下游 Agent 看不到结构化输入，只能读一段人类风格上下文。
- 上游 Agent 的“给下一个 Agent 的信息”无法被权限过滤、摘要、裁剪和审计。
- 最终交付无法证明哪些结果来自哪个 Agent。

所以卡点不是 `@Agent B` 无法被识别，而是缺少“外部 Agent 结构化提出协作建议，Manager / Server 再授权执行”的交接协议。

## 3. 外部架构参考

外部多 Agent 系统大致分为四类：

| 模式 | 代表 | 特点 | 对 AgentBean 的启发 |
|---|---|---|---|
| Manager / agents-as-tools | OpenAI Agents SDK、LangGraph supervisor | 中央管理者调用专家 Agent，管理者保留最终控制权 | 适合 AgentBean 当前 `ManagementRun`，因为 Server 要保留权限、审计、恢复和最终交付控制 |
| Handoff | OpenAI Agents SDK、LangChain handoffs | 一个 Agent 把控制权交给另一个 Agent，后者接管对话 | 适合“当前 owner”明确变化的交互，但必须把 active owner 持久化 |
| Swarm | AutoGen Swarm、LangGraph Swarm | Agent 通过 handoff message/tool 动态决定下一个 Agent，共享上下文 | 适合探索性协作，但容易循环和难审计，不能作为 AgentBean 第一版默认 |
| Group chat / selector | AutoGen、Semantic Kernel | 多 Agent 共享会话，由 selector 或 group manager 控制发言 | 适合头脑风暴，不适合当前以任务、证据、Artifact 为核心的产品主线 |

OpenAI Agents SDK 把多 Agent 设计归为两个常见模式：manager 把 Agent 当工具调用并保留会话控制权，或 handoff 让专家 Agent 接管会话。OpenAI 的 handoff 文档还强调 handoff 本质是 Agent 把任务委托给另一个 Agent。LangChain / LangGraph 的 handoffs 文档把 handoff 解释为工具更新持久状态变量，例如 `active_agent`，之后系统根据该状态改变行为。AutoGen Swarm 则通过 `HandoffMessage` 选择下一位 speaker，并让接收 Agent 在相同消息上下文中接管任务。Semantic Kernel 的 Agent Orchestration 文档把顺序、并发、handoff、group chat 等模式都作为不同协作模式处理。

参考链接：

- [OpenAI Agents SDK：Handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Agents SDK：Agents 与多 Agent 模式](https://openai.github.io/openai-agents-python/agents/)
- [LangChain：Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)
- [LangGraph Swarm](https://reference.langchain.com/python/langgraph-swarm)
- [AutoGen Swarm](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/swarm.html)
- [AutoGen Core：Handoffs](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/design-patterns/handoffs.html)
- [Semantic Kernel：Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)

结论：AgentBean 不应第一版采用完全去中心化 swarm。AgentBean 的产品事实源在 Server，已有 `ManagementRun`、Task、Dispatch、Artifact、Memory、Lease 和 Event，因此推荐采用“Server 事实源 + PI Manager 编排 + 结构化 handoff”的混合架构：Agent 可以提出交接，但交接由 Server 记录、校验、调度和恢复。

这里的“结构化 handoff”不是要求所有 Agent 都暴露相同内部协议，也不是要求下游 Agent 理解上游 Agent 的完整会话。它只是 AgentBean 协作层的一条事实记录：谁把哪部分工作、以什么上下文、交给谁、期待什么结果。

## 4. 第一性原理

### 4.1 用户购买的是完成结果，不是 Agent 互聊

用户在频道里邀请多个智能体，是为了让不同能力协作完成任务。频道 UI 可以显示必要协作过程，但系统目标是可靠交付，而不是生成一段看似热闹的多 Agent 对话。

因此，Agent 间通信必须服务于任务完成：

- 每次交接都有目标。
- 每个下游 Agent 有明确输入和输出。
- 每个结果能被上游或管理 Agent 判断是否满足要求。
- 最终交付能追溯贡献来源。

### 4.2 交接是状态转移，不是普通消息

普通频道消息的事实是“某人说了什么”。交接的事实是“当前工作的一部分从一个执行者转移给另一个执行者，携带指定上下文和验收要求”。它必须有独立结构：

- `fromAgentId`
- `toAgentId`
- `handoffKind`
- `objective`
- `contextRefs`
- `dependencyResults`
- `acceptanceCriteria`
- `returnMode`
- `idempotencyKey`

没有这些字段，系统就无法在重试、恢复、取消、权限检查和 UI 展示时做正确决策。

### 4.3 Server 是协作事实源，Agent 只提出意图

外部 Agent 可以建议“我需要让 Agent B 给出日报格式”或“把后续任务交给 Agent B 接管”，但它不能绕过 Server 直接创建不可见的 Agent 私聊。原因：

- Server 才知道 Team / Channel / DM 权限。
- Server 才知道 Agent 是否在线、是否在频道内、是否允许被调用。
- Server 才能分配 invocation、dispatch attempt、timeout 和 cancel。
- Server 才能在 Worker 崩溃后恢复。

因此外部 Agent 不调用内部 Management Tool，也不持有 `handoffs.request` 的写权限。它只能在自己的 invocation result 中返回结构化 `collaborationProposal`，由 Server 绑定 `sourceInvocationId`、当前 Task revision 和 claim lease 后持久化；PI Manager 恢复或继续运行时读取该 proposal，再用自己的 management lease 调用 `handoffs.request`。Server 对 `handoffs.request` 重新校验 proposal 来源、Team / Channel 权限、目标 Agent 可见性、预算、循环限制、Task revision 和 claim fencing。proposal 不是系统事实写入权限，只是待校验输入。

### 4.4 上下文要裁剪，不能默认全量透传

Agent B 只需要日报格式时，不应该拿到 Agent A 的完整执行日志、用户所有附件或本地 workspace 内容。上下文传递应按引用和 capsule 进行：

- 消息引用：可见线程中的必要片段。
- 产物引用：允许读取的 artifact id。
- 上游结果引用：`DependencyResultRefDto`。
- 临时协作上下文：权限过滤后的 context capsule。
- 本地项目上下文：默认不跨设备、不上传，除非用户明确共享摘要。

### 4.5 接管是核心能力，Manager 保留事实控制权

“Agent A 先做了很多工作，随后交给 Agent B 接管”是核心产品能力。可靠系统里，接管不是 Agent 私下说一句话，而是 `ManagementRun` 里的状态转移：

- `Agent A` 可以是用户点名的起手 Agent，也可以是已经积累了大量上下文的当前 owner。
- `Agent B` 可以作为被咨询的专家，也可以成为新的 active owner，继续处理后续任务。
- PI Manager 或 Server-side Collaboration Kernel 负责记录 handoff、创建 invocation、在接收方确认后更新 active owner、等待结果和恢复。
- 最终交付可以由 `Agent A`、`Agent B` 或 Manager 汇总后进入 root task review，但交付必须引用贡献来源。

## 5. 推荐架构

### 5.1 总体形态

```mermaid
flowchart TB
    Human["用户"] --> Channel["频道消息 @Agent A"]
    Channel --> Server["AgentBean Server"]
    Server --> Run["ManagementRun\nroot task / event log"]
    Run --> Manager["PI Manager Worker\n协作编排"]
    Manager --> InvokeAgentA["AgentInvocation\nAgent A"]
    InvokeAgentA --> Proposal["collaborationProposal\nsourceInvocationId + task fence"]
    Proposal --> Server
    Manager --> ToolHandoff["handoffs.request\n结构化交接工具"]
    ToolHandoff --> Kernel["Collaboration Kernel\n权限/预算/循环/上下文裁剪"]
    Kernel --> InvokeAgentB["AgentInvocation\nAgent B"]
    InvokeAgentB --> DispatchAgentB["Dispatch / Device or AgentOS"]
    DispatchAgentB --> ResultAgentB["InvocationResult\n格式/交付/证据/Artifact"]
    ResultAgentB --> Manager
    Manager --> InvokeAgentAFinal["AgentInvocation\nAgent A 可继续汇总"]
    InvokeAgentAFinal --> Delivery["management-delivery\nroot task in_review"]
    Delivery --> Human
```

### 5.2 职责划分

| 组件 | 职责 |
|---|---|
| `routeMessage()` | 只负责起手路由：识别用户显式点名和 fallback，不负责多 Agent 协作 |
| `ManagementRouter` | 判断是否进入 managed；把用户点名 Agent 冻结为 root target 或 main agent |
| `ManagementRun` | 一次用户请求的协作事实源，保存状态、预算、根消息、根任务、事件和 checkpoint |
| `PI Manager Worker` | 理解任务、选择协作策略、调用管理工具，不直接越权调用 Agent |
| `AgentCollaborationProposal` | 外部 Agent 在 invocation result 中返回的协作建议，不能直接写 handoff 或改变 owner |
| `Collaboration Kernel` | 管理 handoff、Task DAG、Invocation、依赖、权限、预算、循环检测和恢复 |
| `AgentInvocationGateway` | 创建逻辑调用与 Dispatch attempt；继续作为外部 Agent 执行桥 |
| `Context Capsule` | 为每个下游调用提供裁剪后的临时上下文，不默认透传完整线程和本地内容，也不写长期 Memory |
| `Web` | 展示主线程、任务状态、贡献 Agent、handoff 轨迹和最终交付 |

## 6. 核心数据模型增量

### 6.1 `AgentCollaborationProposalV1`

外部 Agent 不能直接调用 `handoffs.request`。当 `Agent A` 判断需要咨询或接管时，它在自己的 `AgentInvocationResultDto` 中返回协作建议：

```ts
export interface AgentInvocationResultDto {
  readonly schemaVersion: 1;
  readonly invocationId: ID;
  readonly taskId?: ID;
  readonly agentId: ID;
  readonly status: Extract<AgentInvocationStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
  readonly body?: string;
  readonly artifactIds: readonly ID[];
  readonly workspaceRunId?: ID;
  readonly memoryCandidateIds: readonly ID[];
  readonly collaborationProposals?: readonly AgentCollaborationProposalV1[];
  readonly startedAt: UnixMs;
  readonly completedAt: UnixMs;
  readonly error?: string;
}
```

proposal 必须绑定来源 invocation 和当前 Task fence：

```ts
export interface AgentCollaborationProposalV1 {
  readonly schemaVersion: 1;
  readonly sourceInvocationId: ID;
  readonly sourceAgentId: ID;
  readonly sourceTaskContext?: {
    readonly taskId: ID;
    readonly rootTaskId?: ID;
    readonly taskRevision: number;
    readonly taskAttempt: number;
    readonly claimLeaseId: ID;
  };
  readonly toAgentId: ID;
  readonly kind: Extract<AgentHandoffKind, 'consult' | 'template_request' | 'continuation'>;
  readonly objective: string;
  readonly reason: string;
  readonly contextRefs: readonly EvidenceRefDto[];
  readonly dependencyResults: readonly DependencyResultRefDto[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly attachmentIds: readonly ID[];
  readonly returnMode: AgentHandoffReturnMode;
  readonly deadlineAt?: UnixMs;
}
```

Server 接收 proposal 时只做事实归档和可恢复索引，不能立即改变 owner 或直接 dispatch：

1. 校验 `sourceInvocationId` 属于当前 `ManagementRun`，`sourceAgentId` 与 invocation target / result agent 一致。
2. 如果存在 `sourceTaskContext`，校验 task revision、attempt、claim lease 与当前 Task coordination 一致，且 lease 未过期、未释放、未 invalidated。
3. 校验 `toAgentId` 在同一 Team + Channel / DM 权限边界内可见。
4. 对 proposal 计算 `proposalHash` 和 idempotency key，重复同 hash 返回已有 proposal，不同 hash 返回 conflict。
5. 追加 `handoff-proposed` ManagementEvent，只保存 hash、source / target id、kind 和 task fence，不复制敏感正文。

PI Manager 从 `context.get_management_state` 或 dedicated read tool 读取 proposal 后，才可以用持 lease 的 `handoffs.request` 将 proposal 转成正式 `AgentHandoffRecord`。这条边界继承 PI 总纲“外部 Agent 不能直接调用内部 Management Tool”的安全规则。

### 6.2 `AgentHandoffIntentV1`

新增 contracts DTO：

```ts
export type AgentHandoffKind =
  | 'delegate'
  | 'consult'
  | 'review'
  | 'template_request'
  | 'continuation';

export type AgentHandoffReturnMode =
  | 'return_to_manager'
  | 'return_to_source_agent'
  | 'deliver_to_root';

export interface AgentHandoffIntentV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly sourceProposalId?: ID;
  readonly sourceInvocationId?: ID;
  readonly fromAgentId?: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly objective: string;
  readonly reason: string;
  readonly contextRefs: readonly EvidenceRefDto[];
  readonly dependencyResults: readonly DependencyResultRefDto[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly attachmentIds: readonly ID[];
  readonly contextCapsuleId?: ID;
  readonly returnMode: AgentHandoffReturnMode;
  readonly deadlineAt?: UnixMs;
}
```

说明：

- `fromAgentId` 可以为空，表示由 Manager 发起。
- `sourceProposalId` / `sourceInvocationId` 记录该 handoff 是否来自外部 Agent 的结构化建议；如果来自 proposal，Server 必须校验 proposal 仍匹配当前 Task revision 和 claim fence。
- `consult` 表示只询问资料或建议，例如“向 Agent B 询问日报格式”。
- `delegate` 表示下游 Agent 负责完成一个独立子任务。
- `continuation` 表示当前 owner 转移，后续用户补充默认进入新 owner，这是“交给另一个 Agent 接管”的主路径。
- `returnMode` 明确结果回到哪里，避免下游 Agent 私自决定是否直接交付用户。

### 6.3 `AgentHandoffRecordDto`

```ts
export type AgentHandoffStatus =
  | 'requested'
  | 'accepted'
  | 'running'
  | 'returned'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface AgentHandoffRecordDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly managementRunId: ID;
  readonly intent: AgentHandoffIntentV1;
  readonly intentHash: string;
  readonly idempotencyKey: string;
  readonly invocationId?: ID;
  readonly status: AgentHandoffStatus;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}
```

`AgentHandoffRecord` 是协作语义层，`AgentInvocation` 是逻辑调用层，`Dispatch` 是传输/执行 attempt 层：

```text
Handoff 1 -> Invocation 1 -> Dispatch attempt 1..N
```

如果只是 Manager 直接调用某个 Agent，不需要先创建 Handoff；只有需要表达“一个 Agent/Manager 将一部分工作交给另一个 Agent”时才创建 Handoff。

### 6.4 ManagementEvent 增量

新增 typed events：

```ts
readonly 'handoff-proposed': {
  readonly proposalId: ID;
  readonly sourceInvocationId: ID;
  readonly sourceAgentId: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly taskId?: ID;
  readonly taskRevision?: number;
  readonly claimLeaseId?: ID;
  readonly proposalHash: string;
};

readonly 'handoff-requested': {
  readonly handoffId: ID;
  readonly sourceProposalId?: ID;
  readonly sourceInvocationId?: ID;
  readonly fromAgentId?: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly objectiveHash: string;
};

readonly 'handoff-dispatched': {
  readonly handoffId: ID;
  readonly invocationId: ID;
};

readonly 'handoff-returned': {
  readonly handoffId: ID;
  readonly invocationId: ID;
  readonly status: AgentInvocationResultDto['status'];
  readonly resultRevision: number;
  readonly artifactIds: readonly ID[];
};

readonly 'active-agent-changed': {
  readonly previousAgentId?: ID;
  readonly nextAgentId?: ID;
  readonly handoffId?: ID;
  readonly reasonCode: string;
};
```

`active-agent-changed` 用于 `continuation` 或后续用户补充默认归属变化。普通 `consult` 不改变 active owner；`delegate` 只改变子任务 owner，不改变根任务 owner。

`active-agent-changed` 不能和 `handoff-requested` / `handoff-dispatched` 在同一事务里提前写入。只有目标 Agent 已经接受执行权后才能切换：

- targeted claim 成功并获得新的 `claimLeaseId`；或
- Dispatch claim / wake 已 accepted，`AgentInvocationView` 已进入 `running`；或
- 对应 runtime 没有显式 accepted 事件时，Server 已得到等价的 durable running 事实。

如果 `continuation` 在 accepted 前被 `rejected`、dispatch emit 失败或超时，`activeAgentId` 保持 `fromAgentId ?? mainAgentId`。如果 accepted 后执行失败或超时，Server 写 handoff 终态，并默认回滚 `activeAgentId` 到 `fromAgentId ?? mainAgentId`；PI Manager 可以随后改派、重新交接或请求用户处理。

### 6.5 `ManagementRun` 增量

`ManagementRunDto` 增加：

```ts
readonly mainAgentId?: ID;
readonly activeAgentId?: ID;
readonly collaborationMode: 'single-agent' | 'manager-orchestrated' | 'handoff';
```

- `mainAgentId`：用户显式点名或系统选定的起手 Agent，例如 `Agent A`。
- `activeAgentId`：当前默认接收补充消息或接管后续任务的 Agent；`continuation` handoff 会更新它。
- `collaborationMode`：帮助 UI 和恢复逻辑判断 run 的协作形态。

Phase 1 兼容：已有 `frozenTarget` 保持不变。多 Agent 进入 Phase 2 后，`frozenTarget` 可解释为 `mainAgentId` 的兼容投影；`agents.invoke` 不再只能调用 frozen target。

## 7. 管理工具增量

### 7.1 `agents.list_available`

替代当前只返回 frozen target 的 `agents.list_capabilities`：

```ts
readonly 'agents.list_available': {
  readonly capabilityQuery?: string;
  readonly includeBusy?: boolean;
};
```

输出：

```ts
{
  agents: Array<{
    agentId: ID;
    name: string;
    kind: AgentInvocationTargetKind;
    status: 'online' | 'busy' | 'offline' | 'unknown';
    capabilities: readonly string[];
    skills: readonly string[];
    channelMember: boolean;
  }>;
}
```

Server 只返回当前 Team / Channel 可见、未删除、权限允许的 Agent。Manager 不直接遍历全局 Agent 表。

### 7.2 `handoffs.request`

```ts
readonly 'handoffs.request': {
  readonly sourceProposalId?: ID;
  readonly sourceInvocationId?: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly objective: string;
  readonly reason: string;
  readonly contextRefIds: readonly ID[];
  readonly dependencyInvocationIds: readonly ID[];
  readonly attachmentIds: readonly ID[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly returnMode: AgentHandoffReturnMode;
  readonly deadlineAt?: UnixMs;
};
```

行为：

1. 校验 Manager lease、fencing token、Team、Channel、Agent 可见性。
2. 如果携带 `sourceProposalId`，校验 proposal 与 `sourceInvocationId`、`sourceAgentId`、Task revision、attempt、claim lease 仍匹配；stale proposal 返回 conflict。
3. 校验预算：`maxSubtasks`、`maxDepth`、`maxExternalInvocations`。
4. 做循环检测：同一 run 中 `fromAgentId -> toAgentId -> fromAgentId` 的连续 `continuation` 默认拒绝；`consult` 可允许但有限次。
5. 创建 `AgentHandoffRecord` 和 `handoff-requested` event。
6. 生成裁剪上下文或 context capsule。
7. 创建 `AgentInvocation`，把 `dependencyResults`、`contextCapsuleId` 和当前 Task fence 写入不可变 intent。
8. 发起 Dispatch / targeted claim，并在 durable accepted / running 事实出现后才允许 `continuation` 写 `active-agent-changed`。
9. 返回 `{ handoffId, invocationId, status }`。

### 7.3 `handoffs.await_result`

Manager 可以显式等待 handoff 结果：

```ts
readonly 'handoffs.await_result': {
  readonly handoffId: ID;
  readonly timeoutAt?: UnixMs;
};
```

返回：

```ts
{
  handoffId: ID;
  invocationId: ID;
  status: AgentHandoffStatus;
  result?: AgentInvocationResultDto;
}
```

这比让 Manager 轮询所有 invocation 更明确，也便于 UI 展示“正在等待 Agent B 提供格式”或“Agent B 已接管”。

### 7.4 `context.create_capsule`

为下游 Agent 创建裁剪上下文：

```ts
readonly 'context.create_capsule': {
  readonly purpose: string;
  readonly messageIds: readonly ID[];
  readonly artifactIds: readonly ID[];
  readonly invocationIds: readonly ID[];
  readonly redactionPolicy: 'minimal' | 'standard' | 'strict';
};
```

Server 生成 `contextCapsuleId`，写入可审计事件。它是 dispatch-time active context，不是长期 Memory，不创建 memory item，也不触发自动记忆沉淀。后续如果要引用已存在的 Memory，也应作为显式 context ref 输入，而不是在 handoff 流程里自动生成新 Memory。

## 8. 运行流程

### 8.1 示例一：Agent A 咨询 Agent B 后继续完成日报

1. 用户在频道发消息：`@Agent A 我今天主要完成小红书剪藏效果优化...问问 @Agent B 日报格式是什么...`
2. `routeMessage()` 识别起手 Agent 是 `Agent A`。
3. `managementRouter.route()` 在 managed mode 下创建 `ManagementRun`：
   - `mainAgentId = Agent A`
   - `activeAgentId = Agent A`
   - `rootMessageId = 用户消息`
   - `rootTaskId = 自动任务或用户显式任务`
4. PI Manager 读取 root message 和 visible thread，判断需要先咨询 `Agent B`。
5. PI Manager 调用 `handoffs.request`：
   - `toAgentId = Agent B`
   - `kind = template_request`
   - `objective = 获取日报格式`
   - `returnMode = return_to_manager`
   - `contextRefs = 用户原始消息引用`
6. Server 创建 handoff、invocation、dispatch，并发送给 `Agent B`。
7. `Agent B` 返回格式，Server 写入 agent message、workspace run / artifact、`handoff-returned` event。
8. PI Manager 把 Agent B 的格式作为 `dependencyResults`，再调用 `Agent A` 完成日报汇总。
9. Agent A 返回日报初稿。
10. PI Manager 调用 `review.submit_root_delivery`，最终交付进入 root thread，任务进入 `in_review`。
11. 用户确认后，任务 `done`，`ManagementRun` `completed`。

### 8.2 示例二：用户手动编排两个 Agent

用户也可以不用自动 handoff：

1. 先在频道里 `@Agent B 你给一下日报结构`。
2. `Agent B` 正常回复结构。
3. 用户再 `@Agent A 你看一下这个结构，出一下今天的日报`。
4. `Agent A` 读取同一频道内对自己可见的上下文，生成日报。

这个流程仍然需要可靠的频道历史、线程上下文和点名路由，但不要求系统创建 `AgentHandoffRecord`。它和自动交接的区别是：交接意图由人类显式分两条消息表达，而不是由 Agent A 在执行过程中发起。

### 8.3 示例三：Agent A 把任务交给 Agent B 接管

当 Agent A 已经做了大量前置工作并积累上下文，但判断后续应由 Agent B 继续时：

1. Agent A 完成当前 invocation 时，在 `AgentInvocationResultDto.collaborationProposals` 返回 `continuation` 建议：
   - `sourceInvocationId = Agent A 当前 invocation`
   - `sourceTaskContext = 当前 taskId / taskRevision / taskAttempt / claimLeaseId`
   - `toAgentId = Agent B`
   - `kind = continuation`
   - `returnMode = deliver_to_root` 或 `return_to_manager`
   - `objective = 继续完成剩余任务`
   - `contextRefs = Agent A 已产出的消息、artifact、workspace run 摘要`
2. Server 归档 proposal，校验来源 invocation、当前 Task revision、claim lease、同频道权限和目标 Agent 可见性；此时不改变 `activeAgentId`。
3. PI Manager 读取 proposal 后，用自己的 management lease 调用 `handoffs.request`。
4. Server 再次校验 proposal 未 stale、预算和循环限制，创建 `handoff-requested`、`handoff-dispatched`、新的 `AgentInvocation` 和 Dispatch / targeted claim。
5. 只有 Agent B accepted / running 后，Server 才写 `active-agent-changed`，`activeAgentId` 从 Agent A 变为 Agent B。
6. 后续用户在线程里的补充默认进入 Agent B，而不是重新回到 Agent A。
7. Agent B 完成后直接交付 root task，或把结果返回 Manager 汇总。
8. 如果 Agent B 在 accepted 前拒绝、dispatch emit 失败或超时，`activeAgentId` 保持 Agent A；如果 accepted 后失败或超时，Server 写失败终态并默认回滚到 Agent A / `mainAgentId`。

这是本文档的核心能力：Agent 之间不仅能互相咨询，还能进行可恢复、可审计的任务接管。

### 8.4 后续用户补充

当用户在同一线程补充“再把昨天的工作也加进去”：

- 如果 run 仍 `running`，补充进入 PI Manager 的 steer/follow-up；但只要补充改变目标、验收标准、依赖、目标 Agent、接管语义或上下文边界，就必须创建新的 Task revision。
- 新 Task revision 必须创建新的不可变 `AgentInvocation` intent。旧 revision 下的 claim lease、delivery、acceptance、handoff proposal 和 handoff record 都变为 stale，不能满足新任务。
- 如果底层 Runtime 支持 steer，可以复用同一个底层 session 传递补充说明；但逻辑层仍必须有新的 Invocation、task fence 和 idempotency key。
- 如果 run `in_review`，补充创建 root task revision，run 回到 `running`。
- 如果最近一次 handoff 是 `continuation` 且 `activeAgentId = Agent B`，补充默认指向 Agent B；否则默认回到 `mainAgentId` 或 Manager。
- 如果旧 invocation、旧 proposal 或旧 handoff 的 late result 在新 revision 后返回，只作为审计证据保存，不能自动进入 `dependencyResults`、不能触发 `active-agent-changed`，也不能让新 revision 进入 `in_review` 或 `done`。

### 8.5 错误与恢复

| 场景 | 行为 |
|---|---|
| 下游 Agent 不在线 | `handoffs.request` 返回 `UNAVAILABLE`，Manager 可改派、等待或请求用户 |
| 下游 accepted 前拒绝或超时 | Handoff `rejected` / `timed_out`，不写 `active-agent-changed`，owner 保持 source / main Agent |
| 下游 accepted 后失败或超时 | Invocation `failed` / `timed_out`，handoff 写终态并默认回滚 `activeAgentId` 到 source / main Agent，run 保持可恢复 |
| Dispatch emit 失败 | 不切 owner，handoff 进入 `failed` 或等待重试；重复 emit 由 invocation / dispatch idempotency 保护 |
| Worker 崩溃 | Lease 过期，run `recovering`，新 Worker 从 events、handoffs、invocations、checkpoint 重建 |
| 下游 late result | 作为 invocation 终态证据保存；如果 task revision 已变化，不能自动满足新 revision，也不能触发 owner 切换 |
| 交接循环 | Collaboration Kernel 拒绝或要求用户确认 |
| 下游产物不可见 | fail closed，不把 artifact 注入上游 |
| 上游 Agent 试图越权点名私有频道 Agent | proposal 归档或 `handoffs.request` 在 Server 权限检查失败 |

## 9. UI 与产品表现

第一版不需要把 Agent 间所有内部步骤铺满频道。建议展示三层：

1. **主线程消息**：用户请求、必要状态、Agent 结果、最终交付。
2. **协作轨迹折叠区**：显示 `Agent A -> Agent B`，原因“获取日报格式”或“任务接管”，状态“已返回 / 已接管”，贡献产物。
3. **运行详情页**：完整 ManagementRun、handoff、invocation、dispatch attempt、workspace run、artifact 和事件日志。

频道成员面板继续展示哪些 Agent 在频道内，但新增运行态提示：

- `Agent A`：起手 Agent / 已交接 / 汇总中
- `Agent B`：已贡献格式 / 已接管
- `ManagementRun`：等待用户审核

## 10. 权限与安全

1. Handoff 目标 Agent 必须在当前 Team 可见，且属于当前 Channel 或 DM 允许调用范围。
2. Context capsule 只能包含当前用户、Manager 和目标 Agent 都可见的消息、artifact 和显式上下文引用。
3. 本地 workspace 内容默认不跨 Agent 透传。若 Agent A 在本地设备生成日志，Agent B 只拿到用户允许共享的摘要或 artifact。
4. Agent 不拥有权限提升能力。所有 handoff tool 都由 Server 重新校验。
5. Handoff intent、context refs、result refs 和 event payload 进入审计日志；敏感正文通过 capsule/引用管理，不在 event 中重复保存。

## 11. 分阶段实施

本文的落地计划是 PI 总纲 `Phase 2：Task DAG 与团队认领` 之上的 Handoff 子计划，不重新定义总纲 Phase 编号。所有切片都依赖 Phase 2 的 Task coordination、Task revision、claim lease、Invocation Gateway、delivery / acceptance 和 typed ManagementEvent 已经可用。

### Handoff A：管理层多目标调用

目标：让 managed run 可以调用同一频道内除 frozen target 以外的 Agent，但仍由 Manager 串行控制。

- `agents.list_available`
- `agents.invoke` 支持 `targetAgentId`，并由 Server 校验 allowed target
- `ManagementRun.mainAgentId` / `activeAgentId` 只作为默认补充路由事实，不替代 Task claim owner
- 单 run 多 invocation 测试

验收：

- `@Agent A ...问 Agent B...` 能创建两个 invocation。
- Agent B 结果作为 Agent A invocation 的 `dependencyResults`。
- 最终交付只出现一次，root task 进入 `in_review`。

Handoff A 可以先不新增 `AgentHandoffRecord`。它的价值是先拆掉 Phase 1 “只能调用 frozen target”这个技术限制，验证同一 `ManagementRun` 内多 invocation、依赖结果和最终交付是否能跑通。

### Handoff B：Agent Proposal 与结构化 Handoff

目标：把“问另一个 Agent”或“交给另一个 Agent 接管”从普通多调用升级为可审计交接。

- `AgentCollaborationProposalV1`
- `AgentHandoffIntentV1`
- `AgentHandoffRecordDto`
- `handoff-proposed`
- `handoff-requested` / `handoff-dispatched` / `handoff-returned`
- `active-agent-changed`
- `handoffs.request`
- `handoffs.await_result`
- 循环检测和预算限制

验收：

- UI / API 能看到 Agent A -> Agent B 的交接记录。
- 外部 Agent 不能直接调用 `handoffs.request`；只能返回绑定 `sourceInvocationId` 的 proposal。
- `handoffs.request` 必须校验 proposal 仍匹配当前 Task revision、attempt、claim lease 和 source invocation。
- `continuation` 只有在目标 Agent accepted / running 后才把 `activeAgentId` 从 Agent A 更新为 Agent B。
- accepted 前拒绝、dispatch emit 失败或超时不会切 owner；accepted 后失败或超时会回滚到 source / main Agent。
- Worker 重启后能从 handoff + invocation 恢复等待。
- 重复 tool call 不产生重复 dispatch。

### Handoff C：Context Capsule

目标：让下游 Agent 拿到最小必要上下文，而不是完整线程。

- `context.create_capsule`
- context refs 权限过滤
- artifact / invocation result 引用
- capsule 过期和审计

验收：

- Agent B 只能看到日报格式或接管任务所需的最小上下文。
- 私有附件不会因为 handoff 泄漏。
- Capsule 在 workspace run detail 中可解释。

### Handoff D：接管增强

目标：在第一版串行 `continuation` 已经跑通后，补齐更复杂的接管治理能力。

- 长链接管的最大深度和人工确认策略
- source Agent / target Agent 的双向退回机制
- 接管后的 revision 归属、验收标准继承和 stale late-result 处理
- 后续有限并行咨询的聚合策略

验收：

- 长链和预算超限都能 fail closed。
- 接管后退回 source Agent 时，`activeAgentId` 和事件日志保持一致。
- follow-up 语义变化时新 Task revision 会让旧 claim、Invocation、delivery、acceptance 和 handoff proposal stale。
- 并行咨询只能在用户或策略明确允许时启用，不影响第一版串行路径。

## 12. 测试矩阵

| 层级 | 测试 |
|---|---|
| contracts | Proposal / Handoff DTO schema、ManagementEvent schema、Worker tool request/output schema |
| domain | proposal idempotency、handoff idempotency、循环检测、active owner accepted-gate policy、context visibility policy、Task revision stale policy |
| server usecases | managed run 多 invocation、proposal -> handoff 创建、accepted 后切 owner、accepted 前失败不切 owner、accepted 后失败回滚、恢复、取消、超时、late result |
| sqlite repositories | handoff 表、event sequence、invocation/dispatch 外键、唯一约束 |
| socket integration | Device/AgentOS 收到下游 dispatch，结果回到同一 run |
| web-next | 频道协作轨迹、run detail、任务 `in_review`、贡献 Agent 展示 |
| e2e | `Agent A -> Agent B -> Agent A 或 Agent B -> final delivery` 全链路 |

TypeScript 改动必须遵守本仓库 Local Verification Contract：

- contracts/domain 改动跑 `npm run build:contracts` / `npm run build:domain`
- server-next 改动跑 `npm run build:server-next`
- daemon-next 改动跑 `npm run build:daemon-next`
- web-next 改动跑 `npm run build:web-next`

## 13. 非目标

- 不在第一版实现完全去中心化 swarm。
- 不让外部 Agent 直接互相建立私聊或绕过 Server 调用。
- 不把所有 Agent 内部思考、工具日志或本地 workspace 内容透传给下游。
- 不要求 Agent A / Agent B 改造为同一种 Runtime。
- 不在第一版做无限深度任务图、并行竞赛式协作或自动 agent marketplace 选择。

## 14. 关键决策

1. `@Agent` 只决定起手 Agent，不等于完整协作路由。
2. 多 Agent 协作默认进入 `ManagementRun`，不走 direct dispatch 串联。
3. 外部 Agent 可以提出 `AgentCollaborationProposal`，但只有持 lease 的 Manager / Server 可以创建和执行 handoff。
4. Handoff 必须支持两类主路径：`consult` 获取信息后回到原 Agent，`continuation` 把任务交给下一个 Agent 接管。
5. `continuation` 只能在目标 accepted / running 后切 owner；accepted 前失败不切，accepted 后失败默认回滚 source / main Agent。
6. Task revision、claim lease 和 Invocation intent 是交接正确性的 fence；旧 revision 的 proposal / handoff / late result 不能满足新任务。
7. `AgentInvocation` 继续复用 `Dispatch`，不创建第二套执行事实源。
8. Context 以 capsule/ref 传递，不默认全量透传。
9. 第一版不做跨频道 handoff，不把下游结果自动沉淀为 Memory，不开放并行多 Agent 咨询。

## 15. 已收敛约束

1. **最终输出者**：如果 Agent A 已经拥有足够频道上下文和工作上下文，它可以直接总结并输出结果；如果需要 Agent B 的结构、事实或审核，Agent A 可以先咨询 Agent B，再继续输出。若 handoff 是 `continuation`，Agent B 接管后也可以直接给出最终结果。
2. **不自动保存记忆**：Agent B 给出的日报格式、审核意见或中间结论第一版只作为 invocation result / handoff result 使用，不自动沉淀为 channel memory、team memory 或长期知识。用户后续显式“记住”属于 Memory 功能边界，不属于本设计第一切片。
3. **不允许跨频道**：handoff 第一版必须留在同一 Team + 同一 Channel / DM 权限边界内。Agent A 不能把当前频道任务交给只存在于另一个频道的 Agent B，也不能把私有频道上下文带到其他频道。
4. **先串行**：第一版只支持串行 handoff。Agent A 可以先问 Agent B，再继续；也可以交给 Agent B 接管。并行咨询多个 Agent 后再聚合留到后续阶段。

## 16. 推荐第一切片

最小可交付切片是 Handoff A + Handoff B 的串行 `consult` / `continuation` 子集：

1. 扩展 `agents.invoke` 支持 Manager 调用频道内任一 eligible Agent。
2. 新增 `AgentCollaborationProposal`，允许外部 Agent 返回绑定 `sourceInvocationId` 和 Task fence 的协作建议。
3. 新增 `AgentHandoffRecord` 和 `handoffs.request`，先支持 `consult` / `template_request` / `continuation`，且只能由 Manager / Server 持 lease 执行。
4. `continuation` 必须等目标 Agent accepted / running 后才更新 `activeAgentId`，让后续线程补充默认交给接管方。
5. 用户补充改变语义时必须创建新 Task revision，并让旧 proposal / handoff / invocation / delivery / acceptance stale。
6. UI 只展示折叠协作轨迹，不重做频道消息模型。
7. 用 `Agent A -> Agent B -> Agent A final delivery` 和 `Agent A -> proposal -> Agent B continuation -> Agent B final delivery` 两条端到端测试覆盖咨询和接管。

这能直接验证用户想要的“一个 Agent 获取另一个 Agent 的信息并继续完成任务”，同时不把系统推入不可控 swarm。

第一切片仍然不做并行、不跨频道、不自动写 Memory。这样可以先把“咨询”和“接管”两种串行交接跑通，并保持路由、补充消息和 UI 状态稳定。
