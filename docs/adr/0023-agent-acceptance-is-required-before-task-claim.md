---
status: accepted
---

# Agent 明确接受后 Task 才能形成有效 Claim

Agent Exposure Manifest 只用于 PI 预筛候选，不保证 Agent 愿意或能够接受某个具体 Task。PI 向候选 Agent 发送结构化 Task Offer，说明目标、输入、交付物、约束、required Capabilities、required Skills、时限和风险；Agent 自主选择接受、拒绝、请求补充信息或提出调整建议。只有明确接受仍有效的 Offer 后，系统才创建正式 claim/lease 并进入执行状态。

用户显式 `@Agent` 表示 PI 必须优先询问该 Agent，但不能强迫它接受。Offer 超时、被拒绝或因 Task revision 失效后，PI 才按既定分配策略寻找其他候选。该协议保持 PI 的协调权与 Agent 的内部自治边界。
