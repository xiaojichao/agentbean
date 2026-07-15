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

## Session 级认领门禁

GitHub assignee 只能标识账号，不能区分使用同一账号的多个 Codex Session。任何 Session 在创建 worktree 或 PR 前，必须通过 Session Claim 门禁：

```bash
# 首次认领：写入 Session 标记、添加 assignee，并从 ready-for-agent 全局队列移除
npm run issue:claim -- <issue> --session <thread-id> --scope business

# 创建 worktree 前、创建 PR 前各复查一次；非最早有效 Claim 或已有关闭型 PR 时失败
npm run issue:claim-check -- <issue> --session <thread-id>

# 放弃任务时显式释放；移除 assignee，并在适用时恢复全局队列
npm run issue:claim-release -- <issue> --session <thread-id>
```

规则：

- `ready-for-agent` 表示“任意 Session 均可领取”的全局队列。当前 Session 内部产生、已明确归属的 workflow/CI/流程优化任务不得添加该标签。
- Claim 使用 Issue comment 中的机器可读 `thread/session ID`；只有当前 Issue assignee 写入的 marker 才可信，同一 GitHub 账号的 assignee 仍不能代替 Session Claim。
- 并发 Claim 时，以最早仍未释放的 Claim 为唯一 winner；其他 Session 必须停止。
- Claim 成功后立即移除 `ready-for-agent`，避免长运行 Session 再次扫描到已领取任务。
- 释放按 `releasing` 意图、清理 assignee/队列、最终 `release` marker 的顺序执行；中途失败可安全重试。winner 最终释放后必须移除自己的 assignee；如果它原本来自全局队列且 Issue 仍为 Open，同时恢复 `ready-for-agent`。非 winner 只能移除自己账号的 assignee，不得改动 winner 的 assignee 或队列。
- 门禁发现其他 Session Claim、Issue 非 Open、历史查询被截断，或已有活动 PR 通过 closing keyword 关闭同一 Issue 时，一律 fail closed。
- 创建 worktree 与创建 PR 是两个独立检查点；不能因为第一次检查通过就跳过第二次检查。

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
- Claim：使用 `npm run issue:claim -- <n> --session <thread-id> --scope <scope>`；禁止只执行 `--add-assignee @me`。
- Resolve：评论处理结果、关闭 child，并将上下文链接补入 map 的 Decisions-so-far。
