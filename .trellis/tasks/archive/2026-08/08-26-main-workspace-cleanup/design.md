# 清理主工作区历史遗留：技术设计

## Boundaries

本任务同时涉及三个独立工作区，但每个工作区只承担一种职责：

- `/Users/shaw/AgentBean`：待保全和恢复的主协调工作区。
- `/Users/shaw/AgentBean/.worktrees/fix-pi-secret-key-preflight`：仅释放 `main` 分支，完整保留 staged 状态。
- `/Users/shaw/AgentBean/.worktrees/main-workspace-cleanup`：承载 Trellis 规划工件和三个历史任务的归档变更。

恢复材料写到 `/Users/shaw/AgentBean-main-workspace-recovery/` 下的唯一时间戳目录，不写回任何 Git worktree。

## Safety Invariants

1. 先取证、再备份、再验证，最后才允许 stash、detach 或切换分支。
2. 不使用 `git reset`、`git clean`、`git checkout --`、强制分支更新或递归删除。
3. 旧 worktree detach 到它当前同一个 commit，保证工作树和 index 不需要重放。
4. 主工作区的本地分支和 stash 都保留；本任务不做不可逆删除。
5. 任一备份或指纹校验失败时立即停止，不继续后续动作。

## Data Flow

### 主工作区

`12 项本地状态` → `tracked binary patch + untracked tar.gz + 元数据/校验和` → 验证 → `git stash --include-untracked` → 干净工作区 → 切换 `main` → fast-forward 到 `origin/main`。

外部归档覆盖完整目录内容，Git stash 提供便捷恢复；两者互不依赖。

### 旧 main worktree

`HEAD + cached diff` → `staged binary patch + 指纹/统计` → 验证 → 同 HEAD detached → 再次核对指纹/统计。

该 worktree 不移除，125 个 staged 文件继续原地存在。之后若要恢复分支语义，可从其 HEAD 创建新的保全分支，不需要占用 `main`。

### Trellis 任务

`in_progress task` → 补充 merge evidence → `task.py archive` → `archive/2026-08/<task>`。

归档只更正任务账本，不修改历史交付代码，也不回填缺乏逐项证据的旧 checklist。

## Key Decisions and Trade-offs

- 不在本次清理中提交那 6 份有治理价值的文档/配置：避免把“恢复协调工作区”扩大成文档架构评审；代价是内容暂时只能从 stash 或恢复包继续整理。
- 不删除旧 main worktree：释放分支即可达到目标，并保留其全部用户状态；代价是磁盘空间暂不回收。
- 使用 stash 而非逐文件移动：能原样保留 tracked/untracked 关系和基础提交；外部 tar/patch 用于规避 stash 冲突或误操作风险。
- Trellis 归档变更留在独立清理分支且暂不提交：遵守仓库 Git 授权边界；代价是最终账本落地仍需用户后续确认提交。

## Compatibility and Rollback

- 主工作区资料：可从命名 stash 恢复；若与新 `main` 冲突，可在 `feat/plain-view-trim` 基线上新建临时 worktree后恢复，或使用外部 patch/tar 手动还原。
- 旧 worktree：detached 不改变内容；可在原 HEAD 创建保全分支。若 cached diff 指纹变化，停止并使用 staged patch恢复。
- 主分支：只允许 fast-forward；若不满足 fast-forward 条件，停止而不是改写分支。
- Trellis 归档：在未提交状态下可将目录移回原位置；提交后也可用普通反向提交恢复，不需要重写历史。

## Operational Notes

- 所有破坏性目标必须使用绝对路径或明确的相对路径列表，不使用宽泛 glob。
- 记录执行前后 `git status --short --branch`、HEAD、stash ref、任务列表与 worktree 列表，作为验收证据。
- 本任务没有 TypeScript 或产品代码变化，不触发 Local Verification Contract 的 build 要求。
