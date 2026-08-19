# AgentBean Coding Agent Operating Contract

本文件是 AgentBean 仓库对 **Codex、Claude Code、Cursor、Kimi Code 及其他 Coding Agent** 的唯一最高工程契约。平台可替换，项目流程不可随平台切换。

Codex 会话仍继承其全局 Codex operating contract；其他 Coding Agent 也可能有平台级规则。任何外部 Skill、平台默认工作流或自动编排与本仓库规则冲突时，以本文件和用户当前明确指令为准。

详细 Harness 分层、Skill 角色与跨 Agent 切换规则见 `docs/agents/harness.md`。

## Authority / Source-of-Truth Contract

发生冲突时按以下顺序处理：

1. 用户对当前任务的明确指令；
2. 本文件 `AGENTS.md`；
3. 当前 GitHub Issue / PR 的产品需求与验收契约；
4. `CONTEXT-MAP.md`、相关 `CONTEXT.md`、系统级与局部 ADR；
5. 与当前包/层相关的 `.trellis/spec/` 项目编码规范；
6. 当前 `.trellis/tasks/` Execution Packet（若存在）；
7. Matt Pocock / Addy Osmani / Trellis Skill 的通用流程建议。

一个问题只维护一个权威真相源：

- 产品需求、PRD、状态、优先级：GitHub Issues；
- 领域语言和上下文边界：`CONTEXT.md`；
- 架构理由：ADR；
- 项目专属编码规范：`.trellis/spec/`；
- 跨 Session / 跨 Agent 临时执行上下文：`.trellis/tasks/` + `trellis mem`；
- PR 可合并状态：`docs/agents/pr-merge-gate.md` + GitHub 远端事实。

外部 Skill 是 **capability，不是 authority**。不要因为 Skill 已安装就自动串成 Plan → Implement → Check → Review → Finish 流水线。

## GitHub Language Contract

对本仓库，所有 Coding Agent 创建或修改的 GitHub issue / PR 标题、正文、评论、Review 摘要与发布内容必须使用中文，除非用户在该任务中明确要求英文。

Branch 名、代码标识符、包名、stack trace、文件路径、命令名和外部 API 名可以保持原文。

创建、更新、评论或 Review GitHub issue / PR 前，先确认标题和正文符合中文约定。不要直接接受 `gh pr create --fill` 或其他工具生成的英文默认文案。

PR 正文至少使用中文说明：

- 关联 Issue（必须包含 GitHub closing keyword，例如 `Closes #123`；跨仓库用 `Closes owner/repo#123`）
- 变更内容
- 变更原因
- 用户或开发者影响
- 根因分析（修复类 PR 必填）
- 验证结果

## Pull Request Review 节制契约

避免「每次 push → 全量 review → 再改 → 再 push」的高往返（实测单 PR 可达 6–9 轮、占周期 65%–96%）。

Codex Cloud 自动触发 Review 时按以下规则节制；`@codex` 显式召唤时可做完整深度 Review。其他 Coding Agent 的本地 Review 同样遵守“一次深 Review + 后续只核对新增变化”的原则。

**Codex 自动触发 review（`pull_request` synchronize 事件唤起，非 @ 召唤）**：

- **Draft 或未标 `ready-for-review`**：不输出逐行长报告，最多一行摘要；仅 P0 阻塞级问题单列。
- **已 `ready-for-review`**：
  - P0（错误/安全/CI 红）/ P1（明显缺陷）：逐条列，标阻塞；
  - P2（风格/可读性/可选）：合并总结，明确标「可选、不阻塞合并」。
- **增量 review**：上次 Review 后的新 commit 仅小修时，只核对相关点，不重开全量。

**禁止**：连续 push 上重复粘贴未变化的旧建议；把 P2 风格项升级为阻塞项；对同一未变化源码状态重复完整 Review。

**合并门禁与 Cloud bot 注意**：

- `npm run check:pr-merge-readiness` 对文档-only 路径豁免「必须覆盖最新 head」（详见 `docs/agents/pr-merge-gate.md`）；代码改动后的 head 仍需有效 Review。
- 外部 `chatgpt-codex-connector` 触发策略在 Codex Cloud 设置，不会自动读取本文件。Cloud 中优先只在 ready-for-review 时自动 Review。
- Codex Cloud 额度不足时，使用 `docs/agents/pr-merge-gate.md` 定义的替代 Review 通道，可由 Claude Code、本地 Codex 或其他独立模型完成。

## Worktree 协作约定

多个 agent/会话并行工作时**不要共用主 worktree（`/Users/shaw/AgentBean`）**，各自使用独立 worktree。共用主 worktree 会导致互相切换 HEAD、commit 落错分支、rebase/test 期间文件被另一会话替换。

规则：

- **主 worktree** 留给统筹操作（代码 Review、合并 PR、维护 `main`），尽量保持在 `main`。
- **任何并行任务**先开独立 worktree，不要在主 worktree checkout 任务分支：
  ```bash
  cd /Users/shaw/AgentBean
  git worktree add .worktrees/<分支名> <分支名>
  cd .worktrees/<分支名>
  ```
- 在对应 worktree 中完成该任务，不要来回切到主 worktree。
- 某分支已被一个 worktree 占用时，其他 worktree 无法 checkout 同一分支；利用这一 Git 护栏避免串台。
- 任务完成并确认已合并后，清理对应 worktree 和已合并本地分支；脏、未合并或状态不确定的 worktree 不删除。

## Local Verification Contract

TypeScript changes to `apps/server-next`, `apps/daemon-next`, `apps/web-next`, `apps/web`, or `packages/*` MUST run the matching `build:*` (tsc) in addition to relevant behavior tests before claiming done:

- `npm run build:server-next` after `apps/server-next` changes
- `npm run build:daemon-next` after `apps/daemon-next` changes
- `npm run build:web-next` after `apps/web-next` changes
- `npm run build:contracts` / `npm run build:domain` after `packages/*` changes
- `cd apps/web && npm run build` after `apps/web` changes

Why: `vitest` transpiles with esbuild and skips type checking；strict-mode errors 只会在 `tsc` 暴露。仅跑 `vitest` 会隐藏 build break（见 PR #259 review P1）。

同一源码状态已通过的命令直接复用证据。只有相关文件再次变化，或远端出现新的具体失败，才重跑受影响检查。

## Agent Skills

### Issue tracker

Issues 和 PRD 的权威位置是 GitHub Issues。见 `docs/agents/issue-tracker.md`。

### Triage labels

Triage 使用五个 canonical labels，不建立别名。见 `docs/agents/triage-labels.md`。

### Domain docs

Domain documentation 使用 multi-context 布局。见 `docs/agents/domain.md`。

### Trellis：Context / Memory / Collaboration Harness

Trellis **不是 AgentBean 默认 Workflow Engine**。保留它的上下文与跨 Agent 能力：

- `.trellis/spec/`：项目专属编码知识；
- `.trellis/tasks/`：只用于跨 Session / 跨 Coding Agent / 大型多阶段任务的 Execution Packet；
- `trellis mem` / `trellis-session-insight`：恢复 Codex、Claude Code 等历史上下文；
- `trellis channel`：需要持久事件日志的跨 Agent 讨论、worker、Review；
- `trellis-update-spec`：确实产生可复用实现知识时按需更新 spec；
- `trellis-spec-bootstrap`：代码结构显著变化后刷新 spec；
- `trellis-meta`：维护 Trellis 本身。

以下 Trellis 能力可以继续存在于安装生成文件中，但**不进入 AgentBean 默认 Routing，也不作为完成门禁**：

- `trellis-brainstorm`
- `trellis-break-loop`
- `trellis-check`
- `trellis-finish-work`
- 默认 `trellis-implement` / `trellis-check` / `trellis-research` 子 Agent 编排

没有 active Trellis task 时，不要为了 Trellis 而向用户索要 task-creation consent。清晰任务直接按本文件执行。

GitHub Issue 始终是任务真相源；Trellis task 只是 Execution Packet。切换 Coding Agent 时先读取 GitHub / git / CONTEXT / ADR / spec 的当前事实，再利用 Trellis task / `trellis mem` 补回 Session 上下文。

### Matt Pocock Engineering Skills

Matt Pocock Skills 是按需 Engineering Gates，不是 mandatory pipeline。

**推荐路由**：

- `triage`：incoming / underspecified GitHub Issue；
- `to-spec`：当前讨论需要成为持久产品契约；
- `to-tickets`：已批准的大需求需要拆成可独立领取的垂直切片；
- `wayfinder`：超过单 Session 容量的大型路线图；
- `grill-with-docs`：产品或领域决策仍不清晰；
- `diagnosing-bugs`：hard / flaky / performance regression；
- `tdd`：用户明确要求 test-first，或 test-first 能显著降低高风险回归；
- `domain-modeling`：领域术语或边界确有缺口；
- `codebase-design`：模块接口、seam、深模块设计；
- `code-review`：一次独立深 Review，或替代 Codex Cloud Review；
- `research`：需要高可信外部资料；
- `improve-codebase-architecture`：显式架构/重构工作；
- `resolving-merge-conflicts`、`prototype`、`wizard`：匹配显式场景时按需。

Matt 的 `implement` **不作为 AgentBean 默认编排入口**。普通实现由当前 Coding Agent 直接完成，受本仓库 worktree / verification / PR / merge 契约约束。

### Addy Osmani Selected Quality Skills

AgentBean 只引入五个项目内适配版；它们是专项质量门，不构成流水线：

- `source-driven-development`：第三方框架 / SDK / CLI / 平台 API 的正确性依赖具体版本或当前官方文档；
- `security-and-hardening`：认证、授权、Team 隔离、Device credential、文件/Artifact、外部输入、Agent invocation、远程执行等安全边界；
- `browser-testing-with-devtools`：真实 Browser runtime、Socket 状态、Network、Console、可访问性或视觉行为属于验收范围；
- `observability-and-instrumentation`：生产 I/O、重试、跨进程/跨服务调用或诊断信号不足；
- `deprecation-and-migration`：legacy → next、Schema / 协议迁移、authority cutover、兼容路径退役。

不要因为这些 Skill 已安装而对每个 PR 依次运行全部五个。

## Default Development Workflow

默认采用 direct solo execution。只有任务实际需要时才增加 Skill、Trellis Execution Packet 或独立 Agent。

1. **Establish current truth.** 检查 repository、相关 GitHub Issue / PR，以及 `docs/agents/domain.md` 选出的 domain context、ADR 和相关 `.trellis/spec/`。
2. **Choose the lightest intake path.** 清晰、边界明确的请求直接执行。只有需求仍不完整时用 `triage` / `grill-with-docs`；需要持久产品契约时用 `to-spec`；已批准的大需求需要拆分时用 `to-tickets`；超大路线图才用 `wayfinder`。
3. **Create Trellis context only when it earns its cost.** 仅跨 Session、跨 Coding Agent 或大型多阶段任务创建 Execution Packet。普通任务不要创建第二套 Task。
4. **Select execution discipline only when it fits.** 难 Bug 用 `diagnosing-bugs`；合适时用 `tdd`；模块设计用 `codebase-design`；显式架构工作才用 `improve-codebase-architecture`；第三方版本敏感、安全、浏览器 runtime、可观测性、迁移分别按需使用对应 Addy Skill。
5. **Implement in an isolated worktree.** Diff 保持小且完整；一次完成一个用户可见 vertical slice。Native subagent / `trellis channel` 只用于边界清晰、独立且确实受益于并行或独立上下文的工作。
6. **Verify and close the loop.** 跑 targeted tests + Local Verification Contract 要求的 matching build；创建/更新中文 PR；必要时做一次独立深 Review；解决 actionable findings；按 `docs/agents/pr-merge-gate.md` 收口、合并并验证对应 main CI/CD 与生产事实。
7. **Clean up conservatively.** 只清理已证明 clean 且 merged 的 worktree / branch；保留 dirty、unmerged 或不确定状态。

不要仅因为 Skill 已安装就调用 `to-spec`、`to-tickets`、`triage`、`diagnosing-bugs`、`tdd`、`code-review`、Addy quality skills 或 Trellis workflow skills。Superpowers 已卸载，不得把它作为 AgentBean 开发依赖或前置条件。

## Coding Agent Handoff Contract

Codex、Claude Code 或其他 Coding Agent 因额度、上下文或工具限制切换时，不重新发明流程：

1. 新 Agent 先读 `AGENTS.md`；
2. 读取当前 GitHub Issue / PR / comments；
3. 检查 branch、worktree、git status、最近 commit；
4. 读取相关 CONTEXT / ADR / `.trellis/spec/`；
5. 若存在 Execution Packet，再读取其 task artifacts；需要历史对话时使用 `trellis mem`；
6. 复用仍适用于当前源码状态的测试/Review 证据；只对新的代码变化重跑受影响检查；
7. 继续同一 Issue / branch / PR，不因模型切换而重新 Planning、重新建任务或重做无变化的全量 Review。

平台专属规则文件（如 `CLAUDE.md`）只做 thin bootstrap，指向本文件，不复制整套工程规则。

## Fast PR Closeout Contract

对 review → fix → merge 任务，每个确定源码状态只做一次可信本地验证：

- 第一次测试前确认 Node 24，并在当前 worktree 准备依赖。禁止软链或复用其他 checkout 的整套 `node_modules`。
- 跑改动行为对应的 targeted tests + Local Verification Contract 要求的 matching build。除非改动面或验收契约明确要求，不追加 Phase-wide、repo-wide、SEA、browser 或 production suite。
- 记录当前 working-tree state 已通过的命令；相关文件未变化时不重跑。最终 diff review 是一次检查，不开启新验证循环。
- Required local verification 通过后立即 commit / push，然后解决 Review threads、运行 merge-readiness gate 并合并。不要因为 speculative cleanup 或额外覆盖延迟 ready merge。
- 若本地 `gh pr merge` 只因 multi-worktree branch ownership 失败，改用 GitHub API；这不是代码 blocker。
- 合并后只从远端监控 required `main` CI/CD、SEA、deploy、smoke 与 live health。只有新的远端具体失败指向某个回归时才回到本地重跑相关 suite。
