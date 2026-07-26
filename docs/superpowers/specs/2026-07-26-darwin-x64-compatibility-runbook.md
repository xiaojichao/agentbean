# darwin-x64 兼容性验收 Runbook（#725 / AC10）

> 目标：在 GitHub Intel macOS runner 上验证 `darwin-x64` 构建、SEA 启动和 fail-closed 平台判定。
> 架构合同：ADR 0056。该结果是 x64 兼容性证据，不是 Intel Device 产品支持证据。

## 1. 验收环境

`.github/workflows/pi-sea-compatibility.yml` 使用 GitHub `macos-15-intel` runner，并固定：

- `verdict_os: macos`；
- `arch: x64`；
- Node 24.18.0；
- 与其他平台相同的 SEA build/check 脚本和 fail-closed verdict 合同。

Rosetta、arm64 runner 或交叉编译不能替代这个 x64 job。

## 2. Green 证据

x64 matrix 必须完成并上传：

- `pi-sea-verdict-macos-x64/verdict.json`；
- 成功执行的 `darwin-x64` SEA；
- 包含该 x64 verdict 的 aggregate verdict；
- 对应 Actions run URL 与 commit SHA。

#725 的合并后证据：

- [四平台 SEA 与 fail-closed 聚合判定](https://github.com/xiaojichao/agentbean/actions/runs/30183371319)

## 3. 明确不在验收范围

下列 Intel macOS 行为没有可重复的原生设备环境，因此不构成 AC10 或 MVP 发布阻塞条件：

- Device Service 安装、LaunchAgent 生命周期、重新登录恢复和升级；
- Device Profile 连接与恢复；
- Agent 扫描、执行和 Claim 交付；
- 本地目录、Workspace Run、Artifact 与 Device-local Memory；
- Intel 安装产物的签名、公证和面向用户发布。

这些行为即使因共享代码而可用，也只属于未验证的 best-effort 行为，不得写成正式 Intel 支持。

## 4. 判定

- Green：macOS x64 matrix、x64 verdict 和 aggregate verdict 全部通过；
- Red：x64 不能构建/启动、verdict 不匹配、artifact 缺失或聚合判定未通过；
- Intel Device 能力不参与本判定。未来若恢复完整 Intel 支持，必须新增架构决定与可重复的原生设备验收。
