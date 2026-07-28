---
status: accepted
---

# Server 持有唯一 PI 编排权威

只有 #894 冻结的结构化 PI orchestration trigger 才能创建根 Task；每个根 Task 只对应一份 Server-owned、持久化的 PI orchestration run 与 orchestration claim。PI Manager 统一作为 Server-hosted、可替换且带 fencing 的临时驱动，daemon 与 Device Agent 只负责本地子 Task 执行和派生唤醒，不能持有、重建或接管根 Task 的编排事实。

Server 通过持久 run/Task DAG/调度/deadline/event/audit/outbox、原子 orchestration command、可丢弃 checkpoint 与幂等 reconciliation 完成恢复；这样即使 PI worker、Server 副本或 daemon 重启，也由持久事实与事务保证唯一编排，而不依赖某个进程的内存或 Device 在线。该决定取代 ADR 0001、0010 与 0032 中每消息 Channel Coordinator、Device-only coordination 以及仅以 MVP placement 表述编排权威的语义。
