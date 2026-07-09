# AgentBean Memory 设计

- 日期：2026-07-06
- 状态：已评审，待实现
- 作者：zxn
- 范围：`packages/contracts`、`packages/domain`、`apps/server-next`、`apps/daemon-next`、`apps/web-next`
- 方向：自研 AgentBean 本地优先记忆层；server 保存协作记忆，daemon 保存本地工作区记忆，外部开源记忆系统只作为可替换适配器

---

## 1. 背景

AgentBean 是一个面向人类与 Agent 协作的本地优先团队平台。现有核心对象包括 Team、Channel、DM、Thread、Task、Message、Artifact、WorkspaceRun、Device 和 Agent。Server 作为协作中枢，负责团队隔离、频道可见性、消息路由、产物授权和 workspace run 记录；自定义 Agent 则运行在用户本机或远程设备的 daemon 上，直接面对用户本地项目目录和本地工具链。

当前系统已经有三类接近「记忆」的能力：

- `messages`：保存聊天和 Agent 回复，是协作过程的原始事实。
- `saved_messages` / `pinned_messages`：用户或频道层面的人工标记。
- `workspace_runs` / `artifacts`：保存 Agent 执行上下文、日志摘要和产物元数据。

但它们还不是 Agent 可用的长期记忆：

- `getDispatchRequest()` 只组装当前 prompt、thread history 和 attachments；不会带入跨线程、跨日期、跨任务的长期上下文。
- `message:search` 是关键词检索，适合人工查找，不适合作为派发前的语义上下文选择器。
- saved / pinned 是书签，不表达「这个事实应该被 Agent 记住」「这个偏好以后应生效」「这个决策已经替代旧决策」。
- 如果直接套一个通用开源记忆库，容易绕过 AgentBean 已有的 Team / Channel / DM 权限边界。
- 如果把本地项目知识默认同步到 server，会违背 AgentBean 的本地优先前提：用户本地仓库结构、路径、命令、失败日志和调试经验不应默认变成云端长期数据。

因此，AgentBean Memory 必须采用本地优先分层：server 只保存协作级记忆，daemon 保存本地工作区记忆，Active Context 在 dispatch 时临时合成；外部记忆系统只能作为可替换能力，而不是完整记忆的事实源。

## 2. 目标

1. **让 Agent 记住真正有复用价值的信息**：用户偏好、团队约定、项目决策、执行经验、产物结论、工作流步骤。
2. **保持权限正确**：任何记忆的读取都不得越过 Team、Channel、DM、Agent、User 的可见性边界。
3. **保留来源和可撤销性**：每条记忆必须能追溯到源消息、任务、workspace run、artifact 或人工输入。
4. **坚持本地优先**：本地项目知识默认留在 daemon / workspace，本地内容只有在用户显式共享或摘要上报后才进入 server。
5. **用户不是记忆录入员**：第一期就让 daemon 在用户使用 AgentBean 的过程中自动积累低风险本地项目记忆；用户主要负责确认、编辑、共享和废弃。
6. **先稳定再智能**：第一期先做原生存储、本地确定性自动积累、显式共享、治理状态和检索注入；协作级自动候选、embedding、知识图谱作为后续增强。
7. **支持外部适配器**：mem0、Graphiti、Cognee 等只作为提取、索引、检索 provider；AgentBean 自己持有 source of truth、权限和审计。

## 3. 非目标

- 不把 mem0 / Graphiti / Cognee 作为 AgentBean 的核心数据库。
- 不做跨 Team 的全局记忆共享。
- 不训练或微调模型。
- 不把私有频道或 DM 内容自动提升为 Team 级记忆。
- 不默认把用户本地仓库结构、源码、绝对路径、命令历史、构建日志或调试经验上传到 server。
- 不把 Active Context 当作长期云端记忆保存。
- 不在第一期引入图数据库或强依赖向量数据库。
- 不让记忆覆盖当前用户输入、当前线程上下文或显式附件内容。

## 4. 设计原则

### 4.1 记忆是投影，不是事实源

`messages`、`tasks`、`artifacts`、`workspace_runs` 仍是事实源。Memory 是从事实源抽取出来、方便 Agent 使用的长期上下文投影。投影可以被编辑、废弃、替换，但不能抹掉原始事实。

### 4.2 权限先于相关性

检索流程必须先做硬过滤，再做排序：

1. `teamId` 必须匹配。
2. source channel / DM 必须对当前用户和目标 Agent 可见。
3. scope 必须允许注入当前 dispatch。
4. 只有通过权限过滤后，才允许做关键词、embedding 或图谱排序。

### 4.3 自动积累，但分层生效

记忆系统不应要求用户一条条手动录入。AgentBean 应在使用过程中自动沉淀可复用信息，但要按风险分层：

- **低风险本地项目记忆**：由 daemon 基于确定性信号自动生成或更新，例如项目技术栈、常用脚本、workspace run 成功/失败经验；默认只保存在本机，可进入本地 `active`，并受 cwd/profile/agent scope 限制。
- **协作级记忆**：普通事实、流程经验和可解释的共享上下文可以自动或显式进入 `active`；高影响决策、强规则、跨范围提升和敏感摘要默认进入 `candidate` 或要求显式确认。
- **显式「记住」或「共享」**：用户主动确认的内容可以直接进入 `active`，但仍受 source scope 和敏感信息检查限制。

用户的主要动作是确认、编辑、共享、废弃和查看来源，而不是作为记忆录入员维护知识库。

### 4.4 记忆必须可解释

AgentBean UI 必须能显示：

- 这条记忆是什么。
- 为什么被记住。
- 来自哪些源记录。
- 当前作用范围是什么。
- 谁创建、批准、编辑或废弃了它。

### 4.5 外部系统可换

外部记忆系统只能通过 provider 接口接入：

- `MemoryExtractionProvider`
- `MemoryIndexProvider`
- `MemoryRetrievalProvider`

即使更换 provider，AgentBean 的 memory item、权限、状态、来源和审计不变。

## 5. 三层记忆架构映射

可以借鉴「Role / Key Knowledge / Active Context」三层模型，但 AgentBean 不能照搬云端常驻 Agent 的做法。AgentBean 的自定义 Agent 运行在用户本地 daemon 上，因此三层记忆要按数据敏感度和协作边界重新映射。

| 层级 | 含义 | AgentBean 保存位置 | 是否默认上云 | 生命周期 |
|---|---|---|---|---|
| Role | Agent 身份、职责、能力、默认行为 | server 的 Agent 配置 + contracts DTO | 是。Role 本来就是协作系统可见配置 | 长期，低频更新 |
| Key Knowledge | 长期知识：团队约定、项目结构、技术栈、命令经验、代码风格 | 分两类：协作级在 server；本地项目级在 daemon / workspace | 否。只有协作级或用户显式共享的摘要进入 server | 长期，按来源更新 |
| Active Context | 当前任务、最近对话、执行中状态、未完成操作 | dispatch 时由 server + daemon 临时合成 | 否。不是长期记忆 | 短期，随任务结束释放 |

### 5.1 Role

Role 对应现有 `AgentDto` / `AgentRecord` 的配置面：名称、描述、adapterKind、source、category、owner、deviceId、skills 等。它定义「这个 Agent 是谁」「能做什么」「默认职责是什么」。

Role 可以保存在 server，因为：

- 它本来需要在 Team 的 Agent 列表、频道成员、DM 和管理页中展示。
- 它不包含本地项目私密细节。
- 它是路由、权限和 UI 所需的协作事实。

### 5.2 Key Knowledge

Key Knowledge 要拆成两类：

| 类型 | 示例 | 保存位置 |
|---|---|---|
| 协作级 Key Knowledge | Team 决策、频道约定、PR 语言规范、验收标准、用户显式共享的执行摘要 | server team SQLite DB |
| 本地项目级 Key Knowledge | 本地 repo 技术栈、目录结构、常用命令、失败过的 build/test 经验、项目绝对路径、未上报日志摘要 | daemon 本地存储或项目目录 `.agentbean` |

这一区分是 AgentBean Memory 的核心产品边界：server 只保存团队协作需要共享的长期知识；本地项目知识默认留在用户设备上。用户可以显式把某条本地知识「共享到 Team」或「记为频道知识」，但默认不上传完整内容。

### 5.3 Active Context

Active Context 不是长期记忆，而是每次 dispatch 的即时上下文：

- 当前 human message。
- thread history。
- attachments。
- 正在处理的 task。
- server 检索出的协作记忆。
- daemon 检索出的本地工作区记忆。
- 当前 workspace run 状态。

Active Context 只在运行时合成，随 dispatch 生命周期结束而释放。它可以被写入 workspace run manifest、日志摘要或用户显式「记住」后转化为长期记忆，但默认不作为云端长期数据保存。

## 6. 记忆类型与作用域

### 6.1 Memory Kind

| Kind | 含义 | 示例 |
|---|---|---|
| `semantic` | 稳定事实 | 「AgentBean Next 的生产入口是 server-next」 |
| `episodic` | 具体事件或执行经验 | 「上次 smoke 失败是因为 localhost 解析问题」 |
| `procedural` | 工作流或步骤 | 「发 PR 前先跑 server-next test，再跑 build」 |
| `preference` | 用户或团队偏好 | 「GitHub PR 内容默认写中文」 |
| `decision` | 已确认的产品或技术决策 | 「记忆核心自研，mem0 只做 adapter」 |
| `artifact_summary` | 文件产物摘要 | 「某次 workspace run 生成的报告结论」 |

### 6.2 Memory Scope

| Scope | 读取范围 | 创建规则 |
|---|---|---|
| `team` | 当前 Team / 工作空间内可见 | Team 成员和自动积累流程可从 Team 可见来源创建普通 team memory；高影响决策、跨范围提升、敏感摘要进入 candidate 或要求显式确认 |
| `channel` | 指定频道内可见 | 频道成员可从可见消息创建 |
| `dm` | 指定 DM 内可见 | DM 参与者可创建 |
| `agent` | 指定 Agent 可见 | Agent owner/admin 可创建或批准 |
| `user` | 指定用户在当前 Team 内可见 | 用户本人创建或批准 |

第一期共享 contracts 只导出 `team`、`channel`、`dm`、`agent`、`user`。`workspace` 不进入 Phase 1 的 `MemoryScopeType`，避免 server `memory_items.scope_type` 收到自己不能正确处理的值。daemon 本地工作区记忆使用单独的 `LocalMemoryScopeType`。

## 7. 状态机

```text
candidate -> active -> superseded
candidate -> rejected
active -> expired
active -> deleted
```

| Status | 含义 | 是否可注入 |
|---|---|---|
| `candidate` | 协作级自动提取或待确认 | 否 |
| `active` | 已确认可用 | 是，但还要通过 `valid_until` 懒过期检查 |
| `rejected` | 人工拒绝 | 否 |
| `expired` | 已过期 | 否 |
| `superseded` | 被新记忆替代 | 否 |
| `deleted` | 用户删除或来源不可用 | 否 |

规则：

- 普通协作级记忆可以直接进入 `active`，前提是来源对当前 Team 可见、规则确定、风险低且可解释。
- 高影响决策、强规则、敏感摘要、跨范围提升或来源可见性不足的自动提取默认进入 `candidate`。
- Phase 1 显式记忆和本地确定性自动记忆可以直接创建为 `active`，`confidence = NULL` 表示人工确认或规则确定、不适用模型置信度；DTO 中可以省略 `confidence`。
- `valid_until` / `validUntil` 不要求 Phase 1 后台任务主动改状态。读取和注入时使用懒检查：server 使用 `status = 'active' AND (valid_until IS NULL OR valid_until > now)`；daemon 本地使用 `status = 'active' && (validUntil == null || validUntil > now)`。后台定时扫描并写入 `expired` event 可作为 Phase 2 运维增强。
- 显式「记住」默认进入 `active`，但不能超过源内容的权限范围。
- `active` 记忆被编辑时保留审计事件。
- 内容相互冲突时不覆盖旧行，而是创建新行并将旧行标记为 `superseded`。

## 8. 数据模型

### 8.1 存储位置

AgentBean Memory 分两类存储：

| 存储 | 内容 | 推荐位置 | 说明 |
|---|---|---|---|
| server 协作记忆 | Team / Channel / DM / User / Agent scope 的共享记忆 | team SQLite DB | 与 messages、artifacts、workspace_runs 同一个团队隔离边界 |
| daemon 本地工作区记忆 | repo 技术栈、目录结构、常用命令、失败经验、本地路径、workspace 摘要 | `~/.agentbean/teams/<profile>/memory` 或 `<cwd>/.agentbean/memory` | 默认不上报 server；只在 dispatch 时由 daemon 注入 |

第一期 server memory 表只保存协作级记忆。daemon 本地记忆可以先用 JSONL / SQLite 轻量实现，后续再统一 provider 和索引。跨 Team 用户偏好不做第一期；如未来需要，再在 global DB 增加用户级 profile memory，并显式同步到 Team scope。

### 8.2 server `memory_items`

```sql
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  channel_id TEXT,
  agent_id TEXT,
  user_id TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  confidence REAL,
  created_by_kind TEXT NOT NULL,
  created_by_id TEXT,
  approved_by_user_id TEXT,
  extraction_provider TEXT,
  retrieval_key TEXT,
  valid_from INTEGER,
  valid_until INTEGER,
  superseded_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_memory_scope ON memory_items(team_id, scope_type, scope_id, status, updated_at);
CREATE INDEX idx_memory_channel ON memory_items(team_id, channel_id, status, updated_at);
CREATE INDEX idx_memory_agent ON memory_items(team_id, agent_id, status, updated_at);
CREATE INDEX idx_memory_user ON memory_items(team_id, user_id, status, updated_at);
```

字段说明：

- `scope_type` / `scope_id` 是主作用域。
- `scope_type` 只允许 `team`、`channel`、`dm`、`agent`、`user`。Phase 1 server usecase 必须拒绝任何其他值；`workspace` 不属于 server scope。
- `channel_id`、`agent_id`、`user_id` 是加速过滤和组合 scope 的冗余字段。
- `confidence` 在 Phase 1 显式记忆和本地确定性自动记忆中写 `NULL`，表示人工确认或规则确定、不适用模型置信度；Phase 2 自动候选可写入 `0..1` 的模型置信度。
- `valid_until` 是注入时的有效期边界。Phase 1 查询 active memory 时懒过滤过期项，不依赖后台 job 及时把状态改为 `expired`。
- `retrieval_key` 用于外部 provider 映射，不作为权限依据。
- server `memory_items` 不保存本地项目完整索引、源码片段、绝对路径清单或未脱敏日志。
- Phase 1 不提供通用 `structured_json` 字段。原因是它无法稳定建索引，也会把不同 kind 的扩展结构塞进同一个无类型字段，长期会变成无法治理的垃圾桶。
- Phase 1 不提供 `source_count` 冗余字段。source 数量是 `memory_sources` 的派生值，需要时通过 `SELECT COUNT(*) FROM memory_sources WHERE memory_id = ?` 计算，避免 source 增删时出现计数不同步。

### 8.3 server `memory_tags`

```sql
CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, tag)
);

CREATE INDEX idx_memory_tags_tag ON memory_tags(team_id, tag, memory_id);
```

`memory_tags` 是 Phase 1 唯一进入 SQL 层的结构化分类字段。它与 `memory_sources` 一样用关联表表达，便于过滤、索引和后续清理。tag 规则：

- tag 必须是小写 slug，例如 `frontend`、`github-pr`、`build-failure`。
- tag 只用于筛选和粗分类，不承载任意 JSON。
- 需要展示给用户的标签名可以在 UI 层做映射，不写入额外结构字段。

### 8.4 server `memory_sources`

```sql
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, source_kind, source_id)
);

CREATE INDEX idx_memory_sources_source ON memory_sources(team_id, source_kind, source_id);
```

`source_kind`：

- `message`
- `task`
- `artifact`
- `workspace_run`
- `manual`
- `local_summary`

`local_summary` 表示这条 server 记忆来自 daemon 显式共享的本地摘要，而不是 server 直接读取了本地项目。

### 8.5 server `memory_events`

```sql
CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL
);
```

用于审计创建、批准、拒绝、编辑、过期、替代、删除。

### 8.6 server 结构化扩展规则

Phase 1 只允许以下结构化字段进入 server schema：

| 结构化信息 | Phase 1 存储方式 | 说明 |
|---|---|---|
| tags | `memory_tags` | 可过滤、可索引 |
| source labels | 由 `memory_sources.source_kind/source_id/channel_id` + UI 派生 | 不单独存 JSON |
| shared local summary | `memory_items.summary` / `memory_items.content` + `source_kind = local_summary` | 只保存用户确认后的摘要 |

以下字段不进入 Phase 1 server schema：

- `decisionState`
- `sourceLabels`
- `sharedLocalSummary`
- 任意 kind 私有 JSON payload

如果 Phase 2 需要结构化扩展，必须先为每个 `MemoryKind` 定义允许键、类型、索引需求和迁移策略；不能恢复一个无约束的 `structured_json` 垃圾桶字段。对于需要查询的字段，优先建独立列或关联表；只有完全不参与查询、只参与展示的少量 provider metadata 才能考虑进入受白名单约束的 JSON 字段。

### 8.7 daemon 本地 `local_memory_items`

daemon 本地记忆建议优先放在项目目录 `<cwd>/.agentbean/memory`；跨项目的 profile 级偏好可放在 `~/.agentbean/teams/<profile>/memory`。现有 daemon 已经使用 `~/.agentbean/teams/<profile>` 存放认证/profile 信息，并在项目目录下使用 `.agentbean/runs` 存放 workspace run，因此 memory 路径沿用这个本地优先结构。

建议 schema：

```ts
export interface LocalMemoryItem {
  id: string;
  profileId: string;
  teamId?: string;
  agentId?: string;
  cwd?: string;
  cwdHash?: string;
  dedupeKey?: string;
  kind: MemoryKind;
  scopeType: LocalMemoryScopeType;
  content: string;
  summary?: string;
  structured?: {
    techStack?: string[];
    commands?: string[];
    paths?: string[];
    tags?: string[];
    sourceRunIds?: string[];
  };
  status: 'active' | 'expired' | 'superseded' | 'deleted';
  sourceKind: 'scan' | 'workspace_run' | 'manual' | 'local_file';
  sourcePath?: string;
  createdAt: number;
  updatedAt: number;
  validUntil?: number;
}
```

约束：

- `LocalMemoryItem` 默认不上传 server。
- `dedupeKey` 是本地自动积累的稳定去重键，只在 daemon 本地使用。自动生成的 `local_workspace` 记忆必须写入；用户手动创建的 `manual` 记忆可以为空。
- `LocalMemoryItem.structured` 只用于 daemon 本地检索和展示，不对应 server schema，也不允许原样同步到 server。
- 如果用户选择「共享到 Team」或「记为频道知识」，daemon 只提交用户确认后的摘要，server 创建 `sourceKind = local_summary` 的协作记忆。
- 本地绝对路径、未脱敏日志、源代码片段默认不进入 server payload。
- 本地 memory 可以被 daemon 直接用于 prompt 合成，不需要 server 参与检索。

本地自动积累条目上限：

- 每个 `cwdHash` 下 `local_workspace` 自动记忆上限默认 80 条；实现可配置在 50-100 之间。
- 超限时按 `updatedAt` 淘汰最旧的非 `manual` 条目，优先淘汰 `sourceKind = workspace_run` 的旧经验；`sourceKind = scan` 通常通过 `dedupeKey` 覆盖更新，不应快速增长。
- `sourceKind = manual` 的条目不参与自动淘汰，只能由用户主动删除、停用或替代。
- 淘汰时将状态改为 `expired`，不物理删除，便于 UI 和本地审计解释“为什么不再注入”。

### 8.8 `memory_embeddings`（第二期）

第一期不强依赖 embedding。第二期再增加：

```sql
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

向量检索必须仍然先过权限过滤。provider 返回的结果只能作为排序信号，不能决定可见性。

## 9. Contract 设计

新增 `packages/contracts/src/memory.ts`：

```ts
export type MemoryKind =
  | 'semantic'
  | 'episodic'
  | 'procedural'
  | 'preference'
  | 'decision'
  | 'artifact_summary';

export type MemoryScopeType =
  | 'team'
  | 'channel'
  | 'dm'
  | 'agent'
  | 'user';

export type LocalMemoryScopeType =
  | 'local_profile'
  | 'local_workspace'
  | 'local_agent';

export type MemoryStatus =
  | 'candidate'
  | 'active'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'deleted';

export interface MemorySourceDto {
  sourceKind: 'message' | 'task' | 'artifact' | 'workspace_run' | 'manual' | 'local_summary';
  sourceId: string;
  channelId?: string;
}

export interface MemoryDto {
  id: string;
  teamId: string;
  kind: MemoryKind;
  scopeType: MemoryScopeType;
  scopeId?: string;
  channelId?: string;
  agentId?: string;
  userId?: string;
  content: string;
  summary?: string;
  tags: string[];
  status: MemoryStatus;
  confidence?: number;
  sources: MemorySourceDto[];
  createdAt: number;
  updatedAt: number;
  validUntil?: number;
}

export interface DispatchMemoryContextItemDto {
  id: string;
  kind: MemoryKind;
  scopeType: MemoryScopeType | LocalMemoryScopeType;
  origin: 'server' | 'local';
  content: string;
  summary?: string;
  tags?: string[];
  sourceRefs: MemorySourceDto[];
  confidence?: number;
}

export interface AutoAccumulatedMemorySummaryDto {
  id: string;
  kind: MemoryKind;
  scopeType: LocalMemoryScopeType;
  sourceKind: 'scan' | 'workspace_run' | 'manual' | 'local_file';
  summary: string;
  action: 'created' | 'updated' | 'expired';
}
```

`MemoryScopeType` 是 server/shared contract，只包含 server usecase 能创建、校验和检索的协作作用域。`LocalMemoryScopeType` 仅供 daemon 本地存储和本地 prompt 合成使用，不允许写入 server `memory_items.scope_type`。

扩展 `DispatchRequestDto`：

```ts
export interface DispatchRequestDto {
  // existing fields...
  memoryContext?: DispatchMemoryContextItemDto[];
}
```

`memoryContext` 是可选字段，便于旧 daemon 忽略未知字段，也便于分阶段上线。`origin` 用于区分 server 协作记忆和 daemon 本地记忆；server 只生成 `origin = 'server'` 的条目，daemon 合成最终 prompt 时可以追加 `origin = 'local'` 的本地条目。

扩展 daemon dispatch result payload：

```ts
export interface DaemonDispatchResult {
  // existing fields...
  autoAccumulatedMemorySummaries?: AutoAccumulatedMemorySummaryDto[];
}
```

`autoAccumulatedMemorySummaries` 只用于 workspace run 详情展示本次自动积累了什么。它只能包含本地 memory id、kind、scopeType、sourceKind、脱敏 summary 和 created/updated/expired 动作，不允许包含本地 `content` 原文、绝对路径清单、源码片段或未脱敏日志。旧 daemon 不发送该字段时，server 和 web-next 必须兼容，UI 不展示该区域。

## 10. Repository 与 Usecase

### 10.1 Repository

在 `apps/server-next/src/application/repositories.ts` 新增：

```ts
export interface MemoryRepository {
  create(input: MemoryRecord, sources: MemorySourceRecord[], tags: string[]): Promise<MemoryRecord>;
  getById(input: { teamId: ID; memoryId: ID }): Promise<MemoryRecord | null>;
  listCandidates(input: { teamId: ID; limit: number }): Promise<MemoryRecord[]>;
  listActiveForInjection(input: MemoryInjectionQuery & { tags?: string[] }): Promise<MemoryRecord[]>;
  search(input: MemorySearchQuery & { tags?: string[] }): Promise<MemoryRecord[]>;
  updateStatus(input: { teamId: ID; memoryId: ID; status: MemoryStatus; actorId: ID; timestamp: UnixMs }): Promise<MemoryRecord | null>;
  updateContent(input: { teamId: ID; memoryId: ID; content: string; actorId: ID; timestamp: UnixMs }): Promise<MemoryRecord | null>;
  supersede(input: { teamId: ID; memoryId: ID; supersededById: ID; actorId: ID; timestamp: UnixMs }): Promise<MemoryRecord | null>;
  listSources(input: { teamId: ID; memoryId: ID }): Promise<MemorySourceRecord[]>;
  listTags(input: { teamId: ID; memoryId: ID }): Promise<string[]>;
  replaceTags(input: { teamId: ID; memoryId: ID; tags: string[]; actorId: ID; timestamp: UnixMs }): Promise<void>;
}
```

`ServerNextRepositories` 增加 `memories: MemoryRepository`。

### 10.2 Usecase

新增 usecase：

- `rememberMessage(input)`：从消息创建用户确认后的协作记忆。
- `rememberWorkspaceRun(input)`：从执行记录创建用户确认后的协作记忆或本地摘要。
- `shareLocalMemory(input)`：从 daemon 本地记忆创建用户确认后的协作摘要。
- `createMemory(input)`：人工输入记忆。
- `approveMemoryCandidate(input)`。
- `rejectMemoryCandidate(input)`。
- `expireMemory(input)`。
- `searchMemories(input)`。
- `listMemoryCandidates(input)`。
- `listActiveMemories(input)`。

所有 usecase 都必须先调用现有权限检查：

- Team membership：`repositories.teams.isMember`
- Channel 可见性：复用 `ensureUserCanViewChannel`
- Agent 管理权限：复用 agent owner/admin 规则
- DM 可见性：复用 direct message channel 规则

daemon 侧新增本地 memory 服务：

- `LocalMemoryStore`：读写 `<cwd>/.agentbean/memory` 和 `~/.agentbean/teams/<profile>/memory`。
- `scanWorkspaceMemory(input)`：扫描项目技术栈、命令和结构摘要，生成本地 `LocalMemoryItem`。
- `observeDispatchOutcome(input)`：dispatch 完成后的本地记忆总入口，hook 在 executor 结果返回之后；它决定是否记录、记录哪些摘要，并返回 `autoAccumulatedMemorySummaries` 供 dispatch result 回传。
- `recordWorkspaceRunLearning(input)`：`observeDispatchOutcome` 调用的内部函数，只处理有 workspace run 产物的情况，从 manifest / logs / artifacts 摘要中记录成功或失败经验。
- `listLocalMemoriesForDispatch(input)`：按 cwd、agentId、prompt 检索本地 active memory。
- `shareLocalMemory(input)`：经用户确认后只把摘要提交给 server。

关系约定：

1. executor 产出 `DaemonDispatchResult`。
2. daemon 调用 `observeDispatchOutcome(request, result)`。
3. 如果 `result.workspaceRun` 存在，`observeDispatchOutcome` 调用 `recordWorkspaceRunLearning` 更新本地经验。
4. 如果没有 workspace run（例如简单问答或无 cwd 的 dispatch），`observeDispatchOutcome` 只做轻量元数据记录，或直接返回空数组。
5. `observeDispatchOutcome` 返回本次 created/updated/expired 的脱敏摘要列表，daemon 放入 `autoAccumulatedMemorySummaries`。

## 11. 写入路径

### 11.1 本地自动积累（第一期主路径）

目标：用户正常使用 AgentBean 时，daemon 自动沉淀当前项目可复用经验。用户不需要先点击「记住」，Agent 下次处理同一 cwd / agent / profile 时就能使用这些本地记忆。

触发源：

- daemon scan：识别 repo 技术栈、包管理器、常用脚本、目录结构摘要。
- dispatch start：不直接写长期记忆；仅当距离上次 scan 超过 24 小时、cwdHash 不存在、或关键项目文件变化时，触发 `scanWorkspaceMemory` 刷新已有 scan 条目的 `updatedAt/content/structured`。当前 cwd、agentId、adapterKind 和工作区状态只作为本次 Active Context 使用。
- workspace run succeeded：记录可复用命令、验证步骤、成功修复路径、生成 artifact 摘要。
- workspace run failed：记录失败命令、失败类别、已确认无效的尝试、下次应先检查的前置条件。
- 用户编辑本地记忆：修正或废弃自动积累出来的条目。

流程：

1. daemon 在本机读取 cwd、workspace run 产物和执行结果摘要。
2. daemon 使用确定性规则生成或更新 `LocalMemoryItem`，按 `cwdHash + kind + dedupeKey` 去重。
3. `LocalMemoryItem` 默认保存为 `active`，仅在当前 daemon/profile/cwd/agent 范围内注入。
4. 命中敏感信息规则时不自动写入，或只写脱敏摘要并标记需要用户确认。
5. dispatch 时 daemon 按 cwd、agentId、prompt 检索本地 memory 并合成 runtime prompt。
6. 用户在本地项目记忆页可以查看、编辑、停用、替代或删除。
7. 用户显式点击「共享」时，daemon 展示摘要、来源和敏感信息检查结果；确认后 server 才创建 `local_summary` 来源的协作记忆。

第一期本地自动积累只使用确定性规则，不调用云端 LLM provider，不上传本地项目内容。

`dedupeKey` 生成规则：

| 触发源 | `dedupeKey` 生成逻辑 | 更新语义 |
|---|---|---|
| scan 技术栈 | `scan:tech-stack` | 同一 cwd 只保留一条，重新 scan 时覆盖 `content/structured/updatedAt` |
| scan 常用脚本 | `scan:scripts` | 同一 cwd 只保留一条，脚本变化时覆盖 |
| scan 目录摘要 | `scan:layout` | 同一 cwd 只保留一条，目录结构变化时覆盖 |
| workspace run 成功命令 | `run-ok:${hash(command + cwdHash)}` | 同一命令成功经验更新次数、来源 run 和最近验证时间 |
| workspace run 失败经验 | `run-fail:${hash(errorCategory + command)}` | 同一失败类别和命令更新最近失败摘要、已确认无效尝试和来源 run |

同一个 `cwdHash + kind + dedupeKey` 已存在 `active` 记录时，自动积累路径必须更新原记录，而不是新增一条。只有 `dedupeKey` 不同，或用户显式创建 `manual` 记忆时，才创建新记录。

Phase 1 run 经验提取规则必须是可审查的确定性规则集，例如 `apps/daemon-next/src/memory/local-learning-rules.ts`：

- 输入只使用 command、exitCode、adapterKind、workspace run status、artifact metadata、stderr/logExcerpt 的脱敏片段和有限错误模式。
- 允许基于明确模式分类，例如 `ENOENT`、`EACCES`、`MODULE_NOT_FOUND`、`TypeError`、`npm ERR!`、`tsc` 失败、测试失败摘要。
- 不在 Phase 1 调用 LLM 或云端 provider 理解自然语言日志，也不把长日志自动总结为因果结论。
- 无法由规则确定的失败只记录低风险元数据，或不记录；自然语言归因、相似失败聚类和根因总结放到 Phase 2 provider / candidate 流程。

### 11.2 显式协作记忆（第一期辅助路径）

入口：

- 消息菜单：「记住」
- 执行详情：「记住这次执行结论」
- Artifact 详情：「记住文件摘要」
- 本地工作区记忆：「共享到 Team / 记为频道知识」
- 设置页：「新增记忆」

流程：

1. 用户选择源记录和记忆类型。
2. Server 校验用户能读取源记录。
3. Server 根据源记录计算最大可用 scope。
4. 用户选择不超过最大权限的 scope。
5. 创建 `active` memory item。
6. 写入 `memory_sources`、`memory_tags` 和 `memory_events`。

最大 scope 规则：

- public/default channel message 可创建 `channel` memory；Team 成员可从 Team 可见来源创建普通 `team` memory。
- 高影响 `team decision`、强约束流程、跨 channel 合并或敏感摘要默认进入 `candidate`，或要求显式确认后才能 `active`。
- private channel message 只能创建该 `channel` memory。
- DM message 只能创建该 `dm` memory 或当前用户的 `user` memory。
- workspace run 只能创建其 `team + channel + agent` 可见范围内的 memory。
- daemon 本地 memory 默认只能留在本地；只有用户显式共享的摘要才能创建 server memory，source_kind 为 `local_summary`。

Team memory 风险分层：

| 类型 | 默认状态 | 创建/生成者 | 说明 |
|---|---|---|---|
| 普通 team memory | `active` | Team 成员或自动积累流程 | 来源必须是 Team 可见内容，且不构成强规则 |
| channel memory | `active` | 频道成员或自动积累流程 | 只在该频道语境生效 |
| team decision / 强规则 | `active` 或 `candidate` | Team 成员可提交；高风险时进入 candidate | 明确来自用户显式确认的决策可 active；自动推断的强规则进 candidate |
| private / DM / local 提升到 team | `candidate` 或需显式共享 | 可见范围内用户 | 防止越权和隐私泄漏 |
| locked policy | admin only | owner/admin | 后续企业治理能力；Phase 1 不作为默认路径 |

owner/admin 的角色是治理和兜底：可锁定、编辑、废弃、恢复或处理争议 team memory，但不需要审批每一条普通 team memory。

### 11.3 协作级自动候选（第二期）

触发源：

- pin message。
- resolved task。
- succeeded workspace run。
- 明确包含「决定」「以后」「偏好」「不要再」「固定流程」等信号的长线程。

流程：

1. 后台 job 读取候选源。
2. 调用 `MemoryExtractionProvider.extract(source)`。
3. 生成 `candidate` memory。
4. 在 Memory 管理页展示待批准项。

自动候选不阻塞消息发送、任务更新或 workspace run 写入。

### 11.4 去重与替代

第一期使用确定性规则：

- server 协作记忆：同 `teamId + scopeType + kind` 下，`content` 标准化后完全相同则不重复创建。
- daemon 本地自动记忆：同 `cwdHash + kind + dedupeKey` 下已有 `active` 记录时更新原记录，不新增。
- daemon 本地自动记忆超出每个 cwd 的上限时，按 §8.7 的保留策略把最旧的非 `manual` 条目标记为 `expired`。
- tag 归一化后写入 `memory_tags`；同一 memory 不允许重复 tag。
- 用户编辑已有记忆时保留同一个 `id`。
- 用户确认「替代旧记忆」时创建新行，并将旧行标记为 `superseded`。

第二期可以由 provider 给出相似度建议，但最终替代动作仍由 AgentBean usecase 写入。

## 12. 读取与注入路径

### 12.1 注入点

server 在 `getDispatchRequest()` 中组装 dispatch 请求时追加协作级 `memoryContext`：

```text
message:send
  -> dispatches.create
  -> daemon asks getDispatchRequest(dispatchId)
  -> server builds prompt/history/attachments/customAgent
  -> server selects server memoryContext
  -> daemon retrieves local memoryContext
  -> daemon merges server + local + active context
  -> daemon serializes final context for runtime
```

选择在 `getDispatchRequest()` 注入，而不是在 `sendMessage()` 注入，原因：

- `getDispatchRequest()` 是 daemon 真正拉取执行上下文的地方。
- 该路径已有 origin message、thread、attachments、agent execution config。
- 如果 dispatch 被排队后稍晚执行，可以拿到更新后的 active memory。
- daemon 能在收到请求后再结合 cwd 和本机缓存追加本地项目 memory，避免把完整本地知识传给 server。

### 12.2 检索输入

`MemoryInjectionQuery`：

server 侧：

- `teamId`
- `channelId`
- `threadId`
- `messageId`
- `agentId`
- `userId`
- `prompt`
- `attachmentIds`
- `tags`
- `limit`
- `tokenBudget`

daemon 本地侧：

- `profileId`
- `teamId`
- `agentId`
- `cwd`
- `cwdHash`
- `prompt`
- `adapterKind`
- `limit`
- `tokenBudget`

### 12.3 检索集合

server 按顺序收集候选：

1. 当前 channel / DM 的 `active` memory。
2. 当前 user 在该 Team 的 `active` preference。
3. 当前 agent 的 `active` memory。
4. Team 级 `active` memory。

daemon 按顺序收集候选：

1. 当前 cwd 的 `local_workspace` memory。
2. 当前 agent 的 `local_agent` memory。
3. 当前 profile 的 `local_profile` memory。
4. 当前 workspace run 的临时 Active Context。

server 和 daemon 各自先排序截断。daemon 最后合并时按 `server 协作记忆`、`local workspace memory`、`Active Context` 分区输出，避免混淆来源。

### 12.4 排序策略

第一期：

- scope 优先级：`channel/dm` > `user` > `agent` > `team`。
- prompt 关键词匹配加分。实现上复用 `packages/domain/src/search.ts` 的 `splitSearchTerms()` 和 `scoreMessageSearch()` 模式，新增 `scoreMemoryRelevance(memory, terms)` 纯函数；注入排序中关键词分只作为 bonus，不作为硬过滤，避免没有命中 prompt 词的高优先级 decision / preference 被错误丢弃。
- `decision`、`preference`、`procedural` 在派发上下文中优先。
- 如果 dispatch 或 UI 指定 tags，server 通过 `memory_tags` 做 SQL 层过滤；不要扫描 `content` 或 JSON。
- 最近更新加小权重。
- Phase 1 显式记忆和本地确定性自动记忆 `confidence = NULL`，不参与置信度过滤。`confidence` 低于阈值不注入只适用于 Phase 2 自动候选或 provider 生成的记忆。
- daemon 本地排序优先级：`local_workspace` > `local_agent` > `local_profile`，同级内按 cwdHash 匹配、prompt 关键词、最近成功 workspace run 加权。
- daemon 本地 memory 增加 source reliability 加权：`manual` 最高，`scan` 高可信且不降权，`workspace_run` 默认可信但低于 `manual/scan`。如果某条 `workspace_run` 经验被注入后再次出现同类失败，daemon 可在本地降低该条排序权重，或把它标记为需要用户确认；Phase 1 不要求引入 candidate 状态。

第二期：

- 在权限过滤后的候选集合内使用 embedding rerank。
- 可选接入 mem0 或其他 provider 的检索结果。

### 12.5 上下文预算

默认：

- server 协作记忆最多 8 条，总长度不超过 1200 中文字或约 1600 tokens。
- daemon 本地记忆最多 8 条，总长度不超过 1200 中文字或约 1600 tokens。
- Active Context 使用独立预算，优先保留当前 prompt、thread history、attachments 和当前 workspace run 状态。
- 单条过长时优先使用 `summary`，没有 summary 再截断 `content`。

超预算时按排序截断，不做模型压缩，避免在热路径引入不稳定延迟。server 预算和 daemon 本地预算互不抢占；daemon 合成最终 prompt 时再按 runtime 最大上下文做最后裁剪。

## 13. Daemon 与 Runtime 序列化

`DispatchRequestDto.memoryContext` 由 server 提供协作记忆，daemon 再读取本地工作区记忆并合成最终 runtime 上下文。

建议统一注入格式：

```text
AgentBean 协作记忆：
- [memory:{id}]（{kind}，{scopeType}，server）{content}
  来源：{sourceKind}:{sourceId}

本地工作区记忆：
- [local-memory:{id}]（{kind}，{scopeType}，local）{content}
  来源：{sourceKind}:{sourcePath}

当前任务上下文：
- 当前消息：{prompt}
- 当前工作区：{cwd}
- 当前执行：{workspaceRunState}
```

序列化位置：

1. 在 system/context 区块之后。
2. 先放 server 协作记忆，再放本地工作区记忆。
3. 再放 thread history、attachments 摘要和当前 Active Context。
4. 最后放当前 prompt。

最终 prompt 渲染落点：

- `DispatchRequestDto.memoryContext` 只是传输字段，不是生效点。记忆只有进入 daemon 最终交给 Agent runtime 的 prompt，才会影响 LLM 行为。
- `apps/daemon-next/src/executor.ts` 的 `buildAdapterPrompt()` 是 argv-mode / promptOnStdin adapter 把 history 和当前 prompt 合成单次调用 payload 的关口；Phase 1 必须在该函数之前或该函数内部把 server memory、本地 memory 和 Active Context 序列化为同一个 memory block，并插入当前 prompt 之前。
- `apps/daemon-next/src/executor-pty.ts` 的 `renderCodexPayload()` 是 Codex PTY 路径的等价渲染关口；它必须使用同一套 memory block 顺序和脱敏规则，不能只让 pipe / argv 路径获得 memory。
- 当前 generic stdin 路径直接写入 `request.prompt`。Phase 1 不能只修改 `buildAdapterPrompt()`，还要抽出统一的 `buildRuntimePrompt()` / `renderRuntimeContext()` helper，或在进入 pipe、argv、promptOnStdin、PTY 各路径前先生成 `finalPromptPayload`，确保所有 adapter path 都收到一致的 memory 注入。
- §13 的注入模板是最终格式来源；executor 调用点只选择 argv、stdin 或 PTY 传输方式，不应各自拼出不同 memory 文本。

约束：

- 明确告诉 Agent：memory 可能过期；当前用户输入和当前附件优先。
- 明确告诉 Agent：server 协作记忆来自 Team/Channel/User/Agent 范围，本地工作区记忆来自当前设备和 cwd。
- 不把 `rejected`、`expired`、`superseded` 记忆发给 runtime。
- 不把用户无权查看的 source ref 发给 runtime。
- 不把本地绝对路径、未脱敏日志或源码片段上传给 server；daemon 可在本地 runtime prompt 中使用它们，但仍要遵守敏感信息过滤。

本次自动积累结果回传：

- daemon 在 dispatch 完成后调用 `observeDispatchOutcome`，并把返回的 `autoAccumulatedMemorySummaries` 放入 dispatch result payload。
- server 在 `receiveDispatchResult()` 中接收该可选字段，只保存到 workspace run metadata / message meta 的脱敏展示区，不创建 server memory。
- web-next 的 workspace run 详情只展示这些脱敏 summary；本地 memory 原文仍留在 daemon。
- 旧 daemon 不发送该字段时，server 不报错，web-next 不展示「本次自动积累」区域。
- 该字段不能作为权限或检索依据，只是 UI explainability 数据。

## 14. Web 产品形态

### 14.1 第一期开口

本地项目记忆：

- 默认展示 daemon 自动积累的项目技术栈、命令经验、失败经验和执行结论。
- 支持编辑、停用、替代、删除。
- 支持「共享摘要到 Team」或「记为频道知识」，共享前必须展示摘要和敏感信息检查结果。

消息菜单：

- 「记住」
- 「记为团队决策」（高风险或自动推断时进入 candidate；明确用户确认时可 active）
- 「记为我的偏好」

Workspace run 详情：

- 「记住执行结论」
- 「查看本次自动积累的本地记忆」
- 「共享摘要到 Team」

设置页：

- 新增「记忆」分区，分为「协作记忆」和「本地项目记忆」。
- 协作记忆 Tab：`已启用`、`候选`、`已拒绝/已过期`。
- 本地项目记忆 Tab：`当前项目`、`当前 Agent`、`当前 Profile`。
- 支持搜索、编辑、停用、查看来源。

### 14.2 记忆列表字段

- 内容。
- 类型。
- 作用范围。
- 状态。
- 来源。
- 最近更新。
- 操作：编辑、停用、替代、删除、查看来源。

### 14.3 注入可见性

在 Agent 执行详情中显示「本次使用了哪些记忆」，并按来源分组：

- 协作记忆：来自 server，可点击查看消息、任务、artifact、workspace run 或 local_summary 来源。
- 本地项目记忆：来自当前设备和 cwd，只在本机展示；server 只知道本次用了本地记忆的数量和可选脱敏摘要。
- 本次自动积累：来自 daemon dispatch result 的 `autoAccumulatedMemorySummaries`，只展示 id、kind、动作和脱敏 summary；不展示本地原文。旧 daemon 没有该字段时隐藏此分组。
- Active Context：当前消息、thread、attachments、当前 workspace run 状态。

这很重要：

- 用户能理解 Agent 为什么这样回答。
- 便于发现过期或错误记忆。
- 便于一键停用或编辑。

## 15. 外部 Provider 设计

### 15.1 接口

```ts
export interface MemoryExtractionProvider {
  extract(input: MemoryExtractionInput): Promise<MemoryExtractionResult>;
}

export interface MemoryIndexProvider {
  upsert(input: MemoryIndexInput): Promise<void>;
  delete(input: { memoryId: ID; teamId: ID }): Promise<void>;
}

export interface MemoryRetrievalProvider {
  search(input: MemoryProviderSearchInput): Promise<MemoryProviderSearchResult[]>;
}
```

Provider 只能返回候选、索引信号或排序信号。最终可见性和注入由 AgentBean 控制。

### 15.2 Provider 选择

| Provider | 适用阶段 | 用法 |
|---|---|---|
| server SQLite / keyword | 第一期 | 协作记忆默认实现，零外部依赖 |
| daemon local JSONL / SQLite / keyword | 第一期 | 本地工作区记忆默认实现，零外部依赖 |
| mem0 adapter | 第二期 | 可选用于自动提取、相似检索、偏好类记忆；server 和 daemon 可分别接入 |
| Graphiti adapter | 第三期 | 时间变化的项目知识图谱、决策替代关系；优先用于协作级决策 |
| Cognee adapter | 第三期以后 | 文档和 Artifact 知识库摄入；本地文档默认先在 daemon 侧处理 |

### 15.3 安全边界

- provider 不保存权限真相。
- provider 不决定哪些记忆能返回给用户或 Agent。
- provider 返回的外部 id 必须映射回 `memory_items.id` 后再读取。
- server provider 不允许直接摄入 env、secret、未授权 artifact 原文、本地源码或未脱敏本地日志。
- daemon provider 可以处理本地项目内容，但默认只在本机运行；如需使用云端 provider，必须在 UI 中明确提示会上传本地内容，并要求用户确认。

## 16. 权限与安全

### 16.1 可见性继承

server 协作记忆的最大可见性不得超过所有来源的交集：

- 来源是 private channel：memory 不得提升为 team。
- 来源是 DM：memory 不得被其他用户或其他 Agent 读取。
- 来源包含多个 channel：memory 只能进入这些 channel 的共同可见范围；第一期直接禁止多 private source 合并。
- 来源是 artifact：沿用 artifact 的 team/channel 授权。
- 来源是 daemon local_summary：只继承用户选择的共享范围；server 不追溯读取本地原文。

daemon 本地记忆的可见性由本机 profile、cwd、agentId 控制：

- `local_workspace` 只在匹配 cwd / cwdHash 的 dispatch 中使用。
- `local_agent` 只给对应 agent 使用。
- `local_profile` 只在当前 daemon profile 下使用。
- 本地记忆不会因为 Team membership 自动上传或跨设备同步。

### 16.2 Agent 可见性

派发给 Agent 时，除了用户可见性，还要检查目标 Agent 是否处于当前 channel / DM 语境中：

- channel dispatch：Agent 必须是该 channel 可路由目标。
- DM dispatch：只注入该 DM 和该 Agent 相关记忆。
- team memory 可以注入，但必须是 `active` 且 team 可见。

### 16.3 敏感信息

禁止自动记忆：

- env 值。
- token、password、secret、cookie。
- 私钥。
- 未脱敏日志中的凭据。
- 本地源码片段和绝对路径清单进入 server。

显式记忆也要做基础 secret pattern 检测。检测命中时要求用户确认并默认建议改写为脱敏内容。

本地记忆可以保存本地路径和项目结构摘要，但共享到 server 前必须经过摘要化和敏感信息检查。

### 16.4 删除与来源失效

- 删除 server message / artifact / workspace run 时，不立即硬删 server memory；先标记 source 不可用或 memory `expired`。
- 如果 server memory 没有任何可用 source，则不得注入。
- 用户删除 server memory 时写 `deleted` 状态和审计事件；是否物理删除由后续隐私策略决定。
- 删除本地项目 `.agentbean/memory` 或 profile memory 后，daemon 不再注入对应本地记忆；server 不保留本地原文副本。

## 17. 分阶段落地

### Phase 1：本地自动积累 + 显式共享 + 注入

目标：不用外部服务，先让 AgentBean 在用户使用过程中自动积累本地项目记忆；用户主要治理这些记忆，并显式决定哪些摘要可以共享到协作侧。

范围：

- contracts：新增 memory DTO，扩展 `DispatchRequestDto.memoryContext` 和 daemon dispatch result 的 `autoAccumulatedMemorySummaries`。
- domain：新增 memory scope / ranking 纯函数。
- server-next：新增协作 memory repository、SQLite migration、usecases；`receiveDispatchResult()` 接收本次自动积累脱敏摘要并挂到 workspace run 详情展示数据。
- daemon-next：新增本地 `LocalMemoryStore`、workspace scan、dispatch outcome observer；自动记录 cwd/profile/agent 记忆，把 server `memoryContext` 和本地 memory 合成 runtime prompt。
- web-next：本地项目记忆治理页、消息菜单、memory 设置页、执行详情展示本次使用和本次自动积累的记忆；区分协作记忆和本地项目记忆。

验收：

- daemon 能自动识别当前 cwd 的技术栈、包管理器和常用脚本，并保存为本地项目 memory。
- workspace run 成功或失败后，daemon 能自动记录可复用命令、验证步骤或失败经验。
- 用户能查看本地自动积累的 memory，并能编辑、停用、替代或删除。
- 用户能从消息创建 channel memory，作为协作级显式共享入口。
- 用户能创建自己的 preference memory，作为高影响偏好的显式确认入口。
- Team 成员能从 Team 可见来源创建普通 team memory，且不需要 owner/admin 逐条审批。
- 明确用户确认的 team decision 可进入 active；自动推断或高风险 team decision 进入 candidate。
- 用户能给 server 协作记忆添加 tags，tag 写入 `memory_tags`，并能按 tag 筛选。
- daemon 能在当前 cwd 下保存和注入本地项目 memory。
- 派发给 Agent 时只注入当前上下文可见的 server active memory，以及当前 daemon/cwd 可见的本地 active memory。
- private channel memory 不会泄漏到 public channel 或 team memory。
- 本地项目 memory 不会默认出现在 server DB。
- 用户显式共享本地 memory 时，server 只收到用户确认后的摘要和 `local_summary` source。
- 本次 dispatch 使用的 memory 可在执行详情中按 server / local / Active Context 分组查看。

### Phase 2：协作级自动候选 + embedding / mem0 adapter

目标：把自动积累从 daemon 本地扩展到协作侧候选，但仍不让高影响记忆未经确认自动生效。

范围：

- 后台 extraction job。
- `candidate` 审批流。
- provider 接口。
- server mem0 adapter 或等价 provider，用于协作记忆。
- daemon 本地 provider adapter，用于本地项目记忆；若调用云端服务必须明确确认上传内容。
- embedding rerank。

验收：

- pinned message 可生成 candidate memory。
- succeeded workspace run 可生成 candidate artifact/workspace memory。
- candidate 未批准前不会注入。
- provider 不影响权限过滤。
- 本地 candidate 默认只在本机出现，不自动进入 server 候选池。

### Phase 3：图谱和文档知识

目标：处理长期项目关系、决策演进、文档产物。

范围：

- Graphiti adapter：建模「决策替代」「事实随时间变化」。
- Cognee adapter：Artifact / docs 摄入和摘要。
- memory conflict UI。

验收：

- 旧决策能被新决策替代。
- Agent 能拿到当前有效决策，而不是历史冲突结论。
- 文档摘要可追溯到 artifact source。

## 18. 测试策略

### 18.1 contracts

- `MemoryDto` / `DispatchMemoryContextItemDto` 类型导出。
- `DispatchRequestDto.memoryContext` 可选，不破坏现有请求。
- `AutoAccumulatedMemorySummaryDto` 和 dispatch result 可选字段向后兼容，旧 daemon 不发送时 server/web 行为不变。
- `MemoryScopeType` 不包含 `workspace`；daemon 本地使用 `LocalMemoryScopeType`。

### 18.2 domain

- scope 最大权限计算。
- memory ranking 复用 `splitSearchTerms()` 的分词模式，并通过 `scoreMemoryRelevance(memory, terms)` 给 prompt 关键词命中加分。
- token budget 截断。
- `valid_until` 懒过期过滤：过期 active memory 不参与注入，但不要求读取路径修改状态。
- Phase 1 `confidence = NULL` 的显式记忆和本地确定性自动记忆不被置信度过滤排除。
- daemon 本地排序包含 source reliability：`manual` > `scan` > `workspace_run`，且 workspace_run 经验可因后续同类失败降权。
- private channel / DM 不可提升为 team。
- server memory 和 local memory 的合并顺序、预算隔离和来源标记。

### 18.3 server-next

- in-memory repository 和 SQLite repository 行为一致。
- `memory_tags` 写入、替换、去重和按 tag 查询行为一致。
- `rememberMessage` 权限测试。
- `shareLocalMemory` 只接受用户确认后的摘要，不接收本地原文。
- server usecase 拒绝 `scope_type` 不在 `team/channel/dm/agent/user` 的写入。
- `approveMemoryCandidate` / `rejectMemoryCandidate` 状态机测试。
- `getDispatchRequest` 只注入 server 协作 memoryContext。
- `getDispatchRequest` 在带 tags 的查询中只返回 tag 匹配且权限可见的 memory。
- `getDispatchRequest` 不注入 `valid_until <= now` 的 memory。
- `receiveDispatchResult` 接收 `autoAccumulatedMemorySummaries` 时只保存脱敏 summary，不创建 server memory，也不要求旧 daemon 必传。
- private channel memory 不泄漏到其他 channel。
- source 删除或失效后不注入。

### 18.4 daemon-next

- `LocalMemoryStore` 能按 profile、cwd、agentId 写入和读取本地 memory。
- `scanWorkspaceMemory` 能从 cwd 自动生成技术栈、包管理器、常用脚本和目录摘要类本地 memory。
- dispatch start 不直接创建 `dispatch:workspace-state` 长期记忆；仅在 scan 过期、cwdHash 缺失或关键项目文件变化时刷新 scan 条目。
- `observeDispatchOutcome` / `recordWorkspaceRunLearning` 能从成功或失败 workspace run 自动更新本地经验，且按 `cwdHash + kind + dedupeKey` 去重。
- `observeDispatchOutcome` 是 dispatch 完成后的总入口；有 workspace run 时调用 `recordWorkspaceRunLearning`，无 workspace run 时返回空或轻量 metadata。
- run 经验提取只使用确定性 rule set，不调用 LLM/provider；无法由规则分类的失败不生成因果型 memory。
- daemon dispatch result 只回传本次自动积累的脱敏 summary，不回传本地 memory content 原文。
- 相同 `cwdHash + kind + dedupeKey` 的自动积累应更新原记录，不新增重复记录。
- 每个 cwd 的 `local_workspace` 自动记忆超过上限时，最旧的非 `manual` 条目变为 `expired`；`manual` 条目不被自动淘汰。
- 自动积累命中 secret pattern 时不写入原文，或只写入脱敏摘要并标记需要用户确认。
- `LocalMemoryStore` 不返回 `validUntil <= now` 的本地 memory。
- `buildAdapterPrompt()` 或统一 prompt rendering helper 生成的 runtime prompt 包含 server memoryContext 和本地 memoryContext，且 memory block 位于当前 prompt 之前。
- generic stdin、argv-mode、promptOnStdin 和 PTY / Codex `renderCodexPayload()` 路径都覆盖 memory 注入。
- 无 server memoryContext / 无本地 memory 时行为不变。
- server memory、本地 memory、Active Context、history、prompt 的顺序符合设计。
- 本地 memory 默认不发给 server。
- `shareLocalMemory` 前执行敏感信息检查，并只上传摘要。

### 18.5 web-next

- 消息菜单创建记忆。
- Memory 设置页能编辑、停用、替代、删除和查看来源。
- 本地项目记忆页能展示 daemon 自动积累的条目，并区分自动生成、用户编辑和已共享摘要。
- 执行详情展示本次注入记忆和 `autoAccumulatedMemorySummaries` 中的本次自动积累摘要；旧 daemon 没有字段时隐藏该区域。

### 18.6 构建与验证

涉及 TypeScript 变更时按仓库约定运行：

- `npm run test:server-next`
- `npm run test:daemon-next`
- `npm run test:web-next`
- `npm run build:contracts`
- `npm run build:domain`
- `npm run build:server-next`
- `npm run build:daemon-next`
- `npm run build:web-next`
- `git diff --check`

## 19. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 记忆泄漏私有频道内容 | 权限先过滤；source visibility 继承；私有 source 禁止提升 team |
| 本地项目知识被默认上传 | server/daemon 存储分离；本地 memory 默认只在 daemon；共享必须用户确认且只传摘要 |
| 错误记忆长期污染 Agent | 普通低风险自动积累可 active，但高影响自动提取先 candidate；执行详情显示注入记忆；支持停用和替代 |
| 本地自动积累过度记忆噪音 | Phase 1 只记录确定性、可复用、低风险条目；按 `cwdHash + kind + dedupeKey` 更新覆盖；每个 cwd 设置自动记忆上限；执行详情展示本次新增或更新条目；用户可停用或删除 |
| 外部 provider 返回越权结果 | provider 只给排序信号；最终按 `memory_items` 重新权限过滤 |
| 注入内容过多影响回复 | 默认 8 条 / 1200 中文字预算；按 scope 和相关性截断 |
| 记忆和当前输入冲突 | daemon 序列化明确当前输入优先；decision 支持 superseded |
| 审计日志膨胀 | Phase 1 先保留完整 `memory_events`，不在热路径清理；Phase 2 再按 `created_at` 保留最近 N 天或按 memory 保留最近 M 条 |
| 第一版过重 | Phase 1 只做本地确定性自动积累，不做协作级 LLM 自动提取、embedding 或图谱 |

## 20. 推荐实现顺序

1. contracts：`memory.ts` + `DispatchRequestDto.memoryContext`。
2. domain：server scope / local scope / visibility / ranking / merge 纯函数；memory ranking 复用 `search.ts` 的 term splitting + scoring 模式，新增 `scoreMemoryRelevance(memory, terms)`。
3. server-next repository：协作 memory in-memory + SQLite migration。
4. server-next usecases：create/list/update/status + 显式协作记忆 + `shareLocalMemory`。
5. `getDispatchRequest()` 注入 server memoryContext。
6. daemon-next：`LocalMemoryStore` + `scanWorkspaceMemory` + `local-learning-rules` 确定性规则集 + `observeDispatchOutcome` / `recordWorkspaceRunLearning` + 本地检索 + server/local/active context 合成。
7. daemon-next：在 `buildAdapterPrompt()`、generic stdin payload 和 PTY / Codex `renderCodexPayload()` 的共同上游序列化最终 memoryContext 到 runtime prompt，覆盖 pipe、argv、promptOnStdin 和 PTY 路径。
8. web-next 最小 UI：本地项目记忆治理页 + 消息菜单 + Memory 设置页 + 执行详情分组显示本次注入和本次自动积累。
9. 测试和 build。
10. 第二期再接协作级 candidate extraction / mem0 adapter。

## 21. 开放问题

以下问题不阻塞 Phase 1，但需要在实现前确认默认值：

1. user preference 是否允许跨 Team 复用；本设计第一期不支持。
2. Artifact 原文是否允许进入自动摘要；本设计第一期只建议人工显式摘要。
3. 执行详情中是否要展示 memory source 的完整消息内容；本设计建议只展示 source link / preview。
4. 本地项目记忆是否默认落在 `<cwd>/.agentbean/memory`，还是 profile 级 `~/.agentbean/teams/<profile>/memory`；本设计建议 workspace 级优先。
5. Phase 2 是否把 daemon `local_workspace` 提升为共享 `workspace` scope；如果要提升，必须同时补 server usecase、权限模型、迁移和 UI。
6. daemon 本地 provider 是否允许调用云端模型做摘要；本设计建议默认关闭，开启时必须明确提示上传范围。
