# 第五十八切片：post-flip strict cutover audit

本文记录 AgentBean Next 第五十八切片新增的 post-flip strict cutover audit。

## 背景

第五十二切片引入 ready-to-flip audit，用于在唯一缺口是 `AGENTBEAN_DEPLOY_TARGET=next` 时返回绿灯。这个命令适合 final flip 前证明外部状态已经准备好。

但 final flip 后，production smoke 不应继续只运行 ready-to-flip audit。真正替换旧 AgentBean 后，CI 必须证明 repository variable `AGENTBEAN_DEPLOY_TARGET=next` 也已经生效，否则 production smoke 只证明“等待授权”而不是“已经切换”。

因此本切片让 `AgentBean Next production smoke` 在两个阶段运行不同 audit：

- final flip 前：运行 `npm run audit:agentbean-next-ready-to-flip`。
- final flip 后：运行 `npm run audit:agentbean-next-cutover`。

两者都必须在 public entry smoke 与 business smoke 之前完成。

## 已落地

- `.github/workflows/ci-cd.yml`
  - `Run AgentBean Next ready-to-flip audit` 仅在 `vars.AGENTBEAN_DEPLOY_TARGET != 'next'` 时运行。
  - 新增 `Run AgentBean Next strict cutover audit`。
  - strict cutover audit 仅在 `vars.AGENTBEAN_DEPLOY_TARGET == 'next'` 时运行。
  - production smoke job 显式注入 cutover audit 所需的 GitHub variables/secrets 到环境变量，避免 Actions 内部依赖 `gh secret list` 权限。
  - `agentbean_next_entry_url` 仍可作为 smoke 目标 URL override；strict audit 使用单独的 `AGENTBEAN_NEXT_AUDIT_ENTRY_URL` 读取 repository variable `AGENTBEAN_NEXT_ENTRY_URL`，避免手动输入 URL 冒充仓库变量。
  - 两个 audit step 都位于 public entry smoke 之前。
- `scripts/check-agentbean-next-readiness.mjs`
  - `ci-runs-ready-to-flip-before-production-smoke` 现在会检查 ready-to-flip audit 的 pre-flip 条件。
  - 新增 `ci-runs-strict-cutover-after-final-flip-before-production-smoke`。
  - 新增 `ci-provides-production-env-for-production-smoke-audits`。
- `scripts/audit-agentbean-next-cutover.mjs`
  - 优先使用显式注入的 production env 校验 final flip、data dir、repository entry URL 与 secrets；本地缺少 env 时仍回退到 GitHub CLI 只读查询。
- `apps/server-next/tests/readiness-check.test.ts`
  - 将新检查纳入 readiness checker 的稳定检查列表。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 明确 production smoke 在 final flip 前跑 ready-to-flip audit，在 final flip 后跑 strict cutover audit。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-27`。

## 验证命令

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-ready-to-flip -- --json
```

## 剩余边界

- 本切片不设置 `AGENTBEAN_DEPLOY_TARGET=next`，不触发 production flip。
- strict cutover audit 的真实 production smoke 分支要等 final flip 后由 GitHub Actions 执行。
- 生产是否真正替换旧 AgentBean 仍取决于用户明确批准最终开关、设置 repository variable、production deploy flip、Next production smoke 与真实浏览器验收。
