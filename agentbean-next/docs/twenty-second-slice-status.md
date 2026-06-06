# 第二十二切片实现状态

本文记录 AgentBean Next 第二十二切片当前已经落地的 preview session persistence。

## 已实现

- `apps/web-next/preview`
  - 注册或登录成功后，将 `user`、`team` 与当前 `channel` 保存到 `localStorage`。
  - 页面刷新后会自动恢复已保存的 preview session。
  - 恢复 session 后会重新订阅 devices、agents 与 channels。
  - Socket.IO reconnect 时，如果页面已有 session，也会重新订阅。
  - 订阅失败时会清除本地 session 与页面状态，避免 stale session 卡住页面。

## 已验证

覆盖范围：

- preview HTML 仍可由 server-next dev server 正常托管。
- 完整 phase tests、packages build 与 preview smoke 均保持通过。
- full local preview 的真实 Socket.IO 登录、device list、custom agent create、message send 与 daemon reply broadcast 仍保持通过。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run dev:agentbean-next
```

## 暂未实现

这些不属于第二十二切片：

- production deploy 切换到 server-next。
- web-next 还没有真实浏览器点击自动化验收脚本。
- preview session 只保存非敏感 DTO，不保存密码，也不代表正式 auth token 设计。
- 真实 Codex/Claude/Gemini 交互式 adapter 仍在后续切片。
