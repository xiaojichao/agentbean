---
status: accepted
---

# Channel archive 是项目结束边界

AgentBean 不为“一个频道一个项目”的场景增加独立 Project 实体或多阶段项目状态；用户归档 Channel 即权威声明该频道代表的项目已经结束。PI 不根据静默时间或最后一个 Task 的完成状态自行判断项目结束，而是在 Channel archive 时进入项目收尾，检查遗留工作并提出项目摘要、Memory Candidate 和 Reusable Experience Pack 草稿。经验是否保存或复用继续遵循已确认的双重确认规则。
