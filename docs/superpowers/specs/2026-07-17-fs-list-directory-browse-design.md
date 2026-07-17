# 目录浏览能力化设计（fs:list）

> **设计日期**：2026-07-17
> **取代**：`2026-07-09-区分当前与远程设备-design.md` 的 **D1 决策**（远程设备目录浏览降级为手动填路径）
> **仓库**：xiaojichao/agentbean
> **状态**：待评审

---

## 1. 背景与结论（TL;DR）

当前目录浏览**用「身份」门控功能**：只有被判定为「本机」（`device.isLocal === true`）的设备，才在 daemon 那台机器上弹原生目录选择窗（macOS `osascript` / Linux `zenity`）。这套设计有两个结构性缺陷：

1. **本机识别脆弱**：`isLocal` 依赖浏览器 `localStorage.deviceId`，而该值只在 `/device-login/[code]` 一次性仪式里写入，任何账号密码登录的用户恒为 `null` → `isLocal` fail-closed 为 `false` → 物理本机也被当远程 → 目录浏览按钮消失。这是用户本次踩中的 bug（详见 [[custom-agent-runtime-readonly-causes]]，已第三次复发）。
2. **远程设备是二等公民**：远程 / headless daemon 无桌面会话，`osascript` 弹不出窗也不报错，daemon 挂起。2026-07-09 spec 的 D1 决策选择「远程直接不展示按钮，降级为手动填绝对路径」——用户要凭记忆手打路径，无存在性校验，打错即 Agent 在错误目录启动。

**结论**：引入 daemon 文件系统列表能力 `fs:list`，把目录浏览 UI 从「在 daemon 屏幕上弹窗」改为「在浏览器里渲染树形选择器」。daemon 侧只需 `readdir`（不需要屏幕），web 侧用已有的 socket 请求-响应通道（`selectDirectory` 已在用）逐层拉取目录。**「本机」概念从目录浏览场景中彻底删除**，门控从身份换成能力（`DeviceCapabilitiesDto.fsBrowse`）。

**收益**：

- 本机误判 bug 在目录浏览路径上**结构性绝种**（门控条件 `isLocal` 不再参与判定）。
- 远程设备 / headless 服务器**首次获得全功能目录浏览**（VS Code Remote-SSH / SFTP 客户端同款原理）。
- 选中路径**保证存在**（从真实文件系统点选），杜绝手打路径错误。
- 旧 daemon（无 `fs:list` 能力）fail-closed 降级回现状（按钮按版本门隐藏 + 手动填路径），无回归。

---

## 2. 为什么重开 2026-07-09 的 D1 决策

2026-07-09 spec 的 D1 是「降级兜底」哲学：远程放弃功能以消除挂起。该决策的「非目标」明确写了「不做 daemon 桌面会话能力探测」并判为 YAGNI。

重开的理由是**用户痛点证伪了 YAGNI 判断**：

- 旧 spec 假设「远程恰好有桌面会话是少数」，但**本机拥有者也踩挂起/降级**（因为 `isLocal` 识别链脆弱，本机常被误判为远程）。降级兜底惩罚的不只是远程场景，还包括所有没做 device-login 的本机用户。
- 「手动填路径」不是等价替代：无校验、易错、UX 差，且用户反馈明确认为当前架构「不合理」。
- `fs:list` 不依赖桌面会话（`readdir` 在 headless 机器上同样工作），旧 spec 拒绝的「桌面会话探测」根本不是本方案需要的东西——本方案不探测会话，而是用一条不依赖会话的数据通道。

**保留**：D2（远程删除护栏）、D3（`[本机]` badge 视觉标识）、D4（未 device-login 时的引导）**不受影响**，本 spec 只取代 D1。

---

## 3. 架构：能力协商替代身份判定

### 3.1 设计原则

沿用 mattpocock `/codebase-design` 词汇：把目录浏览实现成**深模块**——小接口（`fs:list(deviceId, path)`），深实现（授权复验 + denylist + readdir + 目录树渲染）。

**核心转换**：门控问题从「这台设备是不是本机？」（脆弱，需 localStorage 搬运链）改为「daemon 支持 `fsBrowse` 吗？」（hello 时自报，天然准确）。身份判定的整个失败模式被**删除**而非修复。

### 3.2 数据流

```
浏览器（渲染树形 UI）
  │ 用户点开 /Users → fs:list(deviceId, "/Users")
  │
  ▼
server-next  ─── 每次调用复验 canManageDeviceAsUser（拥有者/admin）──▶ 拒绝非拥有者
  │ deviceListDirectory({ deviceId, userId, path })
  ▼ emitWithAck(AGENT_EVENTS.device.listDirectoryRequested, request)
daemon-next
  │ 路径 denylist 校验（挡 ~/.ssh ~/.aws 等）
  │ path: {Path|fs}.readdir(path, { withFileTypes: true })
  ▼ ack
server  ◀── { ok, entries: [{ name, isDir }] }
  ▼
浏览器  ◀── 渲染子目录，用户继续点开 / 选中
```

- **传输通道复用现有设施**：`deviceSelectDirectory`（`socket-server.ts:361`）已是 web→server→daemon→ack 的请求-响应模板，`fs:list` 照搬该形状，不新增传输层。
- **daemon 唯一新动作是 `readdir`**：headless / 无显示器机器完美支持。对比现状的 `selectNativeDirectory()`（spawn `osascript` 弹窗），需求**严格变低**。

### 3.3 能力上报

在 `DeviceCapabilitiesDto`（`packages/contracts/src/device.ts:30`）新增字段：

```typescript
export interface DeviceCapabilitiesDto {
  scanAgents?: boolean;
  runDispatches?: boolean;
  fsBrowse?: boolean;  // 新增：支持 fs:list 目录树浏览
}
```

- daemon 在 `cli.ts:541` 构造 device 配置时 `capabilities: { ..., fsBrowse: true }`。
- `toDeviceDto`（`usecases.ts:4949`）已透传 `capabilities` 字段，无需改。
- 旧 daemon 的 `capabilities.fsBrowse` 为 `undefined`，web 视为不支持 → 降级（见 §6）。

---

## 4. 接口定义

### 4.1 Contracts（`packages/contracts/src/socket.ts`）

新增事件名：

```typescript
device: {
  // ... 既有 ...
  listDirectory: 'device:list-directory',           // web → server
},
device: {
  // ... 既有 ...
  listDirectoryRequested: 'device:list-directory-requested',  // server → daemon
},
```

> **readiness 门禁注意**（见 [[agentbean-readiness-transport-exemption-gotcha]]）：contracts/socket.ts 加新 transport 事件名含 `directory` 词，须同步 readiness 剥离链加 `.replace(/device:list-directory[a-z-]*/g,'')`，否则撞 `phase-0-management-boundary-regression` CI。本 spec 实施切片必须含此同步。

### 4.2 请求 / 响应载荷

```typescript
// 请求
interface ListDirectoryRequest {
  deviceId: string;
  path: string;          // 绝对路径；首次调用约定根锚点（见 §5.2）
}

// 响应
interface ListDirectoryResponse {
  ok: boolean;
  entries?: Array<{ name: string; isDir: boolean }>;
  error?: string;        // 'PERMISSION_DENIED' | 'PATH_NOT_FOUND' | 'RATE_LIMITED' | 'DEVICE_OFFLINE' | 'DIRECTORY_LIST_TIMEOUT'
                          // 注：denylist 命中统一返回 PATH_NOT_FOUND，不暴露目录存在性，故无 PATH_FORBIDDEN 枚举（见 §5.2）
  homePath?: string;     // 首次调用附 daemon 的 home 绝对路径，作为树形浏览的合理起点
}
```

**安全**：响应**只含目录名 + 是否目录**，不含文件内容、不含文件大小/权限/修改时间等元数据（最小信息暴露）。仅列目录。

### 4.3 web 端 lib 函数

新增 `lib/directory-tree.ts`，封装 `deviceEvents().listDirectory(deviceId, path)` 调用 + 错误码翻译。纯函数，可在 `tests/` 单测（沿用 [[web-next-test-conventions]]：只测 lib 纯函数不测组件）。

---

## 5. 关键设计决策

### 5.1 授权：每次调用复验拥有者（收紧，非保持）

**这是与现状相比最大的安全改进。** 现状 `selectDirectory` 的 server 转发（`socket-handlers.ts:268`）只校验 `getDevice`（团队成员可见），**没有复验拥有者/admin**——之所以没出事，是因为旧实现的"授权"实际靠 daemon 弹窗的屏幕物理隔离兜底（非拥有者即使调通，也得坐在 daemon 那台机器前点弹窗）。

改成 `fs:list` 后，屏幕隔离消失，宽门控会变成**真正的越权读取**（任何团队成员可列任意设备目录）。因此：

- server 每次 `device:list-directory` 复验 `canManageDeviceAsUser`（拥有者或 `user.role==='admin'`），与 [[agentbean-device-agent-ownership-auth]] 对齐。
- **授权从不缓存**（复验模式，撤销即时 fail-closed），与 Phase 4 #626 的 `executeTool` 复验哲学一致。

### 5.2 路径锚点与 denylist

- **首次起点**：web 打开树形选择器时，第一次 `fs:list` 用特殊路径标记（如空串或字面量 `"~"`），daemon 返回其 `$HOME` 内容 + `homePath`。后续以 `homePath` 为根逐层展开。避免从 `/` 开始（信息暴露面大、导航深）。
- **daemon 侧 denylist**：拒绝列出敏感路径（及其子树）。初始清单：`~/.ssh`、`~/.aws`、`~/.config/gcloud`、`~/.codex/auth.json`、`~/.claude/...`（与认证相关，呼应 [[agentbean-codex-auth-local-oauth]] / [[agentbean-custom-agent-auth-source]]）。denylist 命中 → `PATH_FORBIDDEN`，不暴露该目录存在性（返回 `PATH_NOT_FOUND` 更稳，避免侧信道确认）。
- **路径规范化**：daemon 用 `path.resolve` 规范化 + 拒绝 `..` 越界遍历（resolve 后再 denylist 比对，挡符号链接绕过的尽力而为）。

### 5.3 UI：树形浏览器组件

新增 `DirectoryTreePicker` 组件（替代当前 `DirectoryBrowseButton` 的弹窗路径，但**保留** `DirectoryBrowseButton` 作为旧 daemon 的降级入口）：

- 模态弹层，左侧树形（可折叠展开），逐层懒加载（点击展开节点才发 `fs:list`）。
- 选中目录 → 填入表单 `cwd` 字段 + 关闭弹层。
- 路径面包屑显示当前选中绝对路径。
- 离线 / 超时 / 权限拒绝：错误态内联提示，不崩溃。

### 5.4 降级与版本门

**支持矩阵**：

| daemon 能力 | 设备 isLocal | 行为 |
|---|---|---|
| `fsBrowse: true` | 任意（本机/远程） | ✅ `DirectoryTreePicker` 树形浏览 |
| `fsBrowse: undefined`（旧 daemon） | `isLocal === true` | 旧路径：`selectDirectory` 弹窗 |
| `fsBrowse: undefined`（旧 daemon） | `isLocal !== true` | 手动填路径（现状 D1 降级） |

- 版本门：定义 `FS_BROWSE_MIN_DAEMON_VERSION`（本 spec 落地的 daemon 版本），web 优先看 `capabilities.fsBrowse`，能力字段缺失时回退看 `daemonVersion`。
- **按钮显示条件改为能力驱动**：`canBrowseDirectory` 语义从「isLocal===true」改为「`fsBrowse` 支持 OR `isLocal===true`（兼容旧 daemon 弹窗）」。详见 §7 实施切片。
  - **澄清与 §5.1 的关系**：「删除 isLocal 依赖」指的是**主路径**（`fsBrowse` 设备的树形浏览）完全不读 `isLocal`；这里保留的 `isLocal===true` 仅服务于「旧 daemon 弹窗」这条**兼容降级分支**。两处不矛盾：新能力走能力门控，旧能力靠 isLocal 兜底，全设备升级后该 OR 的右半永远走不到，届时可删。
- fail-closed：daemon 离线 / 能力未知 → 不展示树形按钮，回退手动填路径。无回归。

---

## 6. 安全面分析

新增攻击面：**远程列任意（拥有者）设备的文件系统目录名**。威胁与缓解：

| 威胁 | 缓解 |
|---|---|
| 非拥有者越权列目录 | server 每次复验 `canManageDeviceAsUser`（拥有者/admin），fail-closed |
| 列敏感目录（`.ssh` 凭证目录名暴露） | daemon denylist + 返回 `PATH_NOT_FOUND`（不确认存在） |
| `..` 路径遍历绕过 denylist | `path.resolve` 规范化后比对 |
| 信息枚举（全盘扫描） | 限速：单连接 `fs:list` QPS 上限（如 10/s），超限 `RATE_LIMITED` |
| 响应过大（目录 10 万项） | 单次响应条目上限（如 1000），超出截断 + 提示 |
| 重放 / 越权 token | 复用既有 socket auth（token / deviceToken），不新增凭证 |

**残留风险**：denylist 不可能穷举（如用户自定义凭证路径）。接受——列目录名不等同读内容，且仅拥有者可列（拥有者本就有该设备完全控制权，能删设备）。与 [[agentbean-device-agent-ownership-auth]] 的"拥有者对设备有完全控制权"一致。

---

## 7. 实施切片建议

（详细步骤交由后续 `writing-plans` 技能产出实施计划，此处只给切片边界。）

1. **切片 1（contracts + daemon 能力）**：`DeviceCapabilitiesDto.fsBrowse` + 事件名 + readiness 同步 + daemon `deviceListDirectory` handler（readdir + denylist + 限速）。daemon 单测：denylist 命中、`..` 遍历、条目截断。
2. **切片 2（server 转发 + 授权）**：`socket-handlers.ts` 注册 `device:list-directory`，复验 `canManageDeviceAsUser`；`socket-server.ts` `deviceListDirectory` 转发（照搬 `deviceSelectDirectory` 形状）。server 单测：非拥有者拒、拥有者放、离线返回。
3. **切片 3（web lib + 组件）**：`lib/directory-tree.ts` + `DirectoryTreePicker` 组件 + 错误码翻译；接入 `AgentConfigDialog` / `AddCustomAgentDialog`。web lib 单测。
4. **切片 4（门控切换 + 降级）**：`canBrowseDirectory` 改能力驱动；支持矩阵的降级路径；移除「远程设备请手动填写」对 `fsBrowse` 设备的适用。e2e 验证（browser-harness CDP）本机/远程/headless 三态。
5. **切片 5（文档收口）**：更新 MEMORY（`custom-agent-runtime-readonly-causes` 增 B 方案落地记录）、CONTEXT/ADR（若仓库有 adr 目录则记"推翻 D1"决策）。

---

## 8. 验收标准

- [ ] 本机设备（`fsBrowse` daemon）：目录浏览按钮可见，点开树形选择器，逐层展开，选中路径正确填入。
- [ ] 远程设备（`fsBrowse` daemon）：**同上，全功能**（本次痛点 + 远程二等公民体验同时解决）。
- [ ] 旧 daemon（无 `fsBrowse`）+ 本机：回退 `selectDirectory` 弹窗，行为不变。
- [ ] 旧 daemon（无 `fsBrowse`）+ 远程：回退手动填路径，行为不变（D1 降级保留为兜底）。
- [ ] 非拥有者调 `fs:list`：返回 `PERMISSION_DENIED`，不能列目录。
- [ ] denylist 路径：返回 `PATH_NOT_FOUND`，不暴露存在性。
- [ ] readiness / phase-0-management-boundary-regression CI 全绿。

---

## 9. 非目标（YAGNI）

- **不实现文件读取**（`fs:read`）：只列目录名，不读文件内容。文件浏览是另一条路径，需独立安全评审。
- **不实现文件写入 / 上传**：目录选择只读。
- **不做方案 A（daemon localhost 本机发现端点）**：B 已让目录浏览脱离 `isLocal` 依赖，A 解决的是剩余的 `memory.localSummary` / 删除护栏等场景的本机识别，另案处理，不在本 spec。
- **不改 D2/D3/D4**：删除护栏、`[本机]` badge、device-login 引导维持现状。
- **不强制升级 daemon**：旧 daemon 靠能力字段 + 版本门 fail-closed 降级，依赖 [[agentbean-daemon-no-auto-update]] 的设备版本碎片现实。
