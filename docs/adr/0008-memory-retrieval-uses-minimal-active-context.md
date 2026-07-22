---
status: accepted
---

# Memory 读取使用最小 Active Memory Context

PI Manager 不在每条频道消息中加载全部 Team、Channel 或 Agent Memory，而是自动组合少量核心 Team Memory、当前频道相关记忆、已关联经验包和当前 Task 事实作为 Active Memory Context。Team Memory 的作用域表示可在权限范围内检索，不表示默认全量注入；Team-scoped Agent Memory 只在候选 Agent 选择或调用时按需检索，其他频道、未关联经验包和跨 Team Memory 默认不可见。PI 可以显式扩大检索深度，但每次都重新执行权限与来源校验。
