# Agent 智能体「忙碌」状态恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 server-next 在 dispatch 生命周期里真正写入 agent 的 `busy` 状态（派发→busy，终态→online/offline），使 web-next 显示「忙碌」，行为对齐 legacy。

**Architecture:** 状态翻转集中在 server-next 的 3 个 dispatch usecase 点（`sendMessage`/`cancelDispatch`/`failTimedOutDispatches`）；推送复用现有 `afterAgentMutation` + `refreshAgentSubscribers` 桥接（仅给 3 条未接的路径接上，超时路径需扩展 `ServerNextRealtime` 加 `refreshAgents`）；路由层不动（已 online-only，busy 自动不派发）；daemon 不动；web 仅统一 `AgentStatusBadge` 文案/配色。

**Tech Stack:** TypeScript、socket.io、vitest（server-next 真实内存 repo 零 mock）、Next.js（web-next）。

**Spec:** `docs/superpowers/specs/2026-07-03-agent-busy-state-design.md`

## Global Constraints

- 状态值复用合约已有 `'busy'`（`packages/contracts/src/agent.ts:12`），**不新增字段/表/枚举**。
- `busy` 写入现有 `AgentRecord.status`（`apps/server-next/src/application/repositories.ts:70`），与 online/offline 同字段。
- 取消/超时回落带守卫 `if (agent.status === 'busy')`，**不复活**已被级联置 offline 的 agent。
- 路由保持 online-only（`packages/domain/src/routing.ts:94`、`usecases.ts:4150`），**不改路由**——busy 自动被排除。
- daemon-next **零改动**。
- 测试用 `createInMemoryServerNext({ now, ids })` + 确定性 `createIds`，真实内存 repo，无 mock。
- 提交信息用中文，末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 本计划在 worktree `feat/agent-busy-state` 内执行（多会话隔离）。

---

## File Structure

- **Modify** `apps/server-next/src/application/usecases.ts` — 3 处状态翻转：`sendMessage`(:2436-2450)、`cancelDispatch`(:2930-2947)、`failTimedOutDispatches`(:2949-2967)
- **Modify** `apps/server-next/src/transport/socket-handlers.ts` — `message.send`(:281)、`dispatch.cancel`(:302) 回调接 `afterAgentMutation`
- **Modify** `apps/server-next/src/transport/socket-server.ts` — web-ns `afterAgentMutation`(:232-248) 加 `resultDispatchTeamId`；`ServerNextRealtime`(:22-23) 加 `refreshAgents`；realtime 对象(:450-454) 加实现
- **Modify** `apps/server-next/src/dev-server.ts` — 超时 loop(:314-316) 调 `realtime.refreshAgents`
- **Modify** `apps/web-next/components/agent-status-badge.tsx` — busy 文案「忙碌」/琥珀配色
- **Test** `apps/server-next/tests/first-slice.test.ts` — usecase 状态翻转（Task 1-3）
- **Test** `apps/server-next/tests/socket-integration.test.ts` — 推送端到端（Task 4-5）
- **Test** `packages/domain/tests/domain-core.test.ts` — busy 路由防回归（Task 7）

---

## Task 1: sendMessage 派发后置 busy

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:2449`（`dispatches.push(toDispatchDto(dispatch))` 之后）
- Test: `apps/server-next/tests/first-slice.test.ts`（在 `:1665` 现有 sendMessage 测试附近新增）

**Interfaces:**
- Consumes: `repositories.agents.updateStatus({ agentId, status, lastSeenAt })`（`repositories.ts:223`，返回 `Promise<void>`）；`dispatch.agentId`（DispatchRecord 字段）；`now`（sendMessage 内 `:2392` 已定义）
- Produces: sendMessage 后目标 agent `status === 'busy'`，供 Task 2/3 回落与 Task 4 推送依赖

- [ ] **Step 1: Write the failing test**

在 `apps/server-next/tests/first-slice.test.ts` 中，找到 `:1665` 的 `test('sendMessage creates a dispatch for the first eligible online agent', ...)`，在其后新增：

```ts
test('sendMessage marks the dispatched agent as busy', async () => {
  const app = createInMemoryServerNext({
    now: () => 400,
    ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    deviceId: 'device-1',
    lastSeenAt: 400,
  });

  await app.sendMessage({
    userId: 'user-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    body: '@Codex hello',
  });

  await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
    ok: true,
    agents: [{ id: 'agent-1', status: 'busy' }],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run（从 `apps/server-next`）:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "marks the dispatched agent as busy"
```
Expected: FAIL — `agents: [{ id: 'agent-1', status: 'online' }]`（当前不写 busy）

- [ ] **Step 3: Write minimal implementation**

在 `apps/server-next/src/application/usecases.ts` 的 `sendMessage` 中，定位 `:2436-2450` 的 `if (route.kind === 'dispatch')` 块。在 `dispatches.push(toDispatchDto(dispatch));`（`:2449`）之后、块结束（`:2450`）之前插入：

```ts
        dispatches.push(toDispatchDto(dispatch));
        await repositories.agents.updateStatus({
          agentId: dispatch.agentId,
          status: 'busy',
          lastSeenAt: now,
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "marks the dispatched agent as busy"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/first-slice.test.ts
git commit -m "feat: sendMessage 派发后将 agent 标记为 busy

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: cancelDispatch 守卫回落 busy→online

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:2939-2946`（`cancelDispatch` 内 `markCancelled` 之后）
- Test: `apps/server-next/tests/first-slice.test.ts`

**Interfaces:**
- Consumes: `repositories.agents.getById(agentId)`（`repositories.ts:214`，返回 `Promise<AgentRecord | null>`）；`cancelled.dispatch.agentId`（DispatchMutationResult.dispatch 是 DispatchRecord）；Task 1 产生的 busy 状态
- Produces: cancelDispatch 后 busy agent 回 online（offline 不复活）

- [ ] **Step 1: Write the failing tests**

在 `first-slice.test.ts` 中新增两个测试：

```ts
test('cancelDispatch clears busy back to online', async () => {
  const app = createInMemoryServerNext({
    now: () => 400,
    ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    deviceId: 'device-1',
    lastSeenAt: 400,
  });
  await app.sendMessage({
    userId: 'user-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    body: '@Codex hello',
  });

  const ack = await app.cancelDispatch({ userId: 'user-1', dispatchId: 'dispatch-1' });

  expect(ack).toMatchObject({ ok: true, dispatch: { id: 'dispatch-1', status: 'cancelled' } });
  await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
    ok: true,
    agents: [{ id: 'agent-1', status: 'online' }],
  });
});

test('cancelDispatch does not revive an offline agent', async () => {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1']) },
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'offline',
    deviceId: 'device-1',
    lastSeenAt: 400,
  });
  await repositories.dispatches.create({
    id: 'dispatch-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    agentId: 'agent-1',
    status: 'queued',
    requestId: 'req-1',
    createdAt: 500,
    updatedAt: 500,
    prompt: 'hello',
  });

  await app.cancelDispatch({ userId: 'user-1', dispatchId: 'dispatch-1' });

  await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
    ok: true,
    agents: [{ id: 'agent-1', status: 'offline' }],
  });
});
```

> 说明：第二个测试用 `createInMemoryRepositories()` + `createServerNextUseCases` 直种数据（参考 `socket-integration.test.ts:870` 模式），因为 offline agent 不会被路由、sendMessage 不会为其创建 dispatch。需在测试文件顶部确认已 import `createInMemoryRepositories` 与 `createServerNextUseCases`（`first-slice.test.ts` 已有这些 import）。

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "cancelDispatch"
```
Expected: FAIL — 「clears busy back to online」期望 online 实际仍 busy（未回落）

- [ ] **Step 3: Write minimal implementation**

在 `usecases.ts` 的 `cancelDispatch`（`:2930-2947`）中，把 `markCancelled` 之后的返回前改为：

```ts
      const cancelled = await repositories.dispatches.markCancelled({
        dispatchId: cancelInput.dispatchId,
        completedAt: clock.now(),
      });
      if (!cancelled) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      const agent = await repositories.agents.getById(cancelled.dispatch.agentId);
      if (agent && agent.status === 'busy') {
        await repositories.agents.updateStatus({
          agentId: cancelled.dispatch.agentId,
          status: 'online',
          lastSeenAt: clock.now(),
        });
      }
      return makeSuccess({ dispatch: toDispatchDto(cancelled.dispatch) });
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "cancelDispatch"
```
Expected: PASS（两个测试都过：busy→online；offline 不复活）

- [ ] **Step 5: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/first-slice.test.ts
git commit -m "feat: cancelDispatch 守卫回落 busy→online（不复活 offline）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: failTimedOutDispatches 守卫回落 busy→online

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:2957-2965`（`failTimedOutDispatches` 循环内 `markTimedOut` 之后）
- Test: `apps/server-next/tests/first-slice.test.ts`

**Interfaces:**
- Consumes: `dispatch.agentId`（`listPendingOlderThan` 返回的 DispatchRecord）；`now`（failTimedOutDispatches 内 `:2950` 已定义）
- Produces: 超时后 busy agent 回 online（offline 不复活）

- [ ] **Step 1: Write the failing tests**

在 `first-slice.test.ts` 新增：

```ts
test('failTimedOutDispatches clears busy back to online on timeout', async () => {
  const app = createInMemoryServerNext({
    now: () => 1000,
    ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    deviceId: 'device-1',
    lastSeenAt: 1000,
  });
  await app.sendMessage({
    userId: 'user-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    body: '@Codex hello',
  });

  const ack = await app.failTimedOutDispatches({ olderThan: 1001 });

  expect(ack).toMatchObject({ ok: true, dispatches: [{ id: 'dispatch-1', status: 'timed_out' }] });
  await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
    ok: true,
    agents: [{ id: 'agent-1', status: 'online' }],
  });
});

test('failTimedOutDispatches does not revive an offline agent', async () => {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 2000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1']) },
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'offline',
    deviceId: 'device-1',
    lastSeenAt: 400,
  });
  await repositories.dispatches.create({
    id: 'dispatch-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    agentId: 'agent-1',
    status: 'queued',
    requestId: 'req-1',
    createdAt: 500,
    updatedAt: 500,
    prompt: 'hello',
  });

  await app.failTimedOutDispatches({ olderThan: 1000 });

  await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
    ok: true,
    agents: [{ id: 'agent-1', status: 'offline' }],
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "failTimedOutDispatches"
```
Expected: FAIL — 「clears busy back to online」期望 online 实际仍 busy

- [ ] **Step 3: Write minimal implementation**

在 `usecases.ts` 的 `failTimedOutDispatches`（`:2949-2967`）循环内，把 `if (timedOut?.changed)` 块改为：

```ts
        if (timedOut?.changed) {
          const agent = await repositories.agents.getById(dispatch.agentId);
          if (agent && agent.status === 'busy') {
            await repositories.agents.updateStatus({
              agentId: dispatch.agentId,
              status: 'online',
              lastSeenAt: now,
            });
          }
          dispatches.push(toDispatchDto(timedOut.dispatch));
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
../../node_modules/.bin/vitest run tests/first-slice.test.ts --config vitest.config.ts -t "failTimedOutDispatches"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/first-slice.test.ts
git commit -m "feat: failTimedOutDispatches 守卫回落 busy→online（不复活 offline）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 推送 — sendMessage 与 cancelDispatch 接 afterAgentMutation

**Files:**
- Modify: `apps/server-next/src/transport/socket-handlers.ts:281`（message.send 回调）、`:302`（dispatch.cancel 回调）
- Modify: `apps/server-next/src/transport/socket-server.ts:232-244`（web-ns afterAgentMutation 的 agentTeamIds）
- Test: `apps/server-next/tests/socket-integration.test.ts`

**Interfaces:**
- Consumes: `options.afterAgentMutation?(payload, result)`（web handler options，由 `socket-server.ts:232` 注入）；`resultDispatchTeamId(result)`（`socket-server.ts:957`，从 `result.dispatch.teamId` 提取）
- Produces: sendMessage/cancelDispatch 后 web 订阅者收到 `agent:status`（busy/online）

**背景：** message.send 与 dispatch.cancel 当前用自定义回调，未调 `afterAgentMutation`，故 agent 状态变更不推 web。`SendMessageInput` 有 `teamId`（payloadTeamId 可提取）；但 `CancelDispatchInput`（`usecases.ts:532`）只有 `userId`+`dispatchId`，payloadTeamId 落空——需让 web-ns afterAgentMutation 额外用 `resultDispatchTeamId` 从 `{dispatch:{teamId}}` 提取。

- [ ] **Step 1: Write the failing test**

在 `socket-integration.test.ts` 的 `describe('server-next Socket.IO namespaces', ...)` 块内新增：

```ts
  test('emits agent:status busy on dispatch and online on cancel', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1',
        'agent-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agentSock = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agentSock.disconnect(); });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] });
    await agentSock.emitWithAck(AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }] });

    const statuses: Array<{ id?: string; status?: string }> = [];
    web.on(WEB_EVENTS.agent.status, (s) => statuses.push(s as { id?: string; status?: string }));
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { teamId: 'team-1' });

    await web.emitWithAck(WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });

    await web.emitWithAck(WEB_EVENTS.dispatch.cancel, { userId: 'user-1', dispatchId: 'dispatch-1' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'online')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
../../node_modules/.bin/vitest run tests/socket-integration.test.ts --config vitest.config.ts -t "emits agent:status busy on dispatch"
```
Expected: FAIL — 超时（web 收不到 busy 的 agent:status）

- [ ] **Step 3: Write minimal implementation**

**(a)** `socket-handlers.ts:281` 的 message.send 回调，在 `afterMessageSend` 之后加 `afterAgentMutation`：

```ts
  bind(socket, WEB_EVENTS.message.send, app, 'sendMessage', async (_payload, result) => {
    await options.afterMessageSend?.(_payload, result);
    await options.afterAgentMutation?.(_payload, result);
    if (!options.dispatch || !isSendMessageAck(result)) {
      return;
    }
    for (const dispatch of result.dispatches) {
      const request = await app.getDispatchRequest({ dispatchId: dispatch.id });
      if (request.ok) {
        options.dispatch(request.request);
      }
    }
  }, { authenticatedUser: options.authenticatedUser });
```

**(b)** `socket-handlers.ts:302` 的 dispatch.cancel 回调，在 `isDispatchAck` 检查之后加 `afterAgentMutation`：

```ts
  bind(socket, WEB_EVENTS.dispatch.cancel, app, 'cancelDispatch', async (_payload, result) => {
    if (!isDispatchAck(result)) {
      return;
    }
    await options.afterAgentMutation?.(_payload, result);
    options.dispatchStatus?.(result.dispatch);
    if (!options.dispatchCancel) {
      return;
    }
    const request = await app.getDispatchRequest({ dispatchId: result.dispatch.id });
    if (request.ok) {
      options.dispatchCancel(request.request);
    }
  }, { authenticatedUser: options.authenticatedUser });
```

**(c)** `socket-server.ts:232-244` 的 web-ns `afterAgentMutation`，在 `agentTeamIds` 数组末尾加 `resultDispatchTeamId(result)`：

```ts
      async afterAgentMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const agentTeamIds = uniqueStrings([
          payloadTeamId(payload),
          payloadTargetTeamId(payload),
          ...payloadTeamIds(payload, 'affectedTeamIds'),
          ...resultAgentVisibleTeamIds(result),
          resultDispatchTeamId(result),
        ]);
        for (const teamId of agentTeamIds) {
          await refreshAgentSubscribers(webSubscribers, app, teamId);
        }
        for (const teamId of payloadTeamIds(payload, 'channelTeamIds')) {
          await refreshChannelSubscribers(webSubscribers, app, teamId);
        }
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
../../node_modules/.bin/vitest run tests/socket-integration.test.ts --config vitest.config.ts -t "emits agent:status busy on dispatch"
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-next/src/transport/socket-handlers.ts apps/server-next/src/transport/socket-server.ts apps/server-next/tests/socket-integration.test.ts
git commit -m "feat: sendMessage/cancelDispatch 接 afterAgentMutation 推送 agent 状态

web-ns afterAgentMutation 增加 resultDispatchTeamId 提取，
让无 teamId 的 cancelDispatch 也能按 dispatch.teamId refresh。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 推送 — 超时路径扩展 realtime.refreshAgents

**Files:**
- Modify: `apps/server-next/src/transport/socket-server.ts:22-23`（ServerNextRealtime 接口）、`:450-454`（realtime 返回对象）
- Modify: `apps/server-next/src/dev-server.ts:314-316`（超时 loop）
- Test: `apps/server-next/tests/socket-integration.test.ts`（含 `startSocketServer` 改动）

**Interfaces:**
- Consumes: `refreshAgentSubscribers(subscribers, app, teamId)`（`socket-server.ts:474`，async）
- Produces: `ServerNextRealtime.refreshAgents(teamId: string): Promise<void>`；dev-server 超时后推 agent 状态

**背景：** `failTimedOutDispatches` 在 `dev-server.ts:310` 由定时器调用，只有 `realtime` 对象，而 `ServerNextRealtime`（`socket-server.ts:22`）只有 `emitDispatchStatus`。需扩展接口加 `refreshAgents`，并在超时 loop 调用。

- [ ] **Step 1: 改 startSocketServer 以暴露 realtime**

在 `socket-integration.test.ts:2542-2553` 的 `startSocketServer`，捕获并返回 realtime：

```ts
async function startSocketServer(app: ReturnType<typeof createInMemoryServerNext>) {
  const httpServer = createServer();
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const realtime = attachServerNextNamespaces(ioServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    ioServer,
    realtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}
```

- [ ] **Step 2: Write the failing test**

在 `socket-integration.test.ts` 新增（验证 realtime.refreshAgents 把当前 agent 状态推给订阅者）：

```ts
  test('realtime.refreshAgents emits current agent status to subscribers', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1',
        'agent-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer, realtime } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agentSock = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agentSock.disconnect(); });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] });
    await agentSock.emitWithAck(AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }] });

    const statuses: Array<{ id?: string; status?: string }> = [];
    web.on(WEB_EVENTS.agent.status, (s) => statuses.push(s as { id?: string; status?: string }));
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { teamId: 'team-1' });
    await web.emitWithAck(WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });

    statuses.length = 0;
    await realtime.refreshAgents('team-1');
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
../../node_modules/.bin/vitest run tests/socket-integration.test.ts --config vitest.config.ts -t "refreshAgents emits current"
```
Expected: FAIL — TypeScript 报 `realtime.refreshAgents` 不存在（接口未定义）

- [ ] **Step 4: Write minimal implementation**

**(a)** `socket-server.ts:22-23` 的 `ServerNextRealtime` 接口加方法：

```ts
export interface ServerNextRealtime {
  emitDispatchStatus(dispatch: unknown): void;
  refreshAgents(teamId: string): Promise<void>;
}
```

**(b)** `socket-server.ts:450-454` 的返回对象加实现：

```ts
  return {
    emitDispatchStatus(dispatch) {
      emitDispatchStatus(webSubscribers, dispatch);
    },
    async refreshAgents(teamId) {
      await refreshAgentSubscribers(webSubscribers, app, teamId);
    },
  };
```

**(c)** `dev-server.ts:314-316` 的超时 loop，emit dispatchStatus 旁加 refreshAgents：

```ts
    for (const dispatch of result.dispatches) {
      realtime.emitDispatchStatus(dispatch);
      await realtime.refreshAgents(dispatch.teamId);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
../../node_modules/.bin/vitest run tests/socket-integration.test.ts --config vitest.config.ts -t "refreshAgents emits current"
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/transport/socket-server.ts apps/server-next/src/dev-server.ts apps/server-next/tests/socket-integration.test.ts
git commit -m "feat: ServerNextRealtime 增加 refreshAgents，超时回落推 agent 状态

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: web AgentStatusBadge 文案/配色统一为「忙碌」/琥珀

**Files:**
- Modify: `apps/web-next/components/agent-status-badge.tsx:6,14`

**Interfaces:**
- Consumes: 无（纯展示常量）
- Produces: busy 渲染为「忙碌」+ `bg-amber-50 text-amber-700`（对齐 `member-detail.tsx:35-41,86-91`）

**说明：** web-next 仅有 store/lib 单元测试（`tests/*.test.ts`），无 React 组件渲染测试基建（无 jsdom/testing-library、无 `.tsx` 测试）。故用 `build:client`（tsc）验证编译，辅以视觉确认。

- [ ] **Step 1: 修改组件**

`apps/web-next/components/agent-status-badge.tsx`，把 `LABEL.busy` 与 `STYLE.busy` 改为：

```ts
const LABEL: Record<AgentStatus, string> = {
  connecting: '连接中',
  online: '在线',
  busy: '忙碌',
  offline: '离线',
  error: '异常',
};

const STYLE: Record<AgentStatus, string> = {
  connecting: 'bg-amber-100 text-amber-800',
  online: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-amber-50 text-amber-700',
  offline: 'bg-neutral-200 text-neutral-700',
  error: 'bg-rose-100 text-rose-800',
};
```

- [ ] **Step 2: 验证编译**

Run（从 `apps/web-next`）:
```bash
npm run build:client
```
Expected: tsc 编译通过，无类型错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/components/agent-status-badge.tsx
git commit -m "style: AgentStatusBadge busy 统一为忙碌/琥珀配色

对齐 member-detail 等多数组件，原处理中/天蓝不一致。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 路由 busy 防回归测试 + 口径排查

**Files:**
- Test: `packages/domain/tests/domain-core.test.ts`（`describe('Phase 1 message routing rules', ...)` 块内，约 `:51-153`）
- 调查（不改代码）：`apps/server-next/src`、`packages/domain/src` 的 `status === 'online'` 判定

**Interfaces:**
- Consumes: `routeMessage(input)`（`packages/domain/src/routing.ts:33`）
- Produces: 明确的 busy 路由排除测试（防回归）；口径排查报告（发现并修正任何误把 busy 当离线的判定）

**背景：** `isEligibleOnlineAgent`（`routing.ts:94`）已只认 online，busy 自动排除——但无测试覆盖 busy。需固化。另需排查其他 `status === 'online'` 判定点，确认 busy 该认的认、不该认的不认。

- [ ] **Step 1: Write the failing test（先确认现状）**

在 `packages/domain/tests/domain-core.test.ts` 的 routing describe 块内新增：

```ts
  test('does not dispatch to a busy agent even when explicitly mentioned', () => {
    const result = routeMessage({
      body: '@Busybot do thing',
      teamId: 'team-1',
      agents: [{ id: 'agent-1', name: 'Busybot', status: 'busy' }],
      humanMembers: [],
    });
    expect(result).toEqual({ kind: 'no-dispatch', reason: 'unknown-mention' });
  });

  test('does not use a busy agent as fallback', () => {
    const result = routeMessage({
      body: 'hello',
      teamId: 'team-1',
      agents: [{ id: 'agent-1', name: 'Busybot', status: 'busy' }],
      humanMembers: [],
    });
    expect(result).toEqual({ kind: 'no-dispatch', reason: 'no-online-agent' });
  });
```

- [ ] **Step 2: Run test（应直接通过——固化现有行为）**

Run（从仓库根）:
```bash
cd packages/domain && ../../node_modules/.bin/vitest run tests/domain-core.test.ts -t "busy"
```
Expected: PASS（路由已 online-only）。若 FAIL，说明路由行为被改坏，需修 `routing.ts:94`。

- [ ] **Step 3: 口径排查**

Run（从仓库根）:
```bash
grep -rn "status === 'online'\|status !== 'online'" apps/server-next/src packages/domain/src --include="*.ts" | grep -v dist
```
对每个命中逐条判定：
- 用于**路由/派发资格**（如 `routing.ts:94`、`usecases.ts:4150`）→ 保持 online-only（busy 不该被派发）✅
- 用于**「算在线」展示/可见性/device 解析** → 应改成 `status === 'online' || status === 'busy'`（busy 仍算在线呈现）

若发现需改的判定点，在该处加测试并修改（沿用本任务 TDD 节奏）。若无（预期），记录结论。

- [ ] **Step 4: Run domain 全量测试确认无回归**

Run:
```bash
cd packages/domain && ../../node_modules/.bin/vitest run
```
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/domain/tests/domain-core.test.ts
git commit -m "test: 固化 busy agent 不被路由的回归测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（若 Step 3 发现并改了口径判定点，一并 `git add` 对应源码 + 测试。）

---

## 收尾：全量测试

- [ ] **Step 1: server-next 全量测试**

Run（从 `apps/server-next`）:
```bash
../../node_modules/.bin/vitest run --config vitest.config.ts
```
Expected: 全部 PASS（含原有 + 新增）。

- [ ] **Step 2: web-next 编译**

Run（从 `apps/web-next`）:
```bash
npm run build:client
```
Expected: 编译通过。

- [ ] **Step 3: domain 全量测试**

Run（从仓库根）:
```bash
cd packages/domain && ../../node_modules/.bin/vitest run
```
Expected: 全部 PASS。

- [ ] **Step 4: contracts 测试（确认 AgentStatus 未被破坏）**

Run（从仓库根）:
```bash
cd packages/contracts && ../../node_modules/.bin/vitest run
```
Expected: 全部 PASS。

---

## Self-Review

**1. Spec coverage:**
- §4.2 进入 busy → Task 1 ✅
- §4.3 回落：成功（已有，Task 7 回归）/ 失败（已有）/ 取消（Task 2）/ 超时（Task 3）/ device 掉线（已有，Task 7 不涉及）/ device 重连（已有）✅
- §5 守卫 → Task 2/3 的 `if status === 'busy'` ✅
- §6 device 掉线级联自愈 → 现有代码，无需任务（spec 已说明）✅
- §6.1 口径排查 → Task 7 Step 3 ✅
- §7 推送：成功/失败（已有）/ sendMessage（Task 4）/ cancel（Task 4）/ 超时（Task 5）✅
- §8 web 文案 → Task 6 ✅
- §9 测试 → Task 1-7 全覆盖 ✅

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整代码；web task 因无组件测试基建改用 build 验证（已说明，非占位符）。

**3. Type consistency:** `updateStatus({ agentId, status, lastSeenAt })`、`getById(agentId)`、`refreshAgents(teamId)`、`resultDispatchTeamId(result)` 在各任务间签名一致。dispatch.agentId / cancelled.dispatch.agentId 均为 DispatchRecord 字段。
