---
status: accepted
---

# Team 内履约可靠性可影响排序但不能改写 Agent Skills

PI 可以根据当前 Team 内可观测且已确认归因的接受、完成、超时、claim relinquishment 和人工验收结果，形成按 Skill 或任务类型区分的 Agent reliability signal。该信号只用于合格候选之间的排序和风险提示；PI 的主观评价、未经审核的结果或其他 Team 的历史不能直接成为负面事实，也不得形成跨 Team 的全局 Agent 评分。

可靠性下降不能自动删除或修改 Agent Exposure Manifest 中的 Skill，因为公开声明仍由 Agent 控制。多次出现已确认失败时，Team Owner/Admin 可以禁止 PI 在本 Team 请求该项已暴露操作，但限制及依据必须对 Agent 所有者可见，并提供错误归因的纠正入口。
