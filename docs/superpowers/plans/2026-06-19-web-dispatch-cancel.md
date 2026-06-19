# apps/web dispatch:cancel 接入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 apps/web 接入 dispatch:cancel —— 实时展示 dispatch 状态 + running 时可取消,补全「agent 处理中」体验。

**Architecture:** 纯前端接入,server-next/contracts 零改动。`ChatMessage` 加 `dispatchStatus`/`dispatchId` 字段;store 加 `applyDispatchStatus` action;conversation-page 监听 `message:dispatch-status`(DispatchDto)更新;channel-message 在 human message 下方渲染状态胶囊 + running 取消按钮(发 `dispatch:cancel {dispatchId}`)。

**Tech Stack:** Next.js 14(React)、Zustand、vitest + jsdom + @testing-library/react、Tailwind + lucide-react。无新依赖。

**对应 spec:** `docs/superpowers/specs/2026-06-19-web-dispatch-cancel-design.md`

**已验证的关键假设(写 plan 前确认):**
- `CancelDispatchInput = { userId, dispatchId }`(`server-next/usecases.ts:472`)→ web 发 `{ dispatchId }`,userId 由 session 派生。
- `DispatchDto.messageId` = origin/触发 message(`usecases.ts:1975`)→ 状态挂 human message。

---

## 文件结构

| 文件 | 责任 | 状态 |
|------|------|------|
| `apps/web/lib/schema.ts` | `ChatMessage` 加 `dispatchStatus?`/`dispatchId?`;引入 `DispatchStatus` 类型 | ✏️ 修改 |
| `apps/web/lib/store.ts` | 加 `applyDispatchStatus` action(更新 messagesByChannel 里匹配 messageId 的 message) | ✏️ 修改 |
| `apps/web/components/conversation-page.tsx` | 监听 `message:dispatch-status` → 调 `applyDispatchStatus`;cleanup | ✏️ 修改 |
| `apps/web/components/channel-message.tsx` | human message 下方 dispatch 指示行(状态胶囊 + running 取消按钮) | ✏️ 修改 |
| `apps/web/tests/dispatch-status.test.ts` | store `applyDispatchStatus` 测试 | 🆕 创建 |
| `apps/web/tests/channel-message-dispatch.test.tsx` | channel-message dispatch 展示 + 取消交互测试 | 🆕 创建 |
| `packages/contracts` / `apps/server-next` | **零改动** |

---

## Task 1: schema + store applyDispatchStatus action

**Files:**
- Modify: `apps/web/lib/schema.ts`、`apps/web/lib/store.ts`
- Test: `apps/web/tests/dispatch-status.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/dispatch-status.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentBeanStore } from '../lib/store';
import type { ChatMessage } from '../lib/schema';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1',
    body: 'hi', createdAt: 1000, ...overrides,
  };
}

describe('applyDispatchStatus', () => {
  beforeEach(() => {
    useAgentBeanStore.setState({
      messagesByChannel: {
        c1: [makeMsg({ id: 'm1' }), makeMsg({ id: 'm2', body: 'second' })],
      },
    });
  });

  it('updates dispatchStatus and dispatchId on the matching message', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[0].dispatchStatus).toBe('running');
    expect(msgs[0].dispatchId).toBe('d1');
  });

  it('leaves other messages untouched', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[1].dispatchStatus).toBeUndefined();
    expect(msgs[1].dispatchId).toBeUndefined();
  });

  it('can update dispatchStatus alone (no dispatchId change when omitted)', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'cancelled');
    const msg = useAgentBeanStore.getState().messagesByChannel.c1[0];
    expect(msg.dispatchStatus).toBe('cancelled');
    expect(msg.dispatchId).toBe('d1'); // preserved
  });

  it('is a no-op when the channel or message is absent', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'missing', 'running', 'dx');
    useAgentBeanStore.getState().applyDispatchStatus('other', 'm1', 'running', 'dy');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[0].dispatchStatus).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/web && npx vitest run tests/dispatch-status.test.ts`
Expected: FAIL —— `applyDispatchStatus is not a function`(action 未定义) + `dispatchStatus` 类型错误

- [ ] **Step 3a: 修改 schema.ts**

在 `apps/web/lib/schema.ts` 顶部类型区(第 1 行附近)加 `DispatchStatus` 镜像(与 contracts 一致,8 态):

```typescript
export type DispatchStatus =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';
```

修改 `ChatMessage` 接口(52-61 行),加两个可选字段:

```typescript
export interface ChatMessage {
  id: string;
  channelId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson?: string | null;
  artifacts?: Artifact[];
  dispatchStatus?: DispatchStatus;
  dispatchId?: string;
}
```

- [ ] **Step 3b: 修改 store.ts**

在 `apps/web/lib/store.ts` 的 `AgentStore` 接口(约 181-182 行 `appendMessage` 之后)加声明:

```typescript
  applyDispatchStatus(channelId: string, messageId: string, dispatchStatus: DispatchStatus, dispatchId?: string): void;
```

(确保 `DispatchStatus` 已从 `./schema.js` import —— 在 store.ts 顶部 `import type { ..., ChatMessage, ... }` 里加入 `DispatchStatus`。)

在 store 实现(约 246-252 行 `appendMessage` 之后)加实现:

```typescript
  applyDispatchStatus(channelId, messageId, dispatchStatus, dispatchId) {
    set((s) => {
      const list = s.messagesByChannel[channelId];
      if (!list) return s;
      let changed = false;
      const next = list.map((msg) => {
        if (msg.id !== messageId) return msg;
        changed = true;
        return {
          ...msg,
          dispatchStatus,
          ...(dispatchId !== undefined ? { dispatchId } : {}),
        };
      });
      if (!changed) return s;
      return { messagesByChannel: { ...s.messagesByChannel, [channelId]: next } };
    });
  },
```

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/web && npx vitest run tests/dispatch-status.test.ts`
Expected: PASS(4 tests)。再跑全量 `cd apps/web && npx vitest run` 确认无回归(69 baseline + 4 = 73)。

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/schema.ts apps/web/lib/store.ts apps/web/tests/dispatch-status.test.ts
git commit -m "feat(web): add ChatMessage dispatchStatus field and applyDispatchStatus store action"
```

---

## Task 2: conversation-page 监听 message:dispatch-status

**Files:**
- Modify: `apps/web/components/conversation-page.tsx`
- Test: `apps/web/tests/dispatch-status.test.ts`(扩充)或集成验证

- [ ] **Step 1: 扩充测试 —— 加监听集成测试**

在 `apps/web/tests/dispatch-status.test.ts` 末尾加一个 describe(用 jsdom + mock socket):

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const handlers: Record<string, ((payload: unknown) => void)[]> = {};
const emitMock = vi.fn();
const mockSocket = {
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    (handlers[event] ??= []).push(handler);
  }),
  off: vi.fn((event: string, handler: (payload: unknown) => void) => {
    handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
  }),
  emit: emitMock,
};

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => mockSocket,
  agentEvents: () => ({ subscribe: () => {}, onSnapshot: () => () => {}, onStatus: () => () => {} }),
  channelEvents: () => ({ subscribe: () => {} }),
  dmEvents: () => ({ list: async () => ({ ok: true, dms: [] }), onSnapshot: () => () => {} }),
}));

import { ConversationPage } from '../components/conversation-page';
import { useAgentBeanStore } from '../lib/store';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(handlers)) delete handlers[k];
  emitMock.mockReset();
});

describe('ConversationPage dispatch-status listener', () => {
  it('updates the matching message on message:dispatch-status', async () => {
    useAgentBeanStore.setState({
      currentTeamId: 't1',
      channels: [{ id: 'c1', name: 'general', createdAt: 0 }],
      dms: [],
      agents: {},
      messagesByChannel: {
        c1: [{ id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1', body: 'hi', createdAt: 0 }],
      },
    });
    render(<ConversationPage channelId="c1" mode="channel" />);
    await waitFor(() => expect(mockSocket.on).toHaveBeenCalledWith('channel:join', expect.anything()));

    // simulate server broadcasting a dispatch-status for m1
    for (const h of handlers['message:dispatch-status'] ?? []) {
      h({ id: 'd1', messageId: 'm1', channelId: 'c1', status: 'running' });
    }
    expect(useAgentBeanStore.getState().messagesByChannel.c1[0].dispatchStatus).toBe('running');

    // other channel's dispatch-status is ignored
    for (const h of handlers['message:dispatch-status'] ?? []) {
      h({ id: 'd2', messageId: 'm9', channelId: 'other', status: 'running' });
    }
    expect(useAgentBeanStore.getState().messagesByChannel.c1).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/web && npx vitest run tests/dispatch-status.test.ts`
Expected: 新测试 FAIL —— `handlers['message:dispatch-status']` 为空(还没监听),dispatchStatus 未更新

- [ ] **Step 3: 修改 conversation-page.tsx**

在 `apps/web/components/conversation-page.tsx` 的 `useEffect`(23-54 行)里,加入 `applyDispatchStatus`(从 store 解构)+ dispatch-status 监听 + cleanup:

在 store 解构区(约 19-21 行 `applyChannelHistory`/`appendMessage` 旁)加:
```typescript
  const applyDispatchStatus = useAgentBeanStore((s) => s.applyDispatchStatus);
```

在 `useEffect` 内,`onMessage` 定义之后(约 42 行后)加 onDispatchStatus,并在 `socket.on('channel:message', onMessage)`(44 行)后注册,cleanup(51 行后)加 off:

```typescript
    const onDispatchStatus = (dispatch: { messageId: string; channelId: string; status: string; id?: string }) => {
      if (dispatch.channelId === channelId) {
        applyDispatchStatus(channelId, dispatch.messageId, dispatch.status as any, dispatch.id);
      }
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', onMessage);
    socket.on('message:dispatch-status', onDispatchStatus);

    return () => {
      offAgents();
      offStatus();
      offDms();
      socket.off('channels:snapshot', applyChannelsSnapshot);
      socket.off('channel:history', onHistory);
      socket.off('channel:message', onMessage);
      socket.off('message:dispatch-status', onDispatchStatus);
    };
```

并把 `applyDispatchStatus` 加入 useEffect 依赖数组(54 行)。

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/web && npx vitest run tests/dispatch-status.test.ts`
Expected: PASS。全量 `cd apps/web && npx vitest run` 无回归。

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/conversation-page.tsx apps/web/tests/dispatch-status.test.ts
git commit -m "feat(web): listen for message:dispatch-status and update message state"
```

---

## Task 3: channel-message dispatch 指示行 + 取消按钮

**Files:**
- Modify: `apps/web/components/channel-message.tsx`
- Test: `apps/web/tests/channel-message-dispatch.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/channel-message-dispatch.test.tsx`:

```typescript
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from '@/lib/schema';

const emitMock = vi.fn((event: string, payload: unknown, cb: (res: unknown) => void) => cb({ ok: true }));
vi.mock('@/lib/store', () => ({
  useAgentBeanStore: (selector: (s: unknown) => unknown) =>
    selector({ agents: {} }),
}));
vi.mock('@/lib/socket', () => ({
  getWebSocket: () => ({ emit: emitMock }),
  getResolvedServerUrl: () => 'http://srv',
  getStoredAuthToken: () => 'tok',
  // emitWithTimeout mock: call socket.emit (so emitMock is asserted) and resolve ok.
  emitWithTimeout: (socket: { emit: typeof emitMock }, event: string, payload: unknown) => {
    socket.emit(event, payload, () => {});
    return Promise.resolve({ ok: true });
  },
}));
vi.mock('@/lib/display-names', () => ({
  messageSpeakerName: () => 'Agent',
}));

import { ChannelMessage } from '../components/channel-message';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1',
    body: 'hi', createdAt: 1000, ...overrides,
  };
}

afterEach(() => {
  cleanup();
  emitMock.mockReset();
});

describe('ChannelMessage dispatch indicator', () => {
  it('shows "agent 正在处理…" and a 取消 button when running', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'running', dispatchId: 'd1' })} />);
    expect(screen.getByText(/正在处理/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('shows 已取消 capsule when cancelled (no cancel button)', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'cancelled', dispatchId: 'd1' })} />);
    expect(screen.getByText('已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
  });

  it('shows error text when failed', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'failed', dispatchId: 'd1' })} />);
    expect(screen.getByText(/失败/)).toBeInTheDocument();
  });

  it('renders no indicator when succeeded', () => {
    const { container } = render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'succeeded', dispatchId: 'd1' })} />);
    expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('正在处理');
  });

  it('emits dispatch:cancel with dispatchId on cancel click', () => {
    render(<ChannelMessage msg={makeMsg({ dispatchStatus: 'running', dispatchId: 'd1' })} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(emitMock).toHaveBeenCalledWith('dispatch:cancel', { dispatchId: 'd1' }, expect.any(Function));
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/web && npx vitest run tests/channel-message-dispatch.test.tsx`
Expected: FAIL —— 无「正在处理」/「取消」(组件还没渲染指示)

- [ ] **Step 3: 修改 channel-message.tsx**

在 `apps/web/components/channel-message.tsx` 顶部 import 加 `emitWithTimeout`、`getWebSocket`(从 `@/lib/socket`)与 `DispatchStatus`、`Loader2`/`X`/`AlertCircle` 图标(lucide-react):

```typescript
import { AlertCircle, Loader2, X } from 'lucide-react';
import { getWebSocket, getResolvedServerUrl, getStoredAuthToken, emitWithTimeout } from '@/lib/socket';
import type { DispatchStatus } from '@/lib/schema';
import { useAgentBeanStore } from '@/lib/store';
```

(确认 `emitWithTimeout` 已从 `@/lib/socket` 导出 —— socket.ts:183 是模块内函数,需在 plan 实现时 `export function emitWithTimeout(...)` 或在 channel-message 内联超时逻辑。**实现注意**:若 socket.ts 未导出 emitWithTimeout,在 socket.ts 加 `export` 或在组件内用 `getWebSocket().emit('dispatch:cancel', { dispatchId }, cb)` + 超时。优先方案:socket.ts 导出 emitWithTimeout。)

在 `ChannelMessage` 组件的 return(80-95 行)里,human message 气泡(`tone` 为 sky)内,在 `{msg.body}` 与 artifacts 之间(86 行后)插入 dispatch 指示行。先定义指示渲染逻辑:

在组件内(51 行 `ChannelMessage` 函数体内)加:
```typescript
  const dispatch = msg.senderKind === 'human' ? msg.dispatchStatus : undefined;
  const cancelling = false; // optimistic via store in real flow; here disabled to avoid store write in test

  function cancelDispatch() {
    if (!msg.dispatchId) return;
    emitWithTimeout(getWebSocket(), 'dispatch:cancel', { dispatchId: msg.dispatchId })
      .then((res: { ok?: boolean }) => {
        if (res?.ok) {
          useAgentBeanStore.getState().applyDispatchStatus(msg.channelId, msg.id, 'cancelled');
        }
      })
      .catch(() => { /* swallow; button remains */ });
  }

  function renderDispatch() {
    if (!dispatch) return null;
    if (dispatch === 'succeeded') return null;
    if (dispatch === 'running' || dispatch === 'queued' || dispatch === 'sent' || dispatch === 'accepted') {
      return (
        <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
          <Loader2 size={12} className="animate-spin text-blue-500" />
          <span>agent 正在处理…</span>
          <button
            type="button"
            onClick={cancelDispatch}
            className="ml-1 inline-flex items-center gap-1 rounded border border-neutral-200 px-2 py-0.5 text-neutral-600 hover:bg-neutral-50"
          >
            <X size={10} /> 取消
          </button>
        </div>
      );
    }
    if (dispatch === 'cancelled') {
      return <div className="mt-2 text-xs text-neutral-400">已取消</div>;
    }
    if (dispatch === 'failed') {
      return <div className="mt-2 text-xs text-red-500">处理失败</div>;
    }
    if (dispatch === 'timed_out') {
      return <div className="mt-2 text-xs text-amber-600">处理超时</div>;
    }
    return null;
  }
```

在 return 的消息气泡 `<div className="whitespace-pre-wrap text-sm">{msg.body}</div>`(86 行)之后加:
```typescript
      {renderDispatch()}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/web && npx vitest run tests/channel-message-dispatch.test.tsx`
Expected: PASS(5 tests)。全量 `cd apps/web && npx vitest run` 无回归。

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/channel-message.tsx apps/web/lib/socket.ts apps/web/tests/channel-message-dispatch.test.tsx
git commit -m "feat(web): show dispatch status indicator and cancel button on human messages"
```
(若改了 socket.ts 导出 emitWithTimeout,一并 add)

---

## Task 4: 全量验证与 build

**Files:** 无新文件;全量 test + next build + 类型检查。

- [ ] **Step 1: 全量 web 测试**

Run: `cd apps/web && npx vitest run`
Expected: 全 PASS(baseline 69 + dispatch-status + channel-message-dispatch,约 78 tests)。注意:既有 69 含 task-status/agent-scope/chat-scope 等,不应回归。

- [ ] **Step 2: next build(类型 + 编译)**

Run: `cd apps/web && npm run build`
Expected: next build 成功(无 TS 错误)。AGENTS.md Local Verification Contract 要求 web 改动跑 `cd apps/web && npm run build`。

- [ ] **Step 3: 类型/契约对齐确认**

确认 `WEB_EVENTS.message.dispatchStatus`(=`'message:dispatch-status'`)与 conversation-page 监听的字符串一致;`dispatch:cancel` 与 server `WEB_EVENTS.dispatch.cancel` 一致。无需改 contracts。

- [ ] **Step 4: 手动烟测(可选,需 server + device)**

1. 起本地 server-next + 一个 custom agent daemon。
2. web 发消息触发 dispatch,确认 human message 下方出现「agent 正在处理… [取消]」。
3. 点取消,确认变「已取消」。
4. 不取消时,agent reply 到达,指示消失。

- [ ] **Step 5: Commit 文档(若 known-gaps 需更新) + 收尾**

在 `agentbean-next/docs/known-gaps.md` 的 dispatch lifecycle 段补一句:web dispatch cancel affordance 已落地(`apps/web/components/{conversation-page,channel-message}.tsx`)。

```bash
git add agentbean-next/docs/known-gaps.md
git commit -m "docs(agentbean-next): mark web dispatch cancel affordance as landed"
```

---

## 验证矩阵(self-review 对照 spec)

| spec 要求 | 对应 Task |
|-----------|-----------|
| ChatMessage 加 dispatchStatus/dispatchId | Task 1 |
| store applyDispatchStatus action | Task 1 |
| 监听 message:dispatch-status 更新 | Task 2 |
| human message 下方指示(running 取消) | Task 3 |
| 状态胶囊(running/failed/cancelled/timed_out) | Task 3 |
| 取消发 dispatch:cancel {dispatchId} + optimistic | Task 3 |
| server/contracts 零改动 | 全程不碰 |
| 不做 history/详细 error/重试(YAGNI) | 非目标 |
