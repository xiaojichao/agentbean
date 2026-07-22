---
status: accepted
---

# 用户设备平台只支持 macOS

AgentBean 当前只对 macOS 用户设备提供产品支持。Device Service、Agent 扫描与执行、本地文件访问、原生选择器、安装、升级和发布验证不再为 Windows/Linux 新增实现或兼容承诺。仓库已有的 Windows/Linux 兼容代码暂不主动删除，但它们不能约束新需求，也不代表受支持产品能力。

该限制不适用于云端基础设施。`server-next` 与 Web 继续部署在 Railway/Vercel，因此其 Linux 运行与 CI 仍然保留；PI Provider Credential 继续由 Server secret store 管理，不因用户设备是 macOS 而迁入本机 Keychain。
