# Refresh .trellis/spec from real codebase

## Goal

把 `.trellis/spec/` 从未定制的模板重写为贴合真实 6 包架构的实战编码指南；清理幻影 / 错误目录；修正 `config.yaml`；保留已真实的 `guides/`。

## Scope

- spec 目录：`.trellis/spec/`（contracts / domain / pi-management-runtime / server-next / daemon-next 的 backend + web-next 的 frontend + guides + 根 index）
- 取证源：`packages/*` 与 `apps/*` 真实源码 + `docs/adr/`
- **不在范围**：不改任何产品源码 / 测试；不 commit（主区有并行会话）

## 背景

`trellis init`（2026-08-05）生成的 spec 全是空模板：`(To be filled)` 遍布、8 个包各贴 `backend/`+`frontend/`（含已废弃的 `server`/`web`/`daemon` 与纯后端包的 `frontend`）。唯一真实内容是 `guides/`。

## 所做改动

- 删 9 个幻影 / 错误目录：`spec/{server,web,daemon}` + 5 个纯后端包的 `frontend/` + `web-next/backend/`
- `config.yaml`：移除 `daemon`/`server`/`web` 三个不存在的 legacy 包路径
- 重写 6 包 spec（40 篇，全中文、source-backed、零占位符）
- 给 6 个 `index.md` 追加「相关 ADR」交叉引用（接 `docs/adr/`）
- 新建根 `spec/index.md` 导航
- 保留 `guides/`（已是项目专属内容）

## Acceptance Criteria

- [x] `.trellis/spec/` 描述当前真实架构（6 包）
- [x] 每包有真实源码佐证的编码指南（文件路径 + 行号）
- [x] 非适用的模板段已删除
- [x] `index.md` 与最终文件集一致（内部链接完整性已自动校验）
- [x] 无占位符残留（grep 验证）
- [x] spec 与 `docs/adr/` 交叉引用

## Notes

- 主区有并行会话（`AGENTS.md` -141/+26 来自他处），全程未 commit、未切分支。
- writer agent 自校正了多处行号（如 server-next `createServer` 在 `dev-server.ts:299` 非 `:8`；`bind()` 201 处非 ~150；测试 146 文件非 147）。
- 取证纠正了若干记忆错误：contracts **无 zod**（手写校验器）；domain **不含** Repository 接口（在 server-next）；server-next **非 Hono**（裸 `node:http`）；daemon **Node 24** 非 22。
