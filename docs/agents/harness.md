# AgentBean Engineering Harness

本文定义 AgentBean 在 Codex、Claude Code、Cursor、Kimi Code 等 Coding Agent 之间共享的工程 Harness。它解决的是“项目如何开发”，而不是绑定某个模型或某套外部 Skill。

## 1. 核心原则

1. **平台可替换，项目契约不可替换。** Coding Agent 可以切换，`AGENTS.md` 仍是仓库唯一最高工程契约。
2. **外部 Skill 是能力，不是流程主权。** Matt Pocock、Trellis、Addy Osmani 的 Skill 只能在匹配场景按需调用，不得接管普通开发流程。
3. **最轻流程优先。** 清晰、局部、可验证的任务直接执行；只有复杂度、风险或上下文持续性确有需要时才增加额外机制。
4. **一个问题只有一个权威真相源。** 产品需求、领域语言、架构决策、编码规则、执行上下文、PR 合并状态分别落到固定位置，避免重复维护。
5. **同一源码状态只验证一次。** 本地验证、Review、CI、部署验证按证据复用，不做无意义循环。

## 2. 权威层级

发生冲突时按以下顺序处理：

1. 用户对当前任务的明确指令
2. 根目录 `AGENTS.md`
3. GitHub Issue / PR 中当前任务的验收契约
4. `CONTEXT-MAP.md`、相关 `CONTEXT.md`、`docs/adr/` 与局部 ADR
5. `.trellis/spec/` 中与当前包/层相关的项目编码规范
6. 当前 `.trellis/tasks/` Execution Packet（若存在）
7. Matt / Addy / Trellis Skill 自带流程与通用建议

外部 Skill 与上层规则冲突时，以上层规则为准；不要为了遵循 Skill 而引入额外审批、重复 Review、重复测试或额外任务系统。

## 3. 真相源矩阵

| 问题 | 权威位置 | 说明 |
|---|---|---|
| 我们要做什么？ | GitHub Issue / PRD | 产品需求、范围、验收标准、优先级、负责人 |
| 这个领域叫什么、边界是什么？ | `CONTEXT.md` | 统一术语、上下文边界、领域模型 |
| 为什么采用这个架构？ | ADR | 设计决策、权衡、兼容与迁移理由 |
| 在这个仓库里代码应怎么写？ | `.trellis/spec/` | 项目专属实现约定、契约、测试与反例 |
| 当前跨 Session / 跨 Agent 工作做到哪里？ | `.trellis/tasks/` + `trellis mem` | 临时执行材料与历史会话恢复 |
| PR 是否可合并？ | `docs/agents/pr-merge-gate.md` + GitHub | CI、Review、thread、merge readiness |

### `.trellis/spec/` 不应保存什么

- 产品需求与优先级
- 领域术语的唯一解释
- 系统级架构理由
- 当前 PR 的临时实施计划

这些内容应分别回到 GitHub Issue、`CONTEXT.md`、ADR、Execution Packet。

## 4. Trellis 的定位：Context / Memory / Collaboration Harness

Trellis 在 AgentBean 中不再是默认 Workflow Engine。保留并优先使用以下能力：

- `.trellis/spec/`：项目专属编码知识
- `.trellis/tasks/`：跨 Session / 跨 Agent / 大型任务的 Execution Packet
- `trellis mem` / `trellis-session-insight`：跨 Codex、Claude Code 等会话恢复上下文
- `trellis channel`：多 Agent 协作、独立 Review、讨论与持久事件日志
- `trellis-update-spec`：确有可复用编码知识时更新 `.trellis/spec/`
- `trellis-spec-bootstrap`：代码结构发生显著变化时刷新项目规范
- `trellis-meta`：维护 Trellis 本身的项目内配置

### 不作为默认开发流程的 Trellis 能力

以下能力可以继续存在于 Trellis 安装生成的文件中，但 AgentBean 不主动路由到它们，也不把它们作为完成条件：

- `trellis-brainstorm`
- `trellis-break-loop`
- `trellis-check`
- `trellis-finish-work`
- 默认 `trellis-implement` / `trellis-check` / `trellis-research` 子 Agent 编排

只有用户显式要求 Trellis 工作流，或当前任务确实需要其特殊能力时，才可单独调用；仍受 `AGENTS.md` 约束。

### Trellis Task 何时创建

仅当至少满足一项：

- 预计跨多个 Coding Agent 或模型额度周期继续
- 预计跨多个 Session，需要可靠恢复执行上下文
- 一个任务包含明显的多阶段研究/设计/实现材料，单个 GitHub Issue 不适合作为临时执行缓存

普通 UI 小改、简单 Bug、单文件重构、明确字段修改等不创建 Trellis Task。

### Trellis Task 是 Execution Packet，不是 Issue Tracker

GitHub Issue 始终是任务权威源。Trellis Task 只缓存执行上下文，建议在 `task.json.meta` 或任务说明中记录：

- `github_issue`
- branch
- worktree
- PR URL
- 当前阶段或 handoff 摘要

切换 Codex ↔ Claude Code 时，先读取 GitHub Issue 与仓库真相，再利用 Execution Packet / `trellis mem` 恢复丢失上下文；不要把旧 Session 的记忆当成比代码、Issue、ADR 更高的真相源。

## 5. Matt Pocock Skills：工程技巧层

### 推荐保留

- `grill-with-docs`：产品/领域决策仍不清晰时深入澄清
- `triage`：进入 GitHub Issue 的模糊请求
- `to-spec`：将讨论沉淀为 GitHub Issue / 产品契约
- `to-tickets`：把已批准的大需求拆成可独立领取的垂直切片
- `wayfinder`：超过单 Session 容量的大型路线图
- `diagnosing-bugs`：复杂、flaky、性能或难复现 Bug
- `tdd`：用户要求 test-first，或高风险行为适合红绿循环
- `domain-modeling`：领域术语或边界确有缺口
- `codebase-design`：模块接口、seam、深模块设计
- `code-review`：一次深 Review，或 Codex Cloud 额度不足时的替代 Review
- `research`：需要高可信外部资料的研究
- `improve-codebase-architecture`、`resolving-merge-conflicts`、`prototype`、`wizard`：显式场景按需

### 不进入默认 Routing

`implement` 不作为 AgentBean 的默认编排入口。AgentBean 已有更具体的 worktree、验证、PR、Review、merge 与生产验证契约；普通实现由当前 Coding Agent 直接完成。

### Review 节制

`code-review` 不是“每写完一点代码就再审一次”。推荐触发：

- 用户明确要求 Review
- PR 准备从 Draft 转 Ready
- 高风险安全/权限/跨层改动
- Codex Cloud Review 额度不足，需要独立模型替代 Review

同一未变化源码状态不重复运行完整 Review。

## 6. Addy Osmani Skills：专项质量门

AgentBean 只引入五个项目内适配版，均为 MIT 上游 Skill 的窄化版本。它们不能成为统一 Pipeline。

### `source-driven-development`

触发：第三方框架、SDK、CLI、平台 API 的正确用法依赖具体版本或近期文档。

典型：Next.js、Socket.IO、Node、GitHub API、Coding Agent CLI、外部 AgentOS。

不触发：纯业务逻辑、重命名、机械改动。

### `security-and-hardening`

触发：认证、授权、Team 隔离、Device credential、文件/Artifact、外部输入、Agent invocation、远程执行、秘密信息。

不触发：纯样式、无数据边界变化的 UI 改动。

### `browser-testing-with-devtools`

触发：浏览器真实行为是验收的一部分，尤其是 Socket 状态、交互、Network、Console、可访问性、视觉回归。

不触发：纯后端或 CLI 修改。

### `observability-and-instrumentation`

触发：新增/修改生产 I/O、重试、跨进程/跨服务调用、Daemon/Server/Agent Runtime 链路，或现有故障缺少足够诊断信号。

不要求每个普通 PR 都新增 metrics/tracing。

### `deprecation-and-migration`

触发：legacy → next、协议/Schema 迁移、authority cutover、旧 Runtime/兼容路径退役、双写/双读/逐步切换。

不触发：普通新增功能。

## 7. 默认任务 Routing

```text
收到请求
  |
  +-- 清晰、局部、可验证？ --------------------> 直接执行
  |
  +-- GitHub Issue 不完整？ --------------------> triage
  |
  +-- 产品/领域决策不清？ ----------------------> grill-with-docs / domain-modeling
  |
  +-- 跨 Session / 跨 Coding Agent？ -----------> Trellis Execution Packet + mem
  |
  +-- 复杂 Bug / flaky / performance？ ---------> diagnosing-bugs
  |
  +-- test-first 有明显价值？ ------------------> tdd
  |
  +-- 第三方 API / framework 版本敏感？ --------> source-driven-development
  |
  +-- 安全/权限/输入边界？ ----------------------> security-and-hardening
  |
  +-- 浏览器 runtime 行为？ ---------------------> browser-testing-with-devtools
  |
  +-- 生产可观测性缺口？ ------------------------> observability-and-instrumentation
  |
  +-- 迁移/退役/cutover？ -----------------------> deprecation-and-migration
  |
  +-- 需要一次独立深 Review？ -------------------> code-review / trellis channel
  |
  `-- 收口 --------------------------------------> AgentBean PR merge gate
```

一个任务可以命中多个专项能力，但只调用真正影响正确性的最小集合。不得因为 Skill 已安装而自动串成流水线。

## 8. Coding Agent 切换协议

当一个 Agent 因额度、上下文或工具限制停止，下一 Agent 继续时：

1. 读取 `AGENTS.md`。
2. 读取当前 GitHub Issue / PR 与评论。
3. 查看当前 branch、worktree、git status、最近 commit。
4. 读取相关 `CONTEXT.md` / ADR。
5. 读取相关 `.trellis/spec/`。
6. 若存在 Execution Packet，读取 task artifacts；需要历史对话时使用 `trellis mem`。
7. 只复用仍然适用于当前源码状态的测试/Review 证据；相关文件变化后才重跑受影响检查。
8. 继续同一项目流程，不因为换了 Codex、Claude Code 或其他 Agent 而重新 Planning、重新建任务或重新做全量 Review。

## 9. 平台文件策略

- `AGENTS.md`：唯一 canonical contract。
- `CLAUDE.md`、平台专属 rules/settings：只做薄 bootstrap，指向 `AGENTS.md` 和必要的平台能力，不复制完整流程。
- `.trellis/workflow.md`：只描述 Trellis 上下文/Execution Packet 生命周期，不覆盖 `AGENTS.md` 的开发流程。
- 平台 hook：只注入 context state，不用 hook 强制 Plan → Implement → Check → Finish 状态机。

这样可以避免 `AGENTS.md`、`CLAUDE.md`、Cursor rules、Kimi rules 长期发生版本漂移。
