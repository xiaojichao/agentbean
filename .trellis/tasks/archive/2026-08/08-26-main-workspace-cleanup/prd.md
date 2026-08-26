# 清理主工作区历史遗留

## Goal

在不丢失任何本地资料、不破坏其他 worktree 用户改动的前提下，清理主工作区的历史遗留状态，归档三个已有合并证据但仍显示为 `in_progress` 的 Trellis 任务，并让主工作区恢复为干净、最新的 `main` 协调区。

## Background

- 主工作区 `/Users/shaw/AgentBean` 执行前位于 `feat/plain-view-trim`，相对 `origin/main` 落后 23 个提交、领先 2 个提交，并有 12 项状态记录：3 个已跟踪修改、9 个未跟踪路径。
- 这 12 项内容并非都可直接丢弃：`AGENTS.md`、`docs/agents/domain.md`、`CONTEXT-MAP.md`、`docs/product-introduction.md`、`docs/agents/skills-registry.md` 与技能/领域文档治理相关，包含尚未进入 `origin/main` 的修订；其余本地文档和 `figma-design/` 也包含独有材料或生成状态。
- Trellis 仍列出 `00-bootstrap-guidelines`、`08-06-spec-bootstrap-refresh`、`08-16-align-task-card-review-panel` 三个 `in_progress` 任务；对应交付已分别通过 PR #1092（`09eee7af`）和 PR #1226（`f8d88a48`）合入。
- 本地 `main` 分支目前由 `/Users/shaw/AgentBean/.worktrees/fix-pi-secret-key-preflight` 占用。该 worktree 的 HEAD `b2f6fce6` 已被 `origin/main` 包含，但仍有 125 个已暂存文件（503 additions、13377 deletions），不能删除或重置。
- 本清理任务在独立 worktree `/Users/shaw/AgentBean/.worktrees/main-workspace-cleanup`、分支 `codex/main-workspace-cleanup` 中规划，基线为 `origin/main=fbe8afa7`。

## Requirements

### R1 可恢复备份

- 对主工作区的 3 个已跟踪修改导出 binary patch。
- 对 9 个未跟踪路径制作完整归档，包含 `figma-design/` 下被 Git 忽略的生成状态。
- 对占用 `main` 的旧 worktree 导出已暂存 patch，并记录 HEAD、分支、状态统计和 cached diff 指纹。
- 备份写入仓库外的独立恢复目录；生成 SHA-256 清单并验证 patch 非空、压缩包可列出。
- 任何清理或分支切换只能发生在备份验证通过之后。

### R2 保全主工作区内容并清洁状态

- 在外部备份完成后，把主工作区 12 项改动保存为带日期和任务名的 Git stash（包含未跟踪内容），作为仓库内第二恢复点。
- 不在本任务中决定、改写、提交或删除这些文档与设计材料。
- stash 完成后主工作区必须无已跟踪或未跟踪改动。

### R3 归档已完成的 Trellis 遗留任务

- 为三个任务补充对应合并 commit、PR URL 和归档原因，保留原 PRD 与历史记录。
- 使用 Trellis 任务命令归档到 `.trellis/tasks/archive/2026-08/`，使其状态变为 `completed`，不再出现在 active task 列表。
- `00-bootstrap-guidelines` 以被 `08-06-spec-bootstrap-refresh` 实际交付取代为依据归档；不伪造其模板式 checklist 的逐项完成记录。

### R4 安全释放并恢复 `main`

- 对 `/Users/shaw/AgentBean/.worktrees/fix-pi-secret-key-preflight` 只做同一 HEAD 的 detached 切换，释放 `main` 分支；不得清除、重置或改变其 125 个 staged 改动。
- detached 前后校验 HEAD、cached diff 指纹和 staged 文件数量完全一致。
- 主工作区清洁后切回本地 `main`，仅以 fast-forward 方式对齐 `origin/main`；不得 rebase、强制更新或覆盖历史。

### R5 变更隔离

- Trellis 归档和本任务工件只留在 `codex/main-workspace-cleanup` 工作区。
- 未经用户另行确认，不提交、不推送、不创建 PR，也不把本地资料整合进 `main`。

## Acceptance Criteria

- [x] AC1：仓库外恢复目录包含主工作区 tracked patch、9 个未跟踪路径的完整归档、旧 worktree staged patch、状态/HEAD 元数据和通过验证的 SHA-256 清单。
- [x] AC2：主工作区 12 项内容存在于命名清晰的 Git stash，且 stash 完成后、切换 `main` 前 `git status --short` 为空。
- [x] AC3：旧 worktree 仍位于 `b2f6fce6`，已 detached，且 detached 前后的 cached diff 指纹、125 个 staged 文件及统计一致。
- [x] AC4：主工作区位于 `main`，HEAD 与 `origin/main` 一致，工作区干净；`feat/plain-view-trim` 分支及其提交未删除。
- [x] AC5：在清理 worktree 中，三个历史任务位于 `.trellis/tasks/archive/2026-08/`、状态为 `completed`、记录对应 PR/commit，并且不再出现在该分支的 active task 列表；提交并纳入 `main` 前，主工作区仍会读取旧账本。
- [x] AC6：清理 worktree 的 diff 只包含本任务工件和三个任务的归档/元数据变更；没有代码、产品文档或其他用户改动。

## Out of Scope

- 判断 12 项本地内容哪些应进入仓库，或整理/发布这些内容。
- 清理、提交或丢弃 `fix-pi-secret-key-preflight` worktree 中的 125 个 staged 改动。
- 删除恢复目录、删除 stash、删除 `feat/plain-view-trim` 分支或移除任何现有 worktree。
- 提交、推送、创建 PR 或合并本清理分支。
- 改动另一个正在进行的 `pending-review-output-list` 独立 worktree。

## Technical Notes

- 使用仓库外恢复目录避免备份本身污染 Git 状态。
- 主工作区使用“外部归档 + Git stash”双重保全；旧 worktree 使用“外部 staged patch + 原地保留 index”双重保全。
- 分支释放只改变旧 worktree 的 HEAD 归属，不改变其文件、index 或基准提交。
