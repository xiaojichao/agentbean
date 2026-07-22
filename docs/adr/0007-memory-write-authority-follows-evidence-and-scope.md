---
status: accepted
---

# Memory 写入权限取决于证据与作用域变化

AgentBean 采用三级 Memory 写入规则：用户明确要求记住、已确认交付中的明确决定或经用户确认复述的内容，可以在原作用域内作为 Explicit Memory 直接生效并允许撤销；PI 推断出的偏好、规律、评价和经验只能成为 Inferred Memory Candidate，在确认前不得影响后续协作；任何跨频道、Channel 到 Team、Device-local 到 Team 或向其他 Agent 扩散的 Memory scope expansion 都必须显式确认。该规则在减少逐条录入负担的同时，阻止模型推断和权限扩大静默成为事实。
