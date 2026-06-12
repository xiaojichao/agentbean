import type {
  AgentRecord,
  ArtifactRecord,
  ChannelRecord,
  DeviceInviteRecord,
  DeviceRecord,
  DispatchRecord,
  JoinLinkRecord,
  MessageRecord,
  RuntimeRecord,
  ServerNextRepositories,
  TaskRecord,
  TeamMemberRecord,
  TeamRecord,
  UserRecord,
  WorkspaceRunRecord,
} from '../../application/repositories.js';

export function createInMemoryRepositories(): ServerNextRepositories {
  const users = new Map<string, UserRecord>();
  const teams = new Map<string, TeamRecord>();
  const members = new Map<string, TeamMemberRecord>();
  const joinLinks = new Map<string, JoinLinkRecord>();
  const deviceInvites = new Map<string, DeviceInviteRecord>();
  const channels = new Map<string, ChannelRecord>();
  const devices = new Map<string, DeviceRecord>();
  const runtimes = new Map<string, RuntimeRecord>();
  const agents = new Map<string, AgentRecord>();
  const agentEnv = new Map<string, Record<string, string>>();
  const identityLinks = new Map<string, string>();
  const messages = new Map<string, MessageRecord>();
  const dispatches = new Map<string, DispatchRecord>();
  const artifacts = new Map<string, ArtifactRecord>();
  const workspaceRuns = new Map<string, WorkspaceRunRecord>();
  const tasks = new Map<string, TaskRecord>();

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
    deviceInvites: {
      async create(input) {
        deviceInvites.set(input.code, input);
        return input;
      },
      async getByCode(code) {
        return deviceInvites.get(code) ?? null;
      },
      async updateWaiter(input) {
        const invite = deviceInvites.get(input.code);
        if (!invite) {
          return null;
        }
        const updated = {
          ...invite,
          machineId: input.machineId,
          profileId: input.profileId ?? invite.profileId,
          hostname: input.hostname,
        };
        deviceInvites.set(input.code, updated);
        return updated;
      },
      async complete(input) {
        const invite = deviceInvites.get(input.code);
        if (!invite || invite.completedAt !== undefined) {
          return null;
        }
        const updated = { ...invite, completedAt: input.completedAt };
        deviceInvites.set(input.code, updated);
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
      async getDirectByAgent(input) {
        return Array.from(channels.values()).find((channel) =>
          channel.teamId === input.teamId &&
          channel.kind === 'direct' &&
          channel.humanMemberIds.includes(input.userId) &&
          (channel.dmTargetAgentId === input.agentId || channel.agentMemberIds.includes(input.agentId))
        ) ?? null;
      },
      async listForUser(teamId, userId) {
        return Array.from(channels.values()).filter((channel) => {
          if (channel.teamId !== teamId) {
            return false;
          }
          if (channel.kind === 'direct') {
            return false;
          }
          return channel.visibility === 'public' || channel.humanMemberIds.includes(userId);
        });
      },
      async listDirectForUser(teamId, userId) {
        return Array.from(channels.values()).filter((channel) =>
          channel.teamId === teamId &&
          channel.kind === 'direct' &&
          channel.humanMemberIds.includes(userId)
        );
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
      async removeAgentFromTeamChannels(input) {
        for (const channel of channels.values()) {
          if (channel.teamId !== input.teamId || !channel.agentMemberIds.includes(input.agentId)) {
            continue;
          }
          channels.set(channel.id, {
            ...channel,
            agentMemberIds: channel.agentMemberIds.filter((agentId) => agentId !== input.agentId),
            updatedAt: input.timestamp,
          });
        }
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
        if (!agent || agent.deletedAt !== undefined) {
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
      async publish(input) {
        const agent = agents.get(input.agentId);
        if (!agent || agent.deletedAt !== undefined) {
          return null;
        }
        const updated = {
          ...agent,
          visibleTeamIds: Array.from(new Set([...agent.visibleTeamIds, input.teamId])),
        };
        agents.set(agent.id, updated);
        return updated;
      },
      async unpublish(input) {
        const agent = agents.get(input.agentId);
        if (!agent || agent.deletedAt !== undefined) {
          return null;
        }
        const updated = {
          ...agent,
          visibleTeamIds: agent.visibleTeamIds.filter((teamId) => teamId !== input.teamId || teamId === agent.primaryTeamId),
        };
        agents.set(agent.id, updated);
        return updated;
      },
      async updateConfig(input) {
        const agent = agents.get(input.agentId);
        if (!agent || agent.deletedAt !== undefined) {
          return null;
        }
        const { env, ...changes } = input.changes;
        const updated = {
          ...agent,
          ...changes,
          lastSeenAt: changes.lastSeenAt ?? agent.lastSeenAt,
        };
        agents.set(agent.id, updated);
        if (env) {
          agentEnv.set(agent.id, env);
        }
        return updated;
      },
      async softDelete(input) {
        const agent = agents.get(input.agentId);
        if (!agent || agent.deletedAt !== undefined) {
          return null;
        }
        const updated = {
          ...agent,
          visibleTeamIds: [],
          status: 'offline' as const,
          deletedAt: input.timestamp,
          lastSeenAt: input.timestamp,
        };
        agents.set(agent.id, updated);
        agentEnv.delete(agent.id);
        return updated;
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
        return Array.from(agents.values()).filter(
          (agent) => agent.deletedAt === undefined && agent.visibleTeamIds.includes(teamId),
        );
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
      async search(input) {
        const channelIds = new Set(input.channelIds);
        const query = input.query.toLowerCase();
        return Array.from(messages.values())
          .filter((message) => channelIds.has(message.channelId) && message.body.toLowerCase().includes(query))
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, input.limit)
          .reverse();
      },
      async listThreadBefore(input) {
        const before = messages.get(input.beforeMessageId);
        if (!before) {
          return [];
        }
        return Array.from(messages.values())
          .filter((message) =>
            message.channelId === input.channelId &&
            message.threadId === input.threadId &&
            message.id !== input.beforeMessageId &&
            message.createdAt <= before.createdAt
          )
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-input.limit);
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
    artifacts: {
      async create(input) {
        const existing = artifacts.get(input.id);
        if (existing && (existing.teamId !== input.teamId || existing.channelId !== input.channelId)) {
          return existing;
        }
        artifacts.set(input.id, input);
        return input;
      },
      async getForTeam(input) {
        const artifact = artifacts.get(input.artifactId);
        return artifact?.teamId === input.teamId ? artifact : null;
      },
      async listByMessage(messageId) {
        return Array.from(artifacts.values()).filter((artifact) => artifact.messageId === messageId);
      },
      async listByWorkspaceRun(runId) {
        return Array.from(artifacts.values()).filter((artifact) => artifact.workspaceRunId === runId);
      },
    },
    workspaceRuns: {
      async create(input) {
        workspaceRuns.set(input.id, input);
        return input;
      },
      async getForTeam(input) {
        const run = workspaceRuns.get(input.runId);
        return run?.teamId === input.teamId ? run : null;
      },
      async listByDispatch(dispatchId) {
        return Array.from(workspaceRuns.values()).filter((run) => run.dispatchId === dispatchId);
      },
    },
    tasks: {
      async create(input) {
        tasks.set(input.id, input);
        return input;
      },
      async getById(taskId) {
        return tasks.get(taskId) ?? null;
      },
      async list(input) {
        const channelIds = new Set(input.channelIds);
        return Array.from(tasks.values())
          .filter((task) =>
            task.teamId === input.teamId &&
            ((input.includeGlobal && !task.channelId) || (task.channelId ? channelIds.has(task.channelId) : false)),
          )
          .sort((left, right) => left.sortOrder - right.sortOrder || right.createdAt - left.createdAt);
      },
      async update(input) {
        const task = tasks.get(input.taskId);
        if (!task) {
          return null;
        }
        const updated = { ...task, ...input.changes };
        tasks.set(input.taskId, updated);
        return updated;
      },
    },
  };
}

function isPendingDispatchStatus(status: DispatchRecord['status']): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}
