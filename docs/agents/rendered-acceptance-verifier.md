# 真实渲染验收器

本工具把前端/产品父 Issue 的真实页面验收从实现会话中拆出来：验证者拿一份机器可读验收契约和一个已经准备好的真实 URL，在 390px 与 1440px 各自独立的全新 Chrome profile 中观察页面，输出逐项结果、截图和 JSON 报告。它不点击按钮、不填写表单、不修代码，也不把本地或原型数据冒充生产证据。

## 适用边界

- 用于父 Issue、跨切片产品流程和响应式可达性复验；组件单测和既有 browser smoke 仍保留。
- 目标 URL 必须由当前任务提供，并已经处于待观察状态。没有真实 URL 时只校验契约和工具本身，不能声称完成真实渲染验收。
- 验收契约必须引用仓库内的架构、验收表或原型锚点。来源的真实路径必须仍在仓库内，锚点必须唯一；报告记录行号和邻近上下文 hash。缺失、重复或 symlink 逃逸时工具 fail closed，提醒验证者先重新阅读当前契约。
- 每个可见断言必须带 `contractRef`；工具不会从 DOM 或实现代码反推产品要求。
- 工具只执行导航、等待、DOM 读取和截图。HTTP `POST` / `PUT` / `PATCH` / `DELETE` 等非只读请求，以及契约未声明的跨域请求，都会被浏览器层拦截并让该视口失败；额外静态/CDN origin 必须显式写入 `allowedOrigins`。

网页自身可能通过 WebSocket 建立读取订阅，CDP 的 HTTP method guard 无法判定 frame 的业务语义。因此远端目标必须显式传 `--allow-live-target`；使用 session 文件还必须传 `--prepared-read-only-session`，确认它是无写权限账号或专用只读会话且页面状态已准备好。报告会记录这两项授权和 WebSocket 边界。工具不提供点击、输入或 Socket event 接口。

一个 URL/契约只观察一个已经形成的页面状态。Task → 审核工作区 → 预览、无阶段频道、Files/Thread 一致性等跨状态流程，应分别准备只读 URL/状态与契约后运行，不通过 verifier 点击来推进业务事实。

## 验收契约

可从 [`rendered-acceptance-contract.example.json`](./rendered-acceptance-contract.example.json) 复制一份任务专用契约。核心字段：

- `sources`：权威文档路径与必须唯一存在的原文锚点；
- `allowedOrigins`：可选的额外静态/CDN origin；默认只放行目标同源；
- `viewports`：至少包含 390px 和 1440px；
- `ready`：真实页面进入可观察状态的 DOM selector；
- `checks`：`visible`、`hidden`、`text`、`attribute`、`page-no-horizontal-overflow` 或 `horizontal-overflow-contained`；全局无溢出不能替代具体控件/滚动容器的可达性断言；
- `contractRef`：每个 check 对应的 source 与 anchor。

契约只保存验收断言和来源，不保存生产 URL、账号或 token。任务特定的动态 ID 放在命令行 URL 中。

## 运行

```bash
npm run verify:agentbean-next-rendered -- \
  --contract docs/agents/rendered-acceptance-contract.example.json \
  --url 'https://<真实入口>/<team>/chat?<稳定页面状态>' \
  --artifacts-dir output/rendered-acceptance/<issue-or-run> \
  --allow-live-target \
  --json
```

认证页面可传一个仓库外、权限受限且不提交 Git 的 session 文件：

```json
{
  "schemaVersion": 1,
  "origin": "https://app.example.test",
  "localStorage": {
    "agentbean.token": "<read-only-session-token>",
    "agentbean.teamPath": "<team-path>"
  }
}
```

```bash
chmod 600 /tmp/agentbean-rendered-session.json
npm run verify:agentbean-next-rendered -- \
  --contract /path/to/issue-contract.json \
  --url 'https://app.example.test/<team>/chat?...' \
  --session-file /tmp/agentbean-rendered-session.json \
  --allow-live-target \
  --prepared-read-only-session
```

报告和 browser event 工件不会保存 session 文件或 localStorage 原值，目标 URL 的 query/hash 也不会进入报告。session 文件仍是敏感材料，由操作者负责安全删除。

## 结果与职责分离

证据目录包含：

- `<viewport>-<width>x<height>.png` 及报告中的 SHA-256；
- `rendered-acceptance-report.json`；
- 已脱敏的 `browser-events.json`。

独立 verifier 只返回通过/失败和证据路径。主执行 Agent 根据失败项定位、修改、运行 targeted tests 与 matching build，再让新的 verifier 进程复验。通过后把 report、截图或稳定工件链接写入 task lineage 的 `evidence.renderedAcceptance`，不要复制整份报告正文。

CI 只运行 verifier 的 schema/边界测试，并在底层 CDP harness 变化时复跑既有 browser smoke；CI 没有任务特定真实 URL 和预置状态时不会自动运行 live verifier，也不能据此声称父 Issue 已完成真实渲染验收。
