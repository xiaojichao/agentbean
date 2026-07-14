# Issue tracker: GitHub

本仓库的 issues 和 PRD 存放在 GitHub Issues 中。所有操作使用 `gh` CLI。

## 约定

- 创建：`gh issue create --title "..." --body "..."`
- 查看：`gh issue view <number> --comments`
- 列出：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 添加或删除标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

仓库由当前目录的 `git remote` 推断。Codex 创建的 issue 标题、正文和评论遵守仓库的 GitHub Language Contract，使用中文。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub Issues 是默认请求入口；外部 PR 不进入同一套 triage 队列。

提交 PR 后，按 [PR 合并门禁](./pr-merge-gate.md) 核对最新提交的 CI、Review 与 thread 状态，不在 CI 刚绿时直接合并。

## Skill 操作语义

- “publish to the issue tracker”：创建 GitHub issue。
- “fetch the relevant ticket”：运行 `gh issue view <number> --comments`。
- 裸编号 `#42` 可能是 issue 或 PR；先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## Wayfinder 操作

- Map：使用标签 `wayfinder:map` 的单个 GitHub issue。
- Child ticket：优先使用 GitHub sub-issue；不可用时，在 map 的任务列表中链接，并在 child 顶部写入 `Part of #<map>`。
- Child 标签：`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- Blocking：优先使用 GitHub 原生 issue dependencies；不可用时，在 child 顶部记录 `Blocked by: #<n>`。
- Frontier：从 map 的未关闭 child 中排除仍被阻塞或已有 assignee 的条目，按 map 顺序选择第一个。
- Claim：`gh issue edit <n> --add-assignee @me`。
- Resolve：评论处理结果、关闭 child，并将上下文链接补入 map 的 Decisions-so-far。
