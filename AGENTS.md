# AgentBean Codex Operating Contract

This project inherits the global Codex/OMX operating contract.

## GitHub Language Contract

For this repository, all GitHub issue and pull request titles, descriptions, comments, review summaries, and publish/yeet-generated PR content authored by Codex must be written in Chinese.

Do not use English for Codex-authored GitHub issue or pull request content unless the user explicitly asks for English in that specific task. Branch names, code identifiers, package names, stack traces, file paths, command names, and external API names may remain in their original language.

Before creating, updating, commenting on, or reviewing a GitHub issue or pull request, verify that the title and body are Chinese. Do not rely on `gh pr create --fill` or connector-filled defaults without rewriting the generated title and body into Chinese.

When using the GitHub publish/yeet workflow, the PR title must be a natural Chinese summary, and the PR body must use Chinese section headings and Chinese prose for:

- 关联 Issue（必须包含 GitHub closing keyword，例如 `Closes #123`；跨仓库用 `Closes owner/repo#123`）
- 变更内容
- 变更原因
- 用户或开发者影响
- 根因分析（修复类 PR 必填）
- 验证结果

## Worktree 协作约定

多个 agent/会话并行工作时**不要共用主 worktree（`/Users/shaw/AgentBean`）**，各自用独立 worktree 目录。共用主 worktree 会导致互相切换对方的 HEAD、把 commit 落到错的分支（实际事故：一个会话的 commit 被切到另一个会话正在用的分支；rebase/test 中途工作区文件被换成别的分支的内容）。

规则：

- **主 worktree** 留给统筹操作（代码 review、合并 PR、维护 `main`），尽量保持在 `main` 上。
- **任何并行任务**（新功能分支、探索性改动、隔离验证）先开独立 worktree，不要在主 worktree 里 `checkout` 别的分支：
  ```bash
  cd /Users/shaw/AgentBean
  git worktree add .worktrees/<分支名> <分支名>
  cd .worktrees/<分支名>
  ```
  在该目录里干活，**不要 `cd` 回主 worktree**。
- worktree 的分支一旦被占用，其他 worktree（含主 worktree）物理上无法再 `checkout` 它（Git 报 `fatal: already used by worktree`），这是天然护栏——主动利用它来防止串台。
- 任务完成或分支合并后，清理对应 worktree：`git worktree remove .worktrees/<分支名>`；已合并的本地分支用 `git branch -d` 删除。
