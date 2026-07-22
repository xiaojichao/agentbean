---
status: accepted
---

# Provider Card 必须通过生产同路径测试才能发布

PI Provider Card 可以保存为 Draft，但发布前必须复用生产 Management Model Adapter 完成固定无业务数据的普通文本响应，以及 PI tool-call、tool result 到最终响应的完整回合。测试同时验证鉴权、Model ID、响应格式、finish reason、usage 解析、超时和取消，并记录测试时间、延迟与实际返回模型。

未通过测试的 Card 不能发布，其模型不能设为 Active PI Model。MVP 不照搬 cc-switch 的 Streaming/TTFB 测试，因为当前 AgentBean 生产 Adapter 使用非流式响应；单独测试一条运行时不用的路径不能证明 PI 可工作。模型列表获取成功或 Endpoint ping 成功也不能替代生产同路径测试。
