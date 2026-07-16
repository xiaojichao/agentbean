# AgentBean Codex Operating Contract

This project inherits the global Codex operating contract.

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

## Local Verification Contract

TypeScript changes to `apps/server-next`, `apps/daemon-next`, `apps/web-next`, `apps/web`, or `packages/*` MUST run the matching `build:*` (tsc) in addition to `vitest` before claiming done:

- `npm run build:server-next` after `apps/server-next` changes
- `npm run build:daemon-next` after `apps/daemon-next` changes
- `npm run build:web-next` after `apps/web-next` changes
- `npm run build:contracts` / `npm run build:domain` after `packages/*` changes
- `cd apps/web && npm run build` after `apps/web` changes

Why: `vitest` transpiles with esbuild and skips type checking; strict-mode errors (e.g. `noUncheckedIndexedAccess` making `arr[i]` possibly `undefined`) only surface under `tsc`. Running only `vitest` hides build breaks (see PR #259 review P1).

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels without aliases. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a multi-context layout. See `docs/agents/domain.md`.

## Default development workflow

Use direct solo execution by default. Matt Pocock's engineering skills are
on-demand gates inside the delivery loop, not a mandatory pipeline and not a
replacement for repository inspection, local verification, PR review, or
post-merge production checks.

1. **Establish current truth.** Inspect the repository, relevant GitHub issue or
   PR, and the domain context selected through `docs/agents/domain.md`.
2. **Choose the lightest intake path.** Execute a clear, bounded request
   directly. Use `to-prd` only when the conversation needs to become a durable
   product contract. Use `to-issues` only when an approved PRD or plan contains
   independently grabbable vertical slices. Use `triage` for incoming or
   underspecified GitHub issues; `ready-for-agent` means the issue is complete
   enough for autonomous implementation.
3. **Select an execution discipline only when it fits.** Use `diagnose` for hard
   bugs or performance regressions. Use `tdd` when test-first development is
   requested or materially reduces regression risk. Use `zoom-out` when the
   current code area is unfamiliar, and `improve-codebase-architecture` only
   for explicit architecture or refactoring work informed by domain docs and
   ADRs.
4. **Implement in an isolated worktree.** Keep the diff small and complete one
   user-visible vertical slice at a time. Use native subagents only for bounded,
   independent work that benefits from parallel execution.
5. **Verify and close the loop.** Run targeted tests plus the matching build
   required by the Local Verification Contract, create or update the Chinese
   PR, resolve review findings, merge, and verify the corresponding `main`
   CI/CD and production-facing truth when applicable. Follow the fast closeout
   rules in `docs/agents/pr-merge-gate.md`; do not repeat unchanged local
   verification while waiting to commit, push, review, or merge.
6. **Clean up conservatively.** Remove only worktrees and branches proven clean
   and merged; preserve dirty, unmerged, or uncertain local state.

Do not invoke `to-prd`, `to-issues`, `triage`, `diagnose`, `tdd`,
`improve-codebase-architecture`, or other workflow skills merely because they
are installed. Do not require Superpowers or heavy orchestration modes for
ordinary AgentBean development.

## Fast PR closeout contract

For review -> fix -> merge tasks, optimize for one trustworthy local validation
pass per source state:

- Before the first test, confirm Node 24 and prepare dependencies inside the
  current worktree. Never symlink or reuse another checkout's whole
  `node_modules`; never alternate repeatedly between symlink and install fixes.
- Run tests targeted to the changed behavior plus every matching build required
  by the Local Verification Contract. Do not add Phase-wide, repository-wide,
  SEA, browser, or production suites unless the changed surface or an explicit
  acceptance contract requires them.
- Record which commands passed for the current working-tree state. If relevant
  files have not changed, do not rerun those commands. A final diff review is
  one pass, not a new verification cycle.
- Once required local verification passes, immediately commit and push. Then
  resolve review threads, run the merge-readiness gate, and merge. Do not delay
  a ready merge for speculative cleanup or extra coverage.
- If a local `gh pr merge` helper fails only because a branch is owned by
  another worktree, use the GitHub API and continue from remote truth.
- After merge, monitor the required `main` CI/CD, SEA, deploy, smoke, and live
  health evidence. Do not rerun local suites unless a new remote failure points
  to a specific regression.
