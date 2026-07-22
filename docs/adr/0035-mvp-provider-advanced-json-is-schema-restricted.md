---
status: accepted
---

# MVP Provider 高级 JSON 受 Schema 限制

PI Provider Card 保留 cc-switch 风格的普通表单与高级 JSON 双入口，但两者编辑同一份类型化配置。MVP 高级 JSON 只允许 `baseUrl`、`endpointMode`、`modelId`、`timeout`、`maxOutputTokens` 和少量明确支持的兼容参数；Credential 仅显示不可编辑的引用，加密保存且不回显明文。

MVP 不支持 OAuth、Shell 命令、环境变量插值、任意 Headers 或任意 Request Body。Preset 负责提供已知 Provider 默认值；Custom 配置必须通过 Schema 校验与真实模型/tool-call 测试后，其中的模型才能设为 Active PI Model。高级入口因此增强可见性与编辑效率，但不成为绕过运行时和安全边界的任意透传通道。
