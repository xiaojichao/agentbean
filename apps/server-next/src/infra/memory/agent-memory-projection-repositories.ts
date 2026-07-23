import type {
  AgentMemoryProjectionRecord,
  AgentMemoryProjectionRepositories,
  AgentMemoryProjectionUnitOfWork,
  TeamAgentMemoryOptInRecord,
} from '../../application/agent-memory-projection-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';
import type { ID } from '../../../../../packages/contracts/src/index.js';

interface AgentMemoryProjectionMemoryState {
  projections: Map<ID, AgentMemoryProjectionRecord>;
  optIns: Map<string, TeamAgentMemoryOptInRecord>;
}

export function createAgentMemoryProjectionMemoryState(): AgentMemoryProjectionMemoryState {
  return { projections: new Map(), optIns: new Map() };
}

export function createInMemoryAgentMemoryProjectionPersistence(state = createAgentMemoryProjectionMemoryState()): {
  repositories: AgentMemoryProjectionRepositories;
  unitOfWork: AgentMemoryProjectionUnitOfWork;
} {
  const projections = state.projections;
  const optIns = state.optIns;

  const repositories: AgentMemoryProjectionRepositories = {
    projections: {
      async create(input) {
        const record: AgentMemoryProjectionRecord = {
          id: input.id,
          teamId: input.teamId,
          agentId: input.agentId,
          revision: input.revision,
          status: input.status,
          kind: input.kind,
          content: input.content,
          summary: input.summary,
          tags: input.tags,
          sourceRefs: input.sourceRefs,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          publishedBy: null,
          publishedAt: null,
          supersededById: null,
          createdBy: input.createdBy,
          createdAt: input.now,
          updatedAt: input.now,
        };
        projections.set(record.id, record);
        return record;
      },
      async getById(id) {
        return projections.get(id) ?? null;
      },
      async getActiveByTeamAgent(teamId, agentId) {
        for (const record of projections.values()) {
          if (record.teamId === teamId && record.agentId === agentId && record.status === 'active') {
            return record;
          }
        }
        return null;
      },
      async listByTeamAgent(teamId, agentId) {
        return [...projections.values()]
          .filter((record) => record.teamId === teamId && record.agentId === agentId)
          .sort((a, b) => b.revision - a.revision);
      },
      async listActiveByTeam(teamId) {
        return [...projections.values()]
          .filter((record) => record.teamId === teamId && record.status === 'active')
          .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : a.revision - b.revision));
      },
      async updateContent(input) {
        const existing = projections.get(input.id);
        if (!existing || existing.status !== 'draft') return null;
        const updated: AgentMemoryProjectionRecord = {
          ...existing,
          kind: input.kind,
          content: input.content,
          summary: input.summary,
          tags: input.tags,
          sourceRefs: input.sourceRefs,
          validUntil: input.validUntil,
          updatedAt: input.now,
        };
        projections.set(input.id, updated);
        return updated;
      },
      async supersedeActive(input) {
        let prior: AgentMemoryProjectionRecord | null = null;
        for (const record of projections.values()) {
          if (record.teamId === input.teamId && record.agentId === input.agentId && record.status === 'active') {
            prior = record;
            break;
          }
        }
        if (!prior) return null;
        const superseded: AgentMemoryProjectionRecord = {
          ...prior,
          status: 'superseded',
          supersededById: input.newProjectionId,
          updatedAt: input.now,
        };
        projections.set(prior.id, superseded);
        return superseded;
      },
      async activate(input) {
        const existing = projections.get(input.id);
        if (!existing) return null;
        const activated: AgentMemoryProjectionRecord = {
          ...existing,
          status: 'active',
          publishedBy: input.actorId,
          publishedAt: input.now,
          updatedAt: input.now,
        };
        projections.set(input.id, activated);
        return activated;
      },
      async setStatus(input) {
        const existing = projections.get(input.id);
        if (!existing) return null;
        // withdraw 仅对 active 生效（与 sqlite WHERE status='active' 对齐）。
        if (input.status === 'withdrawn' && existing.status !== 'active') return existing;
        const updated: AgentMemoryProjectionRecord = {
          ...existing,
          status: input.status,
          ...(input.status === 'withdrawn'
            ? { withdrawnBy: input.actorId ?? undefined, withdrawnAt: input.now }
            : {}),
          updatedAt: input.now,
        };
        projections.set(input.id, updated);
        return updated;
      },
    },
    optIns: {
      async upsert(input) {
        const record: TeamAgentMemoryOptInRecord = {
          id: input.id,
          teamId: input.teamId,
          agentId: input.agentId,
          projectionId: input.projectionId,
          enabled: input.enabled,
          updatedBy: input.updatedBy,
          updatedAt: input.now,
        };
        // UNIQUE(team_id, agent_id)：覆盖该 agent 现有 opt-in。
        optIns.set(`${input.teamId}:${input.agentId}`, record);
        return record;
      },
      async getByTeamAgent(teamId, agentId) {
        return optIns.get(`${teamId}:${agentId}`) ?? null;
      },
      async listByTeam(teamId) {
        return [...optIns.values()].filter((record) => record.teamId === teamId);
      },
    },
  };

  const runTransaction = serializeTransactions<AgentMemoryProjectionRepositories>(async (operation) => {
    const snapshot = {
      projections: new Map(projections),
      optIns: new Map(optIns),
    };
    try {
      return await operation(repositories);
    } catch (error) {
      projections.clear();
      for (const [id, value] of snapshot.projections) projections.set(id, value);
      optIns.clear();
      for (const [id, value] of snapshot.optIns) optIns.set(id, value);
      throw error;
    }
  });

  return {
    repositories,
    unitOfWork: { run: runTransaction },
  };
}
