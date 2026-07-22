---
status: accepted
---

# MVP Memory 冲突只做简单人工选择

保存 Formal Memory 时只检查同一作用域内可能冲突的有效 Memory。发现冲突后 PI 不自动覆盖、合并或判断谁正确，授权管理者只选择“用新 Memory 取代旧项”或“二者同时保留”。选择取代时旧 Memory 标记为 `superseded` 并立即退出有效上下文，但保留必要版本事实。

PI 无法确定是否冲突时，新内容继续作为 Candidate，不影响后续协作。MVP 不设计跨作用域复杂优先级、自动事实融合或知识图谱冲突消解。
