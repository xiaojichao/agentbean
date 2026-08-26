# 清理主工作区历史遗留：执行计划

## Ordered Checklist

1. 再次确认三个工作区的路径、分支、HEAD、状态和 `origin/main`，确认目标状态未漂移。
2. 在仓库外创建唯一恢复目录，并写入执行前元数据。
3. 导出主工作区 tracked binary patch；对 9 个明确的未跟踪路径制作完整 tar.gz；导出旧 main worktree cached binary patch。
4. 生成并验证 SHA-256 清单；验证两个 patch 非空、tar 可完整列出目标；记录旧 worktree cached diff 指纹与 staged 统计。
5. 在主工作区创建带日期/任务名的 `--include-untracked` stash，记录 stash ref，确认工作区清洁。
6. 在清理 worktree 为三个历史 Trellis 任务补充 PR/commit/归档说明，执行 `task.py archive`，确认 active task 列表只剩本任务和其他真实进行中的任务。
7. 在旧 main worktree 切换到当前同一 commit 的 detached HEAD；复核 HEAD、cached diff 指纹、staged 数量和统计不变。
8. 在主工作区切换到 `main`，以 `git merge --ff-only origin/main` 更新；确认 HEAD 等于 `origin/main`、状态干净，且 `feat/plain-view-trim` 仍存在。
9. 运行最终范围检查：恢复包可读、stash 可见、三个历史任务已归档、旧 worktree staged 状态未变、清理 worktree diff 仅包含 Trellis 账本。
10. 停在未提交状态，向用户汇报结果和精确恢复入口；提交/推送另行确认。

## Validation Commands

- `git status --short --branch`
- `git rev-parse HEAD` / `git rev-parse origin/main`
- `git worktree list --porcelain`
- `git diff --binary --exit-code` 的对应导出与非空检查
- `git diff --cached --binary` 的 SHA-256 前后对比
- `git diff --cached --name-only | wc -l`
- `tar -tzf <archive>`
- `shasum -a 256 -c <manifest>`
- `git stash list --format='%gd %H %s'`
- `python3 ./.trellis/scripts/task.py list`
- `python3 ./.trellis/scripts/task.py list-archive`
- `git diff --stat` 和 `git status --short`（清理 worktree）

## Risky Points and Stop Conditions

- 任一路径或 HEAD 与规划记录不一致：停止并重新审计。
- 主工作区出现新的第 13 项改动：停止，避免把并行用户内容误纳入本次 stash。
- 旧 worktree staged 数量、统计或指纹在 detach 前后不一致：停止，不切换主工作区。
- `main` 不能 fast-forward 到 `origin/main`：停止，不执行 rebase、reset 或强推。
- Trellis archive 命令产生任务目录之外的意外变更：停止并检查 diff。

## Review Gates Before Start

- PRD、设计和本执行计划已由用户确认。
- 当前 Trellis task 状态仍为 `planning`；获批后再运行 `task.py start`。
- Codex dispatch mode 为 `inline`，因此按项目流程跳过 `implement.jsonl` / `check.jsonl` 的真实条目门禁；Phase 2 开始时加载 `trellis-before-dev`。
