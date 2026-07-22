# Issue #716 — Team/Channel Formal Memory Center 实施记录

> 父 issue #699（PI Agent MVP）。PI MVP 切片 D。被 #707 阻塞（已合并）。向下阻塞 #717/#718/#719。

## 目标

让 Team Owner/Admin 在 PI Memory Center（复用现有 `MemoryGovernancePanel`，不新增顶级产品）管理 Team/Channel **Formal Memory**：固定 4 类（`fact/decision/rule/preference`）、版本化、可停用/删除/supersede、按 scope 收紧可见性，频道成员可提交纠错但不能直接改。

## 核心设计原则（§6.5）

**复用 Phase 3 已建成的 `memory_items`/`memory_sources`/`memory_audit_events` 表与状态机，不做破坏性重建**。Formal Memory 是「产品投影层」：4 类产品 kind 通过适配映射到现有 6 类存储 kind，排除 `episodic/artifact-summary`。

## 已确认决策

1. **「停用」= `status='expired'` + `change_reason`** 区分「手动停用」vs「时间过期」。检索硬门 `evaluateMemoryInjection` 已排除 expired，AC#8 自动满足。零 schema 重建。
2. **纠错申请 = `createMemory(asCandidate:true)`** 进 `memory_items`（status=candidate），Owner/Admin 用 activate/reject 审批。完整 candidate 治理留 #719。
3. **版本历史 = `version_family_id` 列**（初版=自身 id，supersede 继承），`WHERE version_family_id=? ORDER BY created_at` 一次聚合。
4. **migration 仅 ALTER ADD COLUMN**（formal_kind/change_reason/version_family_id），不重建表、不改 CHECK。

## 架构：三层复用

底层 `CollaborativeMemoryService`（已就绪，scope 授权无角色区分）→ 新增 `formal-memory-service`（投影 + 数据组装，门控在 usecase）→ web `MemoryGovernancePanel` 新增 Formal 视图。

## 落点

- `packages/contracts/src/formal-memory.ts`（新）：`FORMAL_MEMORY_KINDS` + 适配函数 + DTO + 命令 Input
- `packages/domain/src/formal-memory-policy.ts`（新）：`canManageFormalMemory`/`canReadFormalMemory`/`canProposeFormalCorrection` 纯函数
- `apps/server-next/src/application/formal-memory-service.ts`（新）：7 方法（list/getDetail/create/revise/deactivate/delete/proposeCorrection）+ 投影
- `apps/server-next/src/infra/sqlite/migrations/team/0030_formal_memory.sql`（新）：3 列 + 索引
- `apps/server-next/src/application/usecases.ts`：7 usecase 方法（owner/admin 写门控 + scope 读门控）
- `apps/server-next/src/transport/socket-handlers.ts`：7 bind（`memory:formal-*`）
- `apps/web-next/app/[teamPath]/settings/MemoryGovernancePanel.tsx`：FormalMemorySection（formal 作主 tab）
- `apps/web-next/lib/{socket,formal-memory-form}.ts`

## AC 映射

| AC | 实现 |
|---|---|
| #1 列表/详情/来源/状态 | `listFormal`（formal_kind 非空）+ `getDetail`（versions + sources）+ FormalMemorySection |
| #2 4 类最小元数据 | `FORMAL_MEMORY_KINDS` + CreateFormalMemoryInput |
| #3 Owner/Admin 管理 | usecase `canManageFormalMemory` 写门控 + supersede/expire/delete |
| #4 版本化（操作者/时间/来源/原因） | version_family_id + change_reason + created_by + audit |
| #5 可见性 | `canReadFormalMemory`（team 任何成员；channel 须频道成员）|
| #6 成员纠错不可直接改 | `proposeFormalCorrection`（asCandidate）+ Owner/Admin 审批 |
| #7 排除 episodic/artifact-summary | `storageKindToFormalKind` 返回 null |
| #8 退出检索 | `evaluateMemoryInjection` 只放行 active（底层已就绪）|
| #9 Vitest + build | 全 workspace tsc 0 错 + 测试全绿 |

## 验证

- contracts formal 7/7；domain formal-policy 7/7 + 全 260/260；server memory 套 125/125（含 formal 22）；web formal 9/9
- 所有 boundary checker（phase0/1/2/3 + readiness）PASS
- contracts/domain/server/web tsc 0 错

## 已知边界（留给子任务）

- **#717**：System Knowledge 与 User Memory 隔离（Global DB scope）
- **#718**：Team-scoped Agent Memory 投影
- **#719**：Memory Candidate 完整治理（冲突/合并/scope expansion）+ candidate 审批 UI 完善
