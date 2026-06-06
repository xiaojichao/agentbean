# 第四十五切片：本地 Preview 第一屏贴近旧 AgentBean

本文记录 AgentBean Next 第四十五切片当前已经落地的本地 preview UI 修正。

## 背景

上一轮本地 preview 已经可以真实启动 `server-next`、连接 `daemon-next`、创建 custom agent、发送消息并看到 agent reply。但第一屏仍带有明显的协议验证器痕迹，例如 `Next local` 标记、裸露的登录表单、裸露的 secret/env 输入区，以及不够接近旧 AgentBean 的 Team 工作台观感。

这会造成一个替换风险：即使底层链路可用，用户打开页面后仍会觉得它不是 AgentBean，而是临时调试工具。

## 已完成

- `apps/web-next/preview/index.html` 的页面标题改为 `AgentBean`。
- 侧边栏品牌副标题从 `Next local` 改为 `私有 Agent 团队`。
- Team 入口改成旧 AgentBean 风格的 Team switcher。
  - 默认仍自动进入 `AgentBean` preview team。
  - 用户名/密码字段保留在内部表单里，保证现有自动 register/login flow 不变。
- 左侧频道区保留真实 `channel:create` 表单，但改成产品化的侧边栏 action block。
- 右侧 custom agent 创建区改成工作台卡片。
  - 设备、运行时、名称保持第一层可见。
  - 环境变量输入折叠到 `环境变量` details 中，减少第一屏 secret/debug 感。
- DOM harness 测试同步锁住新的 shell 文案和 Team switcher 结构。

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:web-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH cd apps/web-next && ../../node_modules/.bin/vitest run tests/preview-page.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
```

本轮验证结果：

- `build:web-next` 通过。
- `apps/web-next/tests/preview-page.test.ts` 通过 `7/7`。
- `npm run preview:agentbean-next` 通过，覆盖 custom agent -> message -> daemon reply 主链路。
- 本地 preview server `/healthz` 在 `http://127.0.0.1:4110/healthz` 返回 `{"ok":true,"service":"agentbean-next-server"}`。
- 运行中的 preview HTML 已返回：
  - `<title>AgentBean</title>`
  - `私有 Agent 团队`
  - `team-switcher`
  - `添加自定义 Agent`
  - `环境变量`
  - `发送消息`

## 仍未完成

- 还没有把生产用户入口正式切到 AgentBean Next。
- 还没有 production browser smoke。
- 如果旧 Vercel web 仍是主要用户入口，仍需决定最终公开入口是继续走旧 Vercel、改 Vercel 指向 Next，还是由 Railway `server-next` 托管正式页面。

