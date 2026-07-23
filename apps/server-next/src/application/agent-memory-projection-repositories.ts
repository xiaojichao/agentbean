/**
 * #718 Team-scoped Agent Memory 投影存储接口（接口 + Record，镜像 agent-exposure-repositories.ts）。
 * sqlite 实现在 infra/sqlite/agent-memory-projection-repositories.ts，内存实现在 infra/memory/repositories.ts。
 *
 * 两表都在 Team DB（team_id 不跨库 FK，同 agent_exposure_manifests）。
 * supersede 原子性由 AgentMemoryProjectionUnitOfWork 保证：publish = supersedeActive(旧) + activate(新) 同事务。
 * 消费过滤（active + opted-in + revision fence）由 service 用 domain evaluateTeamAgentMemoryOptIn 完成，
 * repo 只提供基础 CRUD，保持存储与策略分离。
 */
import type {
  AgentMemoryProjectionStatus,
  FormalMemoryKind,
  ID,
  MemorySourceRefDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

export interface AgentMemoryProjectionRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly status: AgentMemoryProjectionStatus;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly validFrom: UnixMs;
  readonly validUntil: UnixMs | null;
  readonly publishedBy: ID | null;
  readonly publishedAt: UnixMs | null;
  readonly supersededById: ID | null;
  readonly withdrawnBy?: ID;
  readonly withdrawnAt?: UnixMs;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface TeamAgentMemoryOptInRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly projectionId: ID;
  readonly enabled: boolean;
  readonly updatedBy: ID;
  readonly updatedAt: UnixMs;
}

export interface AgentMemoryProjectionCreateInput {
  readonly id: ID;
  readonly teamId: ID;
  readonly agentId: ID;
  readonly revision: number;
  readonly status: AgentMemoryProjectionStatus;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly validFrom: UnixMs;
  readonly validUntil: UnixMs | null;
  readonly createdBy: ID;
  readonly now: UnixMs;
}

export interface AgentMemoryProjectionContentUpdateInput {
  readonly id: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly validUntil: UnixMs | null;
  readonly now: UnixMs;
}

export interface AgentMemoryProjectionRepositories {
  readonly projections: {
    create(input: AgentMemoryProjectionCreateInput): Promise<AgentMemoryProjectionRecord>;
    getById(id: ID): Promise<AgentMemoryProjectionRecord | null>;
    /** 当前 active revision（validUntil 过期判定由 service 负责；此处仅按 status='active'）。 */
    getActiveByTeamAgent(teamId: ID, agentId: ID): Promise<AgentMemoryProjectionRecord | null>;
    listByTeamAgent(teamId: ID, agentId: ID): Promise<AgentMemoryProjectionRecord[]>;
    /** Team 下所有 agent 的 active projections（AC#6 全 Team 消费视图）。 */
    listActiveByTeam(teamId: ID): Promise<AgentMemoryProjectionRecord[]>;
    /** 更新 draft 内容（仅 draft 可改）。 */
    updateContent(input: AgentMemoryProjectionContentUpdateInput): Promise<AgentMemoryProjectionRecord | null>;
    /**
     * 把 team+agent 当前 active 标记为 superseded 并指向 newProjectionId。
     * 返回被取代的旧 active（无则 null）。publish 流程中须在 activate 之前调用。
     */
    supersedeActive(input: { readonly teamId: ID; readonly agentId: ID; readonly newProjectionId: ID; readonly now: UnixMs }): Promise<AgentMemoryProjectionRecord | null>;
    /** draft→active：设置 status='active' + publishedBy/publishedAt。 */
    activate(input: { readonly id: ID; readonly actorId: ID; readonly now: UnixMs }): Promise<AgentMemoryProjectionRecord | null>;
    /** 通用状态切换：expire→expired / withdraw→withdrawn（withdraw 额外记 withdrawnBy/At）。 */
    setStatus(input: { readonly id: ID; readonly status: AgentMemoryProjectionStatus; readonly actorId?: ID; readonly now: UnixMs }): Promise<AgentMemoryProjectionRecord | null>;
  };
  readonly optIns: {
    upsert(input: {
      readonly id: ID;
      readonly teamId: ID;
      readonly agentId: ID;
      readonly projectionId: ID;
      readonly enabled: boolean;
      readonly updatedBy: ID;
      readonly now: UnixMs;
    }): Promise<TeamAgentMemoryOptInRecord>;
    getByTeamAgent(teamId: ID, agentId: ID): Promise<TeamAgentMemoryOptInRecord | null>;
    /** Team 下所有 opt-in 记录（AC#6 全 Team 消费视图）。 */
    listByTeam(teamId: ID): Promise<TeamAgentMemoryOptInRecord[]>;
  };
}

export interface AgentMemoryProjectionUnitOfWork {
  run<T>(operation: (repositories: AgentMemoryProjectionRepositories) => Promise<T>): Promise<T>;
}
