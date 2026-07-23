# Phase 5B Windows x64 用户级服务真实会话验收 Runbook（#676）

> 适用 issue：[#676 — Windows x64 用户级服务真实会话验收](https://github.com/xiaojichao/agentbean/issues/676)
> 父决策：#664（Phase 5A 决策地图） · 生命周期合同：#669 · 数据保留合同：#670
> 原型分支：`codex/phase5-windows-service-prototype`（最新 `e1164f3e`，领先 `main` 17 commits，未合并）
> 原型代码位置：`apps/daemon-next/prototypes/windows-user-service/`

---

## 0. 本 Runbook 的边界（先读）

这是一份**真人执行手册**，不是实现规格。它在 macOS / Linux 上无法执行，只服务于 #676 唯一剩余的验收门槛。

#676 的自动化部分已经 100% 完成，全部在原型分支 `codex/phase5-windows-service-prototype`：

| 已验证面 | 证据 |
| --- | --- |
| per-user MSI payload / `InteractiveToken` Task / `IgnoreNew` 单实例 / 活跃工作排空 / durable outbox flush / 有界崩溃重启 / `KILL_ON_JOB_CLOSE` Job Object / 卸载回归 | CI `hosted-runner-partial` 通过 |
| 管理员会话权限面 | Actions run，verdict = `hosted-admin-partial-*` |
| 标准用户权限面（临时本地账号 `AgentBeanProbe`，`isAdministrator=false`、Medium integrity、`INTERACTIVE`/`CONSOLE LOGON` token） | Actions run，verdict = `hosted-standard-user-process-partial-*` |

**剩余门槛只有一项**：在一台真实 Windows 11 x64 普通非管理员桌面会话上，跑通 `install → sleep/wake → logout/login → reboot/login → remove`，并采集 `session-evidence.jsonl` + 无 UAC 观察。GitHub-hosted runner 无法替代（见 §5）。

完成本 Runbook 的全部序列并采集到合规证据，才构成 #676 的 Green；在此之前 #676 保持 Open，下游 #666 不解锁。

---

## 1. 机器与环境前置条件

| 要求 | 如何验证 | 不满足的后果 |
| --- | --- | --- |
| Windows 11 **x64**（AMD64） | `$env:PROCESSOR_ARCHITECTURE -eq 'AMD64'` | 脚本抛 `WINDOWS_X64_REQUIRED`；ARM64（如 UTM Windows VM）不可替代 |
| 普通**非管理员**桌面账号 | `whoami /groups` 不含 `BUILTIN\Administrators`（或见 §2 自检） | verdict 退化为 `hosted-admin-partial-*`，不计 Green |
| **真实交互桌面会话**（本人登录桌面，非 alternate-credential token） | 登录后看到自己的桌面即可 | Task 停在 `0x41303`（never run），自启无法验证 |
| 机器策略**允许 per-user MSI**（`DisableMsi ≠ 1`） | 见 §2 自检（查注册表） | MSI 返回 `1625`，hosted windows 正是此策略 |
| 工具链：Node（带 npm）、.NET SDK 8.0.x、可联网安装 WiX 4.0.6 | `node -v`；`dotnet --version` | `install` 步骤构建失败 |
| 安装**不提权**（无 UAC 弹窗） | `install` 全程不弹 UAC 即为通过项之一 | 若弹 UAC，说明 payload 触发了 elevation，与 per-user 合同冲突 |

> ⚠️ 原型明确**不改机器策略、不绕过 `DisableMsi`**。若目标机策略禁止 per-user MSI，请换一台策略允许的机器，不要为了通过而放宽策略。

---

## 2. 执行前自检

在目标机的 PowerShell（普通用户、不提权）运行，确认四项前置全部满足后再进入 §3：

```powershell
# 1. 架构必须是 AMD64
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw "ARCH_NOT_X64: $($env:PROCESSOR_ARCHITECTURE)" }

# 2. 必须是非管理员
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$prin = New-Object Security.Principal.WindowsPrincipal($id)
if ($prin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'IS_ADMINISTRATOR_NOT_STANDARD_USER' }

# 3. 机器策略不能禁用 per-user MSI
$reg = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Installer'
$disable = if (Test-Path $reg) { (Get-ItemProperty $reg -ErrorAction SilentlyContinue).DisableMsi } else { $null }
if ($disable -eq 1) { throw 'MACHINE_POLICY_DISABLE_MSI_1' }

# 4. 工具链
dotnet --version | Out-Null
node -v

Write-Host "SELF_CHECK_OK arch=AMD64 admin=false disableMsi=$disable"
```

---

## 3. 执行序列（核心）

入口命令：`npm run prototype:phase5-windows-service-session`（即 `run-session.ps1`）。
参数：`-Action install|check|remove`，`-Checkpoint initial|wake|login|reboot|manual`。

> 原型脚本会安装到 `%LOCALAPPDATA%\AgentBean\DeviceServicePrototype\`，并在 `%LOCALAPPDATA%\AgentBean\DeviceServicePrototype\session-evidence.jsonl` 追加证据。`remove` 卸载任务与 payload，但**故意保留** state/evidence 供审阅（遵守 #670）。

| 步骤 | 命令 | 期间的人工动作 | 成功标志 |
| --- | --- | --- | --- |
| 1 | `npm run prototype:phase5-windows-service-session -- -Action install` | 无（不提权运行） | MSI 装入 `%LOCALAPPDATA%`、注册并启动 AtLogOn task、自动追加 `checkpoint=initial` 证据；**全程无 UAC** |
| 2 | `npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint wake` | 先让机器**睡眠**，再**唤醒** | 追加 `checkpoint=wake` 证据，task 仍 enabled、worker ready |
| 3 | `npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint login` | 先**注销**当前账号，再**登录**回来 | AtLogOn 自启拉起 task/worker，追加 `checkpoint=login` 证据 |
| 4 | `npm run prototype:phase5-windows-service-session -- -Action check -Checkpoint reboot` | 先**重启**，再**登录**回来 | AtLogOn 自启 + 持久状态保留，追加 `checkpoint=reboot` 证据 |
| 5 | `npm run prototype:phase5-windows-service-session -- -Action remove` | 无 | task 注销、payload 删除（`PER_USER_PAYLOAD_REMAINED` 不触发）；state/evidence 保留 |

> `install` 末尾会自动跑一次 `session-check initial`，因此 jsonl 的第一条一定是 `checkpoint=initial`。
> 每一步的 `check` 内部有 4 个硬断言（见 §4），任一失败脚本立即非零退出且**不追加该 checkpoint 证据**——缺哪一条就说明哪一段会话转换没通过。

---

## 4. 证据：`session-evidence.jsonl`

**路径**：`%LOCALAPPDATA%\AgentBean\DeviceServicePrototype\session-evidence.jsonl`
**格式**：每行一个 JSON 对象，`schemaVersion=1`（字段来源：`Program.cs` `SessionCheck`，行 103–124）。

```json
{
  "schemaVersion": 1,
  "checkpoint": "wake",
  "observedAtUtc": "2026-07-23T08:14:02.314Z",
  "approximateBootAtUtc": "2026-07-23T03:00:00.000Z",
  "host": {
    "os": "Microsoft Windows NT 10.0.22631.0",
    "arch": "X64",
    "userSid": "S-1-5-21-...",
    "isAdministrator": false
  },
  "task": {
    "enabled": true,
    "state": 4,
    "lastTaskResult": 0,
    "runningInstances": 1
  },
  "worker": { "Pid": 12345, "...": "..." }
}
```

### 字段对照表

| 字段 | Green 期望 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `1` | |
| `checkpoint` | `initial` / `wake` / `login` / `reboot` **四条齐全** | 缺任一即对应会话转换未验证 |
| `observedAtUtc` | 四条时间递增，跨度覆盖 sleep/logout/reboot | 证明是分多次、跨会话采集 |
| `approximateBootAtUtc` | `reboot` 条比 `login` 条**显著更新**；`wake`/`login` 条通常不变 | 由 `DateTime.UtcNow - TickCount64` 近似；reboot 后 `TickCount64` 重置，是"真的重启了"的强信号 |
| `host.arch` | `X64` | 非 X64 直接 `WINDOWS_X64_REQUIRED` |
| `host.userSid` | 四条一致（同一普通账号） | |
| `host.isAdministrator` | **`false`** | `true` 即降级为 Partial |
| `task.enabled` | `true` | |
| `task.state` | `3`（Ready）或 `4`（Running） | Task Scheduler `TaskState` 枚举 |
| `task.lastTaskResult` | `0` | `17` 等非零表示 action 异常退出（见设计红线） |
| `task.runningInstances` | `1` | `IgnoreNew` 单实例语义 |
| `worker` | `state` 含 `Pid`，且 ready | worker 正在响应 pipe |

### `SessionCheck` 的 4 个硬断言（`Program.cs` 行 97–100）

`check` 命令在写入 jsonl 前依次断言，任一失败即抛错、不写该行：

| 失败常量 | 触发条件 | 含义 |
| --- | --- | --- |
| `SESSION_TASK_DISABLED` | `task.Enabled` 为 false | task 被禁用 |
| `INTERACTIVE_TOKEN_MISSING` | Task XML 不含 `<LogonType>InteractiveToken</LogonType>` | 未按当前 SID 注册登录任务 |
| `IGNORE_NEW_MISSING` | Task XML 不含 `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancePolicy>` | 单实例策略丢失 |
| `SESSION_WORKER_NOT_READY` | 20 秒内 worker 未 ready | 平台适配器/worker 未起来 |

### 4.2 ACL 保持（人工 / 额外验证）

issue #676 要求 sleep/wake、logout/login、reboot/login 后「ACL」与状态/自启/日志并列保持。原型 `SessionCheck` **不采集 ACL**，故需操作员在每个 checkpoint 额外确认两点：

1. **Task 安全描述符**：仅当前用户 SID 可管理。查询（普通用户、不提权）：
   ```powershell
   (Get-ScheduledTask -TaskName 'AgentBean Device Service Prototype').Principal.UserId
   # 应等于当前账号；Task XML 的 Principals 仅含当前 SID
   ```
2. **命名管道 ACL**：worker 命名管道以 `CurrentUserOnly` 构造（`Program.cs` `PipeName` + `NamedPipeServerStream`），仅当前用户可连接。该属性在 worker 运行期间生效；真机可在 worker 响应时确认仅当前用户进程能连入（hosted standard-user job 已自动化验证此点）。

任一 checkpoint 若 ACL 退化为其他用户可管理 / 可访问，即不满足 Green（见 §5.2 第 5 条）。

---

## 5. Green / Partial / Red 判据矩阵

### 5.1 verdict 三态（hosted verify 流程的产物，仅供理解 Partial 语义）

原型 `verify` 命令（`Program.cs` `Verify()`，行 257–350；由 `npm run prototype:phase5-windows-service` 调用，**不是** `run-session.ps1`）会输出一个 verdict 字符串。三态（行 342–346）：

| 条件 | verdict 字符串 | 对 #676 |
| --- | --- | --- |
| `isAdministrator == true` | `hosted-admin-partial-needs-standard-user-session` | **Partial** |
| 非管理员 且 `GITHUB_ACTIONS == true`（hosted runner） | `hosted-standard-user-process-partial-needs-real-session-transitions` | **Partial** |
| 非管理员 且 非 hosted | `green-standard-user-session` | **Green 候选** |

> ⚠️ 注意：真机会话流程（§3 的 `run-session.ps1`）只调 `install` / `session-check` / `uninstall`，**不调用 `verify`，也不在 `session-evidence.jsonl` 写 verdict 字段**。因此 verdict 字符串不是 §3 序列的产物；真机 Green 判据以 §5.2 为准，不依赖 verdict。若仍想取得该字符串，需在**另一台**机器另跑一次 `npm run prototype:phase5-windows-service`（该命令是会卸载的 throwaway 流程，与 §3 的保留安装模式互斥）。

### 5.2 #676 关闭（Green）的充要条件

真机会话流程下，**全部**满足才可关 #676：

1. 四条 `checkpoint`（initial/wake/login/reboot）证据齐全，每条通过 §4 的 4 个硬断言；
2. 每条 `host.isAdministrator == false` 且 `host.arch == "X64"`；
3. `reboot` 条的 `approximateBootAtUtc` 比 `login` 条更新（证明真重启）；
4. `install` 全程**无 UAC** 弹窗（人工观察）；
5. **ACL 保持**：跨四个 checkpoint，task 安全描述符仍仅允许当前 SID 管理、命名管道仍为 `CurrentUserOnly`（见 §4.2，需操作员额外验证；原型 `SessionCheck` 不自动采集 ACL）。

### 5.3 明确不计 Green 的情况（Partial）

- GitHub-hosted `windows-latest`（`runneradmin`、`DisableMsi=1`）—— 无论怎么跑；
- alternate-credential token（无真实桌面会话，`task.lastTaskResult` 停在 `0x41303` / 267011）；
- Windows ARM64（UTM VM 等）；
- 管理员会话。

### 5.4 Red（失败）

任一硬断言抛错、`isAdministrator=true`、`install` 弹 UAC、或 ACL 退化为非 current-user-only，即为 Red，需按 §6 诊断后重跑。

---

## 6. 失败诊断

| 错误 / 现象 | 根因 | 处置 |
| --- | --- | --- |
| `WINDOWS_X64_REQUIRED` | ARM64 或非 Windows | 换 Windows 11 x64 机器 |
| `MACHINE_POLICY_DISABLE_MSI_1` / `MSI_INSTALL_FAILED_1625` | 机器策略 `DisableMsi=1` | **换策略允许的机器，不改策略** |
| `MSI_INSTALL_FAILED_1721` | MSI custom action 失败 | 不应出现：原型 MSI **不含** Task Scheduler custom action（见 §8）；若出现说明 `Package.wxs` 被改动，查原型分支 |
| `PROTOTYPE_ALREADY_INSTALLED` | 上次未 `remove` | 先跑 `-Action remove` |
| `PER_USER_PAYLOAD_MISSING` | MSI 装了但 exe 不在 `%LOCALAPPDATA%` | 查 `%LOCALAPPDATA%\AgentBean\DeviceServicePrototypeInstaller\install.log` |
| `MSI_UNINSTALL_FAILED_<code>` | `remove` 时 msiexec 失败 | 记录 code，查 install.log |
| `PER_USER_PAYLOAD_REMAINED` | `remove` 后 exe 仍在 | 卸载未清理干净，手动 `msiexec /x` |
| `SESSION_TASK_DISABLED` / `INTERACTIVE_TOKEN_MISSING` / `IGNORE_NEW_MISSING` / `SESSION_WORKER_NOT_READY` | `check` 的 4 个硬断言之一失败（定义见 §4） | 按对应常量定位；通常重新 `-Action install` |
| `task.lastTaskResult` 停在 `0x41303`（267011，never run） | alternate-credential token 无真实桌面会话 | 必须本人在真实桌面登录后重跑 |
| `lastTaskResult == 17` | action 非零退出 | 有界恢复应已由平台适配器处理；若反复出现查 `Supervise` 日志 |

---

## 7. 证据归档与回贴 issue

1. `remove` 后，证据与状态保留在 `%LOCALAPPDATA%\AgentBean\DeviceServicePrototype\`：
   - `session-evidence.jsonl`（**必附**，四条 checkpoint）
   - `outbox.jsonl` / `state.json` / `desired-state.json`（排空、持久状态与 `desired` 开关证据）
2. 回贴 #676 时建议附上：
   - 完整 `session-evidence.jsonl`（`userSid` 可脱敏为末四位，但保留 `arch` / `isAdministrator` / `task.*` / `approximateBootAtUtc`）；
   - 一句"`install` 全程无 UAC 弹窗"的人工观察；
   - 原型 verdict 字符串与原型 commit（`codex/phase5-windows-service-prototype` @ `e1164f3e`）。
3. **#670 数据保留边界**：原型 `remove` 只删 Task Scheduler 任务与 per-user payload；真实 profile / outbox / scan cache / 本地 Memory / workspace 数据不在本原型范围（原型 worker 是 throwaway，不持有真实 profile 数据）。生产卸载语义以 #670 合同为准。

---

## 8. 设计红线（不可违背，源自原型 README 与实测）

1. **原型不进生产、不实现真实 Device Service Supervisor**。它只为 #676 冻结 Task XML/COM 与两阶段停止合同。
2. **不改机器策略、不绕过 `DisableMsi`**。hosted standard-user job 用 `-SkipMsi` 直起平台适配器，而非绕过策略。
3. **MSI 不含 Task Scheduler custom action**。实测 MSI execute-sequence 注册/启动任务均失败 `1721`，故 MSI 只装 payload，task 由交互式调用方在 `msiexec` 返回后注册并启动。
4. **有界恢复归平台适配器所有**。Task Scheduler `RestartOnFailure` XML 虽写 5 次/`PT1M`，但实测记录 `LastTaskResult=17` 后并不重启 action，仅作调度器级兜底。
5. **两阶段停止顺序不可乱**：`desired=disabled`（先让平台适配器停重启）→ 排空 + durable outbox fsync → worker clean exit → Scheduler `Enabled=false` + `Stop(0)` 兜底。先设 Scheduler 位会让运行实例消失、无法继续 IPC drain。
6. **强制清理走 Job Object**：`IRegisteredTask::Stop(0)` 不保证清理 action 子进程树，故 Supervisor/Runner 必须放进 `KILL_ON_JOB_CLOSE` Job Object。

---

## 9. 关联与下游影响

- 关闭 #676（Green）后，方可解锁下游 **#666**（签名更新通道、原子切换与自动回滚协议）。
- #676 是 #673（三平台生产验收与 Legacy 退场门禁矩阵）的输入之一。
- 原型 CI：`.github/workflows/phase5-windows-service-prototype.yml`（两个 job：`hosted-runner-partial`、`hosted-standard-user-process`）。
