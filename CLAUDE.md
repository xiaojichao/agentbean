# AgentBean Claude Code Bootstrap

Claude Code 在本仓库开发时，首先读取并遵守根目录 `AGENTS.md`。

`AGENTS.md` 是 AgentBean 对所有 Coding Agent 的唯一 canonical engineering contract；详细 Harness 分层与 Skill routing 见 `docs/agents/harness.md`。

## 规则

- 不复制或维护另一套 Claude 专属开发流程。
- GitHub Issue、CONTEXT / ADR、`.trellis/spec/`、PR merge gate 的真相源与优先级完全按 `AGENTS.md`。
- Trellis 只作为 context / memory / collaboration harness；没有 active Trellis task 时不要要求创建任务或进入额外 planning gate。
- 从 Codex 或其他 Coding Agent 接手时，继续同一个 Issue / branch / worktree / PR，并复用仍适用于当前源码状态的验证证据。
- Matt / Addy / Trellis Skills 都是按需 capability；Skill 自带通用流程不得覆盖 `AGENTS.md`。
