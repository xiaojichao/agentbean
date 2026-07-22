---
status: accepted
---

# Memory 治理集中在 PI Management

AgentBean 不新增顶级 Memory 设置。PI Agent 的系统作用域提供 System Knowledge 管理，仅系统管理员可用；Team 作用域提供统一 Memory Center，集中治理 Team Memory、Channel Memory、Agent Memory 投影、Memory Candidates 和 Reusable Experience Packs，避免管理员在多个频道与 Agent 页面来回维护。

频道详情只提供“查看本频道 Memory”的快捷入口，跳转到已经按频道过滤的 Team Memory 页面；Agent 页面只管理其向 Team 暴露的 Memory 投影并提供相应入口，不展示 Agent 内部记忆。User Memory 属于用户个人，放在个人设置而不是 Team PI 设置中。
