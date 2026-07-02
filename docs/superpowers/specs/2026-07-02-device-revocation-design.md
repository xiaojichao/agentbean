# 设备吊销（Device Revocation）设计：防止离线删除后重连复活

**日期**: 2026-07-02
**状态**: Draft
**关联**: PR#380（层1 在线踢出）、memory `agentbean-device-delete-daemon-not-stopped`

## 1. 问题陈述

层1（PR#380）已解决**在线**设备删除：web 删除 → server 向整组别名 daemon 发 `device:removed` → daemon 收到后 `disconnect() + exit(0)`。

但**离线**设备删除存在复活漏洞：

- 删除时 daemon 不在线（断网/关机/进程未跑），server 无 socket 可通知
- `deleteDevice`（usecases.ts:1564）对整组别名**物理删除** DB 记录
- daemon 的 `reconnection: true`（cli.ts:678）自动重连
- 重连时 `deviceHello`（usecases.ts:1389）`upsertHello({ id: existing?.id ?? ids.nextId() })`，因设备已删 `findByMachineProfile` 返回 null，**用全新 id 重建记录**，status='online' → 设备复活

**根因**：删除是可逆的——只删了"当前状态"（DB 记录），server 没记住"这机器曾被删"，daemon 重连只凭 `machineId+profileId` 凭证即可重建。

## 2. 目标 / 非目标

**目标**

- 离线设备删除后，daemon 重连不再复活（deviceHello 拒绝）
- 在线删除（层1）行为不回归，且增强为双保险
- 重新走 invite 接入同机器不被阻断

**非目标（YAGNI）**

- undelete / 回收站（删除即永久）
- 吊销表 TTL / 自动清理（永久保留；invite 清除是唯一删除路径）
- 吊销管理 UI

## 3. 产品决策

1. **不支持 undelete**：删除即永久，需恢复走重新 invite。
2. **可重新接入**：重新 invite 同 machineId 时清除该机器吊销记录。

## 4. 方案：device_revocations 吊销表

### 4.1 数据模型

migration `apps/server-next/src/infra/sqlite/migrations/global/0010_device_revocations.sql`（注：0009 已被 `agent_visibility` 占用，故用 0010）：

```sql
CREATE TABLE device_revocations (
  teamId      TEXT NOT NULL,
  machineId   TEXT NOT NULL,
  profileId   TEXT,              -- 可空：兼容无 profileId 的别名记录
  deviceId    TEXT,              -- 审计：被删设备 id
  deletedAt   INTEGER NOT NULL,
  PRIMARY KEY (teamId, machineId, profileId)
);
CREATE INDEX idx_revocations_machine ON device_revocations(teamId, machineId);
```

**吊销键 `(teamId, machineId, profileId)`**：精确到 daemon 重连的实际凭证三元组。含 teamId 避免误伤同机器加入的其他团队；profileId 可空以覆盖别名记录。`idx_revocations_machine` 支持 invite 清除时按 `(teamId, machineId)` 批量删。

> migration 必须在 `applyGlobalMigrations` 静态枚举注册（memory `server-next-migration-static-registration`）。

### 4.2 行为改动

**① deleteDevice（usecases.ts:1595）写吊销** — 物理删整组前，把 `resolveDeviceAliasGroup` 整组每个设备的 `(teamId, machineId, profileId)` upsert 进吊销表：
```
devicesToDelete = resolveDeviceAliasGroup(...)
revocations.upsertAll(devicesToDelete)        // 新增
for (target of devicesToDelete) devices.delete(...)   // 物理删照旧
```

**② deviceHello（重连入口，usecases.ts:1389）查拒** — `upsertHello` **之前**插入吊销检查：
```
existing = findByMachineProfile(...)
revoked = revocations.find(teamId, machineId, profileId)
if (revoked) return makeFailure('DEVICE_REVOKED', 'Device was removed')
upsertHello(...)
```

**③ deviceHelloFromCredentials（invite 入口）清吊销** — 重新接入路径，upsert **之前**清除：
```
revocations.clear(teamId, machineId)          // invite 合法接入 → 解封整台机器
upsertHello(...)
```

**④ daemon 拒后退出（index.ts + cli.ts）** — deviceHello 的 `emitWithAck` 收到 `{ok:false, error:'DEVICE_REVOKED'}` → 调新回调 `onDeviceRevoked` → cli 先 `socket.io.reconnection(false)` 再 `exit(0)`（复用层1 已注入的 exit dep）。打印日志：`设备已从团队移除，退出。重新接入请用 agentbean invite。`

**⑤ 契约** — `packages/contracts/src` 加错误码 `DEVICE_REVOKED = 'DEVICE_REVOKED'`（deviceHello ack 的 error 字段）。

**⑥ 层1 兼容（双保险）** — 在线删除**仍发 `device:removed`**（层1 即时踢出），**同时写吊销**（①）。两层独立：层1 管"即时踢"（用户立刻见下线），层2 管"重连不再复活"；删除瞬间 daemon 网络抖动没收到 `device:removed` 的竞态，由层2 兜底。

### 4.3 为什么 deviceHello 与 deviceHelloFromCredentials 分流

重连入口凭 machineId → **查吊销拒绝**；invite 接入入口凭 invite credential → **清吊销放行**。否则"重新接入"会被自己设的吊销拦死。两个入口两种语义，正好实现"删了拒重连、重新 invite 可接入"。

## 5. 测试策略（TDD，先红后绿）

**server-next（in-memory repos）**：

1. deleteDevice 后，同 `(team, machine, profile)` 的 deviceHello 返回 `DEVICE_REVOKED`，不建记录
2. deviceHelloFromCredentials（invite）清吊销后，deviceHello 成功 upsert
3. 别名组：删整组后，组内每个 machineId 重连都被拒
4. 跨团队：删 teamA 的 `(teamA, machine, profile)` 不影响 teamB 的 `(teamB, machine, profile)` 重连
5. 在线删除：`device:removed` 仍发（层1 不回归）+ 吊销写入（双保险）
6. 无 profileId 的别名记录删除后，`(team, machine, null)` 吊销生效

**daemon-next**：

7. deviceHello ack 返回 `DEVICE_REVOKED` → `onDeviceRevoked` 被调用（exit dep 注入 mock 验证 `exit(0)` + `reconnection(false)`）

## 6. 范围

- **server-next**：migration 0010 + repository（revocations CRUD）+ usecase（deleteDevice/deviceHello/deviceHelloFromCredentials）+ 契约 DEVICE_REVOKED
- **daemon-next**：index.ts 收 DEVICE_REVOKED 调 `onDeviceRevoked` + cli.ts `onDeviceRevoked` 停重连退出
- **不改 web**：删除 UX 不变（仍走 deleteDevice，返回不变）

## 7. 风险与边界

- **历史已删设备**：migration 不回填吊销（历史已物理删，无法知 machineId）。若其 daemon 还在跑会复活一次（边缘，接受）。可选缓解：deviceHello 速率告警，本次不做。
- **profileId 可空别名**：deviceHello 重连用 machineId+profileId；别名记录 profileId 为空时，吊销键 `(team, machine, NULL)` 须在查询时正确匹配（SQLite NULL 主键语义需 `IS NULL` 处理，repository 实现注意）。
- **deviceHelloFromCredentials 必须先清吊销再 upsert**：该入口本身不查吊销（不会自拒），但先清保证语义清晰，并避免与并发 deviceHello 查询的窗口竞争。

## 8. 验收标准

- 离线删除设备后，daemon 重连收到 `DEVICE_REVOKED` 并永久退出，DB 不出现新设备记录
- 重新 invite 同机器可成功接入（吊销被清）
- 在线删除行为不回归（`device:removed` 仍即时踢出）
- 三端测试全绿（server-next / daemon-next + tsc strict）
