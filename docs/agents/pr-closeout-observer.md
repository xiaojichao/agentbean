# PR closeout observer

`observe:pr-closeout` 把单个 PR 的开发与交付证据汇总为只读观察。它不调用 ready、review、rerun、merge、deploy 或任何生产写接口，也不替代 `check:pr-review-readiness`、`check:pr-merge-readiness`、GitHub branch protection 或人工生产授权。

## 运行

```bash
npm run observe:pr-closeout -- 123
npm run observe:pr-closeout -- 123 --json
npm run observe:pr-closeout -- 123 --skip-live-health
npm run observe:pr-closeout -- 123 --health-url https://api.agentbean.dev/healthz
npm run observe:pr-closeout -- 123 --health-url https://staging.example.com/healthz \
  --allow-live-target --allowed-health-origin https://staging.example.com
```

默认仓库由 `GITHUB_REPOSITORY` 或当前 `gh repo view` 决定，默认 live health URL 为 `https://api.agentbean.dev/healthz`。自定义目标必须同时显式传 `--allow-live-target` 与完全相同的 `--allowed-health-origin`，否则不会发起请求；也可以用 `--skip-live-health` 跳过。

## 观察链

observer 分别记录：

1. PR state、Draft、head SHA、merge commit SHA；
2. 当前 head 的 checks；
3. Codex 或约定替代 provider 的 latest-head review coverage；
4. unresolved review threads；
5. merge commit 精确对应的 `main` push `CI/CD` run；
6. `Deploy production` job；
7. `AgentBean Next production smoke` job；
8. `Wait for production server healthcheck` step；
9. 当前 live `/healthz` GET 结果。

`observedPhase` 只是上述事实的压缩标签，不是 ready、approval、acceptance 或生产授权。只有 checks 完整成功、latest-head review 已覆盖、threads 清零且整条交付/health 证据成功时才显示 `observed_complete`。PR head 不用于猜测 main run；只有 `mergeCommit.oid === run.head_sha` 才建立关联。0 个 run 标为 `missing`，多个标为 `ambiguous`。

## Fail-closed 边界

- checks、reviews/comments、review threads 或 jobs 分页截断时，对应状态为 `truncated`，不会推断成功或缺失。
- job/step 不存在时保留 `missing`；存在但未完成时保留 `pending`；失败、取消、跳过使用 GitHub 原 conclusion。
- live health 不会反推某个版本已经部署，也不会替代 workflow smoke。它只是观察时刻的 HTTP GET 事实。
- live health 只接受无凭据、无 query/fragment、路径精确为 `/healthz` 的 HTTP(S) URL；请求前校验 origin 与 DNS 解析均为公网地址，并禁止 redirect、限制超时与响应体大小。响应还必须满足 AgentBean Next health payload 契约。
- 查询错误退出码为 1；观察到 pending/failure/missing 不改变退出码，因为该命令不是门禁。
