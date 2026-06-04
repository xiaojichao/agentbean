# Agent 身份与去重规则

Agent identity 是重写中的高风险部分。目标实现必须在 domain/contracts 层只定义一次身份规则，并在 server、web 与 daemon-facing code 中复用。

当前实现提供了有用经验，但重写版不应保留重复的 client/server dedupe logic。Server domain code 应决定 identity 与 visibility。Web 只渲染 server snapshots。

## 术语

- **Device**：已注册的 daemon endpoint。一个 device 可能有 `deviceId`、`machineId` 和 `profileId`。
- **Runtime**：device 上的一种可执行能力，例如 Codex、Claude Code 或 Kimi CLI。
- **Discovered agent**：由 scanner 或 AgentOS gateway 上报的类 agent 条目。
- **Custom agent**：用户创建的 agent config，绑定到 device、runtime、command、cwd、args 与 env。
- **AgentOS gateway**：Hermes 或 OpenClaw 这类 connector，可能暴露一个或多个 hosted agents。
- **Logical agent**：用于 persistence、channel membership、dispatch、publication 与 UI display 的规范 domain identity。
- **Visible agent**：logical agent 在某个可见 network 中的 projection。

## 规范化

所有身份比较都必须在 key generation 前规范化输入。

| 字段 | 规范化 |
|---|---|
| `networkId` | Network lookup 后的精确 canonical ID。不要用 network name/path 比较。 |
| `deviceId` | Canonical registered device ID。如果 `machineId + profileId` 映射到已有 device，应先调和 device identity，再做 agent dedupe。 |
| `adapterKind` | 转小写，把 `_` 和空格替换为 `-`；aliases：`claude` -> `claude-code`，`codex-cli` -> `codex`，`kimi` -> `kimi-cli`。 |
| `name` | Trim、转小写、把 spaces/underscores 折叠为 `-`，去掉重复 separators 作为 identity。必要时单独保留 display casing。 |
| `command` | Trim 并规范化 slashes 用于比较。已知平台/文件系统大小写规则时应用规则；不要在 case-sensitive filesystems 上盲目转小写。单独保留 display value，并存储 normalized comparison key。 |
| `cwd` | Trim、规范化 slashes、移除 trailing slash，并在已知时应用平台/文件系统大小写规则。单独保留 display value，并存储 normalized comparison key。 |
| `args` | 转换为 string array，移除空 args，使用无歧义 separator join 后比较。 |
| `gatewayId` / `gatewayName` | 优先使用 gateway 提供的 stable gateway instance ID。没有显式 ID 时 fallback 到 normalized gateway name，再 fallback 到 normalized endpoint/command。 |
| `source` | `custom`、`self-register`、`scanned` 之一。 |
| `category` | `executor-hosted`、`agentos-hosted` 之一。 |

Path comparison rules：

- Linux 与其他已知 case-sensitive filesystems 在 comparison keys 中应保留大小写。
- Windows 应以 case-insensitive 方式比较 paths。
- macOS 应尽可能使用检测到的 filesystem behavior；只有已知位于默认 case-insensitive volume 的 local paths 才默认 case-insensitive。
- 如果 platform/filesystem behavior 未知，优先使用 case-sensitive comparison，避免意外合并。
- 同时存储 original display paths 与 normalized comparison keys。

## Identity Key 规则

使用第一条适用规则。`primaryNetworkId` 表示 agent 所属 network。Published networks 是 visibility projections，不是新 identities。

| Agent 输入 | 何时是同一个 Logical Agent | 不要合并的情况 | Canonical ID 策略 |
|---|---|---|---|
| Existing persisted custom agent | 相同 persisted `agentId`。 | 不同 `agentId`，即使 name/runtime 匹配。Custom agents 是用户创建的 configs。 | Server-issued `agentId`。 |
| New custom agent create request | 绝不只按 name 自动合并。可选择按 device/network 拒绝重复 name 作为 validation，但不要静默合并。 | Existing custom agent with different ID。 | 新 server-issued `agentId`。 |
| Custom agent runtime availability | 在同一 `deviceId` 上按 compatible adapter/command 匹配 runtime；这是链接 availability，不是 identity。 | Runtime 属于不同 device 或 incompatible adapter。 | 保持 custom `agentId`；单独存储 runtime match。 |
| Self-registered agent with stable server-known ID | 相同 `agentId`。 | Same name 但 different device/network，且没有 reconciled device identity。 | 复用 `agentId`。 |
| Self-registered agent without trusted ID | 相同 `primaryNetworkId + deviceId + adapterKind + normalizedName`。 | Different device、different primary network、different adapter kind。 | Server 可分配 canonical ID 并记住 source linkage。 |
| Scanned AgentOS hosted concrete agent | 相同 `primaryNetworkId + deviceId + adapterKind + normalizedName`，且 name 不是 generic gateway name。 | Different device、network、adapter 或 concrete name。 | Stable derived ID 或 existing canonical ID。 |
| Scanned AgentOS generic gateway entry | 相同 `primaryNetworkId + deviceId + adapterKind + gatewayInstanceKey`。 | 不应把 distinct non-generic name 的 concrete hosted agent 折叠进 generic display identity。同一 device 上不同 gateway instances 不能合并。 | Stable gateway ID；UI 中可隐藏在 concrete agents 后面。 |
| Scanned executor runtime | 相同 `primaryNetworkId + deviceId + adapterKind + runtimeLocation + args`。 | 不要把它当作 product agent。它只是 capability，除非用户创建/绑定 custom agent。 | Runtime ID 或 runtime record，而不是 agent ID。 |
| Published agent visible in another network | 相同 source `agentId`；通过 publication 进入 `visibleNetworkId` 可见。 | 为 target network 创建第二条 agent row。 | 保持原始 `agentId`，添加 publication record。 |
| Same name on different devices | 不是同一个 logical agent。 | Device reconciliation 证明两个 device IDs 是同一 physical/profile identity。 | 除非先合并 device reconciliation，否则使用独立 IDs。 |
| Same device/name across different primary networks | 不是同一个 logical agent。 | 这是同一个 original agent publish 到另一个 network。 | 按 primary network 使用独立 IDs；publication 保留 original ID。 |

## Source 优先级

当多条 records 解析到同一个 logical agent 时，保留一个 canonical identity，并按以下优先级合并 fields。

### Display 与 Configuration 优先级

除非字段为空，否则更高行拥有 display/config fields。

| Rank | Source | 可拥有的字段 |
|---|---|---|
| 1 | User-edited custom agent config | `name`、`description`、`command`、`args`、`cwd`、`env`、`ownerId`、publication intent。 |
| 2 | Self-registered agent | `name`、`role`、`adapterKind`、`category`、live socket identity、更丰富的 non-scan display info。 |
| 3 | Concrete AgentOS hosted scan | `name`、`adapterKind`、`category`、gateway-backed execution metadata。 |
| 4 | Generic AgentOS gateway scan | Connector availability 与 gateway status。不应替换 concrete hosted agent display。 |
| 5 | Runtime scan | 仅 runtime availability。不应创建或覆盖 product agent display。 |

规则：

- Scan 不得覆盖 user-edited custom agent 的 name、description、env、cwd、command 或 args。
- `hermes-agent` 或 `openclaw-agent` 这类 generic gateway entry 不得覆盖 concrete hosted agent name。
- 如果 self-register event 与现有 scanned AgentOS identity 拥有相同 logical key，它可以更新 live status 与 socket binding。
- Scan 可以刷新 `lastSeenAt`、runtime command availability 以及 category/source evidence。
- Missing scan 会把 scanned/gateway availability 标为 offline；不得删除 custom agent config 或 publication records。

### Status 优先级

Status 独立于 display/config 合并。较低 display-rank 的 record 仍可提供最新 status。

Status merge order：

1. 按 status source 分组 status events，例如 daemon connection、gateway scan、dispatch lifecycle、heartbeat timeout 或 manual/config event。
2. 每个 source 内，如果有 monotonic sequence，只保留最新 event；否则按 `lastSeenAt`/event timestamp 保留最新。
3. 按 timestamp 合并每个 source 的最新 events。较新的 events 胜过较旧 events，即使旧 event 的 status rank 更高。
4. Status priority 只用于打破 same-timestamp 或 same-batch conflicts。

| Rank | Status |
|---|---|
| 1 | `busy` |
| 2 | `online` |
| 3 | `connecting` |
| 4 | `error` |
| 5 | `offline` |

Tie breakers：

1. 只有在 per-source compaction 后 events 来自同一 timestamp/batch 时，才优先选择 status rank 最高的 event。
2. 只保留产生 `error` 的 status source 的 `lastError`，或保留最近一次 failed dispatch 的 `lastError`。
3. 不允许任何较旧 event 覆盖较新 event。例如旧 `busy` 不得覆盖较新的 `offline`、`online` 或 `error`。
4. Heartbeat timeout 可以产生 `offline`，但必须携带比 last successful heartbeat 更新的 timestamp/sequence 才能生效。

## 冲突解决表

| 冲突 | 解决方案 |
|---|---|
| Scan reports `scan-{device}-{name}`，但同 device/name/network 已存在 self-register。 | 保留 self-register canonical ID；删除或 alias stale scan ID；只在允许字段上把 scan metadata 更新到 canonical record。 |
| AgentOS gateway 先报告 generic `hermes-agent`，随后报告 concrete `Reviewer`。 | 如有需要内部保留两个 identities，但 visible list 应优先 concrete hosted agent。Generic gateway 可作为 connector/device capability。 |
| 同一 device 与 adapter 上报两个 gateway instances。 | 除非 `gatewayInstanceKey` 匹配，否则不要合并。先用 gateway ID，再用 gateway name，再用 endpoint/command-derived key。 |
| Custom agent 与同 device 上 scanned AgentOS agent 同名。 | 不自动合并。Custom agent 是 user config。如有混淆，validation 可要求用户重命名。 |
| Custom agent command 指向 scanned runtime。 | 把 custom agent 关联到 runtime availability；不要合并 identities。 |
| 同一 agent name 出现在两个 devices 上。 | 分成两个 logical agents。 |
| 同一 device 以新 `deviceId` 出现，但 `machineId + profileId` 相同。 | 先调和 device；再在 canonical device ID 下做 agent dedupe。 |
| 同一 agent publish 到另一个 network。 | 相同 `agentId`；添加 visible projection/publication。不要 clone。 |
| Scan 漏掉先前 scanned agent。 | 将 scanned/gateway identity 标为 offline。显式 cleanup 之前，不移除 channel membership、history 或 publications。 |
| 用户在 daemon scan stale 时编辑 custom agent config。 | 用户编辑赢得 config；runtime availability 在 daemon reconnect/scan 后更新。 |
| Adapter aliases 不同（`codex-cli` vs `codex`）。 | 规范化并比较 canonical adapter kind。 |
| Adapter kinds 确实不同但 names 匹配。 | 除非存在经过测试的特定 adapter bridge rule，否则不要合并。 |

## 字段归属

| 字段 | Owner |
|---|---|
| `id` | Server identity service。 |
| `primaryNetworkId` | Creation/persistence use case。 |
| `publishedNetworkIds` | Agent publication use cases。 |
| `ownerId` | Creation/ownership use cases。 |
| `name` | User config 或最高 display precedence source。 |
| `description` | User config。 |
| `adapterKind` | Custom agent 来自 user config；discovered hosted agents 来自 daemon/gateway report。 |
| `category` | 从 source report 得出的 domain classification，由 server 规范化。 |
| `source` | Server 根据 creation/report path 推导。 |
| `deviceId` | Device registration 与 agent report。 |
| `command`、`args`、`cwd`、`env` | Custom agent 来自 user config；discovered/gateway metadata 来自 scan report。 |
| `status`、`lastSeenAt`、`lastError` | Live registry/dispatch/heartbeat events。 |
| `channelMembership` | Channel use cases。 |
| `runtimeAvailability` | Daemon runtime reports。 |

## 目标 Domain API

重写版应把 identity 实现为 pure functions 加一个小 service：

```ts
type AgentIdentityKey =
  | { kind: "custom"; agentId: string }
  | { kind: "self-register"; networkId: string; deviceId: string; adapterKind: string; name: string }
  | { kind: "agentos-concrete"; networkId: string; deviceId: string; adapterKind: string; name: string }
  | { kind: "agentos-gateway"; networkId: string; deviceId: string; adapterKind: string; gatewayInstanceKey: string }
  | { kind: "runtime"; networkId: string; deviceId: string; adapterKind: string; location: string; argsKey: string };

function normalizeAgentIdentityInput(input: AgentIdentityInput): NormalizedAgentIdentityInput;
function identityKeysFor(input: NormalizedAgentIdentityInput): AgentIdentityKey[];
function resolveAgentMerge(existing: AgentRecord[], incoming: AgentReport): AgentMergeDecision;
function mergeAgentRecords(display: AgentRecord, status: AgentRecord): AgentProjection;
```

`runtime` keys 应用于 runtime availability 与 custom-agent binding，不应用来创建 visible product agents。

## 必需测试

第一版 contracts/domain package 应包含这些测试：

- 同一 `networkId + deviceId + name` 下，self-register 胜过 scan-prefix duplicate。
- Concrete AgentOS hosted agent 在 display 上胜过 generic gateway。
- 同一 device 上多个 same-adapter AgentOS gateway instances 不合并，除非 `gatewayInstanceKey` 匹配。
- Generic gateway status 可以展示 connector availability，但不替换 concrete agent display。
- Custom agent 不与 scanned runtime 合并。
- Linux path comparison 保留大小写；Windows path comparison 大小写不敏感；unknown filesystem behavior 默认大小写敏感。
- Custom agent config 不会被 daemon scan 覆盖。
- 较新的 `offline` 或 `online` status 胜过较旧的 `busy`；status rank 只打破 same-batch conflicts。
- Runtime availability 关联到同一 device 且 compatible adapter 的 custom agent。
- 两个 devices 上同名 agent 产生两个 logical agents。
- 同一 device 用相同 `machineId + profileId` 重新连接时，先 reconcile 再 dedupe。
- Published agent 在 visible networks 中保持相同 ID。
- Missing scan 把 scanned agent 标为 offline，但不删除 memberships/history。
- Adapter aliases 会被规范化。
- 不同 adapter kinds 的同名 agent 不合并。

## 实现位置

- 将这些规则放在 server/domain 或 shared contracts/domain 中。
- 除稳定 list rendering 外，Web 不得实现自己的 agent dedupe。
- Daemon 可以规范化 adapter/runtime reports，但 server 仍是 identity 的权威。
- 持久化 canonical identity decisions，确保 reconnects 不依赖 in-memory ordering。
