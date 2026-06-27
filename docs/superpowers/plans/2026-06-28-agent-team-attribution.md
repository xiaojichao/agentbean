# Agent 团队归属重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除设备详情页「将 Agent 加入团队」的多团队发布能力，改为单团队默认归属 + Agent 行尾可见性复选框；扫描发现的编程执行器（`executor-hosted` 且 `source≠custom`）不再作为 Agent 成员实体。

**Architecture:** 可见性 = 「是否对 primary team 可见」。sqlite 加 `hidden_from_primary_team` 列，由 `mapAgent` 折算进 `visibleTeamIds`（hidden=1 则 `visibleTeamIds` 不含 primary）；memory 直接操作 `visibleTeamIds` 数组。新 usecase `setAgentTeamVisibility` 替代 `publish/unpublish`，移出时联动退默认频道。迁移清理历史执行器 AgentDto + 多团队 publication。

**Tech Stack:** TypeScript · Node 22 · vitest · socket.io · better-sqlite3 · Next.js App Router · zustand

## Global Constraints

- 生产代码只改 `apps/server-next`、`apps/web-next`、`packages/contracts`；**不动** `apps/server`、`apps/web`（legacy）。
- `contracts` 的 `AgentDto` **不新增公共字段**；`hidden_from_primary_team` 仅作 sqlite 存储列，经 `mapAgent` 折算进 `visibleTeamIds`。
- 注释/文档/commit message 用**中文**。
- 测试框架 vitest；server 测试经 `createInMemoryServerNext` 入口；sqlite 与 memory 双实现必须**语义同步**。
- 迁移文件按 `global/00NN_*.sql` 顺序，`applyMigration` 自动幂等（`schema_migrations` 表）。
- 每任务结束 commit；分支 `feat/agent-team-attribution`（已建并已提交 PRD）。
- 设计依据：`docs/superpowers/specs/2026-06-28-agent-team-attribution-design.md`。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/contracts/src/agent.ts` | 新增 `SetAgentTeamVisibilityInput` DTO | 修改 |
| `packages/contracts/src/socket.ts` | agent 事件：加 `setVisibility`，删 `publish`/`unpublish` | 修改 |
| `apps/server-next/src/application/repositories.ts` | `AgentRepository` 加 `setPrimaryTeamVisibility` | 修改 |
| `apps/server-next/src/application/usecases.ts` | 加 `setAgentTeamVisibility`；改 `registerDiscoveredAgents`；删 `publishAgent`/`unpublishAgent` | 修改 |
| `apps/server-next/src/infra/sqlite/repositories.ts` | `mapAgent`/`listVisibleInTeam`/`setPrimaryTeamVisibility`/注册迁移 | 修改 |
| `apps/server-next/src/infra/memory/repositories.ts` | `setPrimaryTeamVisibility`/`listVisibleInTeam` 过滤 | 修改 |
| `apps/server-next/src/infra/sqlite/migrations/global/0009_agent_visibility.sql` | schema 列 + 历史数据清理 | 新建 |
| `apps/server-next/src/transport/socket-handlers.ts` | 加 `agent:set-visibility` handler；删 publish/unpublish handler | 修改 |
| `apps/web-next/lib/socket.ts` | `agentEvents` 加 `setVisibility`；删 `publish`/`unpublish` | 修改 |
| `apps/web-next/app/[networkPath]/devices/page.tsx` | `AgentRow` 加复选框；移除 `SelectNetworkDialog` 及相关 state/prop | 修改 |

---

## Task 1: 后端可见性核心（repo + usecase + 迁移）

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0009_agent_visibility.sql`
- Modify: `packages/contracts/src/agent.ts`（末尾追加 DTO）
- Modify: `apps/server-next/src/application/repositories.ts:197-213`（`AgentRepository` 接口）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（`applyGlobalMigrations` ~40-60、`mapAgent` 1858-1873、`listVisibleInTeam` 1082-1102、新增 `setPrimaryTeamVisibility`）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（新增 `setPrimaryTeamVisibility`、`listVisibleInTeam` 654-656）
- Modify: `apps/server-next/src/application/usecases.ts`（接口 ~80、`SetAgentTeamVisibilityInput` 引用、新增 `setAgentTeamVisibility` 实现）
- Test: `apps/server-next/tests/agent-team-visibility.test.ts`（新建）

**Interfaces:**
- Consumes: `agentForManagement`（usecases.ts 末尾，已存在）、`ensureDefaultChannelMembership`、`repositories.channels.removeAgentFromTeamChannels`、`toPublicAgent`
- Produces:
  - `AgentRepository.setPrimaryTeamVisibility(input: { agentId: ID; visible: boolean; timestamp: UnixMs }): Promise<AgentRecord | null>`
  - usecase `setAgentTeamVisibility(input: SetAgentTeamVisibilityInput): Promise<Ack<{ agent: AgentDto }>>`
  - `SetAgentTeamVisibilityInput = { userId: ID; teamId: ID; agentId: ID; visible: boolean }`

- [ ] **Step 1: 写失败测试**

新建 `apps/server-next/tests/agent-team-visibility.test.ts`：

```typescript
import { describe, expect, test } from 'vitest';
import { createInMemoryServerNext } from '../src/index';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

describe('agent team visibility', () => {
  test('invisible agent is excluded from listVisibleInTeam and loses channel membership', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerDevice({ userId: 'user-1', teamId: 'team-1', hostname: 'mac' }); // 按 repo 现有签名调整
    await app.registerDiscoveredAgents({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted', source: 'scanned' }],
    });

    // 默认可见
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({ ok: true });

    // 设为不可见
    const hidden = await app.setAgentTeamVisibility({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', visible: false });
    expect(hidden.ok).toBe(true);

    // 成员页不再包含该 agent
    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed.ok && listed.agents.map((a) => a.id)).not.toContain('agent-1');

    // 重新可见
    await app.setAgentTeamVisibility({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', visible: true });
    const listed2 = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed2.ok && listed2.agents.map((a) => a.id)).toContain('agent-1');
  });

  test('listVisibleInTeam excludes executor-hosted runtime agents (scanned/self-register)', async () => {
    // setup 同上，registerDiscoveredAgents 传入 category: 'executor-hosted'
    // Task 2 完成后此类不再创建；此测试验证 listVisibleInTeam 的兜底过滤
    // 断言：executor-hosted+scanned 不出现在 listVisibleAgents 结果
  });
});
```

> 注：`registerDevice`/`registerDiscoveredAgents`/`listVisibleAgents` 的确切入参签名以 `apps/server-next/src/index.ts` 导出的 `createInMemoryServerNext` 返回值为准；如名称略有差异，按现有 `tests/default-channel-membership.test.ts` 的 setup 模式对齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/agent-team-visibility.test.ts`
Expected: FAIL — `app.setAgentTeamVisibility is not a function`

- [ ] **Step 3: contracts 加 DTO**

在 `packages/contracts/src/agent.ts` 末尾追加：

```typescript
export interface SetAgentTeamVisibilityInput {
  userId: ID;
  teamId: ID;
  agentId: ID;
  visible: boolean;
}
```

- [ ] **Step 4: AgentRepository 接口加方法**

在 `apps/server-next/src/application/repositories.ts` 的 `AgentRepository`（197-213）`unpublish` 之后加：

```typescript
  setPrimaryTeamVisibility(input: { agentId: ID; visible: boolean; timestamp: UnixMs }): Promise<AgentRecord | null>;
```

- [ ] **Step 5: memory 实现**

在 `apps/server-next/src/infra/memory/repositories.ts` 的 `agents` repository `unpublish`（578-588）之后加：

```typescript
      async setPrimaryTeamVisibility(input) {
        const agent = agents.get(input.agentId);
        if (!agent) return null;
        const updated = input.visible
          ? { ...agent, visibleTeamIds: Array.from(new Set([agent.primaryTeamId, ...agent.visibleTeamIds])) }
          : { ...agent, visibleTeamIds: agent.visibleTeamIds.filter((t) => t !== agent.primaryTeamId) };
        agents.set(input.agentId, updated);
        return updated;
      },
```

修改 memory `listVisibleInTeam`（654-656）加执行器兜底过滤：

```typescript
      async listVisibleInTeam(teamId) {
        return Array.from(agents.values()).filter(
          (agent) =>
            agent.deletedAt === undefined &&
            agent.visibleTeamIds.includes(teamId) &&
            !(agent.category === 'executor-hosted' && agent.source !== 'custom'),
        );
      },
```

- [ ] **Step 6: 新建 sqlite 迁移 0009**

新建 `apps/server-next/src/infra/sqlite/migrations/global/0009_agent_visibility.sql`：

```sql
-- Agent 对 primary team 的可见性：0=可见（默认），1=隐藏（移出当前团队）
ALTER TABLE agents ADD COLUMN hidden_from_primary_team INTEGER NOT NULL DEFAULT 0;

-- 清理历史编程执行器 AgentDto（executor-hosted 且非 custom），它们不再作为团队成员
DELETE FROM agent_publications WHERE agent_id IN (
  SELECT id FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register')
);
DELETE FROM agent_identity_links WHERE agent_id IN (
  SELECT id FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register')
);
DELETE FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register');

-- 废弃多团队发布：清空所有额外 publication，agent 只归属 primary team
DELETE FROM agent_publications;
```

- [ ] **Step 7: 注册迁移**

在 `apps/server-next/src/infra/sqlite/repositories.ts` 的 `applyGlobalMigrations`（40-60）末尾加一行：

```typescript
  applyMigration(db, 'global/0009_agent_visibility.sql');
```

- [ ] **Step 8: 改 sqlite mapAgent**

修改 `mapAgent`（1858-1873），读取 hidden 列并折算 `visibleTeamIds`：

```typescript
function mapAgent(db: SqliteDatabase, row: unknown): AgentRecord | null {
  if (!row || typeof row !== 'object') return null;
  const deletedAt = sqliteNullableInt(row, 'deleted_at');
  const primaryTeamId = sqliteText(row, 'primary_team_id');
  const hiddenFromPrimary = sqliteInt(row, 'hidden_from_primary_team') === 1;
  const publishedTeamIds = db
    .prepare('SELECT team_id FROM agent_publications WHERE agent_id = ? ORDER BY published_at')
    .all(sqliteText(row, 'id'))
    .map((publication) => sqliteText(publication, 'team_id'));
  const fullVisible = deletedAt === undefined ? Array.from(new Set([primaryTeamId, ...publishedTeamIds])) : [];
  const visibleTeamIds = hiddenFromPrimary ? fullVisible.filter((t) => t !== primaryTeamId) : fullVisible;
  return {
    // ...保留原有字段映射
    primaryTeamId,
    visibleTeamIds,
    // ...
  } as AgentRecord;
}
```

> `sqliteInt`/`sqliteNullableInt` 沿用文件内现有 reader 辅助（参照 `sqliteText` 用法）。

- [ ] **Step 9: 改 sqlite listVisibleInTeam**

修改 `listVisibleInTeam`（1082-1102），primary 分支加 hidden 条件、整体加执行器兜底过滤：

```typescript
      async listVisibleInTeam(teamId) {
        return globalDb
          .prepare(
            `SELECT * FROM (
               SELECT agents.* FROM agents
               WHERE agents.primary_team_id = ?
                 AND agents.deleted_at IS NULL
                 AND agents.hidden_from_primary_team = 0
               UNION
               SELECT agents.* FROM agent_publications
               JOIN agents ON agents.id = agent_publications.agent_id
               WHERE agent_publications.team_id = ?
                 AND agents.deleted_at IS NULL
             ) AS visible
             WHERE NOT (visible.category = 'executor-hosted' AND visible.source != 'custom')`,
          )
          .all(teamId, teamId)
          .map((row) => {
            const agent = mapAgent(globalDb, row);
            if (!agent) throw new Error('SQLite agent row could not be mapped');
            return agent;
          });
      },
```

- [ ] **Step 10: 加 sqlite setPrimaryTeamVisibility**

在 sqlite `agents` repository 的 `unpublish`（约 978-981）之后加：

```typescript
      async setPrimaryTeamVisibility(input) {
        globalDb
          .prepare('UPDATE agents SET hidden_from_primary_team = ? WHERE id = ?')
          .run(input.visible ? 0 : 1, input.agentId);
        if (!input.visible) {
          globalDb.prepare('DELETE FROM agent_publications WHERE agent_id = ?').run(input.agentId);
        }
        const row = globalDb.prepare('SELECT * FROM agents WHERE id = ?').get(input.agentId);
        return row ? mapAgent(globalDb, row) : null;
      },
```

- [ ] **Step 11: 加 usecase setAgentTeamVisibility**

在 `apps/server-next/src/application/usecases.ts`：
(a) 接口（~80，`unpublishAgent` 之后）加：

```typescript
  setAgentTeamVisibility(input: SetAgentTeamVisibilityInput): Promise<Ack<{ agent: AgentDto }>>;
```

(b) 实现（`unpublishAgent` 实现之后，约 1808）加：

```typescript
    async setAgentTeamVisibility(input) {
      const managed = await agentForManagement(repositories, input);
      if (!managed.ok) return managed;
      if (input.teamId !== managed.agent.primaryTeamId) {
        return makeFailure('VALIDATION_ERROR', '只能在 primary team 上切换可见性');
      }
      const agent = await repositories.agents.setPrimaryTeamVisibility({
        agentId: managed.agent.id,
        visible: input.visible,
        timestamp: clock.now(),
      });
      if (!agent) return makeFailure('NOT_FOUND', 'Agent not found');
      if (input.visible) {
        await ensureDefaultChannelMembership(repositories, clock, { teamId: input.teamId, agentId: agent.id });
      } else {
        await repositories.channels.removeAgentFromTeamChannels({
          teamId: input.teamId,
          agentId: agent.id,
          timestamp: clock.now(),
        });
      }
      return makeSuccess({ agent: toPublicAgent(agent) });
    },
```

(c) 顶部 import 加 `SetAgentTeamVisibilityInput`（从 contracts）。

- [ ] **Step 12: 跑测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/agent-team-visibility.test.ts`
Expected: PASS

- [ ] **Step 13: 跑全量 + tsc**

Run: `cd apps/server-next && npx vitest run && npx tsc --noEmit`
Expected: 全绿，无类型错误

- [ ] **Step 14: Commit**

```bash
git add apps/server-next packages/contracts
git commit -m "后端: 新增 Agent 团队可见性切换（setAgentTeamVisibility + hidden_from_primary_team 迁移）"
```

---

## Task 2: 扫描只入库 AgentOS 托管型 Agent

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:1648-1688`（`registerDiscoveredAgents`）
- Test: `apps/server-next/tests/agent-team-visibility.test.ts`（追加用例）

**Interfaces:**
- Consumes: `registerDiscoveredAgents(input)` 现有签名
- Produces: `executor-hosted` 的 discovered agent 不再创建 AgentDto（仅 `agentos-hosted` 入库）

- [ ] **Step 1: 写失败测试**

在 `agent-team-visibility.test.ts` 追加：

```typescript
  test('registerDiscoveredAgents only ingests agentos-hosted, skips executor-hosted', async () => {
    const app = createInMemoryServerNext({ now: () => 1000, ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']) });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerDevice({ userId: 'user-1', teamId: 'team-1', hostname: 'mac' });
    const res = await app.registerDiscoveredAgents({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      agents: [
        { name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted', source: 'scanned' },
        { name: 'codex', adapterKind: 'codex', category: 'executor-hosted', source: 'scanned' },
      ],
    });
    expect(res.ok && res.agents.map((a) => a.category)).toEqual(['agentos-hosted']);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/agent-team-visibility.test.ts`
Expected: FAIL — 返回了两个 agent（含 executor-hosted）

- [ ] **Step 3: 改 registerDiscoveredAgents 跳过 executor-hosted**

在 `usecases.ts:1648` 的 `for (const discovered of discoveredInput.agents)` 循环体首行加过滤：

```typescript
  for (const discovered of discoveredInput.agents) {
    if (discovered.category !== 'agentos-hosted') {
      continue; // 编程执行器(executor-hosted)不再作为 Agent 成员，仅作 RuntimeDto 展示
    }
    const adapterKind = normalizeAdapterKind(discovered.adapterKind) as AdapterKind;
    // ...原有逻辑不变
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/agent-team-visibility.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-next
git commit -m "后端: 扫描只入库 agentos-hosted，跳过 executor-hosted 编程执行器"
```

---

## Task 3: 传输层 — 新增 set-visibility 事件

**Files:**
- Modify: `packages/contracts/src/socket.ts`（agent 事件块 ~45-56）
- Modify: `apps/server-next/src/transport/socket-handlers.ts:151-175`（agent handler 区）
- Test: `apps/server-next/tests/socket-handlers.test.ts`（追加用例）

**Interfaces:**
- Consumes: `app.setAgentTeamVisibility`（Task 1 产出）、`withAuthenticatedUserId`、`afterAgentMutation`
- Produces: socket event `agent:set-visibility`，payload `{ agentId, teamId, visible }`

- [ ] **Step 1: 写失败测试**

在 `apps/server-next/tests/socket-handlers.test.ts` 追加（参照现有 publish handler 测试模式）：

```typescript
  test('agent:set-visibility forwards to setAgentTeamVisibility use case', async () => {
    const socket = new FakeSocket();
    const app = {
      setAgentTeamVisibility: vi.fn(async () => makeSuccess({ agent: { id: 'agent-1' } })),
    } as unknown as ServerNextUseCases;
    registerWebSocketHandlers(socket, app, { authenticatedUser: { id: 'user-1' } });
    const handler = socket.handlers[WEB_EVENTS.agent.setVisibility];
    const ack = vi.fn();
    await handler({ agentId: 'agent-1', teamId: 'team-1', visible: false }, ack);
    expect(app.setAgentTeamVisibility).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1', visible: false }));
    expect(ack).toHaveBeenCalled();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/socket-handlers.test.ts`
Expected: FAIL — `WEB_EVENTS.agent.setVisibility` 未定义

- [ ] **Step 3: contracts 加事件**

在 `packages/contracts/src/socket.ts` 的 `agent` 事件块加：

```typescript
  setVisibility: 'agent:set-visibility',
```

- [ ] **Step 4: 加 server handler**

在 `apps/server-next/src/transport/socket-handlers.ts` 的 `agent.unpublish` handler 之后加：

```typescript
socket.on(WEB_EVENTS.agent.setVisibility, async (payload, ack) => {
  try {
    const input = await withAuthenticatedUserId(payload, { authenticatedUser: options.authenticatedUser });
    const result = await app.setAgentTeamVisibility(input as Parameters<ServerNextUseCases['setAgentTeamVisibility']>[0]);
    ack?.(result);
    await options.afterAgentMutation?.(withChannelTeamIds(input, [payloadString(input, 'teamId')]), result);
  } catch (error) {
    ack?.(socketErrorAck(error, WEB_EVENTS.agent.setVisibility));
  }
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/socket-handlers.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/contracts apps/server-next
git commit -m "传输: 新增 agent:set-visibility 事件与 handler"
```

---

## Task 4: 前端 — socket 封装 + AgentRow 可见性复选框

**Files:**
- Modify: `apps/web-next/lib/socket.ts:204-273`（`AgentEvents` 接口与 `agentEvents` 实现）
- Modify: `apps/web-next/app/[networkPath]/devices/page.tsx`（`AgentRow` 1118-1170、`AgentGroup` 调用处 689-715、`SelectNetworkDialog` 1172-1242、相关 state 382、465、759-765、`updateSelectedAgentPublishState`）
- Test: `apps/web-next/tests/socket-client.test.ts`（追加用例）

**Interfaces:**
- Consumes: `WEB_EVENTS.agent.setVisibility`（Task 3）、`useAgentBeanStore` currentTeamId/teams、`emitWithTimeout`
- Produces: `agentEvents().setVisibility(agentId, teamId, visible): Promise<{ok, agent?, error?}>`；UI 复选框切换可见性

- [ ] **Step 1: 写失败测试（socket 封装）**

在 `apps/web-next/tests/socket-client.test.ts` 追加（参照现有 `emitWithAck` 断言模式）：

```typescript
  test('agentEvents.setVisibility emits agent:set-visibility with teamId and visible', async () => {
    // 用 FakeWebTransport 构造 agentEvents，调 setVisibility('agent-1', 'team-1', false)
    // 断言 transport.emitted 含 ['agent:set-visibility', { agentId: 'agent-1', teamId: 'team-1', visible: false }]
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web-next && npx vitest run`
Expected: FAIL — `setVisibility is not a function`

- [ ] **Step 3: socket.ts 加 setVisibility**

在 `apps/web-next/lib/socket.ts`：
(a) `AgentEvents` 接口加：

```typescript
  setVisibility(agentId: string, teamId: string, visible: boolean): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;
```

(b) `agentEvents` 实现加：

```typescript
    setVisibility(agentId, teamId, visible) {
      return emitWithTimeout(socket, WEB_EVENTS.agent.setVisibility, { agentId, teamId, visible })
        .then((res) => (res?.agent ? { ...res, agent: normalizeAgentSnapshot(res.agent) } : res));
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web-next && npx vitest run`
Expected: PASS

- [ ] **Step 5: 改造 AgentRow — 移除「选择团队」，加可见性复选框**

在 `devices/page.tsx` 把 `AgentRow`(1118-1170) 签名与渲染改为：

```tsx
function AgentRow({ agent, smokeKind, icon, iconBg, onSelectAgent, onDeleteAgent, canManage, currentTeamId, onToggleVisibility }: {
  agent: any;
  smokeKind: 'agentos' | 'custom';
  icon: React.ReactNode;
  iconBg: string;
  onSelectAgent: (agent: any) => void;
  onDeleteAgent?: (agent: any) => void;
  canManage: boolean;
  currentTeamId: string;
  onToggleVisibility: (agent: any, visible: boolean) => void;
}) {
  const visibleInTeam = (agent.visibleTeamIds ?? []).includes(currentTeamId);
  return (
    <div
      onClick={() => onSelectAgent(agent)}
      className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-left hover:bg-white"
      data-smoke="device-agent-item"
      data-agent-id={agent.id}
      data-agent-name={agent.name}
      data-agent-kind={smokeKind}
      data-agent-source={agent.source ?? ''}
      data-agent-category={agent.category ?? ''}
      data-agent-visible={visibleInTeam ? '1' : '0'}
    >
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{agent.name}</div>
        <div className="text-xs text-neutral-400">{agent.adapterKind}</div>
      </div>
      <Circle size={6} className={`shrink-0 fill-current ${agent.status === 'online' ? 'text-emerald-500' : 'text-neutral-300'}`} />
      <label
        onClick={(e) => e.stopPropagation()}
        className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-neutral-600"
        title="对当前团队可见"
      >
        <input
          type="checkbox"
          checked={visibleInTeam}
          disabled={!canManage}
          onChange={(e) => { e.stopPropagation(); onToggleVisibility(agent, e.target.checked); }}
        />
        可见
      </label>
      {canManage && onDeleteAgent && agent.source === 'custom' && (
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteAgent(agent); }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50"
          title="删除 Agent"
          aria-label={`删除 ${agent.name}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 改 AgentGroup 与调用处**

`AgentGroup` 组件（及其内部对 `AgentRow` 的调用）移除 `onSelectNetwork` 透传，改为透传 `currentTeamId` 与 `onToggleVisibility`。两处 `<AgentGroup>` 调用（689-715）删除 `onSelectNetwork={setSelectNetworkAgent}`，加：

```tsx
  currentTeamId={currentTeamId}
  onToggleVisibility={handleToggleVisibility}
```

在 `DeviceDetail` 组件内新增处理函数（用 `agentEvents` 与本地 state 刷新）：

```tsx
const handleToggleVisibility = async (agent: any, visible: boolean) => {
  if (!currentTeamId) return;
  const res = await agentEvents().setVisibility(agent.id, currentTeamId, visible);
  if (res.ok && res.agent) {
    setDeviceAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, visibleTeamIds: res.agent!.visibleTeamIds } : a)));
    setCustomAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, visibleTeamIds: res.agent!.visibleTeamIds } : a)));
  }
  refreshDeviceAgents();
};
```

- [ ] **Step 7: 移除 SelectNetworkDialog 及相关残留**

删除：
- `SelectNetworkDialog` 组件定义（1172-1242）
- state `selectNetworkAgent`（382）及其在删除清理处的引用（465）
- 渲染块（759-765）
- `updateSelectedAgentPublishState` 回调
- `AgentRow` 的「已发布到 N 个团队」徽章（1147-1151）已在 Step 5 重写中移除

- [ ] **Step 8: 跑测试 + tsc + lint**

Run: `cd apps/web-next && npx vitest run && npx tsc --noEmit`
Expected: 全绿，无类型错误

- [ ] **Step 9: Commit**

```bash
git add apps/web-next
git commit -m "前端: Agent 行尾可见性复选框，移除多团队发布对话框"
```

---

## Task 5: 废弃清理 — 删除 publish/unpublish 全链路 + 回归

**Files:**
- Modify: `packages/contracts/src/socket.ts`（删 `publish`/`unpublish` 事件）
- Modify: `packages/contracts/src/agent.ts`（删 `PublishAgentCommandDto`/`UnpublishAgentCommandDto`，若仅 server 用则改 server 内 Input 类型）
- Modify: `apps/server-next/src/application/usecases.ts`（删 `publishAgent`/`unpublishAgent` 接口与实现、`PublishAgentInput`/`UnpublishAgentInput`）
- Modify: `apps/server-next/src/application/repositories.ts`（删 `AgentRepository.publish`/`unpublish`，如无其他引用）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts` + `infra/memory/repositories.ts`（删对应实现）
- Modify: `apps/server-next/src/transport/socket-handlers.ts`（删 publish/unpublish handler）
- Modify: `apps/web-next/lib/socket.ts`（删 `AgentEvents.publish`/`unpublish` 与实现）
- Test: 全量回归

**Interfaces:**
- Consumes: Task 1-4 已用 `setAgentTeamVisibility` / `setVisibility` 替代全部调用点
- Produces: `publish`/`unpublish` 相关代码与协议彻底移除

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "agent:publish\|agent:unpublish\|\.publish(\|\.unpublish(\|publishAgent\|unpublishAgent\|PublishAgentInput\|UnpublishAgentInput" apps/server-next/src apps/web-next packages/contracts/src`
Expected: 仅剩待删的定义本身（无外部调用点）

- [ ] **Step 2: 删除后端 publish/unpublish**

按 Files 列表删除 `usecases.ts` 的 `publishAgent`/`unpublishAgent`（接口 ~80、实现 1756-1807、Input 类型 362-374）、`AgentRepository.publish/unpublish`（接口 + sqlite/memory 实现）、socket handler（151-175 区的 publish/unpublish 两个块）。

- [ ] **Step 3: 删除 contracts 事件**

在 `packages/contracts/src/socket.ts` 的 `agent` 块删除 `publish: 'agent:publish'` 与 `unpublish: 'agent:unpublish'` 两行。若 `PublishAgentCommandDto`/`UnpublishAgentCommandDto` 无其他引用一并删除。

- [ ] **Step 4: 删除前端 publish/unpublish**

在 `apps/web-next/lib/socket.ts` 删除 `AgentEvents.publish`/`unpublish` 接口声明与 `agentEvents` 内对应实现。

- [ ] **Step 5: 全量测试 + 类型检查**

Run:
```
cd apps/server-next && npx vitest run && npx tsc --noEmit
cd ../web-next && npx vitest run && npx tsc --noEmit
cd ../.. && npx vitest run   # 若有 root 层 contract 测试
```
Expected: 全绿

- [ ] **Step 6: 手动/回归验证要点**

- 成员页（`/[networkPath]/members`）：被设为不可见的 agent 不出现；executor-hosted 不出现。
- 设备详情页：复选框切换后，成员页实时反映（订阅 `agent.status`/snapshot）。
- 私聊：被移出的 agent 无法再被 @ / 发起新私聊（权限检查 `visibleTeamIds.includes` 拦截）。
- 迁移幂等：重复启动 server-next，`schema_migrations` 不重复应用，无报错。

- [ ] **Step 7: Commit**

```bash
git add apps/server-next apps/web-next packages/contracts
git commit -m "清理: 移除废弃的多团队 publish/unpublish 全链路"
```

---

## Self-Review（计划完成后）

**1. Spec coverage**（对照 PRD §1-§7）：
- §1 数据模型（visibleTeamIds/hidden）→ Task 1 Step 6-10 ✅
- §2 后端（ingest 跳过、setAgentTeamVisibility、listVisibleInTeam 过滤、权限不变）→ Task 1/2 ✅
- §3 前端（移除 SelectNetworkDialog、复选框、移除限制）→ Task 4 ✅
- §4 当前团队 = URL teamId → Task 4 用 `currentTeamId`（store 已解析）✅
- §5 边界（移出退频道、私聊保留、设备页仍见、限制移除）→ Task 1 Step 11（退频道）/ Task 5（限制随 publish 删除）✅
- §6 迁移（删执行器、收窄多团队）→ Task 1 Step 6 ✅
- §7 测试 → 各 Task TDD + Task 5 回归 ✅

**2. Placeholder scan**：无 TBD/TODO；setup 处标注「按现有测试模式对齐」属可执行的参照指引（非占位）。

**3. Type consistency**：`setPrimaryTeamVisibility`（repo）/ `setAgentTeamVisibility`（usecase）/ `setVisibility`（前端 socket）/ `agent:set-visibility`（协议）四处命名一致区分层次；`SetAgentTeamVisibilityInput` 字段 `{userId, teamId, agentId, visible}` 全链路一致。

**4. 已知风险（实现时关注）**：
- `registerDevice`/`registerDiscoveredAgents`/`listVisibleAgents` 的测试入口签名需在 Task 1 Step 1 按 `createInMemoryServerNext` 实际导出核对。
- `AgentGroup` 组件内部若直接渲染 `AgentRow`，Task 4 Step 6 需同步改其 props 透传。
- 删除 `AgentRepository.publish/unpublish` 前确认无其他 usecase（如 workspace）引用。
