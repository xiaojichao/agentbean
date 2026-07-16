# PR Review 与合并门禁

PR 默认先以 Draft 创建，让 CI 在 Review 排队前收敛：

```bash
gh pr create --draft
# 修复 CI，直到当前 Head 稳定
npm run check:pr-review-readiness -- <PR号>
```

只有前置门禁输出 `READY`，才执行 `gh pr ready <PR号>` 并触发 Codex Review。若转为 Ready 已自动触发 Review，不要重复发送 Review 请求。

Review 完成后，使用合并门禁确认最新提交的 Review 已收敛：

```bash
npm run check:pr-merge-readiness -- <PR号>
```

机器可读输出：

```bash
npm run check:pr-merge-readiness -- <PR号> --json
```

只有合并门禁输出 `READY` 时才进入合并动作。检查器会阻止以下情况：

- PR 是 Draft、存在冲突或已经关闭；
- 最新提交的 CI/check 尚未完成或失败；
- Codex Review 尚未覆盖最新提交；
- 仍有 requested reviewer、blocking change request 或未解决 Review thread。

该命令不会自行合并 PR。修复 Review finding 并 push 新提交后，必须重新触发 Review；旧提交上的 Review 不满足门禁。

前置门禁同样是只读命令：它要求 PR 仍是 Draft、当前 Head 的 CI/check 已全部通过且查询结果完整，但不要求 Codex Review。CI 仍在运行、失败或缺失时保持 Draft，先修复再重跑，避免 Review 结果在新 push 后立刻过期。

退出码：`0` 表示 READY，`2` 表示仍有门禁阻塞，`1` 表示命令或 GitHub 查询失败。

## 快速收口规则

目标是让每个确定的源码状态只接受一次可信的本地验证，避免把等待合并变成重复测试循环。

### 1. 先稳定 worktree，再开始验证

- 全程使用 Node 24。
- 依赖必须属于当前 worktree；禁止把其他 checkout 的整套 `node_modules` 软链进来。
- 第一次测试前检查当前 worktree 的 `node_modules/.bin/vitest`、`node_modules/.bin/tsc` 和 workspace package links。缺失或指向其他 checkout 时，在当前 worktree 安装一次依赖，然后保持该布局不变。
- 依赖或 workspace link 错误属于环境问题。修复环境后重跑受影响命令，不要扩大成源码全量回归。

### 2. 按改动面选择一次验证矩阵

必须满足 `AGENTS.md` 的 Local Verification Contract：相关行为测试加对应 TypeScript build。除此之外：

- 普通 package/app 修改只跑目标测试和对应 build；
- 只有修改 Phase boundary、CI、SEA、browser、发布脚本或跨 package integration 时，才追加对应专项；
- Phase full suite 或 repository full suite 留给明确的 integration/closeout PR，不在每条 review finding 后重复运行；
- 同一源码状态下已经通过的命令直接复用结果。只有相关文件再次变化，或远端出现新的具体失败，才重跑受影响的命令。

### 3. 验证通过后立即进入 GitHub 收口

固定顺序：

1. 一次最终 diff/status 核对；
2. 中文 commit 并 push；
3. 回复并 resolve actionable review threads；
4. 运行 `npm run check:pr-merge-readiness -- <PR号>`；
5. READY 后立即 merge；
6. 只从远端监控 `main` required CI、SEA、deploy、smoke 与 live health。

此阶段禁止因为“再保险”重新执行已经通过的本地测试、build、依赖安装或无关审查。若 `gh pr merge` 只是被 multi-worktree 的本地 branch ownership 阻塞，改用 GitHub API merge；这不是代码 blocker。

### 4. 新失败只做定向回退

- 新 commit 触发的 required check 失败：读取失败 job/log，只重跑或修复对应 surface；
- 外部 deploy、billing、runner queue 或 transient upload 故障：与代码验证分层，按远端状态 targeted rerun；
- 同一环境错误连续出现时停止重复试错，保留已通过的源码证据并明确报告环境 blocker。
