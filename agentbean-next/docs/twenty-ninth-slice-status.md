# 第二十九切片实现状态

本文记录 AgentBean Next 第二十九切片当前已经落地的 preview channel create flow。

## 已实现

- `apps/web-next/preview/index.html`
  - 新增 `channel-create-form`，可创建 public/private channel。
  - `channels:snapshot` 会保存完整 channel 列表，而不是只保留第一个 channel。
  - message form 的 channel 下拉框改为使用完整 channel snapshot。
  - `channel:create` 成功后会立即选中新 channel，并等待 server snapshot 继续对齐真实状态。
  - 顶部状态面板 grid 改为自适应列，避免新增 Channels panel 后挤压桌面布局。
  - 列表项渲染统一转义 primary/meta 文本，避免 channel title 或 message body 作为 HTML 注入。
- `apps/server-next/tests/dev-server.test.ts`
  - preview smoke 增加 `channel-create-form` 与 `channel:create` 的静态托管检查。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P4-13` preview channel create flow 检查项。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/dev-server.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

## 暂未实现

这些不属于第二十九切片：

- 将 preview HTML 升级为正式 Next.js web-next 产品界面。
- channel member 管理、settings 与 archive/delete 的可视化入口。
- 浏览器自动化覆盖 localStorage session restore 与 channel create 的完整点击流。
