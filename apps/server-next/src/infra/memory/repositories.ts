import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AgentRecord,
  ArtifactRecord,
  ChannelDocumentRecord,
  ChannelDocumentOperationRecord,
  ChannelDocumentRevisionRecord,
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
  ProjectChannelWorkspaceRecord,
  ProjectChannelWorkspaceRevisionRecord,
  PublishWorkspaceRevisionOutcome,
  WorkspacePublishStagingRecord,
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
import { createMemoryExperiencePackRepositories } from './experience-pack-repositories.js';
import { createInMemorySystemUserMemoryRepositories } from './system-user-memory-repositories.js';
import { createInMemoryAgentExposurePersistence } from './agent-exposure-repositories.js';
import { createInMemoryAgentMemoryProjectionPersistence } from './agent-memory-projection-repositories.js';
import {
  createChannelCoordinationUnitOfWork,
  type ChannelCoordinationRepositories,
} from '../../application/channel-coordination-unit-of-work.js';
import type { ChannelCoordinationDecisionRecord, ChannelCoordinationJobRecord } from '../../../../../packages/contracts/src/index.js';
import {
  cloneMessageTracerMemoryState,
  createInMemoryMessageTracerRepositories,
  createMessageTracerMemoryState,
  restoreMessageTracerMemoryState,
} from './message-tracer-repositories.js';
import {
  clonePromotionGateMemoryState,
  createInMemoryPromotionGateRepositories,
  createPromotionGateMemoryState,
  restorePromotionGateMemoryState,
} from './promotion-gate-repositories.js';
import { createMemoryTaskLifecycleRepositories } from './task-lifecycle-repositories.js';
import {
  createInMemorySystemActivityRepositories,
  createSystemActivityMemoryState,
} from './system-activity-repositories.js';
import { createMemorySystemActivityUnitOfWork } from '../../application/system-activity-unit-of-work.js';
import {
  cloneSystemActivityMemoryState,
  restoreSystemActivityMemoryState,
} from './system-activity-repositories.js';
import type {
  ChannelProjectMutationRecord,
  ChannelProjectProfileRecord,
  ProjectArtifactCollectionRecord,
  ProjectArtifactDecisionMutationRecord,
  ProjectArtifactFinalizationRecord,
  ProjectArtifactMutationRecord,
  ProjectArtifactReviewRecord,
  ProjectArtifactVersionRecord,
  ProjectDocumentBundleBackfillCandidateRunRecord,
  ProjectDocumentBundleBackfillOutcomeRecord,
  ProjectDocumentBundleBackfillProgressRecord,
  ProjectDocumentBundleMemberRecord,
  ProjectDocumentBundleMutationRecord,
  ProjectDocumentBundleRecord,
  ProjectDocumentInputSetItemResultRecord,
  ProjectReferenceItemRecord,
  ProjectReferenceSelectionRecord,
  ProjectReferenceSetMutationRecord,
  ProjectReferenceSetRecord,
  ProjectStageEdgeRecord,
  ProjectStageRecord,
} from '../../application/project-repositories.js';

export function createInMemoryRepositories(): ServerNextRepositories {
  const management = createInMemoryManagementPersistence();
  const taskCoordinationState = createTaskCoordinationMemoryState();
  const taskCoordination = createInMemoryTaskCoordinationRepositories(taskCoordinationState);
  const memoryState = createMemoryRepositoryMemoryState();
  const memory = createInMemoryMemoryRepositories(memoryState);
  const piProvider = createInMemoryPiProviderPersistence();
  const systemUserMemory = createInMemorySystemUserMemoryRepositories();
  const agentExposure = createInMemoryAgentExposurePersistence();
  const agentMemoryProjection = createInMemoryAgentMemoryProjectionPersistence();
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
  const channelDocuments = new Map<string, ChannelDocumentRecord>();
  const channelDocumentRevisions = new Map<string, ChannelDocumentRevisionRecord>();
  const channelDocumentOperations = new Map<string, ChannelDocumentOperationRecord>();
  const workspaceRuns = new Map<string, WorkspaceRunRecord>();
  const projectChannelWorkspaces = new Map<string, ProjectChannelWorkspaceRecord>();
  const projectChannelWorkspaceRevisions = new Map<string, ProjectChannelWorkspaceRevisionRecord>();
  const workspacePublishStagings = new Map<string, WorkspacePublishStagingRecord>();
  const tasks = new Map<string, TaskRecord>();
  const channelProjectProfiles = new Map<string, ChannelProjectProfileRecord>();
  const projectStages = new Map<string, ProjectStageRecord>();
  const projectStageEdges = new Map<string, ProjectStageEdgeRecord>();
  const channelProjectMutations = new Map<string, ChannelProjectMutationRecord>();
  const projectArtifactCollections = new Map<string, ProjectArtifactCollectionRecord>();
  const projectArtifactVersions = new Map<string, ProjectArtifactVersionRecord>();
  const projectArtifactMutations = new Map<string, ProjectArtifactMutationRecord>();
  const projectArtifactReviews = new Map<string, ProjectArtifactReviewRecord>();
  const projectArtifactFinalizations = new Map<string, ProjectArtifactFinalizationRecord>();
  const projectArtifactDecisionMutations = new Map<string, ProjectArtifactDecisionMutationRecord>();
  const projectDocumentBundles = new Map<string, ProjectDocumentBundleRecord>();
  const projectDocumentBundleMembers = new Map<string, ProjectDocumentBundleMemberRecord[]>();
  const projectDocumentBundleMutations = new Map<string, ProjectDocumentBundleMutationRecord>();
  const projectReferenceSets = new Map<string, ProjectReferenceSetRecord>();
  const projectReferenceSelections = new Map<string, ProjectReferenceSelectionRecord>();
  const projectReferenceItems = new Map<string, ProjectReferenceItemRecord>();
  const projectReferenceSetMutations = new Map<string, ProjectReferenceSetMutationRecord>();
  const projectDocumentInputSetResults = new Map<string, ProjectDocumentInputSetItemResultRecord>();
  const projectDocumentBundleBackfillProgress
    = new Map<string, ProjectDocumentBundleBackfillProgressRecord>();
  const projectDocumentBundleBackfillOutcomes
    = new Map<string, ProjectDocumentBundleBackfillOutcomeRecord>();
  const reactions = new Map<string, { id: string; messageId: string; userId: string; emoji: string; createdAt: number }>();
  const savedMessages = new Map<string, { id: string; messageId: string; userId: string; teamId: string; channelId: string; createdAt: number }>();
  const pinnedMessages = new Map<string, { id: string; messageId: string; userId: string; teamId: string; channelId: string; createdAt: number }>();
  // #921 Message tracer 内存投影。
  const messageTracerState = createMessageTracerMemoryState();
  const messageTracer = createInMemoryMessageTracerRepositories(messageTracerState);
  // #922 Promotion gate 内存投影。
  const promotionState = createPromotionGateMemoryState();
  const promotion = createInMemoryPromotionGateRepositories(promotionState);
  const lifecycle = createMemoryTaskLifecycleRepositories();
  const systemActivityState = createSystemActivityMemoryState();
  const systemActivity = createInMemorySystemActivityRepositories(systemActivityState);
  const systemActivityUnitOfWork = createMemorySystemActivityUnitOfWork({
    repos: systemActivity,
    snapshot: () => cloneSystemActivityMemoryState(systemActivityState),
    restore: (snap) => restoreSystemActivityMemoryState(
      systemActivityState,
      snap as ReturnType<typeof createSystemActivityMemoryState>,
    ),
  });
  // #930 Team PI authority migration（legacy write fence）。
  const teamPiAuthorityMigrations = new Map<string, import('../../application/pi-authority-cutover-repositories.js').TeamPiAuthorityMigrationRecord>();

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
      async listOpenByTeam(teamId) {
        return Array.from(channelCoordinationJobs.values())
          .filter((job) =>
            job.teamId === teamId
            && (job.status === 'pending' || job.status === 'retry_wait' || job.status === 'running'))
          .sort((left, right) => left.createdAt - right.createdAt);
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
      async markSupersededByLinkedTask(input) {
        const candidates = Array.from(channelCoordinationDecisions.values())
          .filter((decision) =>
            decision.linkedTaskId === input.taskId
            && decision.outcome === 'resolved'
            && decision.supersededByDecisionId === null)
          .sort((left, right) => right.createdAt - left.createdAt);
        const prior = candidates[0];
        if (!prior) return null;
        const updated = { ...prior, supersededByDecisionId: input.byDecisionId, updatedAt: input.now };
        channelCoordinationDecisions.set(prior.id, updated);
        return updated;
      },

      async aggregateUsage(since) {
        let totalInput = 0;
        let totalOutput = 0;
        let count = 0;
        for (const d of channelCoordinationDecisions.values()) {
          if (since !== undefined && d.createdAt < since) continue;
          if (d.usage.inputTokens != null) totalInput += d.usage.inputTokens;
          if (d.usage.outputTokens != null) totalOutput += d.usage.outputTokens;
          count++;
        }
        return { totalInputTokens: totalInput, totalOutputTokens: totalOutput, totalDecisions: count };
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
    systemKnowledge: systemUserMemory.systemKnowledge,
    userMemory: systemUserMemory.userMemory,
    agentExposure: agentExposure.repositories,
    agentExposureUnitOfWork: agentExposure.unitOfWork,
    agentMemoryProjection: agentMemoryProjection.repositories,
    agentMemoryProjectionUnitOfWork: agentMemoryProjection.unitOfWork,
    channelCoordination,
    channelCoordinationUnitOfWork: createChannelCoordinationUnitOfWork((operation) =>
      management.unitOfWork.run(async () => {
        const messageSnapshot = new Map(messages);
        const artifactSnapshot = new Map(artifacts);
        const jobSnapshot = new Map(channelCoordinationJobs);
        const decisionSnapshot = new Map(channelCoordinationDecisions);
        const taskSnapshot = new Map(tasks);
        const referenceSetSnapshot = new Map(projectReferenceSets);
        const referenceSelectionSnapshot = new Map(projectReferenceSelections);
        const referenceItemSnapshot = new Map(projectReferenceItems);
        const referenceMutationSnapshot = new Map(projectReferenceSetMutations);
        const messageTracerSnapshot = cloneMessageTracerMemoryState(messageTracerState);
        try {
          return await operation({
            messages: repositories.messages,
            artifacts: repositories.artifacts,
            jobs: channelCoordination.jobs,
            decisions: channelCoordination.decisions,
            tasks: repositories.tasks,
            channels: repositories.channels,
            projectReferenceSets: repositories.projectReferenceSets,
            inbox: messageTracer.inbox,
            commandReceipts: messageTracer.commandReceipts,
            outbox: messageTracer.outbox,
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
          restoreMap(projectReferenceSets, referenceSetSnapshot);
          restoreMap(projectReferenceSelections, referenceSelectionSnapshot);
          restoreMap(projectReferenceItems, referenceItemSnapshot);
          restoreMap(projectReferenceSetMutations, referenceMutationSnapshot);
          restoreMessageTracerMemoryState(messageTracerState, messageTracerSnapshot);
          throw error;
        }
      })),
    taskCoordination,
    taskCoordinationUnitOfWork: createTaskCoordinationUnitOfWork((operation) =>
      management.unitOfWork.run(async (managementRepositories) => {
        const taskSnapshot = new Map(tasks);
        const taskCoordinationDispatchSnapshot = new Map(dispatches);
        const coordinationSnapshot = cloneTaskCoordinationMemoryState(taskCoordinationState);
        const promotionSnapshot = clonePromotionGateMemoryState(promotionState);
        try {
          return await operation({
            tasks: repositories.tasks,
            messages: repositories.messages,
            artifacts: repositories.artifacts,
            workspaceRuns: repositories.workspaceRuns,
            dispatches: repositories.dispatches,
            coordination: taskCoordination,
            management: managementRepositories,
            channels: repositories.channels,
            promotion,
            lifecycle,
          });
        } catch (error) {
          tasks.clear();
          for (const [id, task] of taskSnapshot) tasks.set(id, task);
          dispatches.clear();
          for (const [id, dispatch] of taskCoordinationDispatchSnapshot) dispatches.set(id, dispatch);
          restoreTaskCoordinationMemoryState(taskCoordinationState, coordinationSnapshot);
          restorePromotionGateMemoryState(promotionState, promotionSnapshot);
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
      async updateProfile(input) {
        const user = users.get(input.userId);
        if (!user) return { ok: false as const, error: 'NOT_FOUND' as const };
        const demotingAdmin = input.role === 'user' && user.role === 'admin';
        if (demotingAdmin) {
          const adminCount = Array.from(users.values()).filter((entry) => entry.role === 'admin').length;
          if (adminCount <= 1) {
            return { ok: false as const, error: 'LAST_ADMIN' as const };
          }
        }
        const nextEmail =
          input.email !== undefined
            ? (input.email === null || input.email === '' ? null : input.email)
            : undefined;
        if (nextEmail) {
          const emailTaken = Array.from(users.values()).some(
            (entry) => entry.id !== input.userId && entry.email === nextEmail,
          );
          if (emailTaken) {
            return { ok: false as const, error: 'EMAIL_CONFLICT' as const };
          }
        }
        const updated = {
          ...user,
          updatedAt: input.updatedAt,
          ...(input.displayName !== undefined
            ? { displayName: input.displayName === null || input.displayName === '' ? undefined : input.displayName }
            : {}),
          ...(input.email !== undefined
            ? { email: nextEmail ?? null }
            : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
        };
        users.set(input.userId, updated);
        return { ok: true as const, user: updated };
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
        // 与 SQLite 的 channels ON DELETE CASCADE 对齐，避免两套仓储语义分叉。
        for (const [bundleId, bundle] of projectDocumentBundles) {
          if (bundle.channelId !== input.channelId) continue;
          projectDocumentBundles.delete(bundleId);
          projectDocumentBundleMembers.delete(bundleId);
        }
        for (const [mutationKey, mutation] of projectDocumentBundleMutations) {
          if (mutation.channelId === input.channelId) projectDocumentBundleMutations.delete(mutationKey);
        }
        const removedSetIds = new Set<string>();
        for (const [setId, set] of projectReferenceSets) {
          if (set.channelId !== input.channelId) continue;
          removedSetIds.add(setId);
          projectReferenceSets.delete(setId);
        }
        const removedSelectionIds = new Set<string>();
        for (const [selectionId, selection] of projectReferenceSelections) {
          if (!removedSetIds.has(selection.referenceSetId)) continue;
          removedSelectionIds.add(selectionId);
          projectReferenceSelections.delete(selectionId);
        }
        for (const [itemId, item] of projectReferenceItems) {
          if (removedSelectionIds.has(item.selectionId)) projectReferenceItems.delete(itemId);
        }
        for (const [mutationKey, mutation] of projectReferenceSetMutations) {
          if (mutation.channelId === input.channelId) projectReferenceSetMutations.delete(mutationKey);
        }
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
          // 用户手工填写 description 受保护：description_source='manual' 时不被扫描描述覆盖
          // （对齐 sqlite agents.upsert ON CONFLICT 的 CASE WHEN description_source='manual' 分支）。
          if (existing.descriptionSource === 'manual') {
            agent.description = existing.description;
          }
          agent.descriptionSource = existing.descriptionSource;
          // createdAt is immutable after first insert (matches SQLite ON CONFLICT leaving created_at).
          agent.createdAt = existing.createdAt ?? agent.createdAt ?? agent.lastSeenAt ?? 0;
        } else {
          agent.nameSource = agent.nameSource ?? 'scanned';
          agent.createdAt = agent.createdAt ?? agent.lastSeenAt ?? 0;
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
          // 用户手工编辑 description → 标记 manual（此后扫描不覆盖，对齐 sqlite）。
          descriptionSource: changes.description !== undefined
            ? 'manual'
            : (agent.descriptionSource ?? undefined),
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
      async getByClientMessageId(input) {
        return Array.from(messages.values()).find((message) =>
          message.teamId === input.teamId
          && message.channelId === input.channelId
          && message.meta?.clientMessageId === input.clientMessageId) ?? null;
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
      async listByChannel(input) {
        return Array.from(artifacts.values()).filter((artifact) =>
          artifact.teamId === input.teamId && artifact.channelId === input.channelId)
          .sort((left, right) => right.createdAt - left.createdAt
            || Buffer.compare(Buffer.from(right.id, 'utf8'), Buffer.from(left.id, 'utf8')));
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
      async deleteForTeam(input) {
        const artifact = artifacts.get(input.artifactId);
        if (!artifact || artifact.teamId !== input.teamId) return false;
        artifacts.delete(input.artifactId);
        return true;
      },
    },
    channelDocuments: {
      async create(input) {
        const existing = channelDocuments.get(input.document.id);
        if (existing) return existing;
        channelDocuments.set(input.document.id, input.document);
        channelDocumentRevisions.set(input.revision.id, input.revision);
        return input.document;
      },
      async createDerived(input) {
        if (channelDocuments.has(input.document.id)
          || channelDocumentRevisions.has(input.revision.id)
          || artifacts.has(input.artifact.id)
          || Array.from(channelDocuments.values()).some((document) =>
            document.teamId === input.document.teamId
            && document.channelId === input.document.channelId
            && document.filename.toLocaleLowerCase() === input.document.filename.toLocaleLowerCase())) return null;
        artifacts.set(input.artifact.id, input.artifact);
        channelDocuments.set(input.document.id, input.document);
        channelDocumentRevisions.set(input.revision.id, input.revision);
        return input.document;
      },
      async getForTeam(input) {
        const document = channelDocuments.get(input.documentId);
        return document && document.teamId === input.teamId && document.channelId === input.channelId ? document : null;
      },
      async listByChannel(input) {
        return Array.from(channelDocuments.values())
          .filter((document) => document.teamId === input.teamId && document.channelId === input.channelId)
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
      },
      async listWithCurrentRevisionByChannel(input) {
        return Array.from(channelDocuments.values())
          .filter((document) => document.teamId === input.teamId && document.channelId === input.channelId)
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
          .flatMap((document) => {
            const currentRevision = channelDocumentRevisions.get(document.currentRevisionId);
            return currentRevision ? [{ document, currentRevision }] : [];
          });
      },
      async listRevisions(input) {
        return Array.from(channelDocumentRevisions.values())
          .filter((revision) => revision.documentId === input.documentId)
          .sort((a, b) => b.revision - a.revision);
      },
      async getRevision(input) {
        const revision = channelDocumentRevisions.get(input.revisionId);
        return revision?.documentId === input.documentId ? revision : null;
      },
      async getRevisionByIdempotencyKey(input) {
        const operation = channelDocumentOperations.get(`${input.documentId}:${input.idempotencyKey}`);
        if (!operation) return null;
        const revision = channelDocumentRevisions.get(operation.revisionId);
        const current = channelDocuments.get(input.documentId);
        if (!revision || !current) return null;
        return {
          document: {
            ...current,
            filename: revision.artifact.filename,
            currentRevisionId: revision.id,
            updatedAt: revision.createdAt,
          },
          revision,
          operation,
          replayed: true,
        };
      },
      async addRevision(input) {
        const operationKey = `${input.documentId}:${input.operation.idempotencyKey}`;
        const existingOperation = channelDocumentOperations.get(operationKey);
        if (existingOperation) {
          const existingRevision = channelDocumentRevisions.get(existingOperation.revisionId);
          const existingDocument = channelDocuments.get(input.documentId);
          if (!existingRevision || !existingDocument) return null;
          return {
            document: {
              ...existingDocument,
              filename: existingRevision.artifact.filename,
              currentRevisionId: existingRevision.id,
              updatedAt: existingRevision.createdAt,
            },
            revision: existingRevision,
            operation: existingOperation,
            replayed: true,
          };
        }
        if (input.requireUniqueFilename && Array.from(channelDocuments.values()).some((document) =>
          document.id !== input.document.id
          && document.teamId === input.document.teamId
          && document.channelId === input.document.channelId
          && document.filename.toLocaleLowerCase() === input.document.filename.toLocaleLowerCase())) return null;
        const current = channelDocuments.get(input.documentId);
        if (!current || current.currentRevisionId !== input.expectedCurrentRevisionId) return null;
        artifacts.set(input.artifact.id, input.artifact);
        channelDocuments.set(input.documentId, input.document);
        channelDocumentRevisions.set(input.revision.id, input.revision);
        channelDocumentOperations.set(operationKey, input.operation);
        if (input.message) messages.set(input.message.id, input.message);
        return {
          document: input.document,
          revision: input.revision,
          operation: input.operation,
          replayed: false,
        };
      },
      async deleteByChannel(channelId) {
        const documentIds = new Set(Array.from(channelDocuments.values())
          .filter((document) => document.channelId === channelId)
          .map((document) => document.id));
        for (const documentId of documentIds) channelDocuments.delete(documentId);
        for (const [revisionId, revision] of channelDocumentRevisions) {
          if (documentIds.has(revision.documentId)) channelDocumentRevisions.delete(revisionId);
        }
        for (const [operationKey, operation] of channelDocumentOperations) {
          if (documentIds.has(operation.documentId)) channelDocumentOperations.delete(operationKey);
        }
        for (const [key, result] of projectDocumentInputSetResults) {
          if (documentIds.has(result.documentId)) projectDocumentInputSetResults.delete(key);
        }
        // 与 SQLite 的 ON DELETE CASCADE 对齐：Bundle 是文档的只读投影，
        // 文档消失时成员行随之消失，绝不反过来阻塞文档删除。
        for (const [bundleId, members] of projectDocumentBundleMembers) {
          const remaining = members.filter((member) => !documentIds.has(member.documentId));
          if (remaining.length === members.length) continue;
          projectDocumentBundleMembers.set(bundleId, remaining);
        }
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
    projectChannelWorkspaces: {
      async createInitial(input) {
        const key = `${input.workspace.teamId}:${input.workspace.channelId}`;
        if (projectChannelWorkspaces.has(key)) return null;
        const revision = structuredClone(input.revision);
        const workspace = structuredClone({ ...input.workspace, currentRevision: revision });
        projectChannelWorkspaceRevisions.set(revision.id, revision);
        projectChannelWorkspaces.set(key, workspace);
        return structuredClone(workspace);
      },
      async publishRevision(input): Promise<PublishWorkspaceRevisionOutcome> {
        const key = `${input.teamId}:${input.channelId}`;
        const workspace = projectChannelWorkspaces.get(key);
        if (!workspace) throw new Error('Project Channel Workspace not found');
        if (workspace.currentRevisionId !== input.baselineRevisionId) {
          return { kind: 'conflict', current: structuredClone(workspace) };
        }
        const nextRevision = workspace.currentRevision.revision + 1;
        const newRevision: ProjectChannelWorkspaceRevisionRecord = {
          id: input.newRevision.id, teamId: input.teamId, channelId: input.channelId,
          revision: nextRevision, files: structuredClone(input.newRevision.files),
          createdBy: input.newRevision.createdBy, createdAt: input.newRevision.createdAt,
          ...(input.newRevision.provenance ? { provenance: structuredClone(input.newRevision.provenance) } : {}),
        };
        projectChannelWorkspaceRevisions.set(newRevision.id, newRevision);
        const updated: ProjectChannelWorkspaceRecord = { ...workspace, currentRevisionId: newRevision.id, currentRevision: newRevision };
        projectChannelWorkspaces.set(key, updated);
        return { kind: 'published', workspace: structuredClone(updated) };
      },
      async getForTeam(input) {
        const workspace = projectChannelWorkspaces.get(`${input.teamId}:${input.channelId}`);
        return workspace ? structuredClone(workspace) : null;
      },
      async getRevision(input) {
        const revision = projectChannelWorkspaceRevisions.get(input.revisionId);
        return revision && revision.teamId === input.teamId && revision.channelId === input.channelId ? structuredClone(revision) : null;
      },
      async listRevisions(input) {
        const revisions = [...projectChannelWorkspaceRevisions.values()].filter(
          (revision) => revision.teamId === input.teamId && revision.channelId === input.channelId,
        );
        revisions.sort((a, b) => b.revision - a.revision);
        return revisions.map((revision) => structuredClone(revision));
      },
      async deleteByChannel(channelId) {
        for (const [id, revision] of projectChannelWorkspaceRevisions) {
          if (revision.channelId === channelId) projectChannelWorkspaceRevisions.delete(id);
        }
        for (const [key, workspace] of projectChannelWorkspaces) {
          if (workspace.channelId === channelId) projectChannelWorkspaces.delete(key);
        }
      },
    },
    workspacePublishStagings: {
      async create(input) {
        const key = `${input.teamId}:${input.publishId}`;
        if (workspacePublishStagings.has(key)) return null;
        const record = cloneWorkspacePublishStaging(input);
        workspacePublishStagings.set(key, record);
        return cloneWorkspacePublishStaging(record);
      },
      async getByPublishId(input) {
        const record = workspacePublishStagings.get(`${input.teamId}:${input.publishId}`);
        return record ? cloneWorkspacePublishStaging(record) : null;
      },
      async update(input) {
        const key = `${input.teamId}:${input.publishId}`;
        const record = cloneWorkspacePublishStaging(input);
        workspacePublishStagings.set(key, record);
        return cloneWorkspacePublishStaging(record);
      },
      async listExpiredOpen(input) {
        return Array.from(workspacePublishStagings.values())
          .filter((row) => row.status !== 'committed' && row.createdAt <= input.olderThan)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, input.limit)
          .map(cloneWorkspacePublishStaging);
      },
      async delete(input) {
        workspacePublishStagings.delete(`${input.teamId}:${input.publishId}`);
      },
    },
    tasks: {
      async create(input) {
        const task: TaskRecord = {
          ...input,
          revision: input.revision ?? 1,
          supersededByRevision: null,
          supersededAt: null,
          supersededReasonCode: null,
        };
        tasks.set(`${task.id}#${task.revision}`, task);
        return task;
      },
      async getById(taskId) {
        return Array.from(tasks.values()).find((t) => t.id === taskId && t.supersededByRevision === null) ?? null;
      },
      async list(input) {
        const channelIds = new Set(input.channelIds);
        return Array.from(tasks.values())
          .filter((task) => task.supersededByRevision === null)
          .filter((task) =>
            task.teamId === input.teamId &&
            ((input.includeGlobal && !task.channelId) || (task.channelId ? channelIds.has(task.channelId) : false)),
          )
          .sort((left, right) => left.sortOrder - right.sortOrder || right.createdAt - left.createdAt);
      },
      async update(input) {
        const task = Array.from(tasks.values()).find((t) => t.id === input.taskId && t.supersededByRevision === null);
        if (!task) {
          return null;
        }
        const updated = { ...task, ...input.changes };
        // #709：append-only 下若 update 误带 revision（非设计路径，但兼容历史/测试调用），
        // 迁移到新 revision key，避免遗留两个 superseded=null 行。生产 revision 变更应走 updateAtRevision。
        if (updated.revision !== task.revision) {
          tasks.delete(`${task.id}#${task.revision}`);
        }
        tasks.set(`${updated.id}#${updated.revision}`, updated);
        return updated;
      },
      async updateAtRevision(input) {
        const task = tasks.get(`${input.taskId}#${input.expectedRevision}`);
        if (!task || task.supersededByRevision !== null) {
          return null;
        }
        const updated: TaskRecord = {
          ...task,
          ...input.changes,
          revision: input.nextRevision,
          supersededByRevision: null,
          supersededAt: null,
          supersededReasonCode: null,
        };
        // #709 append-only：标记旧行 superseded + 写新 revision 行（历史保留, AC4/AC5）；重放幂等。
        tasks.set(`${input.taskId}#${input.expectedRevision}`, {
          ...task,
          supersededByRevision: input.nextRevision,
          supersededAt: updated.updatedAt,
          supersededReasonCode: input.reasonCode ?? null,
        });
        tasks.set(`${updated.id}#${updated.revision}`, updated);
        return updated;
      },
      async delete(input) {
        const task = Array.from(tasks.values()).find((t) => t.id === input.taskId && t.supersededByRevision === null);
        if (!task) {
          return null;
        }
        for (const key of Array.from(tasks.keys())) {
          if (key.startsWith(`${input.taskId}#`)) {
            tasks.delete(key);
          }
        }
        return task;
      },
      async listRevisions(input) {
        return Array.from(tasks.values())
          .filter((task) => task.id === input.taskId && task.teamId === input.teamId)
          .sort((a, b) => a.revision - b.revision);
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
    channelProjects: {
      async getProfile(input) {
        return channelProjectProfiles.get(`${input.teamId}:${input.channelId}`) ?? null;
      },
      async listStages(input) {
        return Array.from(projectStages.values())
          .filter((stage) => stage.teamId === input.teamId && stage.channelId === input.channelId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async getMutation(input) {
        return channelProjectMutations.get(
          `${input.teamId}:${input.channelId}:${input.idempotencyKey}`,
        ) ?? null;
      },
      async createInitialStage(input) {
        const scopeKey = `${input.profile.teamId}:${input.profile.channelId}`;
        const mutationKey = `${scopeKey}:${input.mutation.idempotencyKey}`;
        const existingMutation = channelProjectMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'replayed', mutation: existingMutation };
        }
        const existingProfile = channelProjectProfiles.get(scopeKey);
        const actualRevision = existingProfile?.revision ?? 0;
        if (actualRevision !== input.expectedRevision || existingProfile) {
          return { kind: 'revision_conflict' };
        }
        const currentTask = tasks.get(`${input.stage.taskId}#${input.stage.taskRevision}`);
        if (!currentTask
          || currentTask.supersededByRevision !== null
          || currentTask.teamId !== input.stage.teamId
          || currentTask.channelId !== input.stage.channelId
          || currentTask.revision !== input.stage.taskRevision) {
          return { kind: 'task_scope_conflict' };
        }
        channelProjectProfiles.set(scopeKey, input.profile);
        projectStages.set(input.stage.id, input.stage);
        channelProjectMutations.set(mutationKey, input.mutation);
        return { kind: 'created', mutation: input.mutation };
      },
      async listEdges(input) {
        return Array.from(projectStageEdges.values())
          .filter((edge) => edge.teamId === input.teamId && edge.channelId === input.channelId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async createStage(input) {
        const scopeKey = `${input.stage.teamId}:${input.stage.channelId}`;
        const mutationKey = `${scopeKey}:${input.mutation.idempotencyKey}`;
        const existingMutation = channelProjectMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'replayed', mutation: existingMutation };
        }
        const profile = channelProjectProfiles.get(scopeKey);
        if (!profile || profile.revision !== input.expectedRevision) {
          return { kind: 'revision_conflict' };
        }
        const currentTask = tasks.get(`${input.stage.taskId}#${input.stage.taskRevision}`);
        if (!currentTask
          || currentTask.supersededByRevision !== null
          || currentTask.teamId !== input.stage.teamId
          || currentTask.channelId !== input.stage.channelId
          || currentTask.revision !== input.stage.taskRevision) {
          return { kind: 'task_scope_conflict' };
        }
        const duplicate = Array.from(projectStages.values()).some((stage) =>
          stage.teamId === input.stage.teamId
          && stage.channelId === input.stage.channelId
          && stage.taskId === input.stage.taskId);
        if (duplicate) return { kind: 'duplicate_edge' };
        projectStages.set(input.stage.id, input.stage);
        channelProjectProfiles.set(scopeKey, {
          ...profile,
          revision: input.nextRevision,
          updatedAt: input.updatedAt,
        });
        channelProjectMutations.set(mutationKey, input.mutation);
        return { kind: 'created', mutation: input.mutation };
      },
      async createStageEdge(input) {
        const scopeKey = `${input.edge.teamId}:${input.edge.channelId}`;
        const mutationKey = `${scopeKey}:${input.mutation.idempotencyKey}`;
        const existingMutation = channelProjectMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'replayed', mutation: existingMutation };
        }
        const profile = channelProjectProfiles.get(scopeKey);
        if (!profile || profile.revision !== input.expectedRevision) {
          return { kind: 'revision_conflict' };
        }
        for (const stageId of [input.edge.upstreamStageId, input.edge.downstreamStageId]) {
          const stage = projectStages.get(stageId);
          if (!stage || stage.teamId !== input.edge.teamId || stage.channelId !== input.edge.channelId) {
            return { kind: 'stage_scope_conflict' };
          }
        }
        const taskFences: [string, number][] = [
          [input.edge.upstreamTaskId, input.edge.upstreamTaskRevision],
          [input.edge.downstreamTaskId, input.edge.downstreamTaskRevision],
        ];
        for (const [taskId, taskRevision] of taskFences) {
          const currentTask = tasks.get(`${taskId}#${taskRevision}`);
          if (!currentTask
            || currentTask.supersededByRevision !== null
            || currentTask.teamId !== input.edge.teamId
            || currentTask.channelId !== input.edge.channelId
            || currentTask.revision !== taskRevision) {
            return { kind: 'task_scope_conflict' };
          }
        }
        const duplicate = Array.from(projectStageEdges.values()).some((edge) =>
          edge.teamId === input.edge.teamId
          && edge.channelId === input.edge.channelId
          && edge.upstreamStageId === input.edge.upstreamStageId
          && edge.downstreamStageId === input.edge.downstreamStageId);
        if (duplicate) return { kind: 'duplicate_edge' };
        projectStageEdges.set(input.edge.id, input.edge);
        channelProjectProfiles.set(scopeKey, {
          ...profile,
          revision: input.nextRevision,
          updatedAt: input.updatedAt,
        });
        channelProjectMutations.set(mutationKey, input.mutation);
        return { kind: 'created', mutation: input.mutation };
      },
      async deleteStageEdge(input) {
        const scopeKey = `${input.teamId}:${input.channelId}`;
        const mutationKey = `${scopeKey}:${input.mutation.idempotencyKey}`;
        const existingMutation = channelProjectMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'replayed', mutation: existingMutation };
        }
        const profile = channelProjectProfiles.get(scopeKey);
        if (!profile || profile.revision !== input.expectedRevision) {
          return { kind: 'revision_conflict' };
        }
        const edge = projectStageEdges.get(input.edgeId);
        if (!edge || edge.teamId !== input.teamId || edge.channelId !== input.channelId) {
          return { kind: 'edge_not_found' };
        }
        projectStageEdges.delete(input.edgeId);
        channelProjectProfiles.set(scopeKey, {
          ...profile,
          revision: input.nextRevision,
          updatedAt: input.updatedAt,
        });
        channelProjectMutations.set(mutationKey, input.mutation);
        return { kind: 'deleted', mutation: input.mutation };
      },
      async listArtifactCollections(input) {
        return Array.from(projectArtifactCollections.values())
          .filter((collection) => collection.teamId === input.teamId && collection.channelId === input.channelId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async getArtifactCollection(input) {
        const collection = projectArtifactCollections.get(input.collectionId);
        if (!collection || collection.teamId !== input.teamId || collection.channelId !== input.channelId) {
          return null;
        }
        return collection;
      },
      async listArtifactVersions(input) {
        return Array.from(projectArtifactVersions.values())
          .filter((version) => version.teamId === input.teamId && version.channelId === input.channelId)
          .sort((left, right) => left.versionNumber - right.versionNumber || left.id.localeCompare(right.id));
      },
      async getArtifactVersionByArtifact(input) {
        return Array.from(projectArtifactVersions.values()).find((version) =>
          version.teamId === input.teamId
          && version.channelId === input.channelId
          && version.artifactId === input.artifactId) ?? null;
      },
      async getArtifactMutation(input) {
        return projectArtifactMutations.get(
          `${input.teamId}:${input.channelId}:${input.idempotencyKey}`,
        ) ?? null;
      },
      async promoteArtifact(input) {
        const scopeKey = `${input.teamId}:${input.channelId}`;
        const mutationKey = `${scopeKey}:${input.mutation.idempotencyKey}`;
        const existingMutation = projectArtifactMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          const collection = projectArtifactCollections.get(existingMutation.collectionId);
          const version = projectArtifactVersions.get(existingMutation.versionId);
          if (!collection || !version) return { kind: 'idempotency_conflict' };
          return { kind: 'replayed', collection, version };
        }
        // 自然幂等：同一 Artifact 在同一频道至多一个版本。
        const promotedVersion = Array.from(projectArtifactVersions.values()).find((version) =>
          version.teamId === input.teamId
          && version.channelId === input.channelId
          && version.artifactId === input.version.artifactId);
        if (promotedVersion) {
          const collection = projectArtifactCollections.get(promotedVersion.collectionId);
          if (!collection) return { kind: 'collection_scope_conflict' };
          if (!input.createsCollection && input.collection.id !== promotedVersion.collectionId) {
            return { kind: 'artifact_promoted_to_other_collection' };
          }
          return { kind: 'replayed', collection, version: promotedVersion };
        }
        const artifact = artifacts.get(input.version.artifactId);
        if (!artifact || artifact.teamId !== input.teamId || artifact.channelId !== input.channelId) {
          return { kind: 'artifact_scope_conflict' };
        }
        const stage = projectStages.get(input.version.stageId);
        if (!stage
          || stage.teamId !== input.teamId
          || stage.channelId !== input.channelId
          || stage.taskId !== input.version.taskId) {
          return { kind: 'stage_scope_conflict' };
        }
        // 版本必须落在 Task 的当前 revision 上：陈旧 revision 的结果不得污染新任务。
        const currentTask = tasks.get(`${input.version.taskId}#${input.version.taskRevision}`);
        if (!currentTask
          || currentTask.supersededByRevision !== null
          || currentTask.teamId !== input.teamId
          || currentTask.channelId !== input.channelId) {
          return { kind: 'task_scope_conflict' };
        }
        if (input.createsCollection) {
          if (projectArtifactCollections.has(input.collection.id)) {
            return { kind: 'collection_scope_conflict' };
          }
          const nameTaken = Array.from(projectArtifactCollections.values()).some((collection) =>
            collection.teamId === input.teamId
            && collection.channelId === input.channelId
            && collection.name === input.collection.name);
          if (nameTaken) return { kind: 'collection_name_conflict' };
        } else {
          const existingCollection = projectArtifactCollections.get(input.collection.id);
          if (!existingCollection
            || existingCollection.teamId !== input.teamId
            || existingCollection.channelId !== input.channelId) {
            return { kind: 'collection_scope_conflict' };
          }
          if (existingCollection.revision !== input.expectedCollectionRevision) {
            return { kind: 'collection_revision_conflict' };
          }
          const versionNumberTaken = Array.from(projectArtifactVersions.values()).some((version) =>
            version.collectionId === input.collection.id
            && version.versionNumber === input.version.versionNumber);
          if (versionNumberTaken) return { kind: 'collection_revision_conflict' };
        }
        projectArtifactCollections.set(input.collection.id, input.collection);
        projectArtifactVersions.set(input.version.id, input.version);
        projectArtifactMutations.set(mutationKey, input.mutation);
        return { kind: 'created', collection: input.collection, version: input.version };
      },
      async listArtifactReviews(input) {
        return Array.from(projectArtifactReviews.values())
          .filter((review) =>
            review.teamId === input.teamId && review.channelId === input.channelId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async listArtifactFinalizations(input) {
        return Array.from(projectArtifactFinalizations.values())
          .filter((record) =>
            record.teamId === input.teamId && record.channelId === input.channelId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async getArtifactDecisionMutation(input) {
        return projectArtifactDecisionMutations.get(
          `${input.teamId}:${input.channelId}:${input.idempotencyKey}`,
        ) ?? null;
      },
      async appendArtifactReview(input) {
        const mutationKey = `${input.mutation.teamId}:${input.mutation.channelId}:${input.mutation.idempotencyKey}`;
        const existingMutation = projectArtifactDecisionMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint
            || existingMutation.kind !== 'review'
            || !existingMutation.reviewId) {
            return { kind: 'idempotency_conflict' };
          }
          const review = projectArtifactReviews.get(existingMutation.reviewId);
          return review
            ? { kind: 'replayed', review }
            : { kind: 'idempotency_conflict' };
        }
        const version = projectArtifactVersions.get(input.review.versionId);
        const stage = projectStages.get(input.review.stageId);
        if (!version
          || version.teamId !== input.review.teamId
          || version.channelId !== input.review.channelId
          || version.collectionId !== input.review.collectionId
          || version.stageId !== input.review.stageId
          || !stage
          || stage.teamId !== input.review.teamId
          || stage.channelId !== input.review.channelId) {
          return { kind: 'version_scope_conflict' };
        }
        projectArtifactReviews.set(input.review.id, input.review);
        projectArtifactDecisionMutations.set(mutationKey, input.mutation);
        return { kind: 'created', review: input.review };
      },
      async setArtifactFinalVersion(input) {
        const mutationKey = `${input.teamId}:${input.channelId}:${input.mutation.idempotencyKey}`;
        const existingMutation = projectArtifactDecisionMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint
            || existingMutation.kind !== 'finalization'
            || !existingMutation.finalizationId) {
            return { kind: 'idempotency_conflict' };
          }
          const finalization = projectArtifactFinalizations.get(existingMutation.finalizationId);
          const collection = projectArtifactCollections.get(existingMutation.collectionId);
          return finalization && collection
            ? { kind: 'replayed', collection, finalization }
            : { kind: 'idempotency_conflict' };
        }
        const collection = projectArtifactCollections.get(input.collectionId);
        if (!collection
          || collection.teamId !== input.teamId
          || collection.channelId !== input.channelId
          || collection.revision !== input.expectedCollectionRevision) {
          return { kind: 'collection_revision_conflict' };
        }
        const version = projectArtifactVersions.get(input.finalization.versionId);
        if (!version
          || version.teamId !== input.teamId
          || version.channelId !== input.channelId
          || version.collectionId !== input.collectionId) {
          return { kind: 'version_scope_conflict' };
        }
        const latestReview = Array.from(projectArtifactReviews.values())
          .filter((review) =>
            review.teamId === input.teamId
            && review.channelId === input.channelId
            && review.versionId === input.finalization.versionId)
          .sort((left, right) =>
            right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
        if (!latestReview
          || latestReview.id !== input.finalization.basisReviewId
          || latestReview.decision !== 'approved') {
          return { kind: 'review_basis_conflict' };
        }
        const updatedCollection: ProjectArtifactCollectionRecord = {
          ...collection,
          finalVersionId: input.finalization.versionId,
          revision: input.nextRevision,
          updatedAt: input.updatedAt,
        };
        projectArtifactCollections.set(collection.id, updatedCollection);
        projectArtifactFinalizations.set(input.finalization.id, input.finalization);
        projectArtifactDecisionMutations.set(mutationKey, input.mutation);
        return {
          kind: 'finalized',
          collection: updatedCollection,
          finalization: input.finalization,
        };
      },
    },
    projectDocumentBundles: {
      async list(input) {
        return Array.from(projectDocumentBundles.values())
          .filter((bundle) => bundle.teamId === input.teamId && bundle.channelId === input.channelId)
          .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
      },
      async getById(input) {
        const bundle = projectDocumentBundles.get(input.bundleId);
        if (!bundle || bundle.teamId !== input.teamId || bundle.channelId !== input.channelId) return null;
        return bundle;
      },
      async listMembers(input) {
        return (projectDocumentBundleMembers.get(input.bundleId) ?? [])
          .slice()
          .sort((left, right) => left.position - right.position);
      },
      async getMutation(input) {
        return projectDocumentBundleMutations.get(
          `${input.teamId}:${input.channelId}:${input.idempotencyKey}`,
        ) ?? null;
      },
      async create(input) {
        const mutationKey = `${input.mutation.teamId}:${input.mutation.channelId}:${input.mutation.idempotencyKey}`;
        const existingMutation = projectDocumentBundleMutations.get(mutationKey);
        if (existingMutation) {
          if (existingMutation.requestFingerprint !== input.mutation.requestFingerprint) {
            return { kind: 'idempotency_conflict' };
          }
          return { kind: 'replayed', mutation: existingMutation };
        }
        // 原子提交点复核成员：应用层预检与写入之间，文档可能被移出频道或产生新 revision。
        for (const member of input.members) {
          const document = channelDocuments.get(member.documentId);
          if (!document
            || document.teamId !== input.bundle.teamId
            || document.channelId !== input.bundle.channelId
            || document.currentRevisionId !== member.initialRevisionId) {
            return { kind: 'document_scope_conflict' };
          }
        }
        projectDocumentBundles.set(input.bundle.id, input.bundle);
        projectDocumentBundleMembers.set(input.bundle.id, input.members.slice());
        projectDocumentBundleMutations.set(mutationKey, input.mutation);
        return { kind: 'created', mutation: input.mutation };
      },
    },
    projectReferenceSets: {
      async getByMessageId(input) {
        const set = Array.from(projectReferenceSets.values()).find((candidate) =>
          candidate.teamId === input.teamId
          && candidate.channelId === input.channelId
          && candidate.messageId === input.messageId);
        return set
          ? hydrateProjectReferenceSet(set, projectReferenceSelections, projectReferenceItems)
          : null;
      },
      async create(input) {
        const mutationKey = `${input.mutation.teamId}:${input.mutation.channelId}:${input.mutation.idempotencyKey}`;
        const existingMutation = projectReferenceSetMutations.get(mutationKey);
        if (existingMutation) {
          return existingMutation.requestFingerprint === input.mutation.requestFingerprint
            ? { kind: 'replayed', mutation: { ...existingMutation } }
            : { kind: 'idempotency_conflict' };
        }
        const channel = channels.get(input.set.channelId);
        const message = messages.get(input.set.messageId);
        if (!channel
          || channel.teamId !== input.set.teamId
          || channel.archivedAt != null
          || !message
          || message.teamId !== input.set.teamId
          || message.channelId !== input.set.channelId
          || input.items.some((item) => {
            if (item.kind !== 'document_revision') return false;
            const document = item.documentId ? channelDocuments.get(item.documentId) : null;
            return !document
              || document.teamId !== input.set.teamId
              || document.channelId !== input.set.channelId
              || document.currentRevisionId !== item.revisionId;
          })) {
          return { kind: 'reference_fact_conflict' };
        }
        projectReferenceSets.set(input.set.id, {
          ...input.set,
          selections: [],
        });
        for (const selection of input.selections) {
          projectReferenceSelections.set(selection.id, { ...selection, items: [] });
        }
        for (const item of input.items) projectReferenceItems.set(item.id, { ...item });
        projectReferenceSetMutations.set(mutationKey, { ...input.mutation });
        return { kind: 'created', mutation: { ...input.mutation } };
      },
    },
    projectDocumentInputSetResults: {
      async listByInvocation(input) {
        return Array.from(projectDocumentInputSetResults.values())
          .filter((result) =>
            result.teamId === input.teamId
            && result.channelId === input.channelId
            && result.invocationId === input.invocationId)
          .sort((left, right) =>
            left.createdAt - right.createdAt || left.documentId.localeCompare(right.documentId))
          .map((result) => ({ ...result }));
      },
      async record(input) {
        const key = `${input.invocationId}:${input.inputSetId}:${input.documentId}`;
        const existing = projectDocumentInputSetResults.get(key);
        if (existing) {
          return existing.requestFingerprint === input.requestFingerprint
            ? { kind: 'replayed', result: { ...existing } }
            : { kind: 'idempotency_conflict' };
        }
        projectDocumentInputSetResults.set(key, { ...input });
        return { kind: 'created', result: { ...input } };
      },
    },
    projectDocumentBundleBackfill: {
      async getProgress(input) {
        return projectDocumentBundleBackfillProgress.get(`${input.backfillId}:${input.mode}`) ?? null;
      },
      async saveProgress(input) {
        // 复制一份再存：外泄共享可变引用会让调用方的后续改动悄悄写进「已持久化」的状态。
        projectDocumentBundleBackfillProgress.set(`${input.backfillId}:${input.mode}`, {
          ...input,
          ...(input.cursor ? { cursor: { ...input.cursor } } : {}),
        });
      },
      async listCandidateRuns(input) {
        const candidatesByRun = new Map<string, ProjectDocumentBundleBackfillCandidateRunRecord>();
        for (const document of channelDocuments.values()) {
          for (const revision of channelDocumentRevisions.values()) {
            if (revision.documentId !== document.id) continue;
            const runId = revision.derivationSource?.workspaceRunId;
            if (!runId) continue;
            const key = `${document.teamId}:${runId}`;
            const run = workspaceRuns.get(runId);
            const candidate = run?.teamId === document.teamId
              ? {
                runId: run.id,
                teamId: run.teamId,
                channelId: run.channelId,
                createdAt: run.createdAt,
              }
              : {
                runId,
                teamId: document.teamId,
                channelId: document.channelId,
                createdAt: document.createdAt,
              };
            const existing = candidatesByRun.get(key);
            if (!existing
              || candidate.createdAt < existing.createdAt
              || (candidate.createdAt === existing.createdAt
                && candidate.channelId.localeCompare(existing.channelId) < 0)) {
              candidatesByRun.set(key, candidate);
            }
          }
        }
        const candidates = Array.from(candidatesByRun.values())
          .sort((left, right) => left.createdAt - right.createdAt
            || left.runId.localeCompare(right.runId));
        const after = input.cursor;
        return candidates
          .filter((run) => !after
            || run.createdAt > after.runCreatedAt
            || (run.createdAt === after.runCreatedAt && run.runId > after.runId))
          .slice(0, input.limit);
      },
      async listRunDocumentFacts(input) {
        return Array.from(channelDocuments.values())
          .filter((document) => document.teamId === input.teamId)
          .map((document) => {
            const revisions = Array.from(channelDocumentRevisions.values())
              .filter((revision) => revision.documentId === document.id);
            const derivedEver = revisions.some(
              (revision) => revision.derivationSource?.workspaceRunId === input.workspaceRunId,
            );
            if (!derivedEver) return null;
            const current = channelDocumentRevisions.get(document.currentRevisionId);
            return {
              documentId: document.id,
              channelId: document.channelId,
              createdAt: document.createdAt,
              // derivationSource 会被后续 revision 继承，因此还要求 source === 'run'，
              // 与 SQLite 实现保持同一语义。
              derivesFromRunNow: current?.derivationSource?.workspaceRunId === input.workspaceRunId
                && current?.source === 'run',
            };
          })
          .filter((fact): fact is NonNullable<typeof fact> => fact !== null)
          .sort((left, right) => left.createdAt - right.createdAt
            || left.documentId.localeCompare(right.documentId));
      },
      async findBundleIdForRun(input) {
        return Array.from(projectDocumentBundles.values())
          .filter((bundle) => bundle.teamId === input.teamId
            && bundle.channelId === input.channelId
            && bundle.source.workspaceRunId === input.workspaceRunId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]?.id
          ?? null;
      },
      async recordOutcome(input) {
        projectDocumentBundleBackfillOutcomes.set(
          `${input.backfillId}:${input.mode}:${input.workspaceRunId}`,
          { ...input },
        );
      },
      async summarize(input) {
        const outcomes = {
          created: 0, would_create: 0, existing: 0, ambiguous: 0, skipped: 0, failed: 0,
        };
        const reasons: Record<string, number> = {};
        for (const record of projectDocumentBundleBackfillOutcomes.values()) {
          if (record.backfillId !== input.backfillId || record.mode !== input.mode) continue;
          outcomes[record.outcome] += 1;
          if (record.reasonCode) reasons[record.reasonCode] = (reasons[record.reasonCode] ?? 0) + 1;
        }
        return { outcomes, reasons };
      },
    },
    experiencePack: createMemoryExperiencePackRepositories(),
    systemActivity,
    systemActivityUnitOfWork,
    teamPiAuthorityMigrations: {
      async get(teamId) {
        return teamPiAuthorityMigrations.get(teamId) ?? null;
      },
      async upsert(record) {
        teamPiAuthorityMigrations.set(record.teamId, record);
        return record;
      },
    },
  };
  return repositories;
}

function cloneWorkspacePublishStaging(input: WorkspacePublishStagingRecord): WorkspacePublishStagingRecord {
  return {
    ...input,
    files: input.files.map((file) => ({
      ...file,
      ...(file.content ? { content: Buffer.from(file.content) } : {}),
    })),
    ...(input.provenance ? { provenance: { ...input.provenance } } : {}),
  };
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

function hydrateProjectReferenceSet(
  set: ProjectReferenceSetRecord,
  selectionRecords: Map<string, ProjectReferenceSelectionRecord>,
  itemRecords: Map<string, ProjectReferenceItemRecord>,
): ProjectReferenceSetRecord {
  const selections = Array.from(selectionRecords.values())
    .filter((selection) => selection.referenceSetId === set.id)
    .sort((left, right) => left.position - right.position)
    .map((selection) => ({
      ...selection,
      items: Array.from(itemRecords.values())
        .filter((item) => item.selectionId === selection.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => ({ ...item })),
    }));
  return { ...set, selections };
}

function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}
