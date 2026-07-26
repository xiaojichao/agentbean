# darwin-x64 Device Service 发布验收 Runbook（#725 / AC10）

> 目标：在原生 Intel macOS 上验证 `darwin-x64` 产物的启动、Device Service、Agent 扫描/执行与关键本地能力。
> 架构合同：ADR 0037。Rosetta 只能辅助 Apple Silicon 上的兼容排错，不能替代 Intel x64 的正式证据。

## 1. 环境门槛

在目标机运行：

```bash
test "$(uname -s)" = "Darwin"
test "$(uname -m)" = "x86_64"
node -v
```

Green 要求：

- `uname -m` 必须为 `x86_64`；
- Node 使用仓库声明的 24.x；
- 验收对象是该 commit 生成的 `darwin-x64` 安装产物，不是 arm64 产物经 Rosetta 转译；
- 普通用户会话可使用 `launchctl`，且验收过程中不提升为 root。

## 2. CI 预证据

`.github/workflows/pi-sea-compatibility.yml` 的 `macos-13 / x64` matrix 必须通过并上传：

- `pi-sea-verdict-macos-x64/verdict.json`；
- aggregate verdict；
- 对应 Actions run URL 与 commit SHA。

CI 只证明 x64 SEA 可构建、可启动和平台 verdict 合同成立，不替代真实 Device Service 与本地能力验收。

## 3. 真机执行

在目标 commit 的干净 checkout 中：

```bash
npm ci
npm run build:packages
npm run smoke:phase5a-device-service
```

随后通过产品入口完成：

1. 安装或刷新 Device Service；
2. 关闭发起安装的终端，确认 LaunchAgent 仍存活；
3. 重新登录用户会话，确认服务自动恢复；
4. 连接一个 Device Profile；
5. 扫描至少一个外部 Agent；
6. 发起一次真实 Agent 执行并收到终态结果；
7. 验证一次本地文件目录读取和一次 Workspace Run/Artifact 回传；
8. 停止、重启 Device Service，确认同一 Profile 恢复且不产生重复 Device。

## 4. 证据记录

回填 #725 的证据不得包含 Credential、业务 prompt 或本地敏感文件内容。至少记录：

| 字段 | 要求 |
| --- | --- |
| commit | 完整 SHA |
| host | macOS 版本、Intel 机型、`uname -m=x86_64` |
| artifact | `darwin-x64` 文件名与 SHA-256 |
| CI | x64 matrix run URL、verdict artifact |
| service | 安装、终端关闭后存活、重新登录恢复、restart 结果 |
| agent | 扫描到的测试 Agent 类型与一次执行终态 |
| local | 目录读取、Workspace Run/Artifact 的脱敏 ID |
| secrets | 明确写 `未记录` |

## 5. 判定

- Green：CI x64 verdict 与上述 8 个真机步骤全部通过；
- Partial：仅 CI、仅 Rosetta、或缺少重新登录/Agent 执行/本地能力任一证据；
- Red：x64 产物不能启动、Device Service 不能恢复、扫描/执行失败，或出现 Credential 泄漏。
