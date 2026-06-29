# Agent 成员详情页 Skills 区块 设计

- 日期：2026-06-29
- 分支：`feat/agent-skills-section`
- 范围：`packages/contracts` / `apps/daemon-next` / `apps/server-next` / `apps/web-next`
- 状态：已批准（含架构修正），待写实现计划

## 背景

对标 Raft（slock，raft.build）的 Agent 详情页。对比发现 Raft 详情页有一个 **Skills 清单区块**：按 Global/项目分组列出 agent 可用的全部技能（每个 skill 带 name + description），是 Raft 差异化最大的功能。

AgentBean 的智能体成员详情页（`apps/web-next/components/member-detail.tsx` 的 AgentProfile）目前完全没有"技能/能力"维度——既无数据模型、也无采集、也无 UI。

目标：给 AgentBean 的智能体成员详情页加一个 Skills 区块，展示每个 agent 运行环境里可用的技能清单（全局 + 项目级），对标 Raft 的能力可发现性。

## 现状（数据模型真相）

### 生产版本

- 生产 server = `apps/server-next`
- 生产 daemon = `apps/daemon-next`
- 生产 web = `apps/web-next`
- 共享契约 = `packages/contracts`
- `apps/server` / `apps/daemon` / `apps/web` 为 legacy，不作为依据。

### AgentBean 没有 skill 概念

- `AgentDto`（`packages/contracts/src/agent.ts`）现有字段无任何 skill/capability/ability 字段。
- daemon-next 上报 payload 不含 skill 数据；agents 表无 skills 列。
- 全 repo 搜 `skill`/`技能` 命中全部无关。

### ⚠️ agent 数据流的关键约束（writing-plans 阶段查证，推翻了初版"方案 A"）

agent 有两种来源，数据流不同：

- **scanned agent**（daemon 扫到的 claude-code/codex runtime、agentos gateway）：daemon 上报 `agent.registerBatch` → server `registerDiscoveredAgents`。
- **custom agent**（用户创建，如 mindmap-ppt）：web 调 `createCustomAgent`（`usecases.ts:1696`）→ server 直接 upsert，**不经 `registerDiscoveredAgents`**。

两条关键事实：

1. **`registerDiscoveredAgents` 显式跳过 executor-hosted**（`usecases.ts:1635` 注释："编程执行器（executor-hosted）不作为 Agent 成员，仅以 RuntimeDto 形式在设备详情页展示"）。claude-code/codex 即 executor-hosted。
2. **成员页显示规则**（`repositories.ts:1160`）：`NOT (category='executor-hosted' AND source!='custom')`——即 **custom 的 executor-hosted（mindmap-ppt）显示**，scanned 的不显示。

**结论**：详情页的目标 agent（custom、claude-code）**不经过 `registerBatch` 上报链路**。所以初版"skill 跟 agent `registerBatch` 上报 → `registerDiscoveredAgents` 入库"的方案 A **对 custom agent 不成立**。

**custom agent 必有 deviceId**（`CreateCustomAgentInput.deviceId: string` 必填，`createCustomAgent` 校验 device 存在且在线，upsert 写 `deviceId: device.id`）+ adapterKind + cwd。mindmap-ppt 显示"未知设备"是数据脏，非模型缺失——这使 custom agent 能按 `(deviceId, adapterKind, cwd)` 被 daemon 定向扫描。

### 两家 adapter 的 skill 机制（调研结论）

claude-code 与 codex 都有原生的 skills 机制，且**同构**：每个 skill = 目录 + `SKILL.md`，frontmatter 含 `name` + `description`。

| scope | claude-code | codex |
|---|---|---|
| 用户/全局 | `~/.claude/skills` | `~/.agents/skills`（⚠️ 不是 `~/.codex`） |
| 项目 | `<cwd>/.claude/skills` | `<cwd>/.agents/skills` |
| admin/system | — | `/etc/codex/skills` + 二进制内置（`skill-creator`/`plugin-creator`/`imagegen`） |

- codex 内置 system skills 打包在二进制里，磁盘扫描不到，需 daemon 维护静态清单。
- hermes / gemini / kimi-cli / openclaw 的 skill 机制**未调研**，MVP 不支持。

### daemon scan 与 server↔daemon 通信（复用基础）

- daemon 扫描入口 `scanBuiltinRuntimeAgents`（`apps/daemon-next/src/scanner.ts`），返回 `{runtimes, agents}`；rescan 5 分钟 + scan-cache。
- 上报：`device.runtimes` + `agent.registerBatch`（`emitWithAck`）。
- **server→daemon 下发**：`agentSocketsByDeviceId[deviceId].emit(device.scanRequested, {requestId, deviceId})`（`socket-server.ts:169`），当前**纯触发、无数据**，可扩展 payload 下发 custom agent 列表。
- daemon 监听 `scanRequested` → `scan()` → `reportDeviceSnapshot`（`daemon-next/src/index.ts:172`）。
- `listDeviceAgents` usecase（`usecases.ts:1470`）返回 device 的 agents（含 cwd/adapterKind）+ runtimes。
- `AGENT_EVENTS` 定义在 `packages/contracts/src/socket.ts`。
- daemon-next 已有 `js-yaml` 依赖（`config.ts` 的 `loadYamlConfig`），frontmatter 解析可复用。

## 目标 / 非目标

**目标**

1. custom agent（claude-code）详情页展示全局（`~/.claude/skills`）+ 项目（`<cwd>/.claude/skills`）skills，含数量与 name+description。
2. custom agent（codex）详情页展示全局（`~/.agents/skills`）+ 项目 + 3 个内置 system skill。
3. 默认折叠展示（数量徽章 + 前 5 预览 + 查看全部），按 system / user / project 分组。
4. 手动刷新（复用 `deviceEvents().scan(deviceId)`）+ rescan（≤5 分钟）自动刷新。
5. 新建 server↔daemon 的 custom agent skills 同步链路（复用 scan 触发时机）。
6. 扫描健壮：单个 skill 解析失败不影响其它 skill 与 agent 上报。

**非目标（后续工作）**

- 其它 adapter（hermes / gemini / kimi-cli / openclaw）的 skills 扫描：架构预留（配置表驱动），需先逐 adapter 调研能力机制再实现。
- skills 可编辑（启用/禁用）：只读 MVP。
- skill 详情页（看完整 SKILL.md）：MVP 只展示 name+description。
- 跨 agent skill 查询：需迁到独立 skill 表，后续。
- codex system skills 清单随版本自动同步：MVP 手动维护静态清单。

## 方案选择

**数据来源**：daemon 扫 agent 运行环境的 skills 目录（解析 SKILL.md frontmatter），对标 Raft。

**初版方案 A（skill 跟 agent `registerBatch` 上报）已被证伪**：`registerDiscoveredAgents` 跳过 executor-hosted，custom agent 不走该链路。

**采用方案 B：custom agent skills 同步链路**

- skills 仍存 `agent.skills_json`（per-agent，支持项目级 skills）。
- **新建独立上报事件 `agent.reportCustomSkills`**（绕过 `registerBatch` 的 executor-hosted 跳过逻辑）。
- 复用 scan 触发时机（启动 / rescan / 手动刷新）：server 在 `scanRequested` 下发该 device 的 custom agent 列表，daemon 扫每个的 skills 上报。

## 详细设计

### 0. 端到端数据流

```
[触发] daemon 启动 hello / rescan 5min / web 手动刷新(deviceEvents().scan)
server  listDeviceAgents 查该 device 的 custom agent 列表 {id, adapterKind, cwd}
   ↓ scanRequested payload 下发 customAgents（扩展，新）
daemon  scanRequested handler 收到 customAgents
        对每个 custom agent 扫 skills:
          全局 ~/.claude/skills | ~/.agents/skills         (scope=user)
          项目 <cwd>/.claude/skills | <cwd>/.agents/skills (scope=project)
          codex 内置 system 静态清单                       (scope=system)
   ↓ emitWithAck(agent.reportCustomSkills, {deviceId, items:[{agentId, skills}]})  ← 新事件
server  reportCustomSkills handler：按 agentId 更新 custom agent.skills_json
   ↓ agent snapshot 推送
web     AgentSkillsSection 读 agent.skills 展示
```

### 1. 数据模型（`packages/contracts/src/agent.ts`）

```ts
export interface SkillDto {
  name: string;                            // SKILL.md frontmatter.name
  description: string;                     // frontmatter.description，截断到 ~200 字符
  scope: 'user' | 'project' | 'system';    // 全局 / 项目 / 内置
  sourcePath: string;                      // skill 目录绝对路径；system 为 '<builtin>'
  adapterKind: AdapterKind;                // claude-code | codex
}

export interface AgentDto {
  // ...现有字段不变...
  skills?: SkillDto[];                     // 新增，可选
}
```

**migration**（server-next 新建 `0010_agent_skills.sql`）：
```sql
ALTER TABLE agents ADD COLUMN skills_json TEXT;
```

### 2. 事件契约（`packages/contracts/src/socket.ts`）

- 新增 `AGENT_EVENTS.agent.reportCustomSkills = 'agent:report-custom-skills'`。
- `scanRequested` payload 类型扩展：`{ requestId, deviceId, customAgents?: { id, adapterKind, cwd }[] }`。

### 3. daemon（`apps/daemon-next`）

- 新增 `scanCustomAgentSkills(customAgent: { id, adapterKind, cwd }, home): SkillDto[]`，配置表驱动（claude-code/codex），扫全局 + 项目 + system，frontmatter 用 `js-yaml` 解析。
- `scanRequested` handler 扩展：收到 `customAgents`，对每个调 `scanCustomAgentSkills`。
- 新增 `reportCustomSkills` 上报（`emitWithAck(agent.reportCustomSkills, ...)`）。

### 4. server（`apps/server-next`）

- `requestDeviceScan` / `deviceScan`：下发 `scanRequested` 时带 `customAgents`（由 `listDeviceAgents` 查询该 device 的 custom agent：`category='executor-hosted' AND source='custom'`，取 id/adapterKind/cwd）。
- 新增 `reportCustomSkills` handler + `updateAgentSkills` usecase：按 `agentId` 更新 `custom agent.skills_json`。
- migration `0010_agent_skills.sql`；`repositories.ts` `upsert`/`mapAgent` 加 `skills_json`（沿用 `args_json` 模式）。
- **不改 `registerDiscoveredAgents`**（仍跳过 executor-hosted；custom agent skills 走新 handler）。

### 5. 前端（`apps/web-next/components/member-detail.tsx`）

新增 `<AgentSkillsSection agent={agent} />`，放入 AgentProfile 的"创建的智能体"之后、"操作"之前。

- 无 skills → 不渲染该区块。
- 有 skills：标题"技能 (N)" + 数量徽章；按 system / user / project 三组，每组小标题 + 数量；每组前 5 个 skill（name 粗体 + description 灰字截断）；"查看全部"在区块内展开剩余（不弹窗）。
- 手动刷新：标题行右侧"刷新"按钮（RefreshCw 图标），点击 `deviceEvents().scan(agent.deviceId)`；agent 无 deviceId 时禁用。复用现有 `WEB_EVENTS.device.scan` → `device.scanRequested` → daemon `scan()` 反向链路，不改 server/daemon 的扫描触发。
- 复用现有 `<Section>` 组件样式。

### 6. 错误处理

daemon（扫描健壮，绝不阻断 agent 上报）：

- skills 目录不存在 → 空数组。
- 无 SKILL.md / frontmatter 缺 name → 跳过该 skill，warn 日志。
- 单个 custom agent 扫描抛错 → 该 agent `skills=[]`，不影响其它 custom agent。
- skill 数量 > 200 → 截断到 200，warn。

server：`skills_json` 解析失败 → undefined，不崩 `mapAgent`；skills 全链路可选。

## 测试计划

- **contracts**：`SkillDto` 类型、`AgentDto.skills` 可选、`agent.reportCustomSkills` 事件常量、`scanRequested` payload 扩展类型。
- **daemon**：`scanCustomAgentSkills` 单测（claude-code/codex mock 目录、全局/项目/system、目录缺失→空、无 SKILL.md/缺 name→跳过、>200→截断）；`scanRequested` handler 收到 customAgents 后扫描 + 上报；`reportCustomSkills` 上报 payload。
- **server**：migration `0010`；`reportCustomSkills` handler（按 agentId 更新 `skills_json`）；`upsert`/`mapAgent` skills 往返；`scanRequested` 下发 customAgents（含 `listDeviceAgents` 过滤 custom）。
- **web**：`AgentSkillsSection`（空→不渲染、有→徽章+分组+前 5、查看全部）；刷新按钮调 `deviceEvents().scan`。
- **端到端**：custom agent → scan → skills 上报 → 存储 → 详情页展示。

## 成功标准

1. custom agent（claude-code）详情页展示全局 + 项目 skills 及数量。
2. custom agent（codex）详情页展示全局 + 项目 + 3 个 system skill。
3. 装新 skill 后 ≤5 分钟（rescan）自动出现；也可点"刷新"立即触发。
4. 无 skills 的 agent（其它 adapter / 未扫到）不显示该区块，不报错。
5. 单个 skill 解析失败不影响其它 skill 与 agent 上报。
6. 全部测试通过。

## 关键风险

- **新建 server↔daemon 同步链路是本方案主要工作量**（新事件 + handler + `scanRequested` payload 扩展 + daemon 端 custom agent 扫描）。这是支持项目级 skills 的必然代价。
- **daemon 首次启动拿 custom agent 列表**（已定）：server 在 `device.hello` 成功后主动下发一次 `scanRequested`（含 `customAgents`），触发首次 custom skills 扫描；后续复用 rescan / 手动刷新。统一走 `scanRequested` 通道，不新增 hello ack 字段或 daemon 主动拉事件。
- codex system skills 静态清单随版本漂移：需偶尔手动同步。
- frontmatter 解析复用 `js-yaml`，但多行/特殊字符 description 的边界需测试覆盖。
- 其它 adapter 的 skill 机制未知：后续支持前必须逐个调研。
