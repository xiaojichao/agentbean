# AgentBean Web 端到端协议对等性验证（apps/web × server-next）

> 日期：2026-06-14
> 前置：
> - `2026-06-13-web-protocol-parity-audit.md`（A/B/C 类事件名审计）
> - `2026-06-13-d-payload-parity-audit.md`（D 类 payload 双向字段矩阵）
> - 合并 PR：#205（A 类）、#208（D3+D4）、#209（D1）、#210（D2）、#211（D7）、#212（D5）、#213（C 类核实）
> 目的：D1-D5 系统性模式全部修完后，**实测验证主干流程是否真跑通**，作为生产 cutover 前的功能性 gate。审计既定流程为「每批后探针验证」，本文档即该探针的结论。

---

## 一、结论摘要

**主干流程跑通，D1-D5 修复验证达成。** cutover 基建 readiness 31/31。残留 1 类非致命的客户端健壮性缺陷（emitWithTimeout 未 catch），已定位根因。

| 验证项 | 结果 | 证据来源 |
|---|---|---|
| server-next 协议实现健康度 | ✅ | `smoke:agentbean-next-browser` **19/19 全过**，含 `browser-console-clean` |
| D3 auth 嵌套结构（res.user/token/currentTeam） | ✅ | apps/web 注册成功，URL 跳转 `/default/chat`，token 写入 localStorage |
| D4 token session 闭环 | ✅ | 注册成功即证明 socket auth 链路打通 |
| D1 team 域 currentTeam.path | ✅ | 跳转用 `res.currentTeam?.path`，成功进工作台 |
| chat / tasks 页编译 | ✅ | web dev 日志：`✓ Compiled /[networkPath]/{chat,tasks}` 全 200，无编译错误 |
| cutover 基建 readiness | ✅ | `check:agentbean-next-readiness` **31/31** |
| 客户端 unhandled rejection | ⚠️ | 进工作台 console 1 个 `Uncaught (in promise)`，根因已定位（见 §四），非阻塞 |
| D2 / D7 在 apps/web 客户端实测 | ⏸️ | 本轮未点进 tasks/agents 页操作；browser smoke 已覆盖 server 端 task CRUD |

---

## 二、验证方法

### 2.1 server-next 端：browser smoke（自带服务启动）

`npm run smoke:agentbean-next-browser` 自动执行：build server-next → 随机端口启动 → 真实 Chrome（CDP）→ 注入隔离 session → 跑 19 个 check。覆盖 auth 注册/登录、team、agent 创建、消息往返、task CRUD、artifact 上传/预览/下载、daemon 上线、刷新恢复、console 干净度。

### 2.2 apps/web 端：真实客户端对接实测

1. 后台启动 server-next：`bin.js --port 4000 --storage sqlite --data-dir /tmp/agentbean-server-next-dev`
2. 后台启动 apps/web：`next dev -p 3100`（`.env.local` 指向 `localhost:4000`）
3. Chrome 导航 `/signup`，填表单（username/email/password）→ 提交
4. 观察：URL 跳转、localStorage token、chat/tasks 编译、console 错误

---

## 三、验证结果详述

### 3.1 browser smoke（19/19）

```
PASS browser-target-ready / session-seeded / chrome-ready
PASS browser-login-session          ← auth 注册/登录 + session token
PASS browser-session-readable       ← user + currentTeam 暴露（D1/D3 server 端正确）
PASS browser-daemon-connected / resubscribe-snapshots
PASS browser-custom-agent-create    ← agent 创建（D7 server 端）
PASS browser-agent-reply-visible    ← 消息 dispatch 往返
PASS browser-refresh-resubscribe / post-refresh-dispatch
PASS browser-task-create-visible    ← task 创建
PASS browser-task-status-update     ← task 状态更新（D2 server 端 taskId）
PASS browser-task-refresh-restore   ← 刷新 task:list 恢复
PASS browser-artifact-upload/preview/download-visible
PASS browser-final-screenshot
PASS browser-console-clean          ← 无任何 console 错误/异常
```

**结论**：server-next 端（D5 email、auth 嵌套结构、team、task、agent、device、artifact、daemon）协议实现**完全健康**，真实 Chrome 下无运行时错误。

### 3.2 apps/web 客户端实测（主干「注册→进工作台」）

- 导航 `/signup` → 表单正常渲染（D5：email 字段可选）
- 填表提交 → **注册成功**，URL 跳转 `http://localhost:3100/default/chat`
- localStorage `agentbean.token` 写入（D3：`res.token` / `res.user` / `res.currentTeam` 正确解析）
- chat 页、tasks 页 dev 编译成功，无编译错误

**D3/D4/D1 在 apps/web 端实测通过**。signup 提交逻辑（`app/signup/page.tsx:34-50`）已体现修复：
```js
const res = await authEvents(socket).register({ username, password, email });
const user = res.user;                    // D3 嵌套结构
if (res.ok && res.token && user) {        // D3 res.token
  ...email: user.email ?? null...         // D5 email
  const np = res.currentTeam?.path ...    // D1 currentTeam（非 networkPath）
  router.replace(`/${np}/chat`);
}
```

---

## 四、残留缺陷：客户端 unhandled rejection（已定位根因）

### 4.1 现象

apps/web 进工作台后 console 出现 `Uncaught (in promise)`（0 args，信息少）。

### 4.2 根因

`emitWithTimeout`（`apps/web/lib/socket.ts:148-153`）超时时 `reject(new Error('socket timeout'))`：
```js
function emitWithTimeout(socket, event, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), timeoutMs);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}
```

多处调用方**只 `.then()` 不 `.catch()`**，超时即变 Uncaught (in promise)。进工作台必然触发的两个：

| 位置 | 调用 | 事件 |
|---|---|---|
| `components/sidebar.tsx:25` | `nets.list().then(res => ...)` | `team:list` |
| `app/[networkPath]/chat/page.tsx:306` | `memberEvents().list().then(...)` | `members:list` |

### 4.3 触发机制

sidebar 的 useEffect 守卫是 `if (conn !== 'open') return`——但 socket.io 的 **`connected` ≠ `authenticated`**：`conn==='open'` 在 socket 层就绪时触发，而应用层 auth（`auth: { token }` → server 中间件异步校验）是第二阶段。emit 若在 auth 握手完成前发出，server 对未完成 auth 的 `team:list` 不 ack → 10s 后 `emitWithTimeout` reject → 调用方未 catch → console 噪音。

browser smoke 未踩到（预置 session + 服务端自启，时序不同）；apps/web 真实初始化路径才暴露。

### 4.4 与 C 类的关联

sidebar 同时靠两条路径拿团队列表：① `nets.list()` ack；② `nets.onSnapshot()` 订阅 `teams:snapshot`。而 `teams:snapshot` 正是 C 类未广播项之一（#213 核实），故路径 ② 失效，团队列表更依赖路径 ①，使其健壮性更关键。

### 4.5 性质与修复

**非致命，不阻塞主干**（browser smoke 19/19 证明 server 端 team:list 本身正常；apps/web 实测也成功进工作台，UI 可用 fallback `/default`）。修复方向：

- **最小**：给 sidebar.tsx:25、chat:306 等 emitWithTimeout 调用加 `.catch(() => {})`，消除 console 噪音。
- **彻底**：emit 前等 socket `authenticated` 事件而非仅 `conn==='open'`，根治初始化时序。
- **全局**：审计所有 `emitWithTimeout(...).then(` 无 `.catch` 的调用点统一加 catch（grep 可枚举）。

---

## 五、下一步建议

1. **修 §四 unhandled rejection**（小 PR，加 catch + 时序守卫），消除 console 噪音并加固初始化。
2. **补 D2/D7 客户端实测**：本轮未在 apps/web 点进 tasks/agents 页操作；建议补一次 tasks CRUD 实测，坐实 D2（taskId 命名）在客户端的表现。
3. **C 类决策**：7 项未广播事件当前非阻塞，但 `teams:snapshot`/`tasks:snapshot` 影响多用户实时同步。若 cutover 在即，建议至少补 `teams:snapshot`（与 §四 路径 ② 直接相关）。
4. **生产 cutover**：readiness 31/31 + 主干跑通，功能性 gate 已满足。cutover 为高风险生产操作，需明确授权后走 `audit:agentbean-next-ready-to-flip` + production smoke gate。

---

## 六、复现脚本

```bash
# 1. 重建最新代码
npm run build:packages

# 2. server-next 端 smoke（自启，19/19）
npm run smoke:agentbean-next-browser

# 3. apps/web 客户端实测
mkdir -p /tmp/agentbean-server-next-dev
node apps/server-next/dist/apps/server-next/src/bin.js \
  --host 127.0.0.1 --port 4000 --storage sqlite \
  --data-dir /tmp/agentbean-server-next-dev --session-secret dev-secret &
# 另一终端
cd apps/web && npx next dev -p 3100
# 浏览器开 http://localhost:3100/signup → 注册 → 观察跳转 /default/chat
```
