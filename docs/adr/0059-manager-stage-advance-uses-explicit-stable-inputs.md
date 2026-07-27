---
status: accepted
---

# Manager 阶段推进只使用显式稳定输入

## 背景

ADR 0057 为 #822 建立了阶段级必需输入证据：上游 Task 完成且未被否决时，声明式
`key/kind/label` 暂时视为满足。该决定明确把具体 ArtifactVersion、文档 revision 与
InputSet 的收口留给后续切片。

#829 已具备逻辑产物版本、append-only 审核、唯一最终版、固定文档包、冻结引用和
InputSet。若继续沿用阶段级占位证据，PI Manager 可能在没有明确输入身份时自动执行，
并从标签、文件名或聊天上下文猜测下游材料。

## 决定

Stage edge 的必需输入可绑定显式稳定来源：

- Artifact 输入绑定 `collectionId`，并声明必须是 `final` 或允许最新 `approved`；
- 文档输入绑定 `bundleId`，Server 从该包固定成员解析当前 ChannelDocument revision。

旧 edge 缺少来源绑定时保持可读，但不能满足自动推进。Server 不使用 `key`、`label`、
文件名、路径、mime 或聊天文本补全来源。

推进与 Invocation 创建均重新校验：

- Channel 未归档、Team 自动协调策略、PI 健康；
- Stage edge、Task dependency、canonical acceptance；
- Stage、Task、coordination、claim 与 Invocation revision/attempt fence；
- ArtifactVersion 属于明确上游 Stage/Task revision，且最新审核仍通过；
- 文档包来自明确 Invocation，其 Task revision 与上游阶段一致；
- Agent/Device 的公开能力、Team 可见性和 InputSet 合同版本。

自动协调关闭时只投影建议，不发布 Offer。开启时 Manager 只发布 Task Offer；Agent
必须通过公开能力匹配并明确接受，接受后现有 Claim 协议才设置 active owner。Invocation
在创建时冻结 ArtifactVersion 和文档 revision；任何指针、revision、claim 或审核变化都
使旧决定 fail closed。

## 结果

ADR 0057 的阶段级证据只保留为历史迁移语境；从 #829 起，带必需输入的自动推进必须
使用本决定的显式来源与稳定身份。阶段详情可直接展示推进依据、稳定输入、候选/目标
Agent 和等待原因，而不需要解释模型推断。
