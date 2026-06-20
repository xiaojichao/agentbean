# 设备目录选择实施计划（S3：device:select-directory）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 apps/web 的自定义 Agent 创建/配置能「浏览」远程设备目录选 cwd。daemon-next 收到请求后调用 OS 原生目录对话框（osascript/PowerShell/zenity/kdialog）返回选中路径。apps/web `DirectoryBrowseButton` 早已调用 `deviceEvents().selectDirectory(deviceId)` 等 path,本 slice 打通 server→daemon 转发链路。

**Architecture:** 跨 contracts/daemon-next/server-next/apps-web。**核心新机制**:server-next 首个 **server→daemon request-response 转发**（web ack 等 path ← server emitWithAck daemon ← daemon 弹 OS 对话框 ack path）。daemon 端移植旧 `apps/daemon/src/device-daemon.ts:105-159` 的 `nativeDirectoryPickerCommands`（三平台）+ `selectNativeDirectory`（execFileAsync）。

**Tech Stack:** TypeScript、daemon-next（node:child_process execFile + vitest mock）、server-next（socket.io emitWithAck + vitest）、contracts、apps/web。

---

## 背景

设备详情对等性最后一个 slice。S1/S2a/S2b/connectCommand 已合并。apps/web `DirectoryBrowseButton`（`devices/page.tsx:97-166`）远程设备走 `selectDirectory(deviceId)` 等 daemon 返回 path（`:123`），但 server-next 无 handler、contracts 无定义、daemon-next 无目录选择。

**有条件功能**:只在 daemon 跑在**有桌面**的机器可用（OS 对话框需 GUI）。headless/远程 daemon 返回 error。apps/web 已有 daemonVersion 门槛（`DIRECTORY_PICKER_MIN_DAEMON_VERSION='0.1.27'`，`:116`）。

## 范围

**纳入：**
- **contracts**：`WEB_EVENTS.device.selectDirectory` + `AGENT_EVENTS.device.selectDirectoryRequested`。
- **daemon-next**：移植 `nativeDirectoryPickerCommands`（osascript/PowerShell/zenity/kdialog）+ `selectNativeDirectory`（execFileAsync + 120s timeout + 取消/无命令处理）+ 监听 `selectDirectoryRequested` → 弹对话框 → ack path。
- **server-next**：`SocketLike` 加 `emitWithAck` + `WebSocketHandlerOptions.deviceSelectDirectory`（async）+ socket-server 实现（emitWithAck daemon）+ socket-handlers `device:select-directory` 特殊 handler（转发 + ack web）。
- **apps/web**：`selectDirectory` 从硬编码字符串迁到 `WEB_EVENTS.device.selectDirectory` 常量。
- 测试：daemon nativeDirectoryPickerCommands/selectNativeDirectory 单测（mock execFileAsync）+ server handler wiring + 端到端（mock daemon emitWithAck 返回 path）。

**不纳入**：`capabilities.directoryPicker` 能力位（apps/web 靠 daemonVersion 门槛 + daemon error 兜底,简化）；mac/Linux/Windows 之外平台；真实 OS 对话框端到端（CI 无法弹,靠 mock）。

## 关键约束（实现者必读）

1. **request-response 新机制**：server-next 当前 daemon 转发（dispatch/deviceScan）全是 fire-and-forget（`SocketLike.emit?`）。select-directory 需 `emitWithAck`（等 daemon 弹对话框 ack path,最长 120s）。给 `SocketLike` 加 `emitWithAck?` + `WebSocketHandlerOptions.deviceSelectDirectory` async 回调。
2. **特殊 handler（非 usecase）**：`device:select-directory` 是纯转发（无业务逻辑/存储,不像 get/rename）。用 `socket.on(WEB_EVENTS.device.selectDirectory)` 特殊 handler（仿 `channel.join` `:105`）,不经 `bind` usecase。
3. **daemon OS 对话框**：移植 `apps/daemon/src/device-daemon.ts:105-159`（`nativeDirectoryPickerCommands` 三平台 + `selectNativeDirectory` execFileAsync）。daemon 收到 `selectDirectoryRequested` → `selectNativeDirectory()` → ack `{ok, path}` 或 `{ok:false, error}`（取消/无桌面/无命令）。
4. **测试挑战**：daemon OS 对话框 CI 无法真正弹 → 单测 mock `execFileAsync`（成功/取消/ENOENT）。端到端 mock daemon socket emitWithAck 返回固定 path,验证 web ack 收到。
5. **apps/web 早调用**：`DirectoryBrowseButton:123` 已 `selectDirectory(deviceId)` 等 `res.path`。本 slice 只迁常量 + 打通后端。

## File Structure

- **修改** `packages/contracts/src/socket.ts`：`WEB_EVENTS.device.selectDirectory` + `AGENT_EVENTS.device.selectDirectoryRequested`。
- **新增** `apps/daemon-next/src/directory-picker.ts`：`nativeDirectoryPickerCommands` + `selectNativeDirectory`。
- **新增** `apps/daemon-next/tests/directory-picker.test.ts`：单测。
- **修改** `apps/daemon-next/src/index.ts`：监听 `selectDirectoryRequested`。
- **修改** `apps/server-next/src/transport/socket-handlers.ts`：`SocketLike.emitWithAck` + `WebSocketHandlerOptions.deviceSelectDirectory` + `device:select-directory` 特殊 handler。
- **修改** `apps/server-next/src/transport/socket-server.ts`：`deviceSelectDirectory` 实现（emitWithAck daemon）。
- **修改** `apps/server-next/tests/socket-handlers.test.ts`：wiring 测试。
- **修改** `apps/server-next/tests/device-management.test.ts`：端到端（mock daemon path）。
- **修改** `apps/web/lib/socket.ts`：`selectDirectory` 迁常量。

---

## Task 1：contracts 常量

**Files:** `packages/contracts/src/socket.ts`

- [ ] **Step 1：加常量**

`WEB_EVENTS.device`（`:28-37`，S1 加了 rename/delete）加：

```ts
    selectDirectory: 'device:select-directory',
```

`AGENT_EVENTS.device`（grep `device:` 在 AGENT_EVENTS 区，约 `:101-104`，有 hello/runtimes/scanRequested）加：

```ts
    selectDirectoryRequested: 'device:select-directory-requested',
```

- [ ] **Step 2：类型检查**
Run: `npm --workspace @agentbean/contracts run build`
Expected: 通过。

- [ ] **Step 3：提交**
```bash
git add packages/contracts/src/socket.ts
git commit -m "feat(contracts): device:select-directory + selectDirectoryRequested 常量

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：daemon directory-picker + 单测

**Files:**
- Create: `apps/daemon-next/src/directory-picker.ts`
- Create: `apps/daemon-next/tests/directory-picker.test.ts`

- [ ] **Step 1：写测试（先红）**

新建 `apps/daemon-next/tests/directory-picker.test.ts`。mock `execFile`（node:child_process）验证三平台命令 + 成功/取消/ENOENT：

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { nativeDirectoryPickerCommands, selectNativeDirectory } from '../src/directory-picker';

describe('directory-picker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns osascript on darwin', () => {
    const cmds = nativeDirectoryPickerCommands('darwin');
    expect(cmds[0].command).toBe('osascript');
  });

  it('returns powershell on win32', () => {
    const cmds = nativeDirectoryPickerCommands('win32');
    expect(cmds[0].command).toBe('powershell.exe');
  });

  it('returns zenity/kdialog on linux', () => {
    const cmds = nativeDirectoryPickerCommands('linux');
    expect(cmds.map((c) => c.command)).toEqual(['zenity', 'kdialog']);
  });

  it('selectNativeDirectory returns trimmed stdout on success', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) => cb(null, '  /home/user/project\n', ''));
    const path = await selectNativeDirectory([{ command: 'zenity', args: [] }]);
    expect(path).toBe('/home/user/project');
  });

  it('selectNativeDirectory returns null on cancel (exit code 1)', async () => {
    (execFile as any).mockImplementation((_cmd, _args, _opts, cb) => cb({ code: 1, message: 'cancelled' }, '', ''));
    const path = await selectNativeDirectory([{ command: 'zenity', args: [] }]);
    expect(path).toBeNull();
  });

  it('selectNativeDirectory falls through on ENOENT to next command', async () => {
    (execFile as any)
      .mockImplementationOnce((_c, _a, _o, cb) => cb({ code: 'ENOENT' }, '', ''))
      .mockImplementationOnce((_c, _a, _o, cb) => cb(null, '/path\n', ''));
    const path = await selectNativeDirectory([
      { command: 'zenity', args: [] },
      { command: 'kdialog', args: [] },
    ]);
    expect(path).toBe('/path');
  });
});
```

- [ ] **Step 2：跑测试确认失败**
Run: `npm --workspace @agentbean/daemon-next test -- directory-picker`
Expected: FAIL（模块不存在）。

- [ ] **Step 3：实现 directory-picker.ts**

移植自 `apps/daemon/src/device-daemon.ts:103-159`。新建 `apps/daemon-next/src/directory-picker.ts`：

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type DirectoryPickerCommand = { command: string; args: string[] };

export function nativeDirectoryPickerCommands(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand[] {
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "选择项目目录" default location (path to home folder))'],
    }];
  }
  if (platform === 'win32') {
    return [{
      command: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }'],
    }];
  }
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=选择项目目录'] },
    { command: 'kdialog', args: ['--getexistingdirectory', '.', '选择项目目录'] },
  ];
}

function isMissingCommandError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT';
}

function isDirectoryPickerCancel(err: unknown): boolean {
  const e = err as { code?: number; message?: string; stderr?: string };
  const message = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return e?.code === 1 || /cancel|canceled|cancelled|User canceled|No file selected/i.test(message);
}

export async function selectNativeDirectory(commands = nativeDirectoryPickerCommands()): Promise<string | null> {
  let lastError: unknown = null;
  for (const cmd of commands) {
    try {
      const { stdout } = await execFileAsync(cmd.command, cmd.args, { timeout: 120_000 });
      const selected = stdout.trim();
      return selected || null;
    } catch (err) {
      if (isMissingCommandError(err)) {
        lastError = err;
        continue;
      }
      if (isDirectoryPickerCancel(err)) return null;
      throw err;
    }
  }
  throw new Error(lastError ? `directory picker command not available` : 'directory picker command not available');
}
```

> 直接移植 `device-daemon.ts:103-159`（逻辑一致）。`execFile` from `node:child_process` + `promisify`。先 `cat apps/daemon/src/device-daemon.ts | sed -n '103,159p'` 对照确认移植完整。

- [ ] **Step 4：跑测试确认通过**
Run: `npm --workspace @agentbean/daemon-next test -- directory-picker`
Expected: PASS（6 用例）。

- [ ] **Step 5：提交**
```bash
git add apps/daemon-next/src/directory-picker.ts apps/daemon-next/tests/directory-picker.test.ts
git commit -m "feat(daemon-next): 移植 nativeDirectoryPickerCommands / selectNativeDirectory

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：daemon 监听 selectDirectoryRequested

**Files:** `apps/daemon-next/src/index.ts`

- [ ] **Step 1：监听 + 弹对话框 + ack**

`index.ts` 的 daemon socket 设置区（grep `AGENT_EVENTS.device.scanRequested` 定位监听区，:126 附近）。仿 scanRequested 监听，加 selectDirectoryRequested：

```ts
    socket.on(AGENT_EVENTS.device.selectDirectoryRequested, async (_payload: unknown, ack?: (result: unknown) => void) => {
      try {
        const selected = await selectNativeDirectory();
        if (!selected) {
          ack?.({ ok: false, error: 'CANCELLED' });
          return;
        }
        ack?.({ ok: true, path: selected });
      } catch (err) {
        ack?.({ ok: false, error: err instanceof Error ? err.message : 'directory picker failed' });
      }
    });
```

> import `selectNativeDirectory` from `./directory-picker.js`（顶部）。仿 scanRequested 的 ack 模式（:126-133）。
> daemon 收到 selectDirectoryRequested（server 转发）→ selectNativeDirectory（弹 OS 对话框）→ ack path/error。

- [ ] **Step 2：类型检查 + daemon 全套**
Run: `npx tsc -p apps/daemon-next/tsconfig.json --noEmit && npm --workspace @agentbean/daemon-next test`
Expected: tsc 通过，daemon 全套绿（含 directory-picker 单测）。

- [ ] **Step 3：提交**
```bash
git add apps/daemon-next/src/index.ts
git commit -m "feat(daemon-next): 监听 selectDirectoryRequested 弹目录选择

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：server SocketLike emitWithAck + deviceSelectDirectory + socket-server 实现

**Files:**
- `apps/server-next/src/transport/socket-handlers.ts`（SocketLike + WebSocketHandlerOptions）
- `apps/server-next/src/transport/socket-server.ts`（deviceSelectDirectory 实现）

- [ ] **Step 1：SocketLike 加 emitWithAck**

`socket-handlers.ts:15-18` 的 `SocketLike` 加：

```ts
export interface SocketLike {
  on(event: string, handler: SocketHandler): void;
  emit?(event: string, payload: unknown): void;
  emitWithAck?(event: string, payload: unknown): Promise<unknown>;
}
```

- [ ] **Step 2：WebSocketHandlerOptions 加 deviceSelectDirectory**

`socket-handlers.ts:29-42` 的 `WebSocketHandlerOptions` 加：

```ts
  deviceSelectDirectory?(request: { deviceId: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
```

- [ ] **Step 3：socket-server 实现 deviceSelectDirectory**

`socket-server.ts` 的 options 注入区（grep `deviceScan(request)` 定位，:163-165）后加：

```ts
      async deviceSelectDirectory(request) {
        const socket = agentSocketsByDeviceId.get(request.deviceId);
        if (!socket?.emitWithAck) {
          return { ok: false, error: 'DEVICE_OFFLINE' };
        }
        try {
          const result = await socket.emitWithAck(AGENT_EVENTS.device.selectDirectoryRequested, request);
          return result as { ok: boolean; path?: string; error?: string };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'select-directory failed' };
        }
      },
```

> `agentSocketsByDeviceId` 是 socket-server 已有 Map（:52）。socket.io socket 原生支持 emitWithAck（server→client ack）。socket-server 创建的真实 socket 是 socket.io socket,有 emitWithAck;SocketLike 接口现在声明它。
> `AGENT_EVENTS` 已 import（socket-server.ts 顶部）。

- [ ] **Step 4：类型检查**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit`
Expected: 通过。

- [ ] **Step 5：提交**
```bash
git add apps/server-next/src/transport/socket-handlers.ts apps/server-next/src/transport/socket-server.ts
git commit -m "feat(server-next): SocketLike emitWithAck + deviceSelectDirectory request-response 转发

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：server device:select-directory 特殊 handler

**Files:** `apps/server-next/src/transport/socket-handlers.ts`

- [ ] **Step 1：加特殊 handler**

在 `registerWebSocketHandlers`（grep `registerWebSocketHandlers` 定位，:51 起）里，仿 `channel.join` 特殊 handler（:105 socket.on），加 device:select-directory 转发 handler（在 device bind 区 :88 后）：

```ts
  socket.on(WEB_EVENTS.device.selectDirectory, async (payload, ack) => {
    try {
      const input = await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser });
      const deviceId = (input as { deviceId?: string } | null)?.deviceId;
      if (!deviceId) {
        ack?.(makeFailure('VALIDATION_ERROR', 'deviceId is required'));
        return;
      }
      if (!options.deviceSelectDirectory) {
        ack?.(makeFailure('INTERNAL_ERROR', 'deviceSelectDirectory not configured'));
        return;
      }
      const result = await options.deviceSelectDirectory({ deviceId });
      ack?.(result);
    } catch (error) {
      ack?.(socketErrorAck(error, WEB_EVENTS.device.selectDirectory));
    }
  });
```

> **先读 `channel.join` 特殊 handler（:105）+ `withAuthenticatedUserId`/`socketErrorAck`/`makeFailure` 用法**，照它的模式。`withAuthenticatedUserId` 注入 userId（select-directory 只需 deviceId,但走 authenticated 注入保持一致）。不经 usecase（纯转发）。

- [ ] **Step 2：类型检查 + server 全套**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit && npm --workspace @agentbean/server-next test`
Expected: tsc 通过，测试绿。

- [ ] **Step 3：提交**
```bash
git add apps/server-next/src/transport/socket-handlers.ts
git commit -m "feat(server-next): device:select-directory handler 转发到 daemon

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：apps/web selectDirectory 迁常量

**Files:** `apps/web/lib/socket.ts`

- [ ] **Step 1：selectDirectory 用常量**

`socket.ts` 的 `selectDirectory`（grep `device:select-directory` 定位，约 :441-442，S1 后 rename/delete 已迁常量）：

```ts
    selectDirectory(deviceId) {
      return emitWithTimeout(socket, WEB_EVENTS.device.selectDirectory, { deviceId }, 35000);
    },
```

> 从硬编码 `'device:select-directory'` 迁到 `WEB_EVENTS.device.selectDirectory`（Task 1 加了常量）。35000 timeout 保留（等 daemon 弹对话框）。

- [ ] **Step 2：apps/web 类型检查 + 测试**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit && npm --workspace agentbean-web test`
Expected: tsc 通过（预先存在 socket.test:240 error 非本改），测试绿。

- [ ] **Step 3：提交**
```bash
git add apps/web/lib/socket.ts
git commit -m "fix(web): selectDirectory 迁 WEB_EVENTS 常量

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7：端到端测试（mock daemon path）

**Files:** `apps/server-next/tests/device-management.test.ts`

- [ ] **Step 1：加端到端用例**

端到端验证 web device:select-directory → server 转发 → daemon（mock emitWithAck 返回 path）→ web ack path。在 device-management.test.ts 加用例。**mock daemon socket 的 emitWithAck** 返回固定 path（不真弹对话框）：

```ts
  test('device select-directory returns path from daemon', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1']),
    });
    const { baseUrl, ioServer } = await startSocketServer(app);
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agent.disconnect(); });

    // 注册 + device hello（daemon 上线）
    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'T' });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1', ownerId: 'user-1', machineId: 'm-1', profileId: 'default', hostname: 'mac',
    });

    // daemon 端：监听 selectDirectoryRequested,ack 一个固定 path（模拟用户选目录,不真弹）
    agent.on(AGENT_EVENTS.device.selectDirectoryRequested, (_payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ ok: true, path: '/home/user/project' });
    });

    // web 发 select-directory,应拿到 daemon 返回的 path
    const result = await web.emitWithAck(WEB_EVENTS.device.selectDirectory, { deviceId: 'device-1' });
    expect(result).toMatchObject({ ok: true, path: '/home/user/project' });
  });
```

> daemon 端用测试 client 的 `agent.on(selectDirectoryRequested)` + ack 模拟（真实 daemon 会弹 OS 对话框,测试用固定 path 替代）。这验证 server→daemon request-response 转发链路（web → server emitWithAck daemon → daemon ack → server ack web）。
> `agent.on` 的 ack 参数：socket.io client 的 ack。确认 connectClient 的 socket 类型支持 emitWithAck + on with ack（socket-integration.test.ts 现有用例模式）。

- [ ] **Step 2：跑测试**
Run: `npm --workspace @agentbean/server-next test -- device-management`
Expected: PASS。若 path 没回：查 server deviceSelectDirectory（emitWithAck daemon）+ handler 转发 + daemon ack。

- [ ] **Step 3：server 全套**
Run: `npm --workspace @agentbean/server-next test`
Expected: 全绿。

- [ ] **Step 4：提交**
```bash
git add apps/server-next/tests/device-management.test.ts
git commit -m "test(server-next): device select-directory 端到端（mock daemon path）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 明确不在本计划范围

- **capabilities.directoryPicker**：apps/web 靠 daemonVersion 门槛（0.1.27）+ daemon error 兜底。能力位上报（daemon 检测桌面）作为后续优化。
- **真实 OS 对话框端到端**：CI 无法弹 osascript/PowerShell/zenity。靠 daemon 单测 mock execFileAsync + server 端到端 mock daemon ack。真实对话框需手动验证（本地有桌面 daemon）。
- **headless daemon 友好降级 UI**：daemon 无桌面返回 error，apps/web 显示 directoryPickerErrorMessage（:128）。本 slice 不改 apps/web UI 文案（已有错误处理）。

## Self-Review

1. **Spec 覆盖**：S3 = device:select-directory 端到端。contracts（Task 1）→ daemon directory-picker（Task 2）→ daemon 监听（Task 3）→ server request-response 机制（Task 4）→ server handler（Task 5）→ apps/web 常量（Task 6）→ 端到端（Task 7）。✅
2. **占位符**：每步完整代码；Task 2 移植引用源文件（device-daemon.ts:103-159）+ 完整代码；少数「先读现有模式」（channel.join handler、scanRequested 监听、connectClient ack）给核实方法。✅
3. **一致性**：
   - 事件名：device:select-directory（web→server）/ device:select-directory-requested（server→daemon），contracts + handler + daemon 监听 + apps/web 一致。✅
   - request-response：web emitWithAck ← server handler ← options.deviceSelectDirectory ← socket emitWithAck daemon ← daemon ack path。新机制（SocketLike.emitWithAck）。✅
   - daemon OS 对话框：nativeDirectoryPickerCommands 三平台 + selectNativeDirectory，移植 device-daemon.ts。✅
4. **顺序**：Task 1（contracts）→ 2/3（daemon）→ 4/5（server）→ 6（apps/web）→ 7（端到端）。✅
5. **测试策略**：daemon 单测 mock execFileAsync（三平台 + 成功/取消/ENOENT）；server 端到端 mock daemon ack path（不真弹）。真实 OS 对话框手动验证。✅
6. **新机制风险**：SocketLike.emitWithAck（socket-server 创建的真实 socket.io socket 有 emitWithAck，接口声明它）。device-management 端到端验证 request-response 链路。✅
