# 第六十五切片：workspace artifact tree

本文记录 AgentBean Next 第六十五切片在 preview 消息内为 workspace output artifacts 增加轻量目录树。

## 背景

第六十四切片已经把 message artifacts 分成 `Workspace 输出` 与 `消息附件`，但 workspace output 组内仍是平铺文件列表。`ArtifactDto.relativePath` 已经由 contracts、server projection 与 SQLite repository 保留，因此可以在不新增 API 的前提下，用现有 metadata 呈现 workspace output 的目录结构。

本切片仍是 message inline 第一版，不替代独立 run detail 页面，也不提供跨 run/dispatch 的 artifact browser。

## 已落地

- `apps/web-next/preview/index.html`
  - `Workspace 输出` 组按 `relativePath` 的目录分段展示。
  - 根目录文件显示为 `./`，嵌套文件显示如 `outputs/`、`outputs/logs/`。
  - `消息附件` 组继续保持平铺展示。
- `apps/web-next/tests/preview-page.test.ts`
  - 扩展 message artifacts DOM harness，覆盖 workspace artifacts 的 `relativePath` 目录分段。

## 验证命令

```bash
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts -t "renders message artifacts"
npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 45000 --json
```

真实浏览器 smoke 输出 `16/16` 通过，artifact upload、preview bytes、download bytes 与 console clean 均通过。

## 剩余边界

- 独立 workspace run detail 页面仍需后续 UI/API 切片。
- 跨 run/dispatch 的 artifact browser 仍未落地。
- Tasks、search、saved messages/reactions、admin/metrics 仍属于后续产品 parity。
