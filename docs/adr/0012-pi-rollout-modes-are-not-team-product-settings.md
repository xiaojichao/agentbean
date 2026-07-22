---
status: accepted
---

# PI rollout 模式不属于 Team 产品设置

`direct / shadow / managed` 不再作为 Team 的普通设置，因为 PI 已是默认 Channel Coordinator。系统管理员保留紧急停用、旁路评估和正式启用的 PI Rollout State；Team 只保留一个默认开启的“PI 自动协调”总开关，统一控制低风险建 Task、任务分解、Task Offer、开放认领和 Memory Candidate。关闭后 PI 仍理解消息，只给出建议或等待明确要求。底层模型由系统管理员全局指定，不属于 Team Policy。
