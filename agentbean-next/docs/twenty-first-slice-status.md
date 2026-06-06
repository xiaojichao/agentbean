# 第二十一切片实现状态

本文记录 AgentBean Next 第二十一切片当前已经落地的 full local preview launcher。

## 已实现

- 根 workspace
  - 新增 `npm run dev:agentbean-next`，用于启动完整本地 preview。
  - 该命令会先构建 packages，再启动 server-next SQLite dev server。
- `apps/server-next`
  - 新增 full preview launcher。
  - launcher 会 bootstrap 或登录默认 preview 用户。
  - launcher 会把 daemon-next 连接到同一个 user/team。
  - launcher 会使用 builtin scanner 上报本机 runtimes，并保留 custom command executor。
  - launcher 输出 preview URL、用户、team 与 SQLite data dir。
  - daemon dispatch result 成功后，会把新增 agent message 广播给仍可见该 channel 的 web subscribers。
- `apps/web-next`
  - 静态 preview 页注册默认用户遇到 `CONFLICT` 时，会自动用同一用户名和密码登录。
  - 登录 fallback 后会继续订阅 devices、agents 与 channels，避免组合启动后页面卡在重复注册。

## 已验证

覆盖范围：

- full preview config 能解析默认值与 env/argv 覆盖。
- 默认 preview 用户已存在时，launcher 会从 register fallback 到 login。
- full preview launcher 能启动 SQLite server，并把 daemon-next device 挂到同一个 preview team。
- 完整 preview 真实入口可以登录、读取 online device、创建 custom agent、发送消息并收到 daemon reply。
- 完整 phase tests、packages build 与 preview smoke 均保持通过。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run dev:agentbean-next
```

打开页面：

```text
http://127.0.0.1:4100/
```

默认 preview 身份：

```text
username: shaw
password: secret
team: AgentBean
```

## 暂未实现

这些不属于第二十一切片：

- production deploy 切换到 server-next。
- web-next 还没有真实浏览器自动化验收脚本。
- 后续第二十二切片已补上 preview session persistence；正式 auth token 设计仍未实现。
- 真实 Codex/Claude/Gemini 交互式 adapter 仍在后续切片。
