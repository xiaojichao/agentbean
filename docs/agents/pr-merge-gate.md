# PR Review 与合并门禁

## 第一段：Draft 稳定最新 Head

新 PR 先保持 Draft。修复、补测试和 push 都在 Draft 阶段完成；每次 push 后等待最新 Head 的 CI/check 稳定，再运行只读前置检查：

```bash
npm run check:pr-draft-review-readiness -- <PR号>
```

机器可读输出：

```bash
npm run check:pr-draft-review-readiness -- <PR号> --json
```

只有输出 `REVIEW_READY` 时，才把 PR 转为 Ready 并触发 Codex Review。该门禁要求 PR 仍为 Draft，且最新 Head 已产生完整、无截断、全部完成且成功的 checks；此阶段不要求 Codex Review。CI 缺失、运行中、失败或 GitHub checks 查询超过 100 项时均 fail closed。

```bash
gh pr ready <PR号>
```

## 第二段：Review 收敛后合并

PR 转为 Ready 不是合并信号。Codex Review 返回后，使用现有只读检查器确认最新提交的 Review 已收敛：

```bash
npm run check:pr-merge-readiness -- <PR号>
```

机器可读输出：

```bash
npm run check:pr-merge-readiness -- <PR号> --json
```

只有输出 `READY` 时才进入合并动作。检查器会阻止以下情况：

- PR 是 Draft、存在冲突或已经关闭；
- 最新提交的 CI/check 尚未完成或失败；
- Codex Review 尚未覆盖最新提交；
- 仍有 requested reviewer、blocking change request 或未解决 Review thread。

该命令不会自行合并 PR。修复 Review finding 并 push 新提交后，必须重新触发 Review；旧提交上的 Review 不满足门禁。

两条检查命令的退出码一致：`0` 表示对应阶段 READY，`2` 表示仍有门禁阻塞，`1` 表示命令或 GitHub 查询失败。完整流程为：Draft → 最新 Head CI 稳定 → `REVIEW_READY` → 转 Ready 并触发 Review → finding 修复与最新 Head Review 收敛 → `READY` → 合并。
