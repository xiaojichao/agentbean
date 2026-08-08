# Research: OutputPackage formation authority 对 DM 频道的判定(候选3)

- **Query**: evaluateOutputPackageFormation 对 DM 频道 + 本机 agent 的 authority 校验,是否触发 agent-authority-revoked?
- **Scope**: internal
- **Date**: 2026-08-07

## 结论(TL;DR)

**候选 3(authority reject)不是本次 DM publish 断点的原因**,但它也不是修复点——因为 staging 从未 commit,formation 函数**从未被调用**。即便强行让 formation 跑起来,DM 频道里 Hermes 的 authority 校验也**会通过**(`agentMemberIds` 已含目标 agent)。

## Findings

### 1. evaluateOutputPackageFormation 拒绝优先级

`packages/domain/src/output-package-policy.ts:111-260` 的拒绝顺序:

| 顺序 | 条件 | reasonCode | 行号 |
|---|---|---|---|
| 1 | `!channel.exists` | `channel-not-found` | 135-137 |
| 2 | `channel.archived` | `channel-archived` | 138-140 |
| 3 | staging 不存在 / 未 commit / revision 不匹配 | `workspace-revision-not-committed` | 142-152 |
| 4 | provenance 缺失 / 文件空 / 缺 artifactId | `incomplete-delivery` | 154-158 |
| 5 | 同 path 重复 | `duplicate-manifest-entry` | 160-167 |
| 6 | `!agentAuthorityOk` | `agent-authority-revoked` | 169-171 |
| 7+ | Task lineage 不一致 | `task-authority-mismatch` / `task-attempt-superseded` / `invocation-mismatch` / `claim-inactive` | 181-232 |

**关键**:DM 频道在**第 3 步就会被拒**(`workspace-revision-not-committed`)——因为根本没有 staging 被创建,`staging.status !== 'committed'` 必然成立。第 6 步(authority)永远跑不到。

### 2. agent-authority-revoked 触发条件(仅作未来参考)

调用方 `apps/server-next/src/application/output-package-handler.ts:519-534`:

```ts
async function ensurePublishAgentAuthority(repositories, teamId, channel, provenance) {
  if (!provenance) return { ok: false };
  const agent = await repositories.agents.getById(provenance.agentId);
  if (!agent
    || !agent.visibleTeamIds.includes(teamId)            // ← (a) Team 可见
    || !channel.agentMemberIds.includes(agent.id)        // ← (b) 频道 agent 成员
    || (provenance.deviceId !== undefined && agent.deviceId !== provenance.deviceId)) {  // ← (c) device 绑定
    return { ok: false };
  }
  return { ok: true };
}
```

调用点(output-package-handler.ts:163, 220):

```ts
const authority = await ensurePublishAgentAuthority(repositories, teamId, channel, staging?.provenance);
...
const decision = evaluateOutputPackageFormation({
  ...,
  agentAuthorityOk: authority.ok,
});
```

### 3. DM 频道里 Hermes 的 authority 实际判定

DM 频道创建(`usecases.ts:5278-5290`)时:

```ts
agentMemberIds: [agent.id],       // ← DM 创建即把目标 agent 加入 agentMemberIds
dmTargetAgentId: agent.id,
```

`apps/server-next/src/application/usecases.ts:5317` 强制要求 DM 目标 agent 必须 `visibleTeamIds.includes(dmInput.teamId)`,否则 DM 都不让创建。所以:

| 条件 | DM 频道实际值 |
|---|---|
| agent 存在 | ✅ Hermes-agent-xiao-mbp 存在(刚 dispatch 过) |
| `agent.visibleTeamIds.includes(teamId)` | ✅ DM 创建时已强制校验 |
| `channel.agentMemberIds.includes(agent.id)` | ✅ DM 创建时直接写入(usecases.ts:5289) |
| `provenance.deviceId` 与 `agent.deviceId` 匹配 | ✅ 本机 Hermes 的 dispatch,provenance.deviceId 即本机 device,agent.deviceId 也即本机 |

**结论**:`authority.ok = true`。Hermes 在 DM 频道里**不会触发 agent-authority-revoked**。

### 4. Task lineage 风险点(供修复时参考)

即便把 staging 通了,formation 还要过 Task lineage(usecases.ts policy 181-232)。本机 DM dispatch 通常是用户 @ 触发的简单 dispatch,provenance.taskId 是 daemon 合成 fallback(dispatch.id)。policy.ts:181-184:

```ts
if (task) {
  if (task.teamId !== input.teamId || (task.channelId && task.channelId !== input.channelId)) {
    return { kind: 'rejected', reasonCode: 'task-authority-mismatch' };
  }
  ...
}
```

- 若 taskId 是合成 fallback → `task` 为 null → 走 `taskBinding = 'unmanaged'` 分支(policy.ts:174-180),只记 provenance,不校验 lineage
- 若 taskId 命中真实 Task 记录 → 校验 task.teamId/channelId 与本次一致

DM 频道里通常**没有显式创建 Task**(DM 不走 project stage),所以 taskId 多为合成,会落入 unmanaged 分支,不被 Task lineage 拒绝。

### 5. 与候选 2 的关系

候选 3(formation reject)在当前 DM 链路里**完全不成立**,因为:

```
daemon 没起 staging → server 没收到 commit → commitWorkspacePublishStaging 没跑
→ formPackage 没调用 → evaluateOutputPackageFormation 没跑 → 没有 reject 也没有 create
→ 没有 output-package system 消息 → 没有卡片
```

候选 2(baseline 门)是**上游闸门**,候选 3 是**下游闸门**。要打通 DM publish,候选 2 必须先解决;解决后候选 3 的 authority 这关**会通过**,Task lineage 多半也通过(走 unmanaged)。

## Caveats / Not Found

- **未真实跑过 formation 验证**:由于 staging 从未 commit,无法在日志/db 中取证 formation 的实际 reject reason。本文件结论基于源码静态分析 + DM 频道创建时的 agentMemberIds/visibleTeamIds 保证。
- **未确认 DM dispatch 是否真的走 unmanaged**:如果 web 端 @触发 DM 时会附带一个 Task 上下文(例如 PI managed run),Task lineage 可能因 invocation/claim 缺失而 reject。需要进一步看 web 端 `@` 触发的 dispatch payload,但当前用户场景是手动 @,大概率 unmanaged。
- **本文件不构成修复建议**:仅描述 authority 判定。是否要让 DM 支持 OutputPackage 是产品决策。
