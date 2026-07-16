# Phase 3 环境验证 Checklist（P3-17 / P3-18）

Phase 3 代码/配置层已就绪（P3-01..16 Green + P3-17 smoke 脚本 + P3-18 gate）。这份 checklist 是**真实环境验证**——脱离代码,用真实 LLM Agent + 生产部署证明 Phase 3 端到端可用。全部勾完 → P3-17/18 Green → verdict Ready。

> 验证用 **server-next / daemon-next / web-next**（生产栈,Phase 3 代码在这）。legacy `apps/server` 没有 Phase 3。

---

## 前置

- [ ] Node v24（`.nvmrc` = v24.15.0；CI 同）。better-sqlite3 必须匹配 Node 版本编译
- [ ] 机器上有真实外部 Agent（claude-code / codex / hermes 等,daemon 会扫描发现）
- [ ] build 一次:`npm run build:packages`（server-next / daemon-next 用 `npm start` 跑 dist）

---

## P3-17：两个真实外部 Agent 跨 Task Memory smoke（本地）

### 1. 启三个服务（三个终端）

- [ ] **server-next**（端口 4100,sqlite 持久化 + session secret）:
  ```bash
  cd apps/server-next
  AGENTBEAN_NEXT_SESSION_SECRET=dev-secret AGENTBEAN_NEXT_STORAGE=sqlite npm start
  ```
  日志看到监听 4100 即可。

- [ ] **web-next**（端口 4101）:
  ```bash
  cd apps/web-next
  npm run dev
  ```

- [ ] **daemon-next**（连 server,扫描真实 Agent）:
  ```bash
  cd apps/daemon-next
  npm start -- --server-url http://localhost:4100 --token dev-secret --profile default
  ```
  日志看到 `agent connected` / device registered 即可。

### 2. Web 配 Phase 3

- [ ] 浏览器开 `http://localhost:4101` → 注册/登录 → 进默认团队
- [ ] 设置页 → **PI 管理模式**面板 → 路由模式选 `managed` → **最高管理阶段选 Phase 3**（"跨 Agent Memory,worker 工具接通"）→ 保存
- [ ] 确认保存成功（policy.maxManagementPhase === 3）

### 3. 接真实外部 Agent

- [ ] daemon 自动扫描发现真实 Agent（日志:`N coding runtimes available, M agents discovered`）
  - 若没发现:设置页手动加 **custom agent**（指 claude-code / codex 等）
- [ ] 确认目标 Agent 的 device **online** + worker 注册（supportedPhases 含 3,V3 capability）

### 4. 触发 phase3 managed run

- [ ] 频道里 @ PI Manager + 把消息**标记为任务**（asTask）+ 描述任务（例如"调研 X 并记录结论"）
- [ ] server 日志确认:路由进入 `managementPhase: 3`（不是 1/2）+ `managementPhase3Preflight` 通过 + 创建 run

### 5. 正场景:跨 Agent 经 Memory 协作

- [ ] server 日志:PI Manager worker 调用 memory 工具（`memory.search` / `memory.propose_candidate` / `memory.create_capsule`）
- [ ] Web **Memory 治理面**（设置页 memory tab）:看到 candidate 提议（proposedContent + 来源）
- [ ] 你在治理面 **accept** candidate → memory 转 active
- [ ] PI Manager 创建 capsule（授权给目标 Agent）
- [ ] 第二个 Agent 接手（同一 run 的下一 invocation,或被 invoke 的目标 Agent）→ 经 **capsule inject** 复用第一个 Agent 的记忆
- [ ] 治理面:看到 capsule（active）+ invocation（capsuleRef 绑定）

### 6. 负场景:来源失效 → inject 拒绝

- [ ] 删掉 candidate/memory 引用的来源消息
- [ ] 触发再次 inject（或下一 Agent 接手）
- [ ] server 日志 / 治理面:inject 被 **denied**（`MEMORY_SOURCE_UNAVAILABLE` / `invalid-memory-capsule` rebuild）
- [ ] capsule 状态转 denied 或 rebuild 剔除

---

## P3-18：生产 browser smoke

### 1. 部署

- [ ] **Railway** 部署 server-next（`railway.json` 已配 `npm start` + healthcheck `/healthz`）
- [ ] **Vercel** 部署 web-next
- [ ] 生产域名可访问 + `/healthz` 返回 200

### 2. browser smoke

- [ ] 跑 browser smoke 指向生产:
  ```bash
  npm run smoke:agentbean-next-browser -- --url https://你的生产域名
  ```
  （或 `AGENTBEAN_NEXT_ENTRY_URL=https://... npm run smoke:agentbean-next-browser`）
- [ ] smoke 全绿:browser-target-ready / login / device-runtime / **memory-governance-flow**（创建 memory + 刷新恢复 + 治理状态）/ custom-agent-create / agent-reply-visible / post-refresh-dispatch

---

## 常见坑

- **PI Manager 不调 memory 工具**:memory 工具要靠 PI Manager 的 system prompt / runtime 暴露给 LLM。这是 P3-13 runtime inject（#604 `buildRuntimePrompt`）的产物——若 Agent 没看到 memory 工具,检查 daemon 的 runtime 是否把 phase3 工具列进了 prompt。
- **路由不进 Phase 3**:确认 `maxManagementPhase=3`（Web 治理面）+ worker 注册了 `supportedPhases: [1,2,3]`（V3 capability）。任一缺失 → `managementPhase3Preflight` 拒绝。
- **Agent inject 复用失败**:capsule 过期 / 来源失效 / scope 漂移 → 看 `capsule-injection-validator` 的 denial reason（治理面 capsule 状态 + audit）。
- **daemon 没发现 Agent**:机器上没装对应 CLI（claude-code/codex 等）,或权限/PATH 问题。可手动加 custom agent 绕过扫描。

---

## 完成判定

- P3-17 正负场景全过 + P3-18 browser smoke 全绿 → P3-17 / P3-18 **Green**
- P3-01..18 全 Green → verdict 改 **Ready**
