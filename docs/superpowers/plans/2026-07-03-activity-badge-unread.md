# 活动图标徽标显示真实未读数 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让聊天侧边栏"活动"图标徽标显示真实未读活动数(与活动页一致、标记已读/新消息实时联动、未读 0 时隐藏)。

**Architecture:** 把"已读集合 doneIds"和"活动消息"都上移到全局可见——doneIds 提到顶层组件(复用 PR#395 的 `lib/chat-read-state`);ActivityView 的 join 结果写进全局 store(新增 `upsertMessages`,merge 语义不覆盖);徽标和 ActivityView 共用 `inboxActivityMessages` 纯函数算未读,保证口径一致。

**Tech Stack:** Next.js 14 App Router + React 18 + Zustand 4 + vitest(node 环境)+ TypeScript。

## Global Constraints

- **持久化范围:本地 localStorage**(继承 PR#395,不做跨设备同步、不新增后端事件/migration)。
- **测试运行**:worktree 无 node_modules,用主仓库根 bin:`/Users/shaw/AgentBean/node_modules/.bin/vitest run` 与 `/Users/shaw/AgentBean/node_modules/.bin/tsc -p tsconfig.lib.json --noEmit`,cwd = `apps/web-next`。
- **vitest 默认 node 环境**(无 jsdom);测试只测 `lib/` 纯函数,不渲染 React 组件。
- **路径 alias**:`@/lib/...`(tsconfig `@/*`)。
- **ChatMessage 必填字段**(schema.ts:67-81):`id, channelId, senderKind, senderId, body, createdAt`;其余(`teamId, threadId, metaJson, meta, artifacts, dispatchStatus, dispatchId`)可选。
- **代码风格**:纯函数模块照搬 `lib/chat-scope.ts`;store action 照搬 `lib/store.ts` 的 `appendMessage`/`applyChannelHistory` 风格;中文 commit message + `Co-Authored-By: Claude <noreply@anthropic.com>` footer。
- **page.tsx 是 `'use client'`**;`ActivityView` 是 `chat/page.tsx` 内的子组件(条件渲染,`sidebarView === 'inbox'`)。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/web-next/lib/store.ts` | Zustand store;新增 `mergeMessagesByChannel` 纯函数 + `upsertMessages` action | 修改 |
| `apps/web-next/lib/chat-scope.ts` | 聊天消息可见性纯函数;新增 `inboxActivityMessages` | 修改 |
| `apps/web-next/tests/store-messages.test.ts` | `mergeMessagesByChannel` 单测 | 新建 |
| `apps/web-next/tests/chat-scope.test.ts` | `inboxActivityMessages` 单测 | 新建 |
| `apps/web-next/app/[networkPath]/chat/page.tsx` | doneIds 上移 + 徽标 + ActivityView 改造 | 修改 |

---

### Task 1: `mergeMessagesByChannel` 纯函数 + `upsertMessages` action

**Files:**
- Modify: `apps/web-next/lib/store.ts`
- Test: `apps/web-next/tests/store-messages.test.ts`(新建)

**Interfaces:**
- Produces:
  - `mergeMessagesByChannel(existing: Record<string, ChatMessage[]>, msgs: ChatMessage[]): Record<string, ChatMessage[]>` — 纯函数,按 `channelId` 分组、按 `id` 去重 merge,已存在不覆盖,无新增时返回原引用。Task 3 的 store action 调用它。
  - store action `upsertMessages(msgs: ChatMessage[]): void`。

- [ ] **Step 1: 写失败测试** `tests/store-messages.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { mergeMessagesByChannel } from '../lib/store';
import type { ChatMessage } from '../lib/schema';

function msg(id: string, channelId: string, senderKind: ChatMessage['senderKind'] = 'human'): ChatMessage {
  return { id, channelId, senderKind, senderId: 'u', body: '', createdAt: 0 };
}

describe('mergeMessagesByChannel', () => {
  test('新消息按 channelId 分组追加', () => {
    const result = mergeMessagesByChannel(
      { c1: [msg('m1', 'c1')] },
      [msg('m2', 'c1'), msg('m3', 'c2')],
    );
    expect(result.c1.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(result.c2.map((m) => m.id)).toEqual(['m3']);
  });

  test('已存在 id 不覆盖(保护 active channel 滚动状态)', () => {
    const existing = { c1: [{ ...msg('m1', 'c1'), body: 'old' }] };
    const result = mergeMessagesByChannel(existing, [{ ...msg('m1', 'c1'), body: 'new' }]);
    expect(result.c1[0].body).toBe('old');
  });

  test('同一批 msgs 内部去重', () => {
    const result = mergeMessagesByChannel({}, [msg('m1', 'c1'), msg('m1', 'c1')]);
    expect(result.c1.map((m) => m.id)).toEqual(['m1']);
  });

  test('无新增时返回原对象引用(让 Zustand bailout)', () => {
    const existing = { c1: [msg('m1', 'c1')] };
    expect(mergeMessagesByChannel(existing, [msg('m1', 'c1')])).toBe(existing);
  });

  test('空 msgs 返回原对象引用', () => {
    const existing = { c1: [msg('m1', 'c1')] };
    expect(mergeMessagesByChannel(existing, [])).toBe(existing);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/vitest run tests/store-messages.test.ts`
Expected: FAIL — `mergeMessagesByChannel` 未从 `../lib/store` 导出。

- [ ] **Step 3: 实现 `mergeMessagesByChannel` + `upsertMessages`**

在 `lib/store.ts` 的 `export const useAgentBeanStore = create<State>((set) => ({` **之前**插入纯函数:

```ts
export function mergeMessagesByChannel(
  existing: Record<string, ChatMessage[]>,
  msgs: ChatMessage[],
): Record<string, ChatMessage[]> {
  if (msgs.length === 0) return existing;
  const next: Record<string, ChatMessage[]> = { ...existing };
  let changed = false;
  for (const msg of msgs) {
    const list = next[msg.channelId] ?? [];
    if (list.some((m) => m.id === msg.id)) continue;
    next[msg.channelId] = [...list, msg];
    changed = true;
  }
  return changed ? next : existing;
}
```

在 `State` 接口里(`applyDispatchStatus(...)` 那行之后,约 line 184)加方法签名:

```ts
  upsertMessages(msgs: ChatMessage[]): void;
```

在 `create<State>((set) => ({ ... })` 里(`applyDispatchStatus` 实现之后,约 line 288)加 action:

```ts
  upsertMessages(msgs) {
    set((s) => ({ messagesByChannel: mergeMessagesByChannel(s.messagesByChannel, msgs) }));
  },
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/vitest run tests/store-messages.test.ts`
Expected: PASS — 5 tests。

- [ ] **Step 5: 类型检查**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/tsc -p tsconfig.lib.json --noEmit`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git -C <worktree-root> add apps/web-next/lib/store.ts apps/web-next/tests/store-messages.test.ts
git -C <worktree-root> commit -m "feat(web-next): store 加 upsertMessages(批量 merge 不覆盖)"
```
(`<worktree-root>` = 当前 worktree 根目录绝对路径)

---

### Task 2: `inboxActivityMessages` 纯函数

**Files:**
- Modify: `apps/web-next/lib/chat-scope.ts`
- Test: `apps/web-next/tests/chat-scope.test.ts`(新建)

**Interfaces:**
- Produces: `inboxActivityMessages<T extends ActivityMessage>(messages: T[], visibleIds: Set<string>, limit?: number): T[]`,其中 `ActivityMessage = { channelId: string; senderKind: string; createdAt: number }`。Task 3 的顶层徽标与 ActivityView 共用。

- [ ] **Step 1: 写失败测试** `tests/chat-scope.test.ts`

```ts
import { describe, expect, test } from 'vitest';
import { inboxActivityMessages } from '../lib/chat-scope';

const human = { senderKind: 'human', senderId: 'u', body: '' } as const;

describe('inboxActivityMessages', () => {
  test('只保留 visible channel 的消息', () => {
    const result = inboxActivityMessages(
      [
        { id: 'm1', channelId: 'c1', createdAt: 1, ...human },
        { id: 'm2', channelId: 'c2', createdAt: 2, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  test('过滤 system 消息', () => {
    const result = inboxActivityMessages(
      [
        { id: 'sys', channelId: 'c1', createdAt: 1, senderKind: 'system', senderId: null, body: '' },
        { id: 'm2', channelId: 'c1', createdAt: 2, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['m2']);
  });

  test('按 createdAt 降序', () => {
    const result = inboxActivityMessages(
      [
        { id: 'old', channelId: 'c1', createdAt: 1, ...human },
        { id: 'new', channelId: 'c1', createdAt: 5, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['new', 'old']);
  });

  test('尊重 limit', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, channelId: 'c1', createdAt: i, ...human,
    }));
    expect(inboxActivityMessages(msgs, new Set(['c1']), 3).map((m) => m.id)).toEqual(['m4', 'm3', 'm2']);
  });

  test('visibleIds 为空返回空', () => {
    expect(inboxActivityMessages(
      [{ id: 'm1', channelId: 'c1', createdAt: 1, ...human }],
      new Set(),
    )).toEqual([]);
  });

  test('limit 默认 80', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, channelId: 'c1', createdAt: i, ...human,
    }));
    expect(inboxActivityMessages(msgs, new Set(['c1']))).toHaveLength(80);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/vitest run tests/chat-scope.test.ts`
Expected: FAIL — `inboxActivityMessages` 未从 `../lib/chat-scope` 导出。

- [ ] **Step 3: 实现** — 在 `lib/chat-scope.ts` 末尾追加:

```ts
export interface ActivityMessage {
  channelId: string;
  senderKind: string;
  createdAt: number;
}

export function inboxActivityMessages<T extends ActivityMessage>(
  messages: T[],
  visibleIds: Set<string>,
  limit = 80,
): T[] {
  return messagesForVisibleConversations(messages, visibleIds)
    .filter((m) => m.senderKind !== 'system')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/vitest run tests/chat-scope.test.ts`
Expected: PASS — 6 tests。

- [ ] **Step 5: 类型检查**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/tsc -p tsconfig.lib.json --noEmit`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git -C <worktree-root> add apps/web-next/lib/chat-scope.ts apps/web-next/tests/chat-scope.test.ts
git -C <worktree-root> commit -m "feat(web-next): chat-scope 加 inboxActivityMessages(活动消息口径)"
```

---

### Task 3: `page.tsx` 集成 — doneIds 上移 + 徽标 + ActivityView 改造

**Files:**
- Modify: `apps/web-next/app/[networkPath]/chat/page.tsx`

**Interfaces:**
- Consumes: Task 1 的 `upsertMessages`(store action,经 `useAgentBeanStore` 取)、Task 2 的 `inboxActivityMessages`、PR#395 的 `loadReadIds`/`saveReadIds`/`readKey`(已 import 于本文件)。

> 本任务是组件集成,无新增纯函数(逻辑已在 Task 1/2 TDD 覆盖)。验证靠 `tsc` + 全量回归 + 端到端。改动必须一次性完成(中间状态不编译:doneIds 提顶层后 ActivityView 必须同步接 props)。

- [ ] **Step 1: import 补 `inboxActivityMessages`**

在 `import { messagesForVisibleConversations, visibleConversationIds } from '@/lib/chat-scope';` 行(page.tsx:14)改为:

```ts
import { inboxActivityMessages, messagesForVisibleConversations, visibleConversationIds } from '@/lib/chat-scope';
```

- [ ] **Step 2: 顶层加 `doneIds` state + 持久化 effect**

在 `page.tsx` 顶层组件内、`savedIds` 声明附近(line 169 区域,`reactionIds` 之后)加:

```ts
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [loadedDoneKey, setLoadedDoneKey] = useState<string | null>(null);
```

在 `reactionsKey` 持久化 effect 附近(page.tsx:306–321 区域之后)加 hydrate + persist effect:

```ts
  useEffect(() => {
    setDoneIds(loadReadIds(routeNetworkPath));
    setLoadedDoneKey(readKey(routeNetworkPath));
  }, [routeNetworkPath]);

  useEffect(() => {
    if (loadedDoneKey !== readKey(routeNetworkPath)) return;
    try {
      saveReadIds(routeNetworkPath, doneIds);
    } catch {}
  }, [doneIds, loadedDoneKey, routeNetworkPath]);
```

- [ ] **Step 3: 顶层算 `inboxUnread`**

在顶层组件内(徽标渲染之前,可用 `channels`/`dms`/`messagesByChannel` 处)加:

```ts
  const inboxUnread = inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleConversationIds(channels, dms))
    .filter((m) => !doneIds.has(m.id)).length;
```

- [ ] **Step 4: 徽标改造**(page.tsx:898)

把"活动"按钮里的徽标 span:

```tsx
            <span className="ml-auto rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">{Object.values(messagesByChannel).flat().filter((m) => m.senderKind !== 'system').length}</span>
```

替换为(未读 0 时隐藏):

```tsx
            {inboxUnread > 0 && (
              <span className="ml-auto rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">{inboxUnread}</span>
            )}
```

- [ ] **Step 5: `ActivityView` 接 props + 去 `recent` + join 写 store + `allMessages` 改 store**

改 `ActivityView` 签名(page.tsx:3564),去掉内部 `doneIds`/`loadedDoneKey`/`doneKey`/`recent`(PR#395 加的),改接 props:

```tsx
function ActivityView({ onJump, humanProfiles, networkPath, doneIds, setDoneIds }: { onJump: (channelId: string) => void; humanProfiles: HumanProfile[]; networkPath: string; doneIds: Set<string>; setDoneIds: React.Dispatch<React.SetStateAction<Set<string>>> }) {
  const [filter, setFilter] = useState<'all' | 'unread' | 'mentions'>('all');
  const messagesByChannel = useAgentBeanStore((s) => s.messagesByChannel);
  const upsertMessages = useAgentBeanStore((s) => s.upsertMessages);
  const channels = useAgentBeanStore((s) => s.channels);
  const dms = useAgentBeanStore((s) => s.dms);
  const agents = useAgentBeanStore((s) => s.agents);
  const currentUser = useAgentBeanStore((s) => s.currentUser);
  const currentTeamId = useAgentBeanStore((s) => s.currentTeamId);
  const visibleIds = visibleConversationIds(channels, dms);
  const visibleList = [...visibleIds];
  const visibleKey = visibleList.join('');
```

> 注:`networkPath` prop 在本任务后可能不再被 ActivityView 直接使用(hydrate/persist 已上移顶层),但保留入参以最小化调用处改动;若 tsc 报 unused,移除该入参与调用处传参。

改 join effect(原 `setRecent(...)`,page.tsx:3578–3591)为写 store:

```tsx
  useEffect(() => {
    if (!currentTeamId || visibleList.length === 0) return;
    let cancelled = false;
    Promise.all(visibleList.map((channelId) => channelEvents().join(currentTeamId, channelId, 20))).then((results) => {
      if (cancelled) return;
      const joined: ChatMessage[] = [];
      for (const res of results) {
        if (res.ok && res.messages) joined.push(...res.messages);
      }
      upsertMessages(joined);
    });
    return () => {
      cancelled = true;
    };
  }, [currentTeamId, visibleKey, upsertMessages]);
```

改 `allMessages`(原 `[...recent, ...Object.values(messagesByChannel).flat()]`,page.tsx:3593–3596)为直接用 store:

```tsx
  const allMessages = inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleIds);
  const unreadCount = allMessages.filter((m) => !doneIds.has(m.id)).length;
```

"全部标记已读"(page.tsx:3611)与"标记完成"(page.tsx:3642–3650)的 `setDoneIds` 调用**不变**(现在用的是 props 的 `setDoneIds`,签名一致)。

- [ ] **Step 6: 调用处传 props**(page.tsx:988–994)

```tsx
          <ActivityView onJump={(chId) => {
            setActiveChannel(chId);
            setSidebarView('channels');
            const dm = dms.find((item) => item.id === chId);
            router.push(dm ? `/${np}/dm/${chId}` : `/${np}/channel/${chId}`);
          }} humanProfiles={humanProfiles} networkPath={routeNetworkPath} doneIds={doneIds} setDoneIds={setDoneIds} />
```

- [ ] **Step 7: 类型检查**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/tsc -p tsconfig.lib.json --noEmit`
Expected: exit 0。若报 `networkPath` unused,按 Step 5 注释移除该入参与调用处。

- [ ] **Step 8: 全量回归**

Run: `cd apps/web-next && /Users/shaw/AgentBean/node_modules/.bin/vitest run`
Expected: 全绿(含 Task 1/2 新增 + PR#395 的 chat-read-state 11 个 + 其余现有测试)。

- [ ] **Step 9: Commit**

```bash
git -C <worktree-root> add apps/web-next/app/[networkPath]/chat/page.tsx
git -C <worktree-root> commit -m "fix(web-next): 活动图标徽标显示真实未读数(与活动页一致)"
```

---

### Task 4: 端到端验证(手动,合并后本地完整环境)

> worktree 无完整运行栈(web dev + server-next + 数据),此任务在合并到本地完整环境后执行。

- [ ] **Step 1: 启动** web-next(`npm run dev`)+ server-next,进聊天页。
- [ ] **Step 2: 徽标联动** 在频道里产生消息 → 侧边栏"活动"徽标显示未读数(粉色)。
- [ ] **Step 3: 标记已读** 点"活动" → "全部标记已读" → 徽标降为 0 并**隐藏**;活动页头部"X 条未读"也归零,两者一致。
- [ ] **Step 4: 切页不跳** 切到"频道"/"搜索"/"收藏"再切回"活动" → 徽标与活动页数字稳定,不乱跳。
- [ ] **Step 5: 关闭活动页仍准** 停在"频道"视图,让别的 channel 收新消息 → 徽标 +1(ActivityView 未挂载仍实时)。

---

## Self-Review

**1. Spec coverage:**
- §5.1 `upsertMessages`(merge 不覆盖)→ Task 1 ✓
- §5.2 `doneIds` 上移 + 复用 PR#395 lib → Task 3 Step 2 ✓
- §5.3 `inboxActivityMessages` → Task 2 ✓
- §5.4 徽标显示 inboxUnread + 0 隐藏 → Task 3 Step 4 ✓
- §5.5 ActivityView 改造(join 写 store / 去 recent / allMessages 用 helper / 接 props)→ Task 3 Step 5 ✓
- §7 测试(chat-scope / upsertMessages / 回归)→ Task 1/2/3 Step 8 ✓
- §8 风险(不覆盖保护)→ Task 1 测试"已存在 id 不覆盖" ✓

**2. Placeholder scan:** 无 TBD/TODO;每步含完整代码与确切命令。`<worktree-root>` 在 Step 6 已定义。

**3. Type consistency:**
- `mergeMessagesByChannel(existing, msgs) → Record<string, ChatMessage[]>` — Task 1 定义,Task 3 Step 5 经 `upsertMessages` action 间接消费 ✓
- `inboxActivityMessages(messages, visibleIds, limit?) → T[]` — Task 2 定义,Task 3 Step 3/5 消费 ✓
- `doneIds: Set<string>` / `setDoneIds: React.Dispatch<React.SetStateAction<Set<string>>>` — Task 3 Step 2 定义,Step 5/6 消费 ✓
- `readKey`/`loadReadIds`/`saveReadIds` — PR#395 已 merged,本文件已 import ✓
