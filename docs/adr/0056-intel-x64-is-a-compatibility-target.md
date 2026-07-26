---
status: accepted
---

# Intel x64 是兼容目标而不是受支持的用户设备平台

AgentBean 首版只对 Apple Silicon arm64 上的 macOS Device 能力作完整产品承诺。由于项目没有可持续取得的原生 Intel Mac 验证环境，`darwin-x64` 保留为兼容目标：使用 GitHub `macos-15-intel` runner 验证构建、SEA 启动和 fail-closed 平台判定，但不据此宣称 Device Service 生命周期、Agent 扫描与执行、本地文件和 Workspace、安装升级或签名公证在 Intel 用户设备上受支持。

这取代 ADR 0037 的 Intel 完整支持决定。Rosetta 和 arm64 结果仍不能作为 x64 证据；反过来，Intel CI 结果也只能证明其覆盖的兼容边界。Intel Device 能力采用 best-effort 维护且不阻塞 MVP 发布；若未来恢复完整 Intel 支持，必须以新的架构决定和可重复的原生设备证据重新建立承诺。
