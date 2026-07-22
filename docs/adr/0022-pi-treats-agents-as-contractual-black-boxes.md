---
status: accepted
---

# PI 将 Agent 视为通过公开契约协作的黑盒

PI 只能看到 Agent 或其适配器主动发布的 Agent Exposure Manifest，以及 AgentBean 对连接、请求和结果的外部可观测事实。Capabilities 与 Skills 都是 Agent 愿意用于协作匹配的公开声明；未声明只表示 PI 没有资格据此匹配，不能推断 Agent 内部不存在该能力。

PI 不扫描 Agent 文件，不核验其内部工具、权限或 Skill 依赖，也不安装、复制、启用、禁用或更新 Agent 内部 Skill。系统与 Team 可以治理 PI 是否被允许向 Agent 发出某类请求，但不能借此接管 Agent 内部实现。Agent 是否接受请求以及如何完成任务，由 Agent 自己决定并通过公开协议返回结果。
