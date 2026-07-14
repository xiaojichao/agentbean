# PR 合并门禁

PR 创建后不是合并信号。CI 通过后，使用只读检查器确认最新提交的 Review 已收敛：

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

退出码：`0` 表示 READY，`2` 表示仍有门禁阻塞，`1` 表示命令或 GitHub 查询失败。
