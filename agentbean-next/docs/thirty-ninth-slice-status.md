# 第三十九切片实现状态

本文记录 AgentBean Next 第三十九切片当前已经落地的 external cutover audit。

## 已实现

- `scripts/audit-agentbean-next-cutover.mjs`
  - 只读读取 GitHub repository variables。
  - 只读读取 GitHub repository secrets 名称。
  - 只读读取 npm registry 中 next package versions。
  - 检查 `AGENTBEAN_DEPLOY_TARGET=next`。
  - 检查 `AGENTBEAN_NEXT_DATA_DIR` 存在且不是本地 `.agentbean-next` fallback。
  - 检查 `RAILWAY_TOKEN`、`NPM_TOKEN` 与 `AGENTBEAN_NEXT_SESSION_SECRET` secrets 存在。
  - 检查 npm registry 已存在 `@agentbean/contracts@0.2.0`。
  - 检查 npm registry 已存在 `@agentbean/daemon-next@0.2.0`。
  - 检查 npm registry 已存在 canonical `@agentbean/daemon@0.2.0`。
  - 支持 `--json` 输出。
- `package.json`
  - 新增 `audit:agentbean-next-cutover`。
  - 新增 `dev:agentbean-next:open`，用于启动 full preview 并自动打开浏览器。
- `apps/server-next/src/full-preview.ts`
  - 支持 `AGENTBEAN_NEXT_OPEN_BROWSER=1` 时打开 preview URL。
- `apps/web-next/preview/index.html`
  - 将最小表单堆叠页调整为 AgentBean 风格三栏工作台。
  - 左侧展示品牌、当前 Team、Channels 与新建 Channel。
  - 中间展示对话 header、消息列表与 composer。
  - 右侧展示 Devices、Runtimes、Agents、Custom Agent 与 Events。
  - 调整列表项布局，避免 channel/status、device/status、message/sender 挤在同一行。
- `apps/server-next/tests/cutover-audit.test.ts`
  - 用 fake command runner 覆盖全部通过和缺外部配置两种状态。
- `agentbean-next/docs/verification-matrix.md`
  - 新增 `P3-15`。
- `agentbean-next/docs/production-cutover-runbook.md`
  - 新增外部 cutover audit 章节。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm install --package-lock-only --ignore-scripts
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/cutover-audit.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run check:agentbean-next-readiness
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH AGENTBEAN_DEPLOY_TARGET=next RAILWAY_TOKEN=dummy AGENTBEAN_NEXT_SESSION_SECRET=dummy-secret AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next npm run check:agentbean-next-readiness -- --production
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run smoke:agentbean-next-daemon-install -- --skip-build
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run preview:agentbean-next
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run dev:agentbean-next:open
```

本地 UI 验证：

- `npm run dev:agentbean-next` 已在本机启动 full preview。
- Chrome 已打开 `http://127.0.0.1:4100/`。
- 页面标题为 `AgentBean Next Preview`。
- 页面状态为 `已连接`。
- 页面可见 `Channels`、`Devices`、`Custom Agent`、`Conversation` 与 `Events`。
- `/healthz` 返回 `{"ok":true,"service":"agentbean-next-server"}`。

## 当前外部审计结果

当前外部状态下，`npm run audit:agentbean-next-cutover` 预期失败，因为真正替换旧 AgentBean 所需的外部配置和首次 npm 发布尚未完成。

当前已知缺口：

- GitHub variable `AGENTBEAN_DEPLOY_TARGET` 尚未设置为 `next`。
- GitHub variable `AGENTBEAN_NEXT_DATA_DIR` 尚未设置。
- GitHub secret `AGENTBEAN_NEXT_SESSION_SECRET` 尚未设置。
- npm registry 尚未发布 `@agentbean/contracts@0.2.0`。
- npm registry 尚未发布 `@agentbean/daemon-next@0.2.0`。
- npm registry 尚未发布 canonical `@agentbean/daemon@0.2.0`。

## 暂未实现

这些不属于第三十九切片：

- 写入真实 GitHub variables/secrets。
- 绑定 Railway production volume 与 runtime env。
- 真实发布 next npm packages。
- production deploy flip。
- production browser smoke。
