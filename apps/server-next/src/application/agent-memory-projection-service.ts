/**
 * #718 Team-scoped Agent Memory 投影服务（镜像 agent-exposure-service.ts）。
 *
 * 职责：投影草稿/发布/撤回/过期生命周期、Team opt-in 启用停用、只读消费查询。
 *
 * 授权边界（AC#1/AC#2/AC#3/AC#4）：
 * - createDraft/updateDraft/publish/withdraw：Agent owner（canManageAgent，设备拥有者链路，fail-closed）。
 * - upsertOptIn：Team Owner/Admin（AC#3：启用/停用本 Team 对投影的使用）。
 * - listRevisions：Team 成员（owner 视图含审计；成员可见以治理）。
 * - getConsumableProjections：Team 作用域只读，供 PI Memory Center / Coordinator 消费（AC#6）。
 *
 * 安全合同（AC#4/AC#6/AC#7）：
 * - 消费查询只返回当前 Team 的 active + opted-in 投影，用 domain evaluateTeamAgentMemoryOptIn
 *   做 revision fence + enabled + active 的 fail-closed 判定（AC#7：withdrawn/opt-out/projectionId
 *   不符立即退出消费）。
 * - 消费 DTO 只暴露公开字段（kind/content/summary/tags），不含 sourceRefs 原文/owner 审计。
 * - 投影内容由 owner 手动录入的最小化公开内容；Server 不持有 Device-local 原文，投影不引用之。
 * supersede 原子性由 AgentMemoryProjectionUnitOfWork 保证。
 */
import {
  makeFailure,
  makeSuccess,
  type Ack,
  type AgentMemoryProjectionConsumptionDto,
  type AgentMemoryProjectionDto,
  type CreateAgentMemoryProjectionDraftInput,
  type GetConsumableAgentMemoryProjectionsInput,
  type GetConsumableAgentMemoryProjectionsResult,
  type ID,
  type ListAgentMemoryProjectionRevisionsInput,
  type PublishAgentMemoryProjectionInput,
  type TeamAgentMemoryOptInDto,
  type UpdateAgentMemoryProjectionDraftInput,
  type UpsertTeamAgentMemoryOptInInput,
  type WithdrawAgentMemoryProjectionInput,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateProjectionPublishWindow,
  evaluateTeamAgentMemoryOptIn,
  parseAgentMemoryProjectionContent,
} from '../../../../packages/domain/src/index.js';
import type {
  AgentMemoryProjectionRecord,
  AgentMemoryProjectionRepositories,
  AgentMemoryProjectionUnitOfWork,
  TeamAgentMemoryOptInRecord,
} from './agent-memory-projection-repositories.js';
import type { AgentRecord } from './repositories.js';

export interface AgentMemoryProjectionServiceRepositories {
  readonly agentMemoryProjection: AgentMemoryProjectionRepositories;
  readonly agentMemoryProjectionUnitOfWork: AgentMemoryProjectionUnitOfWork;
  readonly agents: {
    getById(agentId: ID): Promise<AgentRecord | null>;
    listVisibleInTeam(teamId: ID): Promise<AgentRecord[]>;
  };
  readonly teams: {
    getMemberRole(teamId: ID, userId: ID): Promise<'owner' | 'admin' | 'member' | null>;
  };
}

export interface AgentMemoryProjectionServiceDependencies {
  readonly repositories: AgentMemoryProjectionServiceRepositories;
  /** 设备拥有者链路授权（来自 usecase 层 canManageAgentAsUser）。fail-closed：无设备/非拥有者 → false。 */
  readonly canManageAgent: (input: { userId: ID; agentId: ID }) => Promise<boolean>;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

function toProjectionDto(record: AgentMemoryProjectionRecord): AgentMemoryProjectionDto {
  return {
    schemaVersion: 1,
    id: record.id,
    teamId: record.teamId,
    agentId: record.agentId,
    revision: record.revision,
    status: record.status,
    kind: record.kind,
    content: record.content,
    summary: record.summary,
    tags: record.tags,
    sourceRefs: record.sourceRefs,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    publishedBy: record.publishedBy,
    publishedAt: record.publishedAt,
    supersededById: record.supersededById,
    withdrawnBy: record.withdrawnBy,
    withdrawnAt: record.withdrawnAt,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toOptInDto(record: TeamAgentMemoryOptInRecord): TeamAgentMemoryOptInDto {
  return {
    id: record.id,
    teamId: record.teamId,
    agentId: record.agentId,
    projectionId: record.projectionId,
    enabled: record.enabled,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
  };
}

// 局部 record 形状别名，避免循环依赖 application/agent-memory-projection-repositories 的 Record 类型。
interface ProjectionLike {
  readonly id: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly kind: AgentMemoryProjectionRecord['kind'];
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly validUntil: number | null;
}

function toConsumptionDto(record: ProjectionLike, agentName: string): AgentMemoryProjectionConsumptionDto {
  return {
    projectionId: record.id,
    agentId: record.agentId,
    agentName,
    revision: record.revision,
    kind: record.kind,
    content: record.content,
    summary: record.summary,
    tags: record.tags,
    validUntil: record.validUntil,
  };
}

export function createAgentMemoryProjectionService(deps: AgentMemoryProjectionServiceDependencies) {
  const { repositories, canManageAgent, clock, ids } = deps;
  const repo = repositories.agentMemoryProjection;
  const uow = repositories.agentMemoryProjectionUnitOfWork;

  /** 懒过期：active 但 validUntil<=now → 标记 expired。best-effort，失败不阻塞读。 */
  async function refreshExpiry(teamId: ID, agentId: ID, now: number): Promise<void> {
    const active = await repo.projections.getActiveByTeamAgent(teamId, agentId);
    if (active && active.validUntil !== null && active.validUntil <= now) {
      await repo.projections.setStatus({ id: active.id, status: 'expired', now });
    }
  }

  /** 取当前 active（先 refreshExpiry 保证状态准确），返回 record 或 null。 */
  async function resolveActive(teamId: ID, agentId: ID, now: number): Promise<AgentMemoryProjectionRecord | null> {
    await refreshExpiry(teamId, agentId, now);
    return repo.projections.getActiveByTeamAgent(teamId, agentId);
  }

  async function requireAgentOwner(
    userId: ID,
    teamId: ID,
    agentId: ID,
  ): Promise<AgentRecord | null> {
    const agent = await repositories.agents.getById(agentId);
    if (!agent || !agent.visibleTeamIds.includes(teamId)) return null;
    if (!(await canManageAgent({ userId, agentId }))) return null;
    return agent;
  }

  async function createDraft(
    input: CreateAgentMemoryProjectionDraftInput,
  ): Promise<Ack<{ projection: AgentMemoryProjectionDto }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can publish memory projection');
    const parsed = parseAgentMemoryProjectionContent({
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      tags: input.tags,
      sourceRefs: input.sourceRefs,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    });
    if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
    const now = clock.now();
    const existing = await repo.projections.listByTeamAgent(input.teamId, input.agentId);
    const revision = existing.reduce((max, record) => Math.max(max, record.revision), 0) + 1;
    const created = await repo.projections.create({
      id: ids.nextId(),
      teamId: input.teamId,
      agentId: input.agentId,
      revision,
      status: 'draft',
      kind: parsed.content.kind,
      content: parsed.content.content,
      summary: parsed.content.summary,
      tags: parsed.content.tags,
      sourceRefs: parsed.content.sourceRefs,
      validFrom: parsed.content.validFrom || now,
      validUntil: parsed.content.validUntil,
      createdBy: input.userId,
      now,
    });
    return makeSuccess({ projection: toProjectionDto(created) });
  }

  async function updateDraft(
    input: UpdateAgentMemoryProjectionDraftInput,
  ): Promise<Ack<{ projection: AgentMemoryProjectionDto }>> {
    const existing = await repo.projections.getById(input.projectionId);
    if (!existing || existing.teamId !== input.teamId || existing.status !== 'draft') {
      return makeFailure('NOT_FOUND', 'Draft projection not found');
    }
    const agent = await requireAgentOwner(input.userId, input.teamId, existing.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can edit memory projection');
    const parsed = parseAgentMemoryProjectionContent({
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      tags: input.tags,
      sourceRefs: input.sourceRefs,
      validUntil: input.validUntil,
    });
    if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
    const updated = await repo.projections.updateContent({
      id: input.projectionId,
      kind: parsed.content.kind,
      content: parsed.content.content,
      summary: parsed.content.summary,
      tags: parsed.content.tags,
      sourceRefs: parsed.content.sourceRefs,
      validUntil: parsed.content.validUntil,
      now: clock.now(),
    });
    if (!updated) return makeFailure('NOT_FOUND', 'Draft projection not found');
    return makeSuccess({ projection: toProjectionDto(updated) });
  }

  async function publish(
    input: PublishAgentMemoryProjectionInput,
  ): Promise<Ack<{ projection: AgentMemoryProjectionDto; supersededProjectionId: ID | null }>> {
    const draft = await repo.projections.getById(input.projectionId);
    if (!draft || draft.teamId !== input.teamId || draft.status !== 'draft') {
      return makeFailure('NOT_FOUND', 'Draft projection not found');
    }
    const agent = await requireAgentOwner(input.userId, input.teamId, draft.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can publish memory projection');
    const now = clock.now();
    const window = evaluateProjectionPublishWindow({ validFrom: draft.validFrom, validUntil: draft.validUntil, now });
    if (!window.ok) return makeFailure('VALIDATION_ERROR', window.message);

    // 原子：旧 active→superseded（指向本 projection），再 activate 本 draft。永不双 active。
    const result = await uow.run(async (tx) => {
      const superseded = await tx.projections.supersedeActive({
        teamId: input.teamId,
        agentId: draft.agentId,
        newProjectionId: draft.id,
        now,
      });
      const activated = await tx.projections.activate({ id: draft.id, actorId: input.userId, now });
      return { activated, supersededId: superseded?.id ?? null };
    });
    if (!result.activated) return makeFailure('NOT_FOUND', 'Projection not found');
    return makeSuccess({ projection: toProjectionDto(result.activated), supersededProjectionId: result.supersededId });
  }

  async function withdraw(
    input: WithdrawAgentMemoryProjectionInput,
  ): Promise<Ack<{ withdrawn: boolean }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can withdraw memory projection');
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const active = await repo.projections.getActiveByTeamAgent(input.teamId, input.agentId);
    if (!active) return makeSuccess({ withdrawn: false });
    // AC#7：withdrawn 后立即退出后续 Active Memory Context（getConsumable 不再返回）。
    await repo.projections.setStatus({ id: active.id, status: 'withdrawn', actorId: input.userId, now });
    return makeSuccess({ withdrawn: true });
  }

  async function listRevisions(
    input: ListAgentMemoryProjectionRevisionsInput,
  ): Promise<Ack<{ revisions: AgentMemoryProjectionDto[]; activeOptIn: TeamAgentMemoryOptInDto | null }>> {
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const revisions = await repo.projections.listByTeamAgent(input.teamId, input.agentId);
    const optIn = await repo.optIns.getByTeamAgent(input.teamId, input.agentId);
    return makeSuccess({
      revisions: revisions.map(toProjectionDto),
      activeOptIn: optIn ? toOptInDto(optIn) : null,
    });
  }

  async function upsertOptIn(
    input: UpsertTeamAgentMemoryOptInInput,
  ): Promise<Ack<{ optIn: TeamAgentMemoryOptInDto }>> {
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (role !== 'owner' && role !== 'admin') {
      return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can opt in to memory projection');
    }
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const active = await repo.projections.getActiveByTeamAgent(input.teamId, input.agentId);
    if (!active) return makeFailure('NOT_FOUND', 'No active projection to opt in');
    // opt-in 锁定当前 active projection id（revision fence）；projection supersede 后旧 opt-in 失效（AC#7）。
    const saved = await repo.optIns.upsert({
      id: ids.nextId(),
      teamId: input.teamId,
      agentId: input.agentId,
      projectionId: active.id,
      enabled: input.enabled,
      updatedBy: input.userId,
      now,
    });
    return makeSuccess({ optIn: toOptInDto(saved) });
  }

  /**
   * PI / Team 只读消费查询（AC#6）。返回当前 Team 已 opt-in 的 active projection 消费视图。
   * AC#4 隔离：userId 非成员时返回空（fail-closed）。
   * AC#7 fail-closed：用 domain evaluateTeamAgentMemoryOptIn 判定 active + enabled + revision fence。
   */
  async function getConsumableProjections(
    input: GetConsumableAgentMemoryProjectionsInput,
  ): Promise<GetConsumableAgentMemoryProjectionsResult> {
    if (input.userId !== undefined) {
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (!role) return { projections: [] };
    }
    const now = clock.now();
    // agentId → name 映射（消费视图需要 agentName，但不泄露 owner/审计）。
    const teamAgents = await repositories.agents.listVisibleInTeam(input.teamId);
    const nameMap = new Map<ID, string>(teamAgents.map((a) => [a.id, a.name]));

    let actives: AgentMemoryProjectionRecord[];
    if (input.agentId) {
      const single = await resolveActive(input.teamId, input.agentId, now);
      actives = single ? [single] : [];
    } else {
      // team-wide：先对 team 下每个 agent refreshExpiry（懒过期），避免已过 validUntil 但
      // status 仍 active 的 projection 绕过过期被消费（镜像 #710 getTeamCoverage per-agent refreshExpiry）。
      for (const agent of teamAgents) {
        await refreshExpiry(input.teamId, agent.id, now);
      }
      actives = await repo.projections.listActiveByTeam(input.teamId);
    }

    const consumable: AgentMemoryProjectionConsumptionDto[] = [];
    for (const projection of actives) {
      const optIn = await repo.optIns.getByTeamAgent(input.teamId, projection.agentId);
      const verdict = evaluateTeamAgentMemoryOptIn({
        activeProjectionId: projection.id,
        optIn: optIn ? { projectionId: optIn.projectionId, enabled: optIn.enabled } : null,
      });
      if (verdict.consumable) {
        consumable.push(toConsumptionDto(projection, nameMap.get(projection.agentId) ?? ''));
      }
    }
    return { projections: consumable };
  }

  return {
    createDraft,
    updateDraft,
    publish,
    withdraw,
    listRevisions,
    upsertOptIn,
    getConsumableProjections,
  };
}

export type AgentMemoryProjectionService = ReturnType<typeof createAgentMemoryProjectionService>;
