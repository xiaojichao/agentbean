---
status: accepted
---

# MVP 内置四类 Provider Preset

PI Provider Card 的 MVP 创建入口只内置 OpenAI、OpenRouter、DeepSeek 和 Custom OpenAI-compatible 四类 Preset。Preset 负责填充名称、Base URL、Endpoint Mode 和已知兼容参数；模型仍通过自动获取或手工填写选择，并且必须通过真实模型与 tool-call 测试后才能发布。

其他 Provider 暂不为了展示数量而加入内置目录，系统管理员可以先通过 Custom Card 接入。未来只有在相应配置和兼容性测试稳定后再增加 Preset；Provider 品牌名称本身不扩大 MVP 的单一 OpenAI-compatible Chat Completions 协议边界。
