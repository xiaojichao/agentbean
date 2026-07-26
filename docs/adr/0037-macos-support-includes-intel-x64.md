---
status: accepted
---

# macOS 支持同时包括 Apple Silicon 与 Intel

AgentBean 用户设备首版必须原生支持 Apple Silicon arm64 与 Intel x64。Device Service、Agent 扫描与执行、本地文件访问、安装和升级都必须在两种 macOS 架构上成立，不能把 macOS-only 收窄为 arm64-only，也不能将 Rosetta 作为 Intel 用户的正式兼容承诺。

发布流程需要为 `darwin-arm64` 与 `darwin-x64` 生成对应可安装产物，并分别完成签名/公证、启动和关键 Device 能力验证。是否未来合并为 universal binary 由实现阶段决定，但不能在缺少真实双架构证据时宣称支持 Intel。
