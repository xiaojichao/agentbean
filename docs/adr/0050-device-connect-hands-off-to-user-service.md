---
status: accepted
---

# 设备首次连接交接给单一用户级 Device Service

macOS 用户首次连接设备时使用一次性 `agentbean device connect` 完成邀请注册、Device Profile 凭据持久化和 Device Service 安装或刷新；命令确认服务健康后退出，不再把前台 Daemon 进程作为长期运行入口。同一 macOS 用户只有一个 Device Service，不同 Team 只增加 Profile；已有 Profile 的设备仍可通过 `agentbean device install` 与 `agentbean device restart` 迁移或恢复。

这一合同选择“单次连接后交接系统服务”，而不是继续展示会前台常驻的邀请命令，也不为每个 Team 安装独立服务。设备详情页因此不保存或展示历史邀请命令，只在需要重新授权时生成新的短期连接命令。
