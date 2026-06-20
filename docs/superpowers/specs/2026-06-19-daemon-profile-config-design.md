# daemon-next 多 profile + YAML 配置 设计

- 日期：2026-06-19
- 范围：`apps/daemon-next`（纯 daemon 侧，server-next/contracts 零改动）
- 关联：`agentbean-next/docs/known-gaps.md`（daemon 配置/profile 缺口）

## 1. 背景与目标

原版 `apps/daemon` 有完整的 profile/auth-store/YAML 机制；daemon-next 收敛时全部缺失——**每次启动都要 invite 或传 `--team-id`/`--owner-id`**，invite 拿到的 token 仅存内存、重启即丢；无多 team、无配置文件。

本设计完整补全（用户选定 scope）：
1. **token 持久化**：invite 完成后存 token，下次启动自动加载（免重复 invite/传参）。
2. **多 profile**：`listAuthProfiles` + `--all-profiles`，一个 daemon 连多 team 并发。
3. **YAML 配置**：配置文件 + `${VAR}` env 插值。

### 成功标准

- 首次 `--invite-code` 完成后，token/teamId/ownerId 持久化；下次启动无需 invite/team-id/owner-id（自动加载）。
- `--all-profiles` 列出已存 profile，为每个并发启动独立连接。
- 支持 `--config <path>` 加载 YAML（含 `${VAR}` 插值），配置优先级 CLI args > env > YAML > 默认。
- server-next/contracts 零改动。

## 2. 基线

### 2.1 原版 apps/daemon（参考）
- **auth-store**（`auth-store.ts`）：`~/.agentbean/teams/{profileId}/auth.json`；`AuthData { token, serverUrl, userId?, networkId? }`；`loadAuth/saveAuth/clearAuth/listAuthProfiles`。
- **profile-paths**（`profile-paths.ts`）：`profileRoot(profileId)`/`authFile`/`scanCacheFile`；`profileId = slugify(networkId)`。
- **--all-profiles**（`index.ts:194-210`）：`listAuthProfiles()` → `Promise.all(profiles.map(startDeviceDaemon))`，每 profile 独立 socket/scan 缓存。
- **YAML config**（`config.ts`）：`AgentConfig`/`DeviceConfig`；`ENV_PATTERN=/\$\{([A-Z0-9_]+)\}/g` + `deepInterpolate`；`loadConfig`/`loadDeviceConfig` + 字段验证。
- **invite → profile**：invite 完成 → token + networkId → `profileId = slugify(networkId)` → `saveAuth`。

### 2.2 daemon-next 现状（缺口）
- `cli.ts` `parseDaemonNextCliConfig`：config 来自 argv/env；`profileId`（默认 `default`）仅标识、**无持久化**。
- `runDaemonNextCli`：每次 `--team-id`/`--owner-id` 或 `--invite-code`；invite 的 token 仅内存（`device.token`）。
- **无 auth-store、无 profile-paths、无 YAML、无 env 插值、无 --all-profiles**。

## 3. 设计决策

| 决策 | 选定 | 理由 |
|------|------|------|
| scope | 完整（token 持久化 + 多 profile + YAML + env 插值） | 用户选定；对齐原版 |
| profileId 来源 | `slugify(teamId)`（invite 后）或 config `profileId`（默认 `default`） | 对齐原版 networkId slugify；daemon-next 用 teamId |
| auth 存储路径 | `~/.agentbean/teams/{profileId}/auth.json` | 对齐原版 + 与 #303 scan-cache 同根（`teams/{profileId}/`） |
| AuthData | `{ token, serverUrl, teamId, ownerId }` | daemon-next 需要 teamId/ownerId（announce hello） |
| 配置优先级 | CLI args > env > YAML > 内置默认 | 对齐常见约定；CLI 显式覆盖 |
| YAML 字段 | serverUrl/teamId/ownerId/profileId/machineId/hostname/fallbackPrefix（daemon-next config 子集） | 对齐 DaemonNextCliConfig；不引入原版 AgentConfig/adapter（daemon-next custom agent 走 server 配置） |
| env 插值 | `${VAR}`，缺失抛错（对齐原版） | 显式失败优于静默空值 |
| --all-profiles | `listAuthProfiles()` → 并发 `runDaemonNextCli` 每 profile | 对齐原版；每实例独立 socket/scan |

## 4. 架构

### 4.1 新增模块

- **`profile-paths.ts`**：`profileRoot(profileId)`/`authFile(profileId)`（`~/.agentbean/teams/{sanitized profileId}/`）；`sanitizeProfileId`（与 #303 scan-cache.ts 的 sanitize 一致，rebase 时统一）。
- **`auth-store.ts`**：`AuthData { token, serverUrl, teamId, ownerId }`；`loadAuth({profileId, baseDir?})`/`saveAuth(data, {profileId, baseDir?})`/`clearAuth`/`listAuthProfiles({baseDir?})`（扫 `teams/*/auth.json`）。
- **`config.ts`**：`loadYamlConfig(path): Partial<DaemonNextCliConfig> | null`（YAML 解析 + `deepInterpolate` `${VAR}`）；可选依赖 `js-yaml`（或最小自实现——见风险）。

### 4.2 cli.ts 接入

- **`parseDaemonNextCliConfig`**：开头加载 YAML（若 `--config` 或默认路径存在）作底层默认；合并优先级 CLI > env > YAML > 默认。
- **`runDaemonNextCli`**：
  - 开头：若 `--all-profiles` → `listAuthProfiles()` → 并发 `runDaemonNextCli` 每 profile（递归，allProfiles=false）→ return。
  - 否则：若 `--invite-code` → 走 invite → `saveAuth({token, serverUrl, teamId, ownerId}, {profileId=slugify(teamId)})`。
  - 否则（无 invite）：`loadAuth({profileId})` → 用 saved token/teamId/ownerId（覆盖 config 的空值）。
- **config 字段**：`DaemonNextCliConfig` 加 `allProfiles?: boolean`、`configPath?: string`。

### 4.3 profileId 与 invite

- invite 完成 → credentials（teamId/ownerId/token）→ `profileId = config.profileId ?? slugify(teamId)` → `saveAuth`。
- 下次启动：`loadAuth({profileId})` 命中 → 用 saved（免 invite/team-id/owner-id）。
- `--all-profiles`：扫所有 `teams/*/auth.json` → 每 profile 一个实例。

## 5. 数据流

```
parseDaemonNextCliConfig
  └─ loadYamlConfig(--config 或默认) → 底层默认
  └─ 合并:CLI args > env > YAML > 默认

runDaemonNextCli(config)
  ├─ config.allProfiles?
  │    └─ listAuthProfiles() → Promise.all(profiles.map(p => runDaemonNextCli({...config, profileId:p, allProfiles:false}))) → return
  ├─ config.inviteCode?
  │    └─ waitForDeviceInviteCredentials → saveAuth({token,serverUrl,teamId,ownerId}, {profileId=slugify(teamId)})
  ├─ else: loadAuth({profileId}) → 用 saved token/teamId/ownerId(覆盖空值)
  └─ createDaemonProtocolClient(...).start()
```

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| auth.json 损坏/缺失 | loadAuth 返回 null，回退要求 invite/team-id |
| `--all-profiles` 无已存 profile | 报错退出（对齐原版） |
| YAML `${VAR}` 缺失 env | 抛错（对齐原版 `config references missing env var`） |
| YAML 文件不存在/损坏 | 忽略（回退 CLI/env/默认） |
| invite 失败 | 不 saveAuth，报错 |
| 多实例（--all-profiles）某 profile 连接失败 | 独立 catch，不拖垮其他（对齐原版 Promise.all） |
| profileId sanitize | 路径穿越防护（sanitize 非法字符→`-`） |

## 7. 测试策略（vitest）

- **profile-paths**：sanitize、authFile 路径、baseDir 覆盖。
- **auth-store**：save/load round-trip、损坏返回 null、listAuthProfiles 扫多 profile、clear、baseDir 隔离。
- **config(YAML)**：loadYamlConfig（valid/缺失/损坏）、`deepInterpolate` `${VAR}`（命中/缺失抛错/嵌套）、优先级合并（CLI>env>YAML>默认）。
- **cli**：parseDaemonNextCliConfig 合并 YAML；runDaemonNextCli token 持久化（invite→save→下次 load）、--all-profiles 并发（mock listAuthProfiles + runDaemonNextCli）、loadAuth 命中免 invite。

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| `apps/daemon-next/src/profile-paths.ts` | 🆕 `profileRoot`/`authFile`/`sanitizeProfileId` |
| `apps/daemon-next/src/auth-store.ts` | 🆕 `loadAuth`/`saveAuth`/`clearAuth`/`listAuthProfiles` |
| `apps/daemon-next/src/config.ts` | 🆕 `loadYamlConfig` + `deepInterpolate` |
| `apps/daemon-next/src/cli.ts` | ✏️ parseDaemonNextCliConfig 合并 YAML；runDaemonNextCli token 持久化 + --all-profiles + loadAuth |
| `apps/daemon-next/tests/*.test.ts` | 🆕 各模块 + cli 集成测试 |
| `packages/contracts` / `apps/server-next` | **零改动** |

## 9. 非目标（out of scope）

- 原版 `AgentConfig`/`DeviceConfig` 的 adapter 定义（daemon-next custom agent 走 server 配置，不在本地 YAML 定义 agent）。
- auth token 刷新/续期（第一版用 invite 拿到的 token，过期重新 invite）。
- profile 删除/重命名 CLI（第一版手动删 `~/.agentbean/teams/{profileId}/`）。

## 10. 风险与待验证

- **YAML 依赖**：原版用 `js-yaml`？需确认 daemon-next 是否已有/需新增依赖。若不想加依赖，可用最小 YAML 子集解析（仅 key:value 平铺）或改用 JSON 配置。**待确认**：daemon-next package.json 是否已有 yaml 解析能力，否则决策"加 js-yaml 依赖" vs "JSON 配置" vs "最小 YAML"。
- **与 #303 冲突**：#303 新增 `scan-cache.ts`（`scanCachePath` 用 `teams/{profileId}/`）；本 feature `profile-paths.ts`/`auth-store.ts` 同根。rebase 时统一 sanitize/path 逻辑（profile-paths 作为单一来源，scan-cache 引用它）。cli.ts 改动段不同（profile 在 parseConfig/runDaemonNextCli 开头；#303 scan 在 runDaemonNextCli 中段），冲突小。
- **profileId vs teamId**：daemon-next announce hello 需要 teamId/ownerId（AuthData 存它们）。原版 AuthData 存 networkId（=teamId 概念）。需确认 invite credentials 返回 teamId/ownerId（cli.ts 现状：credentials.teamId/ownerId/token，已确认）。
- **--all-profiles 并发资源**：N 个实例 = N 个 socket + N 个定时器（rescan/heartbeat）。第一版对齐原版（Promise.all），不做连接池。
