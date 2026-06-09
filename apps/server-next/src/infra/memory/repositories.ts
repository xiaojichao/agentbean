import type {
  AgentRecord,
  ChannelRecord,
  DeviceRecord,
  DispatchRecord,
  JoinLinkRecord,
  MessageRecord,
  RuntimeRecord,
  ServerNextRepositories,
  TeamMemberRecord,
  TeamRecord,
  UserRecord,
} from '../../application/repositories.js';

export function createInMemoryRepositories(): ServerNextRepositories {
  const users = new Map<string, UserRecord>();
  const teams = new Map<string, TeamRecord>();
  const members = new Map<string, TeamMemberRecord>();
  const joinLinks = new Map<string, JoinLinkRecord>();
  const channels = new Map<string, ChannelRecord>();
  const devices = new Map<string, DeviceRecord>();
  const runtimes = new Map<string, RuntimeRecord>();
  const agents = new Map<string, AgentRecord>();
  const agentEnv = new Map<string, Record<string, string>>();
  const identityLinks = new Map<string, string>();
  const messages = new Map<string, MessageRecord>();
  const dispatches = new Map<string, DispatchRecord>();

  return {
    users: {
      async create(input) {
        users.set(input.id, input);
        return input;
      },
      async getById(id) {
        return users.get(id) ?? null;
      },
      async getByUsername(username) {
        return Array.from(users.values()).find((user) => user.username === username) ?? null;
      },
      async setCurrentTeam(userId, teamId) {
        const user = users.get(userId);
        if (user) {
          users.set(userId, { ...user, currentTeamId: teamId, primaryTeamId: teamId });
        }
      },
    },
    teams: {
      async create(input) {
        teams.set(input.id, input);
        return input;
      },
      async getById(id) {
        return teams.get(id) ?? null;
      },
      async listForUser(userId) {
        return Array.from(members.values())
          .filter((member) => member.userId === userId)
          .map((member) => {
            const team = teams.get(member.teamId);
            if (!team) {
              return null;
            }
            return { ...team, currentUserRole: member.role };
          })
          .filter((team): team is TeamRecord & { currentUserRole: 'owner' | 'admin' | 'member' } =>
            Boolean(team),
          );
      },
      async addMember(input) {
        members.set(`${input.teamId}:${input.userId}`, input);
      },
      async isMember(teamId, userId) {
        return members.has(`${teamId}:${userId}`);
      },
      async getMemberRole(teamId, userId) {
        return members.get(`${teamId}:${userId}`)?.role ?? null;
      },
      async listMembersByIds(teamId, userIds) {
        return userIds.flatMap((userId) => {
          const member = members.get(`${teamId}:${userId}`);
          if (!member) {
            return [];
          }
          const user = users.get(userId);
          return [
            {
              id: `${teamId}:${userId}`,
              teamId,
              userId,
              username: user?.username ?? member.username,
              role: member.role,
              displayName: user?.displayName,
              avatarUrl: user?.avatarUrl,
            },
          ];
        });
      },
    },
    joinLinks: {
      async create(input) {
        joinLinks.set(input.code, input);
        return input;
      },
      async getByCode(code) {
        return joinLinks.get(code) ?? null;
      },
      async incrementUses(code) {
        const link = joinLinks.get(code);
        if (!link) {
          return null;
        }
        if (link.maxUses !== undefined && link.usesCount >= link.maxUses) {
          return null;
        }
        const updated = { ...link, usesCount: link.usesCount + 1 };
        joinLinks.set(code, updated);
        return updated;
      },
    },
    channels: {
      async create(input) {
        channels.set(input.id, input);
        return input;
      },
      async getById(channelId) {
        return channels.get(channelId) ?? null;
      },
      async listForUser(teamId, userId) {
        return Array.from(channels.values()).filter((channel) => {
          if (channel.teamId !== teamId) {
            return false;
          }
          return channel.visibility === 'public' || channel.humanMemberIds.includes(userId);
        });
      },
      async update(input) {
        const channel = channels.get(input.channelId);
        if (!channel) {
          return null;
        }
        const updated = { ...channel, ...input.changes };
        channels.set(input.channelId, updated);
        return updated;
      },
    },
    devices: {
      async upsertHello(input) {
        devices.set(input.id, input);
        return input;
      },
      async getById(id) {
        return devices.get(id) ?? null;
      },
      async findByMachineProfile(machineId, profileId) {
        return (
          Array.from(devices.values()).find(
            (device) => device.machineId === machineId && device.profileId === profileId,
          ) ?? null
        );
      },
      async listByTeam(teamId) {
        return Array.from(devices.values()).filter((device) => device.teamId === teamId);
      },
    },
    runtimes: {
      async replaceForDevice(input) {
        for (const runtime of Array.from(runtimes.values())) {
          if (runtime.deviceId === input.deviceId) {
            runtimes.delete(runtime.id);
          }
        }
        for (const runtime of input.runtimes) {
          runtimes.set(runtime.id, runtime);
        }
        return input.runtimes;
      },
      async getById(runtimeId) {
        return runtimes.get(runtimeId) ?? null;
      },
      async listByDevice(deviceId) {
        return Array.from(runtimes.values()).filter((runtime) => runtime.deviceId === deviceId);
      },
    },
    agents: {
      async upsert(input) {
        const { env, ...agent } = input;
        agents.set(input.id, agent);
        if (env) {
          agentEnv.set(input.id, env);
        }
        return agent;
      },
      async getByIdentityKey(identityKey) {
        const agentId = identityLinks.get(identityKey);
        return agentId ? agents.get(agentId) ?? null : null;
      },
      async getById(agentId) {
        return agents.get(agentId) ?? null;
      },
      async getExecutionConfig(agentId) {
        const agent = agents.get(agentId);
        if (!agent) {
          return null;
        }
        return {
          adapterKind: agent.adapterKind,
          command: agent.command,
          args: agent.args,
          cwd: agent.cwd,
          env: agentEnv.get(agentId),
        };
      },
      async linkIdentity(input) {
        identityLinks.set(input.identityKey, input.agentId);
      },
      async markMissingScannedOffline(input) {
        const seen = new Set(input.seenIdentityKeys);
        const missing: string[] = [];
        for (const [identityKey, agentId] of identityLinks.entries()) {
          const agent = agents.get(agentId);
          if (
            agent &&
            agent.source === 'scanned' &&
            agent.primaryTeamId === input.teamId &&
            agent.deviceId === input.deviceId &&
            !seen.has(identityKey)
          ) {
            agents.set(agent.id, { ...agent, status: 'offline', lastSeenAt: input.timestamp });
            missing.push(agent.id);
          }
        }
        return missing;
      },
      async updateStatus(input) {
        const agent = agents.get(input.agentId);
        if (agent) {
          agents.set(input.agentId, {
            ...agent,
            status: input.status,
            lastSeenAt: input.lastSeenAt,
          });
        }
      },
      async listVisibleInTeam(teamId) {
        return Array.from(agents.values()).filter((agent) => agent.visibleTeamIds.includes(teamId));
      },
    },
    messages: {
      async append(input) {
        messages.set(input.id, input);
        return input;
      },
      async getById(messageId) {
        return messages.get(messageId) ?? null;
      },
      async listByChannel(channelId, limit) {
        return Array.from(messages.values())
          .filter((message) => message.channelId === channelId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-limit);
      },
    },
    dispatches: {
      async create(input) {
        dispatches.set(input.id, input);
        return input;
      },
      async getById(id) {
        return dispatches.get(id) ?? null;
      },
      async markSucceeded(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (!isPendingDispatchStatus(dispatch.status)) {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          status: 'succeeded' as const,
          updatedAt: input.completedAt,
          completedAt: input.completedAt,
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async markTimedOut(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (!isPendingDispatchStatus(dispatch.status)) {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          status: 'timed_out' as const,
          updatedAt: input.completedAt,
          completedAt: input.completedAt,
          error: input.error,
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async markFailed(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (!isPendingDispatchStatus(dispatch.status)) {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          status: 'failed' as const,
          updatedAt: input.completedAt,
          completedAt: input.completedAt,
          error: input.error,
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async markCancelled(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (!isPendingDispatchStatus(dispatch.status)) {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          status: 'cancelled' as const,
          updatedAt: input.completedAt,
          completedAt: input.completedAt,
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async listPendingOlderThan(timestamp) {
        return Array.from(dispatches.values()).filter(
          (dispatch) =>
            (dispatch.status === 'queued' ||
              dispatch.status === 'sent' ||
              dispatch.status === 'accepted' ||
              dispatch.status === 'running') &&
            dispatch.updatedAt < timestamp,
        );
      },
      async listByMessage(messageId) {
        return Array.from(dispatches.values()).filter((dispatch) => dispatch.messageId === messageId);
      },
    },
  };
}

function isPendingDispatchStatus(status: DispatchRecord['status']): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}
