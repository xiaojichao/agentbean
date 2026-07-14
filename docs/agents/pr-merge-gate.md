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
