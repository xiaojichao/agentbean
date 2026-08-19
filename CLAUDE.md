# AgentBean Claude Code Bootstrap

Claude Code 在本仓库开发时，首先读取并遵守根目录 `AGENTS.md`。

`AGENTS.md` 是 AgentBean 对所有 Coding Agent 的唯一 canonical engineering contract；详细 Harness 分层与 Skill routing 见 `docs/agents/harness.md`。

## 规则

- 不复制或维护另一套 Claude 专属开发流程。
- GitHub Issue、CONTEXT / ADR、`.trellis/spec/`、PR merge gate 的真相源与优先级完全按 `AGENTS.md`。
- Trellis 只作为 context / memory / collaboration harness；没有 active Trellis task 时不要要求创建任务或进入额外 planning gate。
- 从 Codex 或其他 Coding Agent 接手时，继续同一个 Issue / branch / worktree / PR，并复用仍适用于当前源码状态的验证证据。
- Matt / Addy / Trellis Skills 都是按需 capability；Skill 自带通用流程不得覆盖 `AGENTS.md`。

## Project Skill adapters

AgentBean 的共享项目 Skill 正文放在 `.agents/skills/`；Claude Code 的 `.claude/skills/` 只放薄适配入口，指向同一份共享正文，避免 Codex / Claude 各维护一套逻辑。

当前 Claude 项目入口包括：

- Addy 适配：`source-driven-development`、`security-and-hardening`、`browser-testing-with-devtools`、`observability-and-instrumentation`、`deprecation-and-migration`
- Trellis 保留能力：`trellis-session-insight`、`trellis-channel`、`trellis-update-spec`、`trellis-spec-bootstrap`、`trellis-meta`、`trellis-continue`

没有为 `trellis-brainstorm`、`trellis-check`、`trellis-break-loop`、`trellis-finish-work` 或默认 implement/check worker 编排增加 Claude 入口；这些不是 AgentBean 默认 Routing。
