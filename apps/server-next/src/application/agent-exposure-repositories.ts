/**
 * #710 Agent Exposure 存储接口（接口 + Record，镜像 pi-provider-repositories.ts）。
 * sqlite 实现在 infra/sqlite/agent-exposure-repositories.ts，内存实现在 infra/memory/repositories.ts。
 *
 * Manifest 表在 Team DB（team_id 不跨库 FK，同 channel_coordination_*）。
 * supersede 原子性由 AgentExposureUnitOfWork 保证：publish = supersedeActive(旧) + activate(新) 同事务。
 */
import type {
  AgentExposureAvailabilityDto,
  AgentExposureCapabilityDto,
  AgentExposureConstraintDto,
  AgentExposureManifestStatus,
  AgentExposureSkillDto,
  ID,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

export interface AgentExposureManifestRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly status: AgentExposureManifestStatus;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validFrom: UnixMs;
  readonly validUntil: UnixMs | null;
  readonly publishedBy: ID | null;
  readonly publishedAt: UnixMs | null;
  readonly supersededById: ID | null;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface AgentExposureRestrictionRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly manifestId: ID;
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

export interface AgentExposureManifestCreateInput {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly status: AgentExposureManifestStatus;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validFrom: UnixMs;
  readonly validUntil: UnixMs | null;
  readonly createdBy: ID;
  readonly now: UnixMs;
}

export interface AgentExposureManifestContentUpdateInput {
  readonly id: ID;
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validUntil: UnixMs | null;
  readonly now: UnixMs;
}

export interface AgentExposureRepositories {
  readonly manifests: {
    create(input: AgentExposureManifestCreateInput): Promise<AgentExposureManifestRecord>;
    getById(id: ID): Promise<AgentExposureManifestRecord | null>;
    /** 当前 active revision（含 validUntil 过期判定由 service 负责；此处仅按 status='active'）。 */
    getActiveByTeamAgent(teamId: ID, agentId: ID): Promise<AgentExposureManifestRecord | null>;
    listByTeamAgent(teamId: ID, agentId: ID): Promise<AgentExposureManifestRecord[]>;
    /** 更新 draft 内容（仅 draft 可改）。 */
    updateContent(input: AgentExposureManifestContentUpdateInput): Promise<AgentExposureManifestRecord | null>;
    /**
     * 把 team+agent 当前 active 标记为 superseded 并指向 newManifestId。
     * 返回被取代的旧 active（无则 null）。publish 流程中须在 activate 之前调用。
     */
    supersedeActive(input: { readonly teamId: ID; readonly agentId: ID; readonly newManifestId: ID; readonly now: UnixMs }): Promise<AgentExposureManifestRecord | null>;
    /** draft→active：设置 status='active' + publishedBy/publishedAt。 */
    activate(input: { readonly id: ID; readonly actorId: ID; readonly now: UnixMs }): Promise<AgentExposureManifestRecord | null>;
    /** 通用状态切换（revoke→revoked / expire→expired）。 */
    setStatus(input: { readonly id: ID; readonly status: AgentExposureManifestStatus; readonly now: UnixMs }): Promise<AgentExposureManifestRecord | null>;
  };
  readonly restrictions: {
    upsert(input: {
      readonly id: ID;
      readonly teamId: ID;
      readonly agentId: ID;
      readonly manifestId: ID;
      readonly disabledCapabilities: readonly string[];
      readonly disabledSkills: readonly string[];
      readonly updatedBy: ID;
      readonly now: UnixMs;
    }): Promise<AgentExposureRestrictionRecord>;
    getByTeamAgent(teamId: ID, agentId: ID): Promise<AgentExposureRestrictionRecord | null>;
  };
}

export interface AgentExposureUnitOfWork {
  run<T>(operation: (repositories: AgentExposureRepositories) => Promise<T>): Promise<T>;
}
