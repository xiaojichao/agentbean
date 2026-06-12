# 第六十七切片：message search 第一版

本文记录 AgentBean Next 第六十七切片在 server-next 与 web-next preview 中补齐轻量消息搜索能力。

## 目标

post-flip follow-up 已经收敛 workspace run detail 的可恢复入口，下一条小切片转向 search parity。第一版目标是让用户能在 preview shell 内搜索当前 team 中自己可见的普通 channel 消息，并由 server-side 查询返回结果，避免只做浏览器 DOM 过滤。

本切片不引入 full-text index、ranking、highlight、saved filters，也不覆盖 direct message 搜索。

## 已落地

- contracts 新增 `MessageSearchInputDto` 与 `MessageSearchResultDto`。
- `message:search` socket event 进入 web event binding，并在 authenticated socket 上复用当前 session user。
- `ServerNextUseCases.searchMessages` 会校验 team membership、最小 query 长度，并只搜索当前用户可见的普通 channels。
- memory 与 SQLite repositories 都实现 simple DB search；SQLite 查询会 escape `LIKE` 通配符。
- web-next preview 右侧工作区新增消息搜索表单与结果列表。
- docs 已同步 socket protocol、DTO contract、known gaps、verification matrix 与 post-flip follow-up status。

## 验证命令

```bash
npm run build:contracts
npm run build:server-next
npm run build:web-next
npm run test:web-next -- --api.host 127.0.0.1
npm run test:server-next -- --api.host 127.0.0.1 tests/first-slice.test.ts tests/socket-handlers.test.ts tests/sqlite-repositories.test.ts
npm run smoke:agentbean-next-browser
npm run check:agentbean-next-readiness
```

## 剩余边界

- Direct message 搜索仍未纳入第一版。
- Full-text indexing、ranking、highlight 与 saved filters 仍是后续 search 产品增强。
- Channel archive/delete、saved messages/reactions、admin/metrics 仍属于后续产品 parity；Tasks 第一版已在第六十八切片落地。
