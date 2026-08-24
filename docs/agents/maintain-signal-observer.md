# Maintain signal observer

`observe:maintain-signal` 是 AgentBean AI-native SDLC 的第一个 Maintain 试点。它把一次既成的 deploy / production smoke / health 结果压缩成可追溯的只读观察，并为真实异常生成 incident、regression test 与 Agent eval 的草案候选。

它不是生产监控平台，也不是自动修复器。当前仓库没有 5xx 时间窗或错误率数据源，因此本工具不声称观测 5xx rate、持续健康或版本归因。

## 确定性输入

- GitHub Actions `runId` 与完整 `headSha`；
- `Deploy production` job 的原始结论；
- production smoke 的 target、cutover、health、entry、business step 原始结论；
- 对显式目标执行的一次只读 GET `/healthz`，必须同时满足 HTTP 200、`ok: true` 与 `service: agentbean-next-server`。

缺少 run/head、step 为 missing/pending、无上游失败却 skipped、目标 URL 无效，或远端 URL 未显式授权时，结果为 `blocked`。`blocked` 不能被解释为 healthy，也不会凭空创建 incident。

## 分级

- `record`：证据完整，workflow 与 live health 都成功；只记录证据。
- `diagnose`：存在确定性 workflow 或 live failure；只建议运行现有只读诊断。
- `escalation_candidate`：workflow health 与当前 live health 同时失败；只生成高优先级草案候选，等待人判断。
- `blocked`：证据不完整或授权不成立；停止推断并请求补齐证据。

每个非健康信号都带稳定 fingerprint。incident、regression 和 eval 只以 `draft_only` 候选写入 JSON 报告，`createAuthorized` / `modifyAuthorized` 固定为 false。

## 权限边界

观察器只允许一次无凭据、无重定向的只读 GET。远端目标除了显式授权，还必须与 `--allowed-origin` 完全一致，并在请求前解析为公开 IP；CI 将 origin 固定为 canonical production origin。脱敏后的 JSON 只能直接写入当前目录的 `artifacts/maintain/`，不允许嵌套目录或符号链接；URL 的 query、fragment、userinfo 和 health response 原文不会进入报告。

production smoke 在任何 curl、entry smoke 或 business smoke 之前还会运行 `check:agentbean-next-production-target`。它不发 HTTP 请求，只验证目标严格等于 canonical production origin，并对 DNS 做公开地址预检。DNS 预检不等于把后续连接固定到已解析 IP；因此本试点依赖受控的 `api.agentbean.dev` DNS，不能拿来授权任意第三方域名。

它不创建 Issue、PR，不 rerun/cancel/dispatch workflow，不修改代码，不 deploy、rollback、publish，也不调用预批准 runbook。报告中的建议不能替代 GitHub latest-head、main run、production smoke、真实渲染或人工生产授权。

## 使用

```bash
npm run observe:maintain-signal -- \
  --repository xiaojichao/agentbean \
  --run-id 32565939196 \
  --head-sha <40-char-sha> \
  --deploy-status success \
  --target-status success \
  --cutover-status success \
  --health-status success \
  --entry-status success \
  --business-status success \
  --entry-url https://api.agentbean.dev \
  --allow-live-target \
  --allowed-origin https://api.agentbean.dev \
  --output artifacts/maintain/post-deploy-signal.json
```

远端目标必须同时显式使用 `--allow-live-target` 和 `--allowed-origin`。`--skip-live-health` 只适合验证 fail-closed 行为，结果必为 `blocked`。业务异常不会改变命令退出码；输入 schema 或工具自身错误才退出 1。

CI 在 production smoke 的末尾以 `always()` 收集该报告，并以 `continue-on-error` 保持观察器不是发布门禁。原 production smoke 的成功或失败仍由原 step 决定。
