---
status: accepted
---

# 子任务以原子合同发布并在频道内通过 Offer 分配

PI 在无执行副作用的 planning draft 中拆解根目标，并为每个可执行子 Task 冻结完整合同：唯一目标、具名输入绑定、具名输出位置、控制依赖、验收与 evidence/authority、required Capabilities/Skills、约束、风险、deadline 与重试上限。Server 只在整张 Task DAG revision 通过无环、根目标 coverage、合同完整性、输入可解析与 allocation 可行性校验后原子发布；发布失败不产生 runnable、Offer、claim 或 Invocation。

Task dependency 只门禁下游 runnable，不隐式传递数据。上游当前 revision/attempt 的 delivery 被合法验收后，具名 output slot 才解析为不可变 snapshot；下游必须通过显式 input binding 使用该 snapshot。验收标准全部阻塞并要求逐项 evidence，非阻塞期望只能作为 Task quality preference。需要主观或高风险判断时，整份 delivery 交给预声明的人类验收权，PI 不得用部分自动判定绕过。

Server 先用当前 Channel membership、Team visibility、Task/input 权限、operation restriction 与 hard capacity 建立 eligibility 硬门槛，再由 PI 根据 Agent Exposure Manifest 的 required Capability/Skill 过滤候选，并以可审计的 preferred Skill、Team 经验、负载、deadline 风险和稳定公平 tie-break 排序。targeted Offer 与 candidate-set Offer 只是同一 Task Offer / Agent acceptance 协议的路由方式；显式 `@Agent`、PI 选择或候选胜出都不能强制建立 claim。Server 在 Offer 发布和 accept/claim 事务中复验当前资格与容量，并只允许一个 acceptance 原子取得 claim。

Offer 只披露候选作决定所需的最小 preview，不授予输入访问。claim 成功后，Server 才签发绑定 Agent、task revision、attempt 与 claim 的 execution context grant。失败、超时、relinquishment 或 fencing 终止当前 attempt，重新派发必须创建新 attempt；未验收的部分 artifact 只能作为显式、带 provenance 的 handoff material，不能解析为正式 output 或解除下游依赖。

当前频道没有合格候选时，Task 进入结构化 `allocation_blocked`。PI 可以为确实可分离的工作提出保持根目标、风险与验收 coverage 的新 DAG revision，但不得降低硬要求、扩张权限或把 unknown 当作 eligible；频道外能力只以脱敏建议交给有权人类决定。该决策细化 ADR-0021 的多 Agent Skill coverage、ADR-0023 的 acceptance-before-claim 与 ADR-0025 的 revision-bound Offer，不改变其既有原则。
