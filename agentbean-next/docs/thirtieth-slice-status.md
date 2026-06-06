# 第三十切片实现状态

本文记录 AgentBean Next 第三十切片当前已经落地的 preview interaction regression harness。

## 已实现

- `apps/web-next/tests/preview-page.test.ts`
  - 读取 `apps/web-next/preview/index.html` 的内联脚本，并在 Node VM 中执行。
  - 提供最小 fake DOM、fake Socket.IO client、fake `FormData` 与 fake `localStorage`。
  - 覆盖保存 token 后的 `auth:whoami` session restore。
  - 覆盖恢复会话后的 `device:list`、`agents:subscribe` 与 `channels:subscribe` resubscribe。
  - 覆盖 `channel-create-form` submit 后发出 `channel:create` payload。
  - 覆盖新 channel 被写入 message channel select 与 session snapshot。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P4-14` preview interaction regression harness 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/preview-page.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

## 暂未实现

这些不属于第三十切片：

- 使用真实浏览器点击 preview 页面。
- 引入 Playwright 或其他浏览器自动化依赖。
- 将 preview HTML 升级为正式 Next.js web-next 产品界面。
