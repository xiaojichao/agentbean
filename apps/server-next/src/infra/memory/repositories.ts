import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentRecord,
  ArtifactRecord,
  ChannelRecord,
  DeviceInviteRecord,
  DeviceRecord,
  DeviceRevocationRecord,
  DispatchRecord,
  JoinLinkRecord,
  MessageRecord,
  RuntimeRecord,
  ServerNextRepositories,
  TaskRecord,
  TeamMemberRecord,
  TeamPiPolicyRecord,
  TeamRecord,
  UserRecord,
  WorkspaceRunRecord,
} from '../../application/repositories.js';
import { DEFAULT_CHANNEL_NAME, rankMessageSearch } from '../../../../../packages/domain/src/index.js';
import { createInMemoryManagementPersistence } from './management-repositories.js';
import {
  cloneTaskCoordinationMemoryState,
  createInMemoryTaskCoordinationRepositories,
  createTaskCoordinationMemoryState,
  restoreTaskCoordinationMemoryState,
} from './task-coordination-repositories.js';
import { createTaskCoordinationUnitOfWork } from '../../application/task-coordination-unit-of-work.js';
import { createMemoryUnitOfWork } from '../../application/memory-unit-of-work.js';
import {
  createManagementMemoryUnitOfWork,
  type ManagementMemoryTransactionRepositories,
} from '../../application/management-memory-unit-of-work.js';
import {
  cloneMemoryRepositoryMemoryState,
  createInMemoryMemoryRepositories,
  createMemoryRepositoryMemoryState,
  restoreMemoryRepositoryMemoryState,
} from './memory-repositories.js';
import { createInMemoryPiProviderPersistence } from './pi-provider-repositories.js';
import {
  createChannelCoordinationUnitOfWork,
  type ChannelCoordinationRepositories,
} from '../../application/channel-coordination-unit-of-work.js';
import type { ChannelCoordinationDecisionRecord, ChannelCoordinationJobRecord } from '../../../../../packages/contracts/src/index.js';

export function createInMemoryRepositories(): ServerNextRepositories {
  const management = createInMemoryManagementPersistence();
  const taskCoordinationState = createTaskCoordinationMemoryState();
  const taskCoordination = createInMemoryTaskCoordinationRepositories(taskCoordinationState);
  const memoryState = createMemoryRepositoryMemoryState();
  const memory = createInMemoryMemoryRepositories(memoryState);
  const piProvider = createInMemoryPiProviderPersistence();
  const managementMemoryContext = new AsyncLocalStorage<ManagementMemoryTransactionRepositories>();

  const users = new Map<string, UserRecord>();
  const teams = new Map<string, TeamRecord>();
  const teamPiPolicies = new Map<string, TeamPiPolicyRecord>();
  const members = new Map<string, TeamMemberRecord>();
  const joinLinks = new Map<string, JoinLinkRecord>();
  const deviceInvites = new Map<string, DeviceInviteRecord>();
  const channels = new Map<string, ChannelRecord>();
  const devices = new Map<string, DeviceRecord>();
  const deviceRevocations = new Map<string, DeviceRevocationRecord>();
  const revocationKey = (teamId: string, machineId: string, profileId?: string | null) =>
    `${teamId}|${machineId}|${profileId ?? ''}`;
  const runtimes = new Map<string, RuntimeRecord>();
  const agents = new Map<string, AgentRecord>();
  const agentEnv = new Map<string, Record<string, string>>();
  const identityLinks = new Map<string, string>();
  const messages = new Map<string, MessageRecord>();
  const channelCoordinationJobs = new Map<string, ChannelCoordinationJobRecord>();
  const channelCoordinationDecisions = new Map<string, ChannelCoordinationDecisionRecord>();
  const dispatches = new Map<string, DispatchRecord>();
  const artifacts = new Map<string, ArtifactRecord>();
  const workspaceRuns = new Map<string, WorkspaceRunRecord>();
  const tasks = new Map<string, TaskRecord>();
  const reactions = new Map<string, { id: string; messageId: string; userId: string; emoji: string; createdAt: number }>();
  const savedMessages = new Map<string, { id: string; messageId: string; userId: string; teamId: string; channelId: string; createdAt: number }>();
  const pinnedMessages = new Map<string, { id: string; messageId: string; userId: string; teamId: string; channelId: string; createdAt: number }>();

  const channelCoordination: ChannelCoordinationRepositories = {
    jobs: {
      async create(input) {
        if (channelCoordinationJobs.has(input.id)) {
          throw new Error(`Coordination job already exists: ${input.id}`);
        }
        if (Array.from(channelCoordinationJobs.values()).some((job) =>
          job.messageId === input.messageId || job.idempotencyKey === input.idempotencyKey)) {
          throw new Error(`Coordination job idempotency conflict: ${input.idempotencyKey}`);
        }
        channelCoordinationJobs.set(input.id, input);
        return input;
      },
      async getById(jobId) {
        return channelCoordinationJobs.get(jobId) ?? null;
      },
      async getByMessageId(messageId) {
        return Array.from(channelCoordinationJobs.values()).find((job) => job.messageId === messageId) ?? null;
      },
      async getByIdempotencyKey(idempotencyKey) {
        return Array.from(channelCoordinationJobs.values())
          .find((job) => job.idempotencyKey === idempotencyKey) ?? null;
      },
      async listByChannel(channelId, limit) {
        return Array.from(channelCoordinationJobs.values())
          .filter((job) => job.channelId === channelId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-limit);
      },
      async updateState(input) {
        const job = channelCoordinationJobs.get(input.jobId);
        if (!job) return null;
        const updated = {
          ...job,
          status: input.status,
          attempt: input.attempt,
          nextRetryAt: input.nextRetryAt,
          updatedAt: input.updatedAt,
        };
        channelCoordinationJobs.set(job.id, updated);
        return updated;
      },
      async listRunnable(input) {
        return Array.from(channelCoordinationJobs.values())
          .filter((job) =>
            (job.status === 'pending' || job.status === 'retry_wait')
              ? (job.nextRetryAt === null || job.nextRetryAt <= input.now)
              : job.status === 'running' && job.updatedAt <= input.runningBefore)
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(0, input.limit);
      },
      async claimForProcessing(input) {
        const job = channelCoordinationJobs.get(input.jobId);
        if (!job) return null;
        const claimable = job.status === 'pending'
          || (job.status === 'retry_wait' && (job.nextRetryAt === null || job.nextRetryAt <= input.now))
          || (job.status === 'running' && job.updatedAt <= input.runningBefore);
        if (!claimable) return null;
        const claimed = {
          ...job,
          status: 'running' as const,
          attempt: job.attempt + 1,
          nextRetryAt: null,
          updatedAt: input.now,
        };
        channelCoordinationJobs.set(job.id, claimed);
        return claimed;
      },
    },
    decisions: {
      async create(input) {
        if (channelCoordinationDecisions.has(input.id)) {
          throw new Error(`Coordination decision already exists: ${input.id}`);
        }
        if (Array.from(channelCoordinationDecisions.values()).some((decision) => decision.jobId === input.jobId)) {
          throw new Error(`Coordination decision already exists for job: ${input.jobId}`);
        }
        channelCoordinationDecisions.set(input.id, input);
        return input;
      },
      async getByJobId(jobId) {
        return Array.from(channelCoordinationDecisions.values())
          .find((decision) => decision.jobId === jobId) ?? null;
      },
      async getByMessageId(messageId) {
        return Array.from(channelCoordinationDecisions.values())
          .find((decision) => decision.messageId === messageId) ?? null;
      },
    },
  };

  let repositories!: ServerNextRepositories;
  const managementMemoryUnitOfWork = createManagementMemoryUnitOfWork(async (operation) => {
    const active = managementMemoryContext.getStore();
    if (active) return operation(active);
    return management.unitOfWork.run(async (managementRepositories) => {
      const snapshot = cloneMemoryRepositoryMemoryState(memoryState);
      try {
        return await managementMemoryContext.run(
          { management: managementRepositories, memory },
          () => operation({ management: managementRepositories, memory }),
        );
      } catch (error) {
        restoreMemoryRepositoryMemoryState(memoryState, snapshot);
        throw error;
      }
    });
  });
  repositories = {
    management: management.repositories,
    managementUnitOfWork: management.unitOfWork,
    managementDispatchUnitOfWork: {
      run(operation) {
        return management.unitOfWork.run(async (managementRepositories) => {
          const dispatchSnapshot = new Map(dispatches);
          const taskSnapshot = new Map(tasks);
          const coordinationSnapshot = cloneTaskCoordinationMemoryState(taskCoordinationState);
          try {
            return await operation({ management: managementRepositories, dispatches: repositories.dispatches,
              tasks: repositories.tasks, coordination: taskCoordination });
          } catch (error) {
            dispatches.clear();
            for (const [id, dispatch] of dispatchSnapshot) dispatches.set(id, dispatch);
            tasks.clear();
            for (const [id, task] of taskSnapshot) tasks.set(id, task);
            restoreTaskCoordinationMemoryState(taskCoordinationState, coordinationSnapshot);
            throw error;
          }
        });
      },
    },
    piProvider: piProvider.repositories,
    piProviderUnitOfWork: piProvider.unitOfWork,
    channelCoordination,
    channelCoordinationUnitOfWork: createChannelCoordinationUnitOfWork((operation) =>
      management.unitOfWork.run(async () => {
        const messageSnapshot = new Map(messages);
        const artifactSnapshot = new Map(artifacts);
        const jobSnapshot = new Map(channelCoordinationJobs);
        const decisionSnapshot = new Map(channelCoordinationDecisions);
        const taskSnapshot = new Map(tasks);
        try {
          return await operation({
            messages: repositories.messages,
            artifacts: repositories.artifacts,
            jobs: channelCoordination.jobs,
            decisions: channelCoordination.decisions,
            tasks: repositories.tasks,
          });
        } catch (error) {
          messages.clear();
          for (const [id, message] of messageSnapshot) messages.set(id, message);
          artifacts.clear();
          for (const [id, artifact] of artifactSnapshot) artifacts.set(id, artifact);
          channelCoordinationJobs.clear();
          for (const [id, job] of jobSnapshot) channelCoordinationJobs.set(id, job);
          channelCoordinationDecisions.clear();
          for (const [id, decision] of decisionSnapshot) channelCoordinationDecisions.set(id, decision);
          tasks.clear();
          for (const [id, task] of taskSnapshot) tasks.set(id, task);
          throw error;
        }
      })),
    taskCoordination,
    taskCoordinationUnitOfWork: createTaskCoordinationUnitOfWork((operation) =>
      management.unitOfWork.run(async (managementRepositories) => {
        const taskSnapshot = new Map(tasks);
        const coordinationSnapshot = cloneTaskCoordinationMemoryState(taskCoordinationState);
        try {
          return await operation({
            tasks: repositories.tasks,
            messages: repositories.messages,
            artifacts: repositories.artifacts,
            workspaceRuns: repositories.workspaceRuns,
            dispatches: repositories.dispatches,
            coordination: taskCoordination,
            management: managementRepositories,
          });
        } catch (error) {
          tasks.clear();
          for (const [id, task] of taskSnapshot) tasks.set(id, task);
          restoreTaskCoordinationMemoryState(taskCoordinationState, coordinationSnapshot);
          throw error;
        }
      }),
    ),
    memory,
    memoryUnitOfWork: createMemoryUnitOfWork((operation) =>
      managementMemoryUnitOfWork.run(({ memory: transactionMemory }) => operation(transactionMemory))),
    managementMemoryUnitOfWork,
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
      async listAll() {
        return Array.from(users.values()).sort((left, right) => left.createdAt - right.createdAt);
      },
      async setCurrentTeam(userId, teamId) {
        const user = users.get(userId);
        if (user) {
          users.set(userId, { ...user, currentTeamId: teamId, primaryTeamId: teamId });
        }
      },
      async updateDescription(input) {
        const user = users.get(input.userId);
        if (!user) return null;
        const updated = { ...user, displayName: input.description ?? undefined, updatedAt: input.updatedAt };
        users.set(input.userId, updated);
        return updated;
      },
      async updatePassword(input) {
        const user = users.get(input.userId);
        if (!user) return null;
        const updated = { ...user, passwordHash: input.passwordHash, updatedAt: input.updatedAt };
        users.set(input.userId, updated);
        return updated;
      },
      async delete(userId) {
        users.delete(userId);
        for (const [key, member] of members.entries()) {
          if (member.userId === userId) {
            members.delete(key);
          }
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
      async listAll() {
        return Array.from(teams.values()).sort((left, right) => left.createdAt - right.createdAt);
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
      async getMember(input) {
        return members.get(`${input.teamId}:${input.userId}`) ?? null;
      },
      async updateMemberRole(input) {
        const key = `${input.teamId}:${input.userId}`;
        const member = members.get(key);
        if (!member) return null;
        const updated = { ...member, role: input.role };
        members.set(key, updated);
        return updated;
      },
      async removeMember(input) {
        members.delete(`${input.teamId}:${input.userId}`);
      },
      async updateOwner(input) {
        const team = teams.get(input.teamId);
        if (!team) return null;
        const updated = { ...team, ownerId: input.ownerId };
        teams.set(input.teamId, updated);
        return updated;
      },
      async listAllMembers(teamId) {
        return Array.from(members.values())
          .filter((m) => m.teamId === teamId)
          .map((m) => ({
            id: `${m.teamId}:${m.userId}`,
            teamId: m.teamId,
            userId: m.userId,
            username: m.username,
            role: m.role,
            joinedAt: m.joinedAt,
          }));
      },
      async update(input) {
        const team = teams.get(input.teamId);
        if (!team) return null;
        const updated = {
          ...team,
          ...(input.name !== undefined && { name: input.name }),
          ...(input.path !== undefined && { path: input.path }),
          ...(input.description !== undefined && { description: input.description }),
        };
        teams.set(input.teamId, updated);
        return updated;
      },
      async delete(teamId) {
        // Cascade: remove all members of this team
        for (const [key, member] of members.entries()) {
          if (member.teamId === teamId) {
            members.delete(key);
          }
        }
        // Remove associated channels
        for (const [key, channel] of channels.entries()) {
          if (channel.teamId === teamId) {
            channels.delete(key);
          }
        }
        // Remove associated agents
        for (const [key, agent] of agents.entries()) {
          if (agent.primaryTeamId === teamId) {
            agents.delete(key);
          }
        }
        teams.delete(teamId);
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
      async listByTeam(teamId) {
        return Array.from(joinLinks.values())
          .filter((link) => link.teamId === teamId)
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async revoke(input) {
        const link = joinLinks.get(input.code);
        if (!link || link.teamId !== input.teamId || link.revokedAt !== undefined) {
          return null;
        }
        const updated = { ...link, revokedAt: input.revokedAt };
        joinLinks.set(input.code, updated);
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
          serverUrl: input.serverUrl ?? invite.serverUrl,
        };
        deviceInvites.set(input.code, updated);
        return updated;
      },
      async complete(input) {
        const invite = deviceInvites.get(input.code);
        if (!invite || invite.completedAt !== undefined) {
          return null;
        }
        const updated = { ...invite, completedAt: input.completedAt, serverUrl: input.serverUrl ?? invite.serverUrl };
        deviceInvites.set(input.code, updated);
        return updated;
      },
    },
    teamPiPolicy: {
      async get(teamId) {
        return teamPiPolicies.get(teamId) ?? null;
      },
      async getOrDefault(teamId) {
        return teamPiPolicies.get(teamId) ?? {
          teamId,
          autoCoordinationEnabled: true,
          updatedBy: 'system',
          updatedAt: 0,
        };
      },
      async setAutoCoordination(input) {
        const record: TeamPiPolicyRecord = {
          teamId: input.teamId,
          autoCoordinationEnabled: input.enabled,
          updatedBy: input.actorId,
          updatedAt: input.now,
        };
        teamPiPolicies.set(input.teamId, record);
        return record;
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
      async getDefaultChannel(teamId) {
        return (
          Array.from(channels.values()).find(
            (channel) =>
              channel.teamId === teamId &&
              channel.kind === 'channel' &&
              channel.name === DEFAULT_CHANNEL_NAME &&
              !channel.archivedAt,
          ) ?? null
        );
      },
      async getDirectByAgent(input) {
        return Array.from(channels.values()).find((channel) =>
          channel.teamId === input.teamId &&
          channel.kind === 'direct' &&
          channel.humanMemberIds.includes(input.userId) &&
          (channel.dmTargetAgentId === input.agentId || channel.agentMemberIds.includes(input.agentId))
        ) ?? null;
      },
      async listByTeam(teamId) {
        return Array.from(channels.values()).filter((channel) =>
          channel.teamId === teamId &&
          channel.kind === 'channel' &&
          !channel.archivedAt
        );
      },
      async listForUser(teamId, userId) {
        return Array.from(channels.values()).filter((channel) => {
          if (channel.teamId !== teamId) {
            return false;
          }
          if (channel.kind === 'direct') {
            return false;
          }
          if (channel.archivedAt) {
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
      async addDefaultChannelMembers(input) {
        const channel = await this.getDefaultChannel(input.teamId);
        if (!channel) {
          return null;
        }
        const humanMemberIds = uniqueStrings([
          ...channel.humanMemberIds,
          ...(input.humanMemberIds ?? []),
        ]);
        const agentMemberIds = uniqueStrings([
          ...channel.agentMemberIds,
          ...(input.agentMemberIds ?? []),
        ]);
        const updated = {
          ...channel,
          humanMemberIds,
          agentMemberIds,
          updatedAt: input.timestamp,
        };
        channels.set(channel.id, updated);
        return updated;
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
      async removeHumanFromTeamChannels(input) {
        for (const channel of channels.values()) {
          if (channel.teamId !== input.teamId || !channel.humanMemberIds.includes(input.userId)) {
            continue;
          }
          channels.set(channel.id, {
            ...channel,
            humanMemberIds: channel.humanMemberIds.filter((userId) => userId !== input.userId),
            updatedAt: input.timestamp,
          });
        }
      },
      async archive(input) {
        const channel = channels.get(input.channelId);
        if (!channel) {
          return null;
        }
        const archived = { ...channel, archivedAt: input.timestamp };
        channels.set(input.channelId, archived);
        return archived;
      },
      async delete(input) {
        const channel = channels.get(input.channelId);
        if (!channel) {
          return null;
        }
        channels.delete(input.channelId);
        return channel;
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
      async findByMachineProfile(input) {
        return (
          Array.from(devices.values()).find(
            (device) =>
              device.teamId === input.teamId &&
              device.machineId === input.machineId &&
              device.profileId === input.profileId,
          ) ?? null
        );
      },
      async findCanonicalByDisplay(input) {
        const norm = (value?: string | null) => (value ?? '').trim().toLowerCase();
        return (
          Array.from(devices.values())
            .map((device) => {
              if (
                device.teamId !== input.teamId ||
                device.ownerId !== input.ownerId ||
                norm(device.hostname ?? device.name ?? device.systemInfo?.hostname) !== norm(input.name) ||
                norm(device.hostname ?? device.name ?? device.systemInfo?.hostname) === ''
              ) {
                return null;
              }
              const canonical = device.canonicalDeviceId ? devices.get(device.canonicalDeviceId) : device;
              return canonical?.teamId === device.teamId && canonical.ownerId === device.ownerId ? canonical : null;
            })
            .filter(
              (device): device is NonNullable<typeof device> => device !== null,
            )
            .sort(
              (a, b) =>
                (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
                (a.id > b.id ? -1 : a.id < b.id ? 1 : 0),
            )[0] ?? null
        );
      },
      async listByTeam(teamId) {
        return Array.from(devices.values()).filter((device) => device.teamId === teamId);
      },
      async listAll() {
        return Array.from(devices.values()).sort((left, right) => left.createdAt - right.createdAt);
      },
      async listConnected() {
        return Array.from(devices.values()).filter((device) => device.status !== 'offline');
      },
      async markOffline(input) {
        const device = devices.get(input.deviceId);
        if (!device) {
          return null;
        }
        const updated: DeviceRecord = {
          ...device,
          status: 'offline',
          lastSeenAt: device.lastSeenAt ?? input.timestamp,
          updatedAt: input.timestamp,
        };
        devices.set(device.id, updated);
        return updated;
      },
      async updateName(input) {
        const device = devices.get(input.deviceId);
        if (!device) {
          return null;
        }
        const updated: DeviceRecord = {
          ...device,
          name: input.name,
          nameSource: 'user',
          updatedAt: input.updatedAt,
        };
        devices.set(device.id, updated);
        return updated;
      },
      async transferOwner(input) {
        const device = devices.get(input.deviceId);
        if (!device) {
          return null;
        }
        const updated = {
          ...device,
          ownerId: input.ownerId,
          updatedAt: input.updatedAt,
        };
        devices.set(device.id, updated);
        return updated;
      },
      async delete(input) {
        for (const runtime of Array.from(runtimes.values())) {
          if (runtime.deviceId === input.deviceId) runtimes.delete(runtime.id);
        }
        for (const agent of Array.from(agents.values())) {
          if (agent.deviceId === input.deviceId && agent.deletedAt === undefined) {
            agents.set(agent.id, {
              ...agent,
              visibleTeamIds: [],
              status: 'offline',
              deletedAt: input.timestamp,
              lastSeenAt: input.timestamp,
            });
            agentEnv.delete(agent.id);
          }
        }
        devices.delete(input.deviceId);
      },
    },
    revocations: {
      async find({ teamId, machineId, profileId }) {
        return deviceRevocations.get(revocationKey(teamId, machineId, profileId)) ?? null;
      },
      async upsertAll({ revocations }) {
        for (const r of revocations) {
          deviceRevocations.set(revocationKey(r.teamId, r.machineId, r.profileId ?? null), r);
        }
      },
      async clear({ teamId, machineId }) {
        for (const key of Array.from(deviceRevocations.keys())) {
          const r = deviceRevocations.get(key)!;
          if (r.teamId === teamId && r.machineId === machineId) {
            deviceRevocations.delete(key);
          }
        }
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
        const existing = agents.get(input.id);
        if (existing) {
          // 可见性是独立状态（由 setPrimaryTeamVisibility 控制），upsert（daemon 上报、
          // 配置更新）不应重置它。对齐 sqlite：sqlite 用 hidden_from_primary_team 列
          // 独立于 upsert 控制，memory 这里保留 existing.visibleTeamIds，避免 daemon
          // 周期上报把已 hidden agent 的可见性重置回 [primary]（导致成员页重现）。
          agent.visibleTeamIds = existing.visibleTeamIds;
          // 用户自定义名受保护：name_source='custom' 时不被扫描报告名覆盖
          // （对齐 sqlite agents.upsert ON CONFLICT 的 CASE WHEN name_source='custom' 分支）。
          if (existing.nameSource === 'custom') {
            agent.name = existing.name;
          }
          agent.nameSource = existing.nameSource;
        } else {
          agent.nameSource = agent.nameSource ?? 'scanned';
        }
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
      async setPrimaryTeamVisibility(input) {
        const agent = agents.get(input.agentId);
        // 与同级方法（updateConfig/softDelete/getExecutionConfig）一致：软删 agent 不再可改可见性，
        // 否则会把已软删的 agent "复活" 进 visibleTeamIds。
        if (!agent || agent.deletedAt !== undefined) {
          return null;
        }
        // visible=true：确保 primary 在 visibleTeamIds 中；visible=false：把 primary 移出。
        const updated = input.visible
          ? { ...agent, visibleTeamIds: Array.from(new Set([agent.primaryTeamId, ...agent.visibleTeamIds])) }
          : { ...agent, visibleTeamIds: agent.visibleTeamIds.filter((t) => t !== agent.primaryTeamId) };
        agents.set(input.agentId, updated);
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
          // 用户改名后标记 'custom'，扫描 upsert 据此保护名（对齐 sqlite name_source）。
          nameSource: changes.name !== undefined && changes.name !== agent.name
            ? 'custom'
            : (agent.nameSource ?? 'scanned'),
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
      async updateSkills(input) {
        const agent = agents.get(input.agentId);
        if (!agent) {
          return null;
        }
        const updated = { ...agent, skills: input.skills };
        agents.set(input.agentId, updated);
        return updated;
      },
      async listVisibleInTeam(teamId) {
        return Array.from(agents.values()).filter(
          (agent) =>
            agent.deletedAt === undefined &&
            agent.visibleTeamIds.includes(teamId) &&
            // 兜底过滤：执行器类 runtime agent（非 custom）不作为团队成员呈现
            !(agent.category === 'executor-hosted' && agent.source !== 'custom'),
        );
      },
      async listByDevice(deviceId) {
        return Array.from(agents.values()).filter(
          (agent) => agent.deviceId === deviceId && agent.deletedAt === undefined,
        );
      },
      async listAll() {
        return Array.from(agents.values()).filter((agent) => agent.deletedAt === undefined);
      },
      async updateOwnerByDevice(input) {
        const updated: AgentRecord[] = [];
        for (const agent of agents.values()) {
          if (agent.deviceId !== input.deviceId || agent.deletedAt !== undefined) {
            continue;
          }
          const next = {
            ...agent,
            ownerId: input.ownerId,
            lastSeenAt: agent.lastSeenAt ?? input.timestamp,
          };
          agents.set(agent.id, next);
          updated.push(next);
        }
        return updated;
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
      async updateMeta(input) {
        const message = messages.get(input.messageId);
        if (!message) {
          return null;
        }
        const updated = { ...message, meta: input.meta };
        messages.set(input.messageId, updated);
        return updated;
      },
      async edit(input) {
        const message = messages.get(input.messageId);
        if (!message) {
          return null;
        }
        const updated = { ...message, body: input.body, meta: input.meta };
        messages.set(input.messageId, updated);
        return updated;
      },
      async softDelete(input) {
        const message = messages.get(input.messageId);
        if (!message) {
          return null;
        }
        const updated = { ...message, body: input.body, meta: input.meta };
        messages.set(input.messageId, updated);
        return updated;
      },
      async setTaskIdIfAbsent(input) {
        const message = messages.get(input.messageId);
        if (!message) {
          return null;
        }
        const existingTaskId = typeof message.meta?.taskId === 'string' ? message.meta.taskId : null;
        if (existingTaskId) {
          return { message, taskId: existingTaskId, inserted: false };
        }
        const updated = {
          ...message,
          meta: {
            ...(message.meta ?? {}),
            taskId: input.taskId,
          },
        };
        messages.set(input.messageId, updated);
        return { message: updated, taskId: input.taskId, inserted: true };
      },
      async listByChannel(channelId, limit) {
        return Array.from(messages.values())
          .filter((message) => message.channelId === channelId)
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-limit);
      },
      async listByThread(input) {
        return Array.from(messages.values())
          .filter((message) =>
            message.channelId === input.channelId &&
            (message.id === input.threadId || message.threadId === input.threadId)
          )
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(-input.limit);
      },
      async search(input) {
        const channelIds = new Set(input.channelIds);
        const pool = Array.from(messages.values()).filter((message) => channelIds.has(message.channelId));
        return rankMessageSearch(pool, input.query, input.limit);
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
      async deleteByChannel(channelId) {
        for (const [id, message] of messages) {
          if (message.channelId === channelId) {
            messages.delete(id);
          }
        }
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
      async touchPending(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (dispatch.status !== 'queued' && dispatch.status !== 'sent') {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          updatedAt: Math.max(input.updatedAt, dispatch.updatedAt + 1),
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async markAccepted(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (
          dispatch.agentId !== input.agentId ||
          (dispatch.status !== 'queued' && dispatch.status !== 'sent') ||
          dispatch.updatedAt !== input.expectedUpdatedAt
        ) {
          return { dispatch, changed: false };
        }
        const updated = {
          ...dispatch,
          status: 'accepted' as const,
          prompt: input.prompt,
          updatedAt: input.acceptedAt,
          acceptedAt: input.acceptedAt,
        };
        dispatches.set(input.dispatchId, updated);
        return { dispatch: updated, changed: true };
      },
      async markSucceeded(input) {
        const dispatch = dispatches.get(input.dispatchId);
        if (!dispatch) {
          return null;
        }
        if (!isCompletableDispatchStatus(dispatch.status)) {
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
        if (!isCompletableDispatchStatus(dispatch.status)) {
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
      async listByTeam(teamId) {
        return Array.from(dispatches.values()).filter((dispatch) => dispatch.teamId === teamId);
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
      async listByWorkspaceRunForChannel(input) {
        return Array.from(artifacts.values()).filter((artifact) =>
          artifact.workspaceRunId === input.runId
          && artifact.teamId === input.teamId
          && artifact.channelId === input.channelId);
      },
      async deleteByChannel(channelId) {
        const deletedIds: string[] = [];
        for (const [id, artifact] of artifacts) {
          if (artifact.channelId === channelId) {
            deletedIds.push(id);
            artifacts.delete(id);
          }
        }
        return deletedIds.sort();
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
      async listByTeam(input) {
        return Array.from(workspaceRuns.values())
          .filter((run) => {
            if (run.teamId !== input.teamId) return false;
            if (input.agentId !== undefined && run.agentId !== input.agentId) return false;
            if (input.deviceId !== undefined && run.deviceId !== input.deviceId) return false;
            if (input.status !== undefined && run.status !== input.status) return false;
            if (input.cursor !== undefined) {
              if (run.updatedAt > input.cursor.updatedAt) return false;
              if (run.updatedAt === input.cursor.updatedAt && run.id >= input.cursor.id) return false;
            }
            return true;
          })
          .sort((a, b) => {
            if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
            if (a.id > b.id) return -1;
            if (a.id < b.id) return 1;
            return 0;
          })
          .slice(0, input.limit);
      },
      async listByAgent(input) {
        return Array.from(workspaceRuns.values())
          .filter((run) => run.teamId === input.teamId && run.agentId === input.agentId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, input.limit);
      },
      async listByDispatch(dispatchId) {
        return Array.from(workspaceRuns.values()).filter((run) => run.dispatchId === dispatchId);
      },
    },
    tasks: {
      async create(input) {
        const task = { ...input, revision: input.revision ?? 1 };
        tasks.set(input.id, task);
        return task;
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
      async updateAtRevision(input) {
        const task = tasks.get(input.taskId);
        if (!task || task.revision !== input.expectedRevision) {
          return null;
        }
        const updated = { ...task, ...input.changes, revision: input.nextRevision };
        tasks.set(input.taskId, updated);
        return updated;
      },
      async delete(input) {
        const task = tasks.get(input.taskId);
        if (!task) {
          return null;
        }
        tasks.delete(input.taskId);
        return task;
      },
    },
    reactions: {
      async toggle(input) {
        const key = `${input.messageId}:${input.userId}:${input.emoji}`;
        if (input.on) {
          reactions.set(key, { id: input.id, messageId: input.messageId, userId: input.userId, emoji: input.emoji, createdAt: input.createdAt });
        } else {
          reactions.delete(key);
        }
      },
      async countByMessage(messageId) {
        const counts: Record<string, number> = {};
        for (const r of reactions.values()) {
          if (r.messageId === messageId) {
            counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
          }
        }
        return counts;
      },
      async getUserReaction(messageId, userId) {
        for (const r of reactions.values()) {
          if (r.messageId === messageId && r.userId === userId) {
            return r.emoji;
          }
        }
        return null;
      },
    },
    savedMessages: {
      async toggle(input) {
        const key = `${input.messageId}:${input.userId}`;
        if (input.on) {
          savedMessages.set(key, { id: input.id, messageId: input.messageId, userId: input.userId, teamId: input.teamId, channelId: input.channelId, createdAt: input.createdAt });
        } else {
          savedMessages.delete(key);
        }
      },
      async listByUser(input) {
        return Array.from(savedMessages.values())
          .filter((s) => s.userId === input.userId && s.teamId === input.teamId)
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async isSaved(messageId, userId) {
        return savedMessages.has(`${messageId}:${userId}`);
      },
    },
    pinnedMessages: {
      async toggle(input) {
        if (input.on) {
          pinnedMessages.set(input.messageId, {
            id: input.id,
            messageId: input.messageId,
            userId: input.userId,
            teamId: input.teamId,
            channelId: input.channelId,
            createdAt: input.createdAt,
          });
        } else {
          pinnedMessages.delete(input.messageId);
        }
      },
      async listByChannel(input) {
        return Array.from(pinnedMessages.values())
          .filter((s) => s.teamId === input.teamId && s.channelId === input.channelId)
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async isPinned(messageId) {
        return pinnedMessages.has(messageId);
      },
    },
  };
  return repositories;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isPendingDispatchStatus(status: DispatchRecord['status']): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}

function isCompletableDispatchStatus(status: DispatchRecord['status']): boolean {
  return isPendingDispatchStatus(status) || status === 'timed_out';
}
