# 第五十一切片：Railway Deploy Command Timeout Guard

本文记录 AgentBean Next 第五十一切片新增的 Railway deploy 命令级 timeout guard。

## 背景

第五十切片之后，`main` 上的 CI/CD run `27069190724` 在 `Deploy production` job 的 `Deploy Railway backend` step 长时间停留在 in progress。该 run 的 `AGENTBEAN_DEPLOY_TARGET` 仍为默认 `old`，所以它没有执行 AgentBean Next production readiness，也没有切换新系统；但这个现象说明生产发布流水线不能只依赖 job 级 timeout。

真正替换旧 AgentBean 前，发布流水线需要在 Railway CLI 卡住时可控失败，否则后续 production smoke、rollback 与审计证据都会被一个无界等待的 deploy step 拖住。

## 已完成

- `.github/workflows/ci-cd.yml` 中的 `Deploy Railway backend` step 改为最多 3 次尝试。
- 每次 `railway up` 前使用 `timeout 8m` 包裹，避免单次 CLI 调用无限挂起。
- `Deploy production` job 仍保留 `timeout-minutes: 30`，命令级上限与 job 级上限互相兜底。
- `scripts/check-agentbean-next-readiness.mjs` 新增 `ci-bounds-railway-deploy-command` 静态检查。
- `apps/server-next/tests/readiness-check.test.ts` 固化 readiness check 顺序，防止 timeout guard 被误删。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next -- --api.host 127.0.0.1 tests/readiness-check.test.ts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
```

## 仍未完成

- 尚未获得用户对 final production flip 的明确批准。
- 尚未设置真实 `AGENTBEAN_NEXT_ENTRY_URL`。
- 尚未取消或重跑已经卡住的旧 `Deploy production` run。
- 尚未在 production host 上真实运行 `AgentBean Next production smoke`。
- 尚未在 Railway production volume 上完成重启后 session/team/channel/message 复核。
