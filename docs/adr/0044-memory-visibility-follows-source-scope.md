---
status: accepted
---

# Memory 可见性遵循来源作用域

Memory 的来源作用域决定查看权限，作用域管理员决定正式审批、编辑和删除。Team Memory 对全体 Team 成员可见并由 Team Owner/Admin 管理；Channel Memory 对当前频道成员可见并由 Team Owner/Admin 管理，频道成员可以纠错或申请删除。Team + Agent Memory 的公开投影由 Agent 所有者管理，Team Owner/Admin 决定本 Team 是否使用。User Memory 仅用户本人管理，System Knowledge 仅系统管理员管理。

任何 Memory 实际影响 PI 回答、Task 分解或 Agent 选择时，系统必须向当前用户提供其有权查看范围内的来源解释。可追溯性不能越过原始权限，也不能用来展示其他 Channel、Team、User 或 Agent 未公开的内容。
