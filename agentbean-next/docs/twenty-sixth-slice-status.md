# 第二十六切片实现状态

本文记录 AgentBean Next 第二十六切片当前已经落地的 preview `auth:whoami` session restore。

## 已实现

- `apps/web-next/preview/index.html`
  - auth 成功后保存 server 返回的 session token。
  - 页面重连或刷新恢复 session 时，先调用 `auth:whoami`。
  - 使用 server 返回的 user/current team 覆盖本地 session 中的 user/team。
  - token 无效或订阅失败时清除本地 session。
- `apps/server-next/tests/dev-server.test.ts`
  - dev server 托管的 preview HTML 必须包含 `auth:whoami` 与 token session 保存逻辑。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/dev-server.test.ts --config vitest.config.ts --api.host 127.0.0.1
```

## 暂未实现

这些不属于第二十六切片：

- 使用浏览器自动化验证 localStorage token restore 的完整点击链路。
- production web-next 正式界面替换旧 `apps/web`。
- logout/revoke 与 token expiry。
