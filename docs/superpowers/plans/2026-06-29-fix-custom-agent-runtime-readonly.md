# 修复:自定义 Agent 配置对话框「Code Agent 运行时 / 项目目录」永远只读

> 状态:实施中(worktree 隔离重做) · 分支:`worktree-device-islocal-readonly` · 日期:2026-06-29

## Context（为什么改）

用户报告:自定义 Agent 配置对话框中「Code Agent 运行时」select 和「项目目录」input 永远只读。

**根因**:server-next 迁移时遗漏 device DTO 的 `isLocal` 字段下发。web-next `devices/page.tsx:410` 用 `device.isLocal === true` 判定本地设备,该值恒 `undefined` → `canEditDeviceSettings`(page.tsx:769)恒 `false` → runtime select(1356)与项目目录 input(1370)对所有设备永远 disabled。

**证据链**:legacy `apps/server` 正常——web 在 `lib/socket.ts:180` 上报 `currentDeviceId`,legacy `index.ts:629-636` 算 `isLocal` 并下发(769),还在 `updateAgentConfig` 二次校验(2359)。server-next 整条链缺失。

**范围（已定）**:完整对齐 legacy——既下发 `isLocal`,又补服务端二次校验。前端 web-next 无需改动。

## 方案

让 `currentDeviceId` 从 web socket 透传到 device DTO,算 `isLocal`;并在 `updateAgentConfig` 加服务端校验。

### 第 1 层 contracts（`packages/contracts/src/device.ts:35`）
`DeviceDto` 加 `isLocal?: boolean;`。

### 第 2 层 传输层
- `socket-server.ts`:新增 `socketCurrentDeviceId(socket)`(同 `socketAuthToken` 模式);`createAuthenticatedUserResolver` 三处 cached 补 `currentDeviceId`;`ChannelSubscription` 加 `currentDeviceId?`;`asChannelSubscription` 返回补 `currentDeviceId`。
- `socket-handlers.ts`:`AuthenticatedUserIdentity` 加 `currentDeviceId`;`withAuthenticatedUserId` 两个 enriched 分支注入 `currentDeviceId`。

### 第 3 层 应用层（`usecases.ts`）
- 新增 `isDeviceLocalToHint(device, currentDeviceId)`:匹配 `id`/`canonicalDeviceId`/`machineId`,fail-closed。
- `toDeviceDto(device, currentDeviceId?)` 等透传;`currentDeviceId !== undefined` 时下发 isLocal(daemon/admin 不下发)。
- 调用点透传:listDevices(1428)/getDevice(1511)/renameDevice(1534)/deleteDevice(1567)。daemon/admin 路径不透传。
- usecase input 类型(listDevices/getDevice/renameDevice/deleteDevice)加 `currentDeviceId?: string | null`。
- `updateAgentConfig`(1802 isCustom 分支顶部)加校验:`includesRuntimeSettings = adapterKind|command|cwd|runtimeId`,`!isLocalDevice` → `FORBIDDEN_REMOTE_DEVICE_SETTINGS`。runtimeId 是 server-next 独有,必须纳入。

### 第 4 层 前端 web-next
无需改动。

## TDD 测试（`apps/server-next/tests/device-management.test.ts`）
- listDevices:匹配 currentDeviceId → isLocal=true;不匹配 → false;无 currentDeviceId → false
- getDevice isLocal 随 currentDeviceId
- updateAgentConfig:远程改 adapterKind → FORBIDDEN_REMOTE_DEVICE_SETTINGS;本地改 → ok;远程改 name(非 runtime)→ ok

## 验证
`npx vitest run apps/server-next/tests/device-management.test.ts` + 全量回归 + 重启三服务 UI 验证。

## Critical Files
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/transport/socket-handlers.ts`
- `apps/server-next/src/transport/socket-server.ts`
- `packages/contracts/src/device.ts`
- `apps/server-next/tests/device-management.test.ts`
