# Research: DM 频道的 Project Channel Workspace 现状(候选2 核心)

- **Query**: DM(direct)频道有没有 project channel profile / workspace?fetchProjectChannelWorkspaceCurrent 对 DM 返回什么?
- **Scope**: internal
- **Date**: 2026-08-07

## 结论(TL;DR)

**DM 频道在设计上没有、也无法拥有 Project Channel Workspace。** 三个 server usecase 入口对 `channel.kind === 'direct'` **硬拒绝**(返回 `NOT_FOUND: Project Channel Workspace not found`)。daemon 拿到这个 NOT_FOUND 后,`baselineRevisionId` 永远为空,staging 分支被跳过,publish 链完全不通到 formation。

## Findings

### 1. DM 频道如何创建(无 workspace 创建路径)

DM 频道创建在 `apps/server-next/src/application/usecases.ts:5265-5293`(经 `createDirectMessage` 路径,搜索 `kind: 'direct'`):

```ts
// usecases.ts:5278-5290
const channel = await repositories.channels.create({
  id: ids.nextId(),
  teamId: dmInput.teamId,
  kind: 'direct',
  name: `dm-${dmInput.userId}-${dmInput.agentId}`,
  title: agent.name,
  visibility: 'private',
  dmTargetAgentId: agent.id,
  createdBy: dmInput.userId,
  createdAt: now,
  humanMemberIds: [dmInput.userId],
  agentMemberIds: [agent.id],
});
```

DM 频道创建只写一条 `channels` 表记录,**没有任何 project channel workspace/profile 创建副作用**:
- 不调用 `repositories.projectChannelWorkspaces.createInitial`
- 不调用 `ensureDefaultChannelMembership`(那是把 agent 加入团队默认 'all' 频道)
- 不创建 project stage

### 2. Project Channel Workspace 创建路径(全部拒绝 DM)

仓库内只有 **两个** Project Channel Workspace 创建入口,且都先调用 `ensureUserCanViewProjectWorkspace`(usecases.ts:17333-17343):

| 入口 | 行号 | DM 处理 |
|---|---|---|
| `createProjectChannelWorkspace` | usecases.ts:5902-5924 | 第 5903 行调用 access guard → DM 在 17340 被拒 |
| `importProjectChannelWorkspace` | usecases.ts:5966-6010 | 第 5971 行调用 access guard → DM 在 17340 被拒 |

读取路径同样硬拒:
- `getProjectChannelWorkspace`(usecases.ts:5926-5932)→ DM 在 17340 被拒
- `listProjectChannelWorkspaceRevisions`(usecases.ts:5959-5964)→ DM 在 17340 被拒
- `exportProjectChannelWorkspace`(usecases.ts:5935-5956)→ DM 在 17340 被拒

### 3. 三个 `kind === 'direct'` 硬拒绝断点

`apps/server-next/src/application/usecases.ts`:

```ts
// usecases.ts:17333-17343 — 人类读取 / UI 入口
async function ensureUserCanViewProjectWorkspace(repositories, input) {
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) return makeFailure('FORBIDDEN', ...);
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
  if (channel.kind === 'direct' || channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');  // ← 17340
  ...
}

// usecases.ts:17352-17363 — Device snapshot 端点
async function ensureSnapshotChannelAccess(repositories, input) {
  ...
  if (channel.kind === 'direct' || channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');  // ← 17361
  ...
}

// usecases.ts:17373-17388 — Workspace publish staging HTTP 入口
async function ensureWorkspacePublishChannelAccess(repositories, sessionSecret, input) {
  ...
  if (channel.kind === 'direct' || channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');  // ← 17386
  ...
}
```

`fetchProjectChannelWorkspaceCurrent` 命中的是第三个(`ensureWorkspacePublishChannelAccess`)或第一个,视调用栈而定。两个都返回 NOT_FOUND。

### 4. fetchProjectChannelWorkspaceCurrent 的 HTTP 端点 + daemon 行为

daemon 端(`apps/daemon-next/src/workspace-publish-http-client.ts:172-204`):

```ts
// GET /api/teams/:id/project-channel-workspace?channelId=&agentId=
export async function fetchProjectChannelWorkspaceCurrent(input) {
  ...
  if (!response.ok || body.ok !== true || !body.workspace) {
    return { ok: false, error: String(body.error ?? body.message ?? `HTTP_${response.status}`) };
  }
  ...
}
```

DM 频道:server 返回 `{ ok: false, error: 'NOT_FOUND', message: 'Project Channel Workspace not found' }`,daemon 收到 `{ ok: false, error: 'NOT_FOUND' }`。

daemon 主流程(`apps/daemon-next/src/index.ts:1157-1171`):

```ts
let baselineRevisionId = frozenWorkspaceRevisionId;    // ← DM 时 frozenWorkspaceRevisionId 也是 undefined
if (serverUrl && !baselineRevisionId) {
  const current = await fetchProjectChannelWorkspaceCurrent({ ... });
  if (current.ok) baselineRevisionId = current.currentRevisionId;   // ← NOT_FOUND: ok=false,不赋值
}
if (serverUrl && baselineRevisionId) {                  // ← false,整段 staging 分支跳过
  ... deliverWorkspaceOutputsViaStaging ...
}
```

`frozenWorkspaceRevisionId`(index.ts:967)来自 `snapshotBaseline`,而 snapshotBaseline 来自 dispatch payload。**DM 频道的 dispatch payload 不带 workspace revision baseline**(因为根本没有 workspace),所以 `frozenWorkspaceRevisionId` 也是 undefined。两层都空 → staging 永远不执行。

### 5. 普通 channel 的 workspace 何时创建

普通 channel(`kind='channel'` 且 `name !== 'all'`)的 Project Channel Workspace 也是 **完全 opt-in**:
- **频道创建时不自动创建 workspace**(usecases.ts 的 createChannel 路径未触发 createInitial)
- 只有用户/Device 显式调用 `createProjectChannelWorkspace`(首次上传文件)或 `importProjectChannelWorkspace`(从 device 同步)才创建
- DM 频道即使在普通 channel 上也走不通,因为 DM 在 access guard 就被拒了

### 6. 与用户报告对应

用户 URL `https://www.agentbean.dev/testsns/dm/fda9a3be-14b9-44d1-b932-b1a7decaec4c` 路径前缀 `/dm/` 即 web-next 的 DM 频道路由,确认为 `kind='direct'`。该频道天生无 Project Channel Workspace。

## Caveats / Not Found

- 没有任何测试覆盖 DM 频道的 workspace 拒绝行为(`apps/server-next/tests/` 里 grep `kind: 'direct'` × `workspace` 零命中),说明这个排除是**早期设计选择**,不是后续遗漏。
- DM 频道也未走 staging,因此 #1084 切片 3 的 web 文件预览优先读本机 .agentbean 的逻辑才会生效(用户看到「文件同步」其实是直接走 artifact 上传+device snapshot,与 workspace revision 无关)。
- 是否有产品意图让 DM 也支持文件包:仓库代码/spec 中无相关线索。需要产品确认是否要扩展。
