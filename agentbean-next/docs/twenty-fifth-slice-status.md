# 第二十五切片实现状态

本文记录 AgentBean Next 第二十五切片当前已经落地的 auth session token 与 `auth:whoami`。

## 已实现

- `apps/server-next`
  - `registerUser` 与 `loginUser` 返回 signed session token。
  - 新增 `whoami` use case，用 token 恢复 user 与 current team。
  - 篡改 token 返回 `UNAUTHENTICATED`。
  - `/web` Socket.IO handler 绑定 `auth:whoami`。
- `apps/web-next`
  - web socket client 新增 `whoami({ token })`。
- `agentbean-next/docs/verification-matrix.md`
  - 新增正式登录态恢复检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/first-slice.test.ts tests/socket-handlers.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/socket-client.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
```

## 暂未实现

这些不属于第二十五切片：

- session token 轮换、过期时间与 logout/revoke。
- production-only `AGENTBEAN_NEXT_SESSION_SECRET` 强制配置。
- web-next preview 页面自动用 token 调 `auth:whoami` 恢复 server session；当前 preview 仍保留第二十二切片的本地 session 恢复。
