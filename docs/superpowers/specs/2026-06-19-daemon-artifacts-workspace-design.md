# daemon-next 附件与产物归档：当前结论

- 日期：2026-06-19
- 更新：2026-07-10
- 状态：已实现；原始迁移设计由 Git history 保存

## 当前合同

- Dispatch attachment 使用 Team-scoped download route 与当前 Device credential 下载到 per-run input 目录。
- 执行环境只通过已实现的 `AGENTBEAN_RUN_ID`、`AGENTBEAN_WORKSPACE`、`AGENTBEAN_INPUT_DIR`、`AGENTBEAN_OUTPUT_DIR` 暴露 Run、workspace、input 与 output 路径。
- 执行后扫描输出目录，按 mtime、扩展名、忽略目录与 SHA256 去重收集产物。
- 产物通过 `/api/teams/:teamId/artifacts/upload` 以 multipart 上传，再以 artifact id 随 `dispatch:result` 关联 Message 与 Workspace Run。
- 完整 stdout/stderr 继续作为 `logs/workspace-run.log` Artifact 上报。
- 附件下载或产物上传失败采用 best-effort skip，不阻断主 dispatch；当前没有为这些增强步骤单独记录失败状态。
- Server 对 upload、preview、download 与 workspace run 同时校验 Device/session、Team membership 和 Channel visibility。

## 当前模块

- `apps/daemon-next/src/attachments.ts`
- `apps/daemon-next/src/workspace-run.ts`
- `apps/daemon-next/src/artifact-collector.ts`
- `apps/daemon-next/src/artifact-uploader.ts`
- `apps/daemon-next/src/index.ts`
- `apps/server-next/src/dev-server.ts`
- `packages/contracts/src/artifact.ts`
- `packages/contracts/src/dispatch.ts`

## 验证

- daemon-next attachment/workspace/artifact tests
- server-next Artifact authorization and HTTP route tests
- `npm run smoke:agentbean-next-browser` 的 upload、preview、download bytes 与 workspace run 链路
- `agentbean-next/docs/verification-matrix.md` 的 Artifact / Workspace Run gates

旧 daemon 的实现字段、路径与迁移方案仅保留在 Git history，不能通过名称替换当作当前实现。
