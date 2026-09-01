/**
 * #710 Agent Exposure 服务（镜像 pi-provider-service.ts）。
 *
 * 职责：Manifest 草稿/发布/撤回/过期生命周期、Team restriction 收紧、只读 active 投影与 coverage。
 *
 * 授权边界（AC#1/AC#4）：
 * - createDraft/updateDraft/publish/revoke：Agent owner（canManageAgent，设备拥有者链路，fail-closed）。
 * - upsertRestriction：Team Owner/Admin。
 * - listRevisions/getTeamCoverage：Team 成员。
 * - getActiveProjection：Team 作用域只读，供 PI Coordinator/候选解析内部消费（AC#3）。
 *
 * 安全合同（AC#3/AC#6）：所有投影只暴露公开 capability/skill/constraint/availability，
 * 绝不包含 sourcePath/工具/权限/依赖。supersede 原子性由 agentExposureUnitOfWork 保证。
 */
import {
  makeFailure,
  makeSuccess,
  type Ack,
  type AgentAutoAcceptPolicyDto,
  type AgentCapabilityDirectoryDto,
  type AgentCapabilityDirectoryEntryDto,
  type AgentExposureActiveProjectionDto,
  type AgentExposureAvailabilityDto,
  type AgentExposureCapabilityDto,
  type AgentExposureConstraintDto,
  type AgentExposureManifestRevisionDto,
  type AgentExposureRestrictionDto,
  type AgentExposureSkillDto,
  type AgentTeamCoverageDto,
  type AgentTeamCoverageEntryDto,
  type CreateAgentExposureDraftInput,
  type GetAgentExposureActiveInput,
  type GetAgentAutoAcceptPolicyInput,
  type GetAgentCapabilityDirectoryInput,
  type GetAgentTeamCoverageInput,
  type ID,
  type ListAgentExposureRevisionsInput,
  type PublishAgentExposureInput,
  type RevokeAgentExposureInput,
  type UpdateAgentExposureDraftInput,
  type UpsertAgentAutoAcceptPolicyInput,
  type UpsertAgentExposureRestrictionInput,
} from '../../../../packages/contracts/src/index.js';
import {
  bindAgentExposureCapability,
  evaluatePublishWindow,
  evaluateRestriction,
  materializeAgentExposureCapability,
  parseAgentExposureContent,
} from '../../../../packages/domain/src/index.js';
import type { AgentExposureRepositories, AgentExposureUnitOfWork } from './agent-exposure-repositories.js';
import type { AgentRecord, ChannelRecord } from './repositories.js';

export interface AgentExposureServiceRepositories {
  readonly agentExposure: AgentExposureRepositories;
  readonly agentExposureUnitOfWork: AgentExposureUnitOfWork;
  readonly agents: {
    getById(agentId: ID): Promise<AgentRecord | null>;
    listVisibleInTeam(teamId: ID): Promise<AgentRecord[]>;
  };
  readonly channels: {
    getById(channelId: ID): Promise<ChannelRecord | null>;
  };
  readonly teams: {
    getMemberRole(teamId: ID, userId: ID): Promise<'owner' | 'admin' | 'member' | null>;
  };
}

export interface AgentExposureServiceDependencies {
  readonly repositories: AgentExposureServiceRepositories;
  /** 设备拥有者链路授权（来自 usecase 层 canManageAgentAsUser）。fail-closed：无设备/非拥有者 → false。 */
  readonly canManageAgent: (input: { userId: ID; agentId: ID }) => Promise<boolean>;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  /**
   * #946：active manifest 被新 revision 替代后回调，撤销绑定旧 revision 的 execution grant
   * （manifest-superseded）。跨域（exposure→task-coordination）best-effort，在 publish 事务外
   * 执行；lease 留存（agent 可用新 manifest 重新 claim 取得新 grant）。
   */
  readonly onManifestSuperseded?: (input: {
    readonly teamId: ID;
    readonly agentId: ID;
    readonly manifestRevision: number;
    readonly now: number;
  }) => Promise<void>;
}

function toManifestDto(
  record: AgentExposureManifestLike,
): AgentExposureManifestRevisionDto {
  return {
    id: record.id,
    teamId: record.teamId,
    agentId: record.agentId,
    revision: record.revision,
    status: record.status,
    capabilities: record.capabilities.map((capability) =>
      materializeAgentExposureCapability(capability, record.publishedAt ?? record.createdAt)),
    skills: record.skills,
    constraints: record.constraints,
    availability: record.availability,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
    publishedBy: record.publishedBy,
    publishedAt: record.publishedAt,
    supersededById: record.supersededById,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toProjection(record: AgentExposureManifestLike): AgentExposureActiveProjectionDto {
  return {
    manifestId: record.id,
    agentId: record.agentId,
    revision: record.revision,
    capabilities: record.capabilities.map((capability) =>
      materializeAgentExposureCapability(capability, record.publishedAt ?? record.createdAt)),
    skills: record.skills,
    constraints: record.constraints,
    availability: record.availability,
    validUntil: record.validUntil,
  };
}

function toRestrictionDto(record: AgentExposureRestrictionLike): AgentExposureRestrictionDto {
  return {
    id: record.id,
    teamId: record.teamId,
    agentId: record.agentId,
    manifestId: record.manifestId,
    disabledCapabilities: record.disabledCapabilities,
    disabledSkills: record.disabledSkills,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
  };
}

// 局部 record 形状别名，避免循环依赖 application/agent-exposure-repositories 的 Record 类型。
interface AgentExposureManifestLike {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly status: 'draft' | 'active' | 'superseded' | 'expired' | 'revoked';
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validFrom: number;
  readonly validUntil: number | null;
  readonly publishedBy: ID | null;
  readonly publishedAt: number | null;
  readonly supersededById: ID | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface AgentExposureRestrictionLike {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly manifestId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
  readonly updatedBy: ID;
  readonly updatedAt: number;
}

export function createAgentExposureService(deps: AgentExposureServiceDependencies) {
  const { repositories, canManageAgent, clock, ids } = deps;
  const repo = repositories.agentExposure;
  const uow = repositories.agentExposureUnitOfWork;

  function bindCapabilities(
    capabilities: readonly Pick<AgentExposureCapabilityDto, 'name' | 'description'>[],
    agent: AgentRecord,
    recordedAt: number,
  ): readonly AgentExposureCapabilityDto[] {
    return capabilities.map((capability) => bindAgentExposureCapability({
      capability,
      deterministicCandidates: agent.scannedCapabilities ?? [],
      summarizedCandidates: agent.scannedCapabilitiesSummarized ?? [],
      recordedAt,
    }));
  }

  /** 懒过期：active 但 validUntil<=now → 标记 expired。best-effort，失败不阻塞读。 */
  async function refreshExpiry(teamId: ID, agentId: ID, now: number): Promise<void> {
    const active = await repo.manifests.getActiveByTeamAgent(teamId, agentId);
    if (active && active.validUntil !== null && active.validUntil <= now) {
      await repo.manifests.setStatus({ id: active.id, status: 'expired', now });
    }
  }

  /** 取当前 active（先 refreshExpiry 保证状态准确），返回 record 或 null。 */
  async function resolveActive(teamId: ID, agentId: ID, now: number) {
    await refreshExpiry(teamId, agentId, now);
    return repo.manifests.getActiveByTeamAgent(teamId, agentId);
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
    input: CreateAgentExposureDraftInput,
  ): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can publish exposure');
    const parsed = parseAgentExposureContent({
      capabilities: input.capabilities,
      skills: input.skills,
      constraints: input.constraints,
      availability: input.availability,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    });
    if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
    const now = clock.now();
    const existing = await repo.manifests.listByTeamAgent(input.teamId, input.agentId);
    const revision = existing.reduce((max, record) => Math.max(max, record.revision), 0) + 1;
    const created = await repo.manifests.create({
      id: ids.nextId(),
      teamId: input.teamId,
      agentId: input.agentId,
      revision,
      status: 'draft',
      capabilities: bindCapabilities(parsed.content.capabilities, agent, now),
      skills: parsed.content.skills,
      constraints: parsed.content.constraints,
      availability: parsed.content.availability,
      validFrom: parsed.content.validFrom || now,
      validUntil: parsed.content.validUntil,
      createdBy: input.userId,
      now,
    });
    return makeSuccess({ manifest: toManifestDto(created) });
  }

  async function updateDraft(
    input: UpdateAgentExposureDraftInput,
  ): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto }>> {
    const existing = await repo.manifests.getById(input.manifestId);
    if (!existing || existing.teamId !== input.teamId || existing.status !== 'draft') {
      return makeFailure('NOT_FOUND', 'Draft manifest not found');
    }
    const agent = await requireAgentOwner(input.userId, input.teamId, existing.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can edit exposure');
    const parsed = parseAgentExposureContent({
      capabilities: input.capabilities,
      skills: input.skills,
      constraints: input.constraints,
      availability: input.availability,
      validUntil: input.validUntil,
    });
    if (!parsed.ok) return makeFailure('VALIDATION_ERROR', parsed.message);
    const now = clock.now();
    const updated = await repo.manifests.updateContent({
      id: input.manifestId,
      capabilities: bindCapabilities(parsed.content.capabilities, agent, now),
      skills: parsed.content.skills,
      constraints: parsed.content.constraints,
      availability: parsed.content.availability,
      validUntil: parsed.content.validUntil,
      now,
    });
    if (!updated) return makeFailure('NOT_FOUND', 'Draft manifest not found');
    return makeSuccess({ manifest: toManifestDto(updated) });
  }

  async function publish(
    input: PublishAgentExposureInput,
  ): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto; supersededManifestId: ID | null }>> {
    const draft = await repo.manifests.getById(input.manifestId);
    if (!draft || draft.teamId !== input.teamId || draft.status !== 'draft') {
      return makeFailure('NOT_FOUND', 'Draft manifest not found');
    }
    const agent = await requireAgentOwner(input.userId, input.teamId, draft.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can publish exposure');
    const now = clock.now();
    const window = evaluatePublishWindow({ validFrom: draft.validFrom, validUntil: draft.validUntil, now });
    if (!window.ok) return makeFailure('VALIDATION_ERROR', window.message);

    // 原子：旧 active→superseded（指向本 manifest），再 activate 本 draft。永不双 active。
    const result = await uow.run(async (tx) => {
      const superseded = await tx.manifests.supersedeActive({
        teamId: input.teamId,
        agentId: draft.agentId,
        newManifestId: draft.id,
        now,
      });
      const activated = await tx.manifests.activate({ id: draft.id, actorId: input.userId, now });
      return { activated, superseded };
    });
    if (!result.activated) return makeFailure('NOT_FOUND', 'Manifest not found');
    // #946：旧 active manifest 被替代后，撤销绑定其 revision 的 execution grant（manifest-superseded）。
    if (result.superseded && deps.onManifestSuperseded) {
      await deps.onManifestSuperseded({
        teamId: input.teamId,
        agentId: draft.agentId,
        manifestRevision: result.superseded.revision,
        now,
      });
    }
    return makeSuccess({
      manifest: toManifestDto(result.activated),
      supersededManifestId: result.superseded?.id ?? null,
    });
  }

  async function revoke(
    input: RevokeAgentExposureInput,
  ): Promise<Ack<{ revoked: boolean }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can revoke exposure');
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const active = await repo.manifests.getActiveByTeamAgent(input.teamId, input.agentId);
    if (!active) return makeSuccess({ revoked: false });
    await repo.manifests.setStatus({ id: active.id, status: 'revoked', now });
    return makeSuccess({ revoked: true });
  }

  async function listRevisions(
    input: ListAgentExposureRevisionsInput,
  ): Promise<Ack<{ revisions: AgentExposureManifestRevisionDto[]; activeRestriction: AgentExposureRestrictionDto | null }>> {
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const revisions = await repo.manifests.listByTeamAgent(input.teamId, input.agentId);
    const restriction = await repo.restrictions.getByTeamAgent(input.teamId, input.agentId);
    return makeSuccess({
      revisions: revisions.map(toManifestDto),
      activeRestriction: restriction ? toRestrictionDto(restriction) : null,
    });
  }

  async function getActiveProjection(
    input: GetAgentExposureActiveInput,
  ): Promise<{ projection: AgentExposureActiveProjectionDto | null }> {
    const now = clock.now();
    const active = await resolveActive(input.teamId, input.agentId, now);
    return { projection: active ? toProjection(active) : null };
  }

  async function upsertRestriction(
    input: UpsertAgentExposureRestrictionInput,
  ): Promise<Ack<{ restriction: AgentExposureRestrictionDto }>> {
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (role !== 'owner' && role !== 'admin') {
      return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can restrict exposure');
    }
    const now = clock.now();
    await refreshExpiry(input.teamId, input.agentId, now);
    const active = await repo.manifests.getActiveByTeamAgent(input.teamId, input.agentId);
    if (!active) return makeFailure('NOT_FOUND', 'No active manifest to restrict');
    // AC#4 fail-closed：只能禁用已公开 operation。
    const verdict = evaluateRestriction({
      activeCapabilities: active.capabilities.map((capability) => capability.name),
      activeSkills: active.skills.map((skill) => skill.name),
      disabledCapabilities: input.disabledCapabilities,
      disabledSkills: input.disabledSkills,
    });
    if (!verdict.ok) return makeFailure('VALIDATION_ERROR', verdict.message);
    const saved = await repo.restrictions.upsert({
      id: ids.nextId(),
      teamId: input.teamId,
      agentId: input.agentId,
      manifestId: active.id,
      disabledCapabilities: verdict.disabledCapabilities,
      disabledSkills: verdict.disabledSkills,
      updatedBy: input.userId,
      now,
    });
    return makeSuccess({ restriction: toRestrictionDto(saved) });
  }

  async function upsertAutoAcceptPolicy(
    input: UpsertAgentAutoAcceptPolicyInput,
  ): Promise<Ack<{ policy: AgentAutoAcceptPolicyDto }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can configure auto-accept');
    const now = clock.now();
    const active = await resolveActive(input.teamId, input.agentId, now);
    if (!active) return makeFailure('NOT_FOUND', 'No active manifest for auto-accept policy');
    if (!Number.isInteger(input.maxActiveClaims) || input.maxActiveClaims < 1 || input.maxActiveClaims > 100) {
      return makeFailure('VALIDATION_ERROR', 'maxActiveClaims must be an integer between 1 and 100');
    }
    const allowedRiskLevels = [...new Set(input.allowedRiskLevels)];
    if (allowedRiskLevels.length === 0
      || allowedRiskLevels.some((risk) => risk !== 'low' && risk !== 'high')) {
      return makeFailure('VALIDATION_ERROR', 'allowedRiskLevels must contain low or high');
    }
    if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil <= now) {
      return makeFailure('VALIDATION_ERROR', 'validUntil must be in the future');
    }
    const activeCapabilityIds = new Set(active.capabilities.map((capability) =>
      materializeAgentExposureCapability(capability, active.publishedAt ?? active.createdAt)
        .registry.capabilityId));
    const allowedCapabilityIds = [...new Set(input.allowedCapabilityIds)];
    if (allowedCapabilityIds.some((capabilityId) => !activeCapabilityIds.has(capabilityId))) {
      return makeFailure('VALIDATION_ERROR', 'Auto-accept capabilities must be in the active manifest');
    }
    const saved = await repo.autoAcceptPolicies.upsert({
      id: ids.nextId(),
      teamId: input.teamId,
      agentId: input.agentId,
      manifestId: active.id,
      manifestRevision: active.revision,
      enabled: input.enabled,
      allowedCapabilityIds,
      allowUnspecifiedCapabilities: input.allowUnspecifiedCapabilities === true,
      allowedRiskLevels,
      allowFrozenProjectInputs: input.allowFrozenProjectInputs === true,
      requireCompletePreview: input.requireCompletePreview !== false,
      maxActiveClaims: input.maxActiveClaims,
      validUntil: input.validUntil ?? null,
      updatedBy: input.userId,
      now,
    });
    return makeSuccess({ policy: saved });
  }

  async function getAutoAcceptPolicy(
    input: GetAgentAutoAcceptPolicyInput,
  ): Promise<Ack<{ policy: AgentAutoAcceptPolicyDto | null }>> {
    const agent = await requireAgentOwner(input.userId, input.teamId, input.agentId);
    if (!agent) return makeFailure('FORBIDDEN', 'Only the agent owner can view auto-accept policy');
    return makeSuccess({
      policy: await repo.autoAcceptPolicies.getByTeamAgent(input.teamId, input.agentId),
    });
  }

  async function getTeamCoverage(
    input: GetAgentTeamCoverageInput,
  ): Promise<Ack<{ coverage: AgentTeamCoverageDto }>> {
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
    const now = clock.now();
    const agentsInTeam = await repositories.agents.listVisibleInTeam(input.teamId);
    const entries: AgentTeamCoverageEntryDto[] = [];
    for (const agent of agentsInTeam) {
      await refreshExpiry(input.teamId, agent.id, now);
      const active = await repo.manifests.getActiveByTeamAgent(input.teamId, agent.id);
      const restriction = await repo.restrictions.getByTeamAgent(input.teamId, agent.id);
      const disabledCap =
        restriction && active && restriction.manifestId === active.id ? restriction.disabledCapabilities : [];
      entries.push({
        agentId: agent.id,
        agentName: agent.name,
        hasActive: Boolean(active),
        activeRevision: active ? active.revision : null,
        available: active ? active.availability.status === 'available' : false,
        exposedCapabilities: active ? active.capabilities.map((capability) => capability.name) : [],
        disabledCapabilities: disabledCap,
        constraints: active ? active.constraints : [],
      });
    }
    return makeSuccess({ coverage: { teamId: input.teamId, entries } });
  }

  async function getCapabilityDirectory(
    input: GetAgentCapabilityDirectoryInput,
  ): Promise<Ack<{ directory: AgentCapabilityDirectoryDto }>> {
    if (input.userId !== undefined) {
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
    }

    let channelAgentIds: ReadonlySet<ID> | null = null;
    if (input.channelId !== undefined) {
      const channel = await repositories.channels.getById(input.channelId);
      if (!channel
        || channel.teamId !== input.teamId
        || (channel.archivedAt !== null && channel.archivedAt !== undefined)) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (input.userId !== undefined
        && channel.visibility === 'private'
        && !channel.humanMemberIds.includes(input.userId)) {
        return makeFailure('FORBIDDEN', 'Not a channel member');
      }
      channelAgentIds = new Set(channel.agentMemberIds);
    }

    const now = clock.now();
    const agentsInScope = (await repositories.agents.listVisibleInTeam(input.teamId))
      .filter((agent) => channelAgentIds === null || channelAgentIds.has(agent.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const entries: AgentCapabilityDirectoryEntryDto[] = [];
    for (const agent of agentsInScope) {
      const active = await resolveActive(input.teamId, agent.id, now);
      if (!active) continue;
      const restriction = await repo.restrictions.getByTeamAgent(input.teamId, agent.id);
      const currentRestriction = restriction?.manifestId === active.id ? restriction : null;
      const disabledCapabilities = new Set(
        (currentRestriction?.disabledCapabilities ?? []).map((name) => name.toLowerCase()),
      );
      const disabledSkills = new Set(
        (currentRestriction?.disabledSkills ?? []).map((name) => name.toLowerCase()),
      );
      entries.push({
        agentId: agent.id,
        agentName: agent.name,
        manifestId: active.id,
        manifestRevision: active.revision,
        available: active.availability.status === 'available',
        capabilities: active.capabilities
          .filter((capability) => !disabledCapabilities.has(capability.name.toLowerCase()))
          .map((capability) => {
            const bound = materializeAgentExposureCapability(
              capability,
              active.publishedAt ?? active.createdAt,
            );
            return {
              registry: bound.registry,
              name: bound.name,
              description: bound.description,
              evidence: bound.evidence,
            };
          }),
        skills: active.skills.filter((skill) => !disabledSkills.has(skill.name.toLowerCase())),
        disabledCapabilities: currentRestriction?.disabledCapabilities ?? [],
        disabledSkills: currentRestriction?.disabledSkills ?? [],
        constraints: active.constraints,
      });
    }
    return makeSuccess({
      directory: {
        teamId: input.teamId,
        channelId: input.channelId ?? null,
        generatedAt: now,
        entries,
      },
    });
  }

  return {
    createDraft,
    updateDraft,
    publish,
    revoke,
    listRevisions,
    getActiveProjection,
    upsertRestriction,
    upsertAutoAcceptPolicy,
    getAutoAcceptPolicy,
    getTeamCoverage,
    getCapabilityDirectory,
  };
}

export type AgentExposureService = ReturnType<typeof createAgentExposureService>;
