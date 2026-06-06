# 第四十三切片：Next npm 发布与 cutover audit 收敛

本文记录 AgentBean Next 第四十三切片当前已经完成的外部发布与 cutover audit 状态。

## 已完成

- 通过 GitHub Actions 手动触发 `CI/CD` workflow：

```bash
gh workflow run "CI/CD" \
  --repo xiaojichao/agentbean \
  --ref main \
  -f agentbean_deploy_target=old \
  -f agentbean_npm_publish_target=next \
  -f run_production_deploy=false
```

- 该 workflow 已成功完成：
  - `Validate web`
  - `Validate AgentBean Next`
  - `Validate server`
  - `Validate daemon`
  - `Publish agent to npm`
- `Deploy production` 按预期跳过，没有执行 production deploy。
- npm registry 已包含：
  - `@agentbean/contracts@0.2.0`
  - `@agentbean/daemon-next@0.2.0`
  - canonical `@agentbean/daemon@0.2.0`
- GitHub repository 已配置：
  - `AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next`
  - secret `AGENTBEAN_NEXT_SESSION_SECRET`

## 验证

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run audit:agentbean-next-cutover -- --json
```

结果：10 项检查中 9 项通过，只剩最终 production flip 开关未打开。

当前唯一失败项：

- `github-variable-deploy-target-next`
  - `AGENTBEAN_DEPLOY_TARGET` 尚未设置为 `next`

真实 npm 安装验证：

```bash
npm install --ignore-scripts @agentbean/contracts@0.2.0 @agentbean/daemon@0.2.0
./node_modules/.bin/daemon
```

结果：

- 安装到的 package 为 `@agentbean/daemon@0.2.0`
- bin 包含：
  - `daemon`
  - `agentbean-daemon`
  - `agentbean-next-daemon`
- `daemon` 能进入 daemon-next CLI，并在缺少 `AGENTBEAN_NEXT_TEAM_ID` 时输出预期校验错误。

`@agentbean/daemon-next@0.2.0` 也已通过真实 npm 安装验证，`agentbean-next-daemon` 能进入相同 CLI 校验。

## 剩余边界

- 不应在尚未确认 Railway production volume 与 runtime env 前设置 `AGENTBEAN_DEPLOY_TARGET=next`。
- Railway production service 仍需确认：
  - 已绑定持久化 volume。
  - volume mount path 与 `/data/agentbean-next` 一致。
  - runtime env 包含 `AGENTBEAN_NEXT_DATA_DIR=/data/agentbean-next`。
  - runtime env 包含 `AGENTBEAN_NEXT_SESSION_SECRET`。
- 完成 Railway runtime 检查后，才能打开最终 flip：

```bash
gh variable set AGENTBEAN_DEPLOY_TARGET --repo xiaojichao/agentbean --body next
```
