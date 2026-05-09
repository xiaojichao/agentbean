# Pipeline 编排增强设计文档

> Archived: Pipeline 功能已从当前代码中删除。本文档仅保留为历史设计记录，不代表当前实现，也不应作为实现待办使用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 AgentBean 的 Pipeline 从简单顺序执行升级为支持重试、条件分支、并行执行的可视化编排系统。

**Architecture:** 扩展现有 `pipeline.ts` 的解析器和执行器，新增 `pipeline-runs` 表实现状态持久化，Web 端新增 `/pipelines` 拖拽编辑器页面。

**Tech Stack:** TypeScript, Node.js 22, Socket.IO, SQLite (better-sqlite3), React + Next.js, Zustand, Tailwind CSS

---

## Context

当前 Pipeline 实现（`apps/server/src/pipeline.ts`）：
- 语法：`@agentName prompt → @agentName prompt`
- 执行模式：纯顺序，单线程
- 状态传递：通过 `prevArtifactIds` 或正则提取文件路径
- 错误处理：遇到失败立即终止
- 无执行历史、无持久化、无可视化

## Phase 1 — 增强执行引擎

### DSL 语法

```
// 顺序（现有，保持兼容）
@Codex-肖 生成登录页面 → @Claude-肖 审查代码

// 并行（新语法：& 连接同层节点）
@Codex-肖 写前端 & @Claude-肖 写API → @Claude-肖 集成测试

// 条件分支（新语法：if/then/else）
@Codex-肖 生成代码 → if ok then @Claude-肖 优化 else @Claude-肖 修复

// 带重试（新语法：retry(N) 后缀）
@Codex-肖 调用外部API retry(3)
```

### AST 节点类型

```typescript
type PipelineNode =
  | { type: 'step'; targetName: string; prompt: string; retry: number; timeoutMs: number }
  | { type: 'parallel'; branches: PipelineNode[][] }
  | { type: 'conditional'; condition: 'ok' | 'hasArtifacts'; thenBranch: PipelineNode[]; elseBranch: PipelineNode[] };
```

### 执行器增强

- **重试策略**：步骤失败时按 `retry` 计数重试，每次间隔指数退避（1s, 2s, 4s）
- **并行执行**：`Promise.all` 并行分发，等待所有分支完成后合并 artifactIds
- **条件判断**：`ok` = 上一步 `result.ok === true`；`hasArtifacts` = 上一步有 artifactIds
- **超时控制**：每步默认 5 分钟，可通过 `timeout(300000)` 语法覆盖

### 执行历史

每步结果写入 `messages` 表，`metaJson` 格式：

```json
{
  "kind": "pipeline-step",
  "runId": "prun-xxx",
  "stepIndex": 2,
  "totalSteps": 4,
  "status": "success",
  "durationMs": 5200,
  "agentId": "codex-shaw",
  "retries": 0
}
```

系统消息（`senderKind: 'system'`）记录 Pipeline 级别事件：
- `pipeline-start`
- `pipeline-complete`
- `pipeline-step-fail`
- `pipeline-retry`

---

## Phase 2 — 执行状态持久化

### 新增表 `pipeline_runs`

```sql
CREATE TABLE pipeline_runs (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  status      TEXT NOT NULL,  -- pending | running | paused | failed | success
  dsl         TEXT NOT NULL,   -- 原始 DSL 字符串
  ast_json    TEXT NOT NULL,   -- 解析后的 AST JSON
  steps_json  TEXT NOT NULL,   -- 执行状态数组
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

### Checkpoint 机制

- 每步完成后 UPDATE `pipeline_runs`
- Server 启动时扫描 `status = 'running'` 的记录，自动恢复执行
- 恢复时从 `steps_json` 中找到第一个未完成的步骤继续

---

## Phase 3 — 可视化编辑器

### 路由

- `/pipelines` — Pipeline 列表页（类似 `/channels`）
- `/pipelines/new` — 新建 Pipeline（可视化编辑器）
- `/pipelines/[id]` — 编辑/查看已有 Pipeline

### 组件设计

**PipelineCanvas** — 核心画布：
- 使用绝对定位 + SVG 连线（或纯 CSS border 连线）
- 节点类型：StepNode（Agent）、ParallelNode（并行容器）、ConditionNode（条件分支）
- 拖拽：react-dnd 或原生 HTML5 drag & drop
- 缩放/平移：鼠标滚轮 + 拖拽空白处

**NodeSidebar** — 左侧工具栏：
- Agent 列表（从 store.agents 读取 online 状态的 Agent）
- 条件节点、并行容器节点
- 拖拽到画布创建节点

**PropertyPanel** — 右侧属性面板：
- 选中 StepNode 时显示：Agent 选择、Prompt 输入、重试次数、超时时间
- 选中 ConditionNode 时显示：条件类型（ok/hasArtifacts）

**ExecutionOverlay** — 执行状态覆盖层：
- 节点边框颜色：灰=未执行、蓝=运行中、绿=成功、红=失败
- 连线动画：运行中的路径显示流动效果（CSS animation）

### 数据流

```
PipelineCanvas --(DSL string)--> server: pipeline:save
Server --(parsePipeline)--> AST --(store in DB)--> pipeline_runs
ChannelInput --(DSL string)--> server: message:send
Server --(detect pipeline)--> runPipeline
Server --(step events)--> /web --(update UI)--> ExecutionOverlay
```

### 模板与执行分离

- Pipeline 模板保存在 `pipeline_runs` 表（`status = 'template'`）
- 在 Channel 中触发执行时，复制模板创建新的 run 记录（`status = 'running'`）
- 执行历史在 Channel 消息流中展示（通过 `metaJson.kind = 'pipeline-*'` 过滤）

---

## 文件变更清单

### Phase 1
- `apps/server/src/pipeline.ts` — 重写 parsePipeline 为 DSL parser + AST；增强 runPipeline
- `apps/server/src/db.ts` — 检查 `pipeline_runs` 表是否存在（向后兼容）
- `apps/server/src/index.ts` — `message:send` 中集成新的 pipeline 检测逻辑

### Phase 2
- `apps/server/src/db.ts` — 新增 `pipeline_runs` 表 schema 和 DAO 方法
- `apps/server/src/pipeline.ts` — 新增 checkpoint/resume 逻辑
- `apps/server/src/index.ts` — Server 启动时恢复未完成的 pipeline

### Phase 3
- `apps/web/app/pipelines/page.tsx` — Pipeline 列表
- `apps/web/app/pipelines/[id]/page.tsx` — 编辑器页面
- `apps/web/components/pipeline-canvas.tsx` — 画布
- `apps/web/components/pipeline-node.tsx` — 节点渲染
- `apps/web/components/pipeline-sidebar.tsx` — 工具栏
- `apps/web/components/pipeline-property-panel.tsx` — 属性面板
- `apps/web/lib/socket.ts` — 新增 `pipeline:save`, `pipeline:run`, `pipeline:status` 事件
- `apps/web/lib/schema.ts` — 新增 Pipeline 相关类型

---

## 测试策略

- **Unit**: `pipeline.test.ts` 测试 DSL parser 所有语法变体
- **Unit**: `pipeline.test.ts` 测试 runPipeline 的重试、并行、条件逻辑
- **Integration**: Web namespace 测试 pipeline 触发 → 步骤事件 → 完成确认
- **E2E**: 浏览器中拖拽构建 Pipeline → 保存 → 在 Channel 中触发 → 验证执行历史

---

## Spec Self-Review

1. **Spec coverage**: 所有三个阶段的语法、数据模型、组件、测试均已覆盖
2. **Placeholder scan**: 无 TBD/TODO/"implement later"
3. **Type consistency**: `PipelineNode` AST 类型与 parser 输出、执行器输入一致；`metaJson` 格式在 Phase 1 和 Phase 3 中一致
