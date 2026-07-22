---
status: superseded
superseded-by: 0043
---

# MVP 模型配置采用 Provider Card 与 Runtime Profile 两层

参考 cc-switch 的 Provider 管理体验，AgentBean MVP 使用两层模型配置。系统管理员通过 PI Provider Card 管理一份完整的 Server provider 配置：可从预设或 Custom 创建，使用普通表单填写协议、Endpoint 和 Credential 引用，自动获取模型或在接口不支持时手工填写 Model ID，并提供经过校验的高级 JSON、复制、备注、控制台链接和生产同路径模型测试。Credential 创建后不向 Team 暴露。

Team 只选择系统管理员发布的 PI Runtime Profile；每个 Profile 绑定一张已启用 Provider Card 与其中一个 Model ID，并展示面向 Team 的名称、用途、模型、数据说明和健康状态。MVP 不引入 Provider Connection、Model Deployment、Model Pool、多应用配置同步、本地代理接管、自动 failover、费用配置或 Agent Skill 安装。
