# Team Workspace Runs cursor 分页

> 日期：2026-06-15
> 分支：`workspace-run-pagination`（stacked on #258 `feat/workspace-run-explorer-filters`）
> 方向：Workspace run 深化第二切片

## 背景

筛选切片（#258，PR review 中）落地后，team workspace runs 列表可按 status/agent/device 过滤。但 list API 仍是单次返回（拉 300、visibility 过滤、取上限 100），前端一次拉全部。team run 量增长后需要分页 + 前端「加载更多」。

## 目标

cursor 分页（第一版）：
- `listByTeam` 支持 cursor，基于复合排序 `updated_at DESC, id DESC`
- usecase 按 pageSize 分页，返回 `nextCursor`
- HTTP `?cursor=&pageSize=`，**invalid cursor → 400**（信任边界校验，吸取 #258 review 教训）
- 前端列表底部「加载更多」，累积 runs，与筛选叠加（换筛选时重置）

## 设计

### 为什么 cursor 不是 offset

`listTeamWorkspaceRuns` 在 usecase 层做 channel visibility 后过滤（拉一批 → 逐条 visibility 检查 → 取 N）。offset 在这种「后过滤」模型下语义错乱：offset 跳过的是原始 run 而非可见 run，导致每页数量不定、可能跳过本应可见的 run。cursor 基于「上一页最后一条**可见** run 的 `(updatedAt, id)`」，下一批严格取「更旧」的，无论中间过滤多少都连续、不重不漏。

### cursor 编码

`base64url(`${updatedAt}:${id}`)`。decode 失败或字段缺失 → `'invalid'` → usecase 返 `BAD_REQUEST`、HTTP 返 400。query 是用户可控的，不盲信（同 #258 的 status 校验）。

### pageSize

default 30，clamp `[1, 100]`。repository fetch limit = `pageSize × 10`（buffer 覆盖 visibility 过滤损耗；default 30 → 300，与现状上限一致）。

### nextCursor 判断

visibility 过滤后取 `pageSize + 1` 条：
- 若可见数 `> pageSize`：`nextCursor` = 第 `pageSize` 条的 cursor，返回前 `pageSize` 条
- 若 `<= pageSize`：无 `nextCursor`（到底了）

边界：buffer 不够（visibility 过滤极端严重）时可能提前结束——第一版接受，buffer = pageSize×10 通常足够。

### 排序稳定性

`updated_at DESC, id DESC` 复合排序。同一 `updated_at` 用 `id` 打破并列，保证 cursor 边界确定（无歧义）。

## 涉及文件

### 后端
- `apps/server-next/src/application/repositories.ts` — `listByTeam` 接口加 `cursor?: { updatedAt: number; id: string }`
- `apps/server-next/src/infra/sqlite/repositories.ts` — cursor WHERE
- `apps/server-next/src/infra/memory/repositories.ts` — cursor filter + 复合排序
- `apps/server-next/src/application/usecases.ts` — `ListTeamWorkspaceRunsInput` 加 `cursor?`/`pageSize?`；返回加 `nextCursor?`；cursor encode/decode + clamp helper
- `apps/server-next/src/dev-server.ts` — `?cursor=&pageSize=` 解析，invalid cursor → 400

### 前端
- `apps/web/lib/socket.ts` — `fetchTeamWorkspaceRuns(teamId, filters?, cursor?)` 返回 `nextCursor?`
- `apps/web/lib/schema.ts` — 返回 wrapper 加 `nextCursor?`
- `apps/web/app/[networkPath]/runs/page.tsx` — 累积 runs、「加载更多」按钮、换筛选重置

### 测试
- `apps/server-next/tests/sqlite-repositories.test.ts` — cursor 过滤
- `apps/server-next/tests/dev-server.test.ts` — cursor/pageSize 透传 + invalid cursor 400

## 不做（后续切片）

- 总数 `totalCount`
- 跳页（只单向「加载更多」）
- 前端虚拟滚动

## 验证

```bash
npm run test:server-next   # 含 cursor 边界
cd apps/web && npm run build
```
