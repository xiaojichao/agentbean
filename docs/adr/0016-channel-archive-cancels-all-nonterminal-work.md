---
status: accepted
---

# Channel archive 显式取消全部非终态工作

Channel archive 代表项目彻底结束，因此归档前必须通过 Channel archive gate 展示全部未完成和待审核工作，并由用户显式确认取消；系统随后停止新 Task 与 Invocation、撤销 claim 和 lease、请求外部 Agent 停止、保留已有消息、交付、Artifact 与审计历史，并将待审核结果标记为项目结束时未确认。第一版不跨频道迁移 Task，需要延续的工作在目标频道创建新 Task，并只引用原 Task 的获准摘要。
