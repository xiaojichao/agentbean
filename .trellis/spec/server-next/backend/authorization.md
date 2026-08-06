# 授权：route() 二次读 / 频道可见性 / 设备归属

## 何时适用

改 PI 管理路由、频道读访问校验、或设备写操作鉴权时。这三处是 server-next 最易引入安全回归的地方，各有专门的防线，不能合并或短路。

## 本地模式

### route() 二次读策略 + crossedBarrier 防双投递

PI 管理路由在 `src/application/management/management-router.ts`。`route()`（:217）做**两次**策略读取以防桥接自动升级路径上的双投递：

1. 第一次：`routeRequest(input)`（:218），用内存中的 `policy.placementPolicy`。
2. 若结果 `kind === 'unavailable'` 且**没有**越过 barrier（`:222` 的 `!result.crossedBarrier`），则**重读存储** `policyForTeam(input.teamId)`（:223）。
3. 若存储策略为 `direct`（:224），回落到 `{ kind: 'direct' }`（:225）；否则保持 unavailable。

`crossedBarrier` 是这条路径上**防双投递的唯一防线**：

- 类型定义：`src/application/management/management-router.ts:96`（`{ kind: 'unavailable'; mode: 'managed'; crossedBarrier?: true }`）
- 置位点（run 已创建后置位）：`:407` 与 `:476`（`return { kind: 'unavailable', mode: 'managed', crossedBarrier: true, ... }`）
- 闸门判断：`:222`（`if (result.kind !== 'unavailable' || result.crossedBarrier) return result;`）

逻辑（:219-:221 注释）：#724 桥接是自动升级，团队从未显式切到 managed；barrier 前的 unavailable 必须回落到 direct，barrier 后绝不回退。显式配置 managed 的团队保持 fail-closed。

**这条二次读不能短路、不能合并成一次读。** 历史回归 #836/#845 都源于此。

### 频道可见性：ensureUserCanViewChannel

共享 helper `ensureUserCanViewChannel` 在深模块 `src/application/channel-access.ts:17`。它只校验**读可见性**，返回 `NOT_FOUND`（频道不存在或不属于该 team）或 `FORBIDDEN`（私有频道且用户非成员），从不授予写权限（:15 注释 `_Avoid_: ...写授权`）。

god-interface 中 14+ 调用点（`src/application/usecases.ts`）：

- `:7214`、`:7241`、`:7253`、`:7269`、`:7415`、`:7437`、`:7464`（文档相关）
- `:7534`、`:7577`、`:7630`、`:7706`（频道消息相关）
- `:7739`、`:7759`、`:8165`（项目相关）

import 在 `src/application/usecases.ts:291`。每个读频道内容的入口都要过这个 helper。

### 设备归属：canManageDeviceAsUser

设备写操作（改名/删除/扫描/配 agent）必须过 `canManageDeviceAsUser`：

- 定义：`src/application/usecases.ts:18925`（`async function canManageDeviceAsUser(...)`）
- 调用点：`:4216`（管理）、`:4230`（改名）、`:4253`（删除）、`:4301`（扫描）、`:4518`（配 agent）、`:4667`（agent 配置更新）

规则：仅设备拥有者或 admin 可管理（详见 「设备/Agent 修改授权边界」memory）。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/application/management/management-router.ts`（:217 route、:218 routeRequest、:222 闸门、:223 重读、:96 类型、:407/:476 crossedBarrier 置位、:219-:221 注释）
- `/Users/shaw/AgentBean/apps/server-next/src/application/channel-access.ts`（:17 ensureUserCanViewChannel、:23/:26 NOT_FOUND/FORBIDDEN）
- `/Users/shaw/AgentBean/apps/server-next/src/application/usecases.ts`（:291 import、:18925 canManageDeviceAsUser、:4216/:4230/:4253/:4301/:4518/:4667 调用、14+ ensureUserCanViewChannel 调用点）

## 反模式

- **route() 合并成一次读**：桥接路径双投递回归（#836/#845）。
- **在 crossedBarrier 置位前就 return**：barrier 后仍可能被上层降级成 direct。
- **用 ensureUserCanViewChannel 当写授权**：它只校验读可见，不授写（:15 注释）。
- **设备写操作跳过 canManageDeviceAsUser**：越权改他人设备。
- **DTO readonly 当运行时不可变**：见 gotchas.md（detachPolicy 防御拷贝）。

## 验证命令

```bash
cd /Users/shaw/AgentBean/apps/server-next
# route() 二次读仍在
grep -n "policyForTeam(input.teamId)" src/application/management/management-router.ts
# crossedBarrier 闸门与置位点齐全
grep -n "crossedBarrier" src/application/management/management-router.ts
# 频道可见性调用点
grep -c "ensureUserCanViewChannel" src/application/usecases.ts
# 设备写操作都过了归属校验
grep -n "canManageDeviceAsUser" src/application/usecases.ts
```
