---
status: accepted
---

# Task 补充消息采用证据分级关联与修订

Task 详情、Task 讨论串、回复 Task 系统消息或明确引用形成强绑定，PI 可以直接把消息关联到 Task；缺少强绑定时，只有当前频道存在唯一明显匹配 Task 且内容是不改变任务本质的小补充，才可自动关联并提供撤销，多个候选、范围扩大、成本增加、交付改变或验收冲突必须先询问用户。已经开始执行的 Task 不原地覆盖目标，而是创建可追溯 Task revision，并让受影响的旧 claim、Invocation 和 acceptance 失去当前 authority。
