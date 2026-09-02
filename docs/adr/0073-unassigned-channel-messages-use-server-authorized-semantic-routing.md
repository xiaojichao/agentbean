---
status: accepted
---

# 未指派频道消息采用 Server 授权的语义路由

人类在频道发送未明确 `@Agent` 的根消息后，Server 先原子提交 Message 与 Inbox，再由 Channel Work Intake 对该来源 lineage 执行可恢复的 Message Route Analysis。PI 模型只产生无权威写入能力的 PI intent proposal；Server 只有在校验当前 Message revision、Team policy、Channel/Team 权限、风险、Capability Registry、Agent Exposure、Freshness basis 与 authority epoch 后，才能形成 Server-authorized semantic trigger，并经唯一 Promotion Gate 创建 root Task、PI orchestration run 与 Task DAG。明确 `@Agent`、DM 与既有 Task follow-up 仍走确定性路径，纯聊天保持 Message only；模型输出本身不是 trigger、Task、Offer、Claim 或执行授权。

Agent 能力匹配采用 `Capability Candidate → Capability Evidence → Team Agent Exposure Manifest → Agent eligibility` 信任链：扫描 `AGENTS.md`、`CLAUDE.md` 或 `SKILL.md` 只发现候选，Agent owner 决定 Team 范围的公开投影，runtime verification 提供时效证据，Server 在 Offer 与 accept/claim 时分别复验权限、Manifest、restriction、capacity 与任务要求。Exposure 表示 Agent 可以被发现，独立的 Agent Auto-accept Policy 表示 Agent 是否愿意自动接受某类 Offer；PI Manager 不得代表 Agent 直接 Claim，也不得用模型推断补造未公开能力。

PI 或 Active PI Model 不可用时，Message 仍成功提交；明确目标、既有 Task linkage 和 Low-risk collective directive 可以走 Deterministic routing fallback，其余分析保持可恢复的 deferred 结果。系统不随机选择 Agent、不降低 required Capability、不静默跨模型 fallback。Agent 原始交付继续保留发送者与 provenance，多 Agent 收口使用 System activity projection 与 Task delivery revision，不创建 PI 聊天气泡或“PI 汇总”Message。

本决策冻结 #1270，取代 ADR-0069 中“自然语言与模型判断永远至多产生 clarification/proposal”以及普通聊天场景“未 `@` 绝不自动选择 Agent”的绝对禁止，也扩展 ADR-0062 中仅接受既有显式 trigger 的来源集合；ADR-0062 的 Server-owned authority、ADR-0069 的单一 lineage/幂等/fencing/恢复不变量、ADR-0064 的 Offer/acceptance/Claim 分离、ADR-0066 的可见性合同与 ADR-0071 的隐藏 PI 边界继续有效。
