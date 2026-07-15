import type { ID, MemoryScopeType } from '../../../../packages/contracts/src/index.js';
import type { MemorySearchPermissions, MemoryScopeVisibility } from './collaborative-memory-search-service.js';
import type { MemorySourceRecord } from './memory-repositories.js';
import type { ServerNextRepositories } from './repositories.js';

export const CURRENT_MEMORY_POLICY_VERSION = 1;

type ServerMemoryPermissionRepositories = Pick<
  ServerNextRepositories,
  | 'teams'
  | 'agents'
  | 'tasks'
  | 'channels'
  | 'messages'
  | 'artifacts'
  | 'workspaceRuns'
  | 'management'
  | 'memory'
>;

/**
 * Production authorization adapter for Server Memory reads. It derives visibility from current
 * repository truth on every call; Capsule recovery therefore cannot reuse a stale permission
 * snapshot from creation time.
 */
export function createServerMemorySearchPermissions(
  repositories: ServerMemoryPermissionRepositories,
): MemorySearchPermissions {
  return {
    async canSearchTeam(input) {
      if (!await repositories.teams.isMember(input.teamId, input.requesterUserId)) return false;
      const agent = await repositories.agents.getById(input.targetAgentId);
      return Boolean(agent && agent.deletedAt === undefined && agent.visibleTeamIds.includes(input.teamId));
    },

    async evaluateScopeVisibility(input) {
      const base = await evaluateScope(repositories, input);
      if (base === 'hidden') return base;
      if (input.source?.sourceVisibility === 'local-only') return 'hidden';
      if (input.source?.sourceVisibility === 'private'
        || input.source?.sourceVisibility === 'dm-participants') return 'explicit-grant';
      return base;
    },

    async isSourceAvailable(input) {
      return isSourceAvailable(repositories, input.teamId, input.source);
    },
  };
}

async function evaluateScope(
  repositories: ServerMemoryPermissionRepositories,
  input: {
    readonly teamId: ID;
    readonly requesterUserId: ID;
    readonly targetAgentId: ID;
    readonly scopeType: MemoryScopeType;
    readonly scopeRef: ID;
  },
): Promise<MemoryScopeVisibility> {
  switch (input.scopeType) {
    case 'team':
      return input.scopeRef === input.teamId ? 'visible' : 'hidden';
    case 'user':
      return input.scopeRef === input.requesterUserId ? 'visible' : 'hidden';
    case 'agent':
      return input.scopeRef === input.targetAgentId ? 'visible' : 'hidden';
    case 'task': {
      const task = await repositories.tasks.getById(input.scopeRef);
      return task?.teamId === input.teamId && task.assigneeId === input.targetAgentId
        ? 'visible'
        : 'hidden';
    }
    case 'channel':
    case 'dm': {
      const channel = await repositories.channels.getById(input.scopeRef);
      if (!channel || channel.teamId !== input.teamId
        || !channel.humanMemberIds.includes(input.requesterUserId)
        || !channel.agentMemberIds.includes(input.targetAgentId)) return 'hidden';
      if (input.scopeType === 'dm') {
        return channel.kind === 'direct' && channel.dmTargetAgentId === input.targetAgentId
          ? 'explicit-grant'
          : 'hidden';
      }
      if (channel.kind !== 'channel') return 'hidden';
      return channel.visibility === 'private' ? 'explicit-grant' : 'visible';
    }
  }
}

async function isSourceAvailable(
  repositories: ServerMemoryPermissionRepositories,
  teamId: ID,
  source: MemorySourceRecord,
): Promise<boolean> {
  switch (source.sourceKind) {
    case 'message': {
      const message = await repositories.messages.getById(source.sourceId);
      return Boolean(message && message.teamId === teamId && message.meta?.deletedAt === undefined);
    }
    case 'task': {
      const task = await repositories.tasks.getById(source.sourceId);
      return task?.teamId === teamId;
    }
    case 'artifact':
      return Boolean(await repositories.artifacts.getForTeam({ teamId, artifactId: source.sourceId }));
    case 'workspace-run':
      return Boolean(await repositories.workspaceRuns.getForTeam({ teamId, runId: source.sourceId }));
    case 'invocation': {
      const invocation = await repositories.management.invocations.getById(source.sourceId);
      return invocation?.intent.teamId === teamId;
    }
    case 'memory': {
      const memory = await repositories.memory.items.getById({ teamId, id: source.sourceId });
      return memory?.status === 'active';
    }
    case 'manual':
    case 'local-summary':
      // These sources are user-authored/imported provenance markers with no separate backing row.
      return true;
  }
}
