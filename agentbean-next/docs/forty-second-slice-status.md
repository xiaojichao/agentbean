# 第四十二切片：preview UI 对齐旧 AgentBean 工作台

本文记录 AgentBean Next 第四十二切片当前已经落地的 preview UI 对齐修复。

## 背景

本地 `apps/web-next/preview/index.html` 原本是为了验证 Socket.IO、custom agent、message dispatch 与 daemon-next runtime 的临时静态操作页。它能够证明协议链路可用，但第一屏不像旧 AgentBean 的产品工作台，也需要用户先手动进入默认团队，容易让本地 preview 看起来像开发调试器，而不是可替换旧 AgentBean 的预览。

这次修复把 preview 的定位收回到“旧 AgentBean 工作台迁移预览”：聊天是主轴，团队与频道在左侧，成员、设备、runtime 与 custom agent 操作在右侧。

## 已完成

- `apps/web-next/preview/index.html`
  - 将第一屏改为旧 AgentBean 风格的三栏工作台。
  - 打开本地 preview 时，如果没有保存 session，会自动使用默认 preview 用户进入当前团队。
  - 左侧频道列表支持点击切换当前频道。
  - 右侧设备列表支持点击切换当前 device，从而切换 custom agent runtime 下拉。
  - 对本地历史 SQLite 数据中的重复 device 行做 preview 层折叠，优先显示在线且带 runtime 的设备记录。
  - 保留原有 `auth:register/login`、`auth:whoami`、`device:list`、`agents:subscribe`、`channels:subscribe`、`channel:create`、`agent:create` 与 `message:send` 真实 socket 行为。
- `apps/web-next/tests/preview-page.test.ts`
  - 收紧 AgentBean-style shell 断言，避免只检查几个临时 class 名。
  - 覆盖无 session 时自动进入默认 preview team。
  - 覆盖重复 preview device 折叠，并保留带 runtime 的设备行。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/preview-page.test.ts --config vitest.config.ts --api.host 127.0.0.1
```

结果：7 个 preview-page 测试通过。

本机真实浏览器验证：

- `PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_NEXT_PORT=4101 npm run dev:agentbean-next`
- 打开 `http://127.0.0.1:4101/`
- 页面自动进入 `shaw · AgentBean`
- 左侧显示 `all` 与 `Ops` 频道
- 右侧显示 `Codex` custom agent、单个 `shaw-mac.local` device，以及 Codex / Claude / Gemini runtime
- Custom Agent 表单默认选中 `shaw-mac.local` 与 `Codex CLI`

## 剩余边界

- 这仍然是静态 preview 页面，不是正式 Next.js App Router 产品界面。
- 旧 AgentBean 的任务、成员详情、设备详情、设置等完整页面还没有迁入 web-next。
- production cutover 仍取决于 npm next packages 发布、GitHub variables/secrets 与 Railway production env/volume 准备。
