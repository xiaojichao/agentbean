import type {
  AgentExposureManifestRecord,
  AgentExposureRepositories,
  AgentExposureRestrictionRecord,
  AgentExposureUnitOfWork,
} from '../../application/agent-exposure-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';
import type { ID } from '../../../../../packages/contracts/src/index.js';

interface AgentExposureMemoryState {
  manifests: Map<ID, AgentExposureManifestRecord>;
  restrictions: Map<ID, AgentExposureRestrictionRecord>;
}

export function createAgentExposureMemoryState(): AgentExposureMemoryState {
  return { manifests: new Map(), restrictions: new Map() };
}

export function createInMemoryAgentExposurePersistence(state = createAgentExposureMemoryState()): {
  repositories: AgentExposureRepositories;
  unitOfWork: AgentExposureUnitOfWork;
} {
  const manifests = state.manifests;
  const restrictions = state.restrictions;

  const repositories: AgentExposureRepositories = {
    manifests: {
      async create(input) {
        const record: AgentExposureManifestRecord = {
          id: input.id,
          teamId: input.teamId,
          agentId: input.agentId,
          revision: input.revision,
          status: input.status,
          capabilities: input.capabilities,
          skills: input.skills,
          constraints: input.constraints,
          availability: input.availability,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
          publishedBy: null,
          publishedAt: null,
          supersededById: null,
          createdBy: input.createdBy,
          createdAt: input.now,
          updatedAt: input.now,
        };
        manifests.set(record.id, record);
        return record;
      },
      async getById(id) {
        return manifests.get(id) ?? null;
      },
      async getActiveByTeamAgent(teamId, agentId) {
        for (const record of manifests.values()) {
          if (record.teamId === teamId && record.agentId === agentId && record.status === 'active') {
            return record;
          }
        }
        return null;
      },
      async listByTeamAgent(teamId, agentId) {
        return [...manifests.values()]
          .filter((record) => record.teamId === teamId && record.agentId === agentId)
          .sort((a, b) => b.revision - a.revision);
      },
      async updateContent(input) {
        const existing = manifests.get(input.id);
        if (!existing || existing.status !== 'draft') return null;
        const updated: AgentExposureManifestRecord = {
          ...existing,
          capabilities: input.capabilities,
          skills: input.skills,
          constraints: input.constraints,
          availability: input.availability,
          validUntil: input.validUntil,
          updatedAt: input.now,
        };
        manifests.set(input.id, updated);
        return updated;
      },
      async supersedeActive(input) {
        let prior: AgentExposureManifestRecord | null = null;
        for (const record of manifests.values()) {
          if (record.teamId === input.teamId && record.agentId === input.agentId && record.status === 'active') {
            prior = record;
            break;
          }
        }
        if (!prior) return null;
        const superseded: AgentExposureManifestRecord = {
          ...prior,
          status: 'superseded',
          supersededById: input.newManifestId,
          updatedAt: input.now,
        };
        manifests.set(prior.id, superseded);
        return superseded;
      },
      async activate(input) {
        const existing = manifests.get(input.id);
        if (!existing) return null;
        const activated: AgentExposureManifestRecord = {
          ...existing,
          status: 'active',
          publishedBy: input.actorId,
          publishedAt: input.now,
          updatedAt: input.now,
        };
        manifests.set(input.id, activated);
        return activated;
      },
      async setStatus(input) {
        const existing = manifests.get(input.id);
        if (!existing) return null;
        const updated: AgentExposureManifestRecord = { ...existing, status: input.status, updatedAt: input.now };
        manifests.set(input.id, updated);
        return updated;
      },
    },
    restrictions: {
      async upsert(input) {
        const record: AgentExposureRestrictionRecord = {
          id: input.id,
          teamId: input.teamId,
          agentId: input.agentId,
          manifestId: input.manifestId,
          disabledCapabilities: input.disabledCapabilities,
          disabledSkills: input.disabledSkills,
          updatedBy: input.updatedBy,
          updatedAt: input.now,
        };
        // UNIQUE(team_id, agent_id)：覆盖该 agent 现有 restriction（保留原 id 或换新）。
        const existingKey = [...restrictions.keys()].find((key) => key.startsWith(`${input.teamId}:${input.agentId}:`));
        if (existingKey) restrictions.delete(existingKey);
        const compositeKey = `${input.teamId}:${input.agentId}:${input.manifestId}`;
        restrictions.set(compositeKey, record);
        return record;
      },
      async getByTeamAgent(teamId, agentId) {
        for (const record of restrictions.values()) {
          if (record.teamId === teamId && record.agentId === agentId) return record;
        }
        return null;
      },
    },
  };

  const runTransaction = serializeTransactions<AgentExposureRepositories>(async (operation) => {
    const snapshot = {
      manifests: new Map(manifests),
      restrictions: new Map(restrictions),
    };
    try {
      return await operation(repositories);
    } catch (error) {
      manifests.clear();
      for (const [id, value] of snapshot.manifests) manifests.set(id, value);
      restrictions.clear();
      for (const [id, value] of snapshot.restrictions) restrictions.set(id, value);
      throw error;
    }
  });

  return {
    repositories,
    unitOfWork: { run: runTransaction },
  };
}
