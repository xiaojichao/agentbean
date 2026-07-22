---
status: accepted
---

# MVP Provider Protocol 只支持 OpenAI-compatible Chat Completions

AgentBean 当前 Management Model Adapter 使用 Bearer API Key，调用 `{baseUrl}/chat/completions`，并按 OpenAI messages 与 tool-call 格式收发内容。为尽快上线，PI Provider Card 的 MVP 协议固定为 `openai_chat_completions`。首批预设可以使用 OpenAI、DeepSeek、OpenRouter 等不同品牌，但它们都必须通过同一协议的真实模型和 tool-call 兼容性测试。

MVP 不展示尚未接通的 Anthropic Messages、OpenAI Responses、Gemini、Bedrock 或 OAuth 选项。以后新增协议时必须提供独立 Adapter 与兼容性测试后再开放相应预设，Provider 名称本身不能作为原生协议已受支持的证据。
