import type {
  AgentInvocationIntentV1,
  AgentInvocationViewDto,
  DispatchDto,
  ManagementEventV1,
  MemoryCandidateRefDto,
  MemoryCapsuleRefDto,
  SubtaskDeliveryV1,
  TaskDto,
  TaskCoordinationDto,
  ManagementCheckpointV1,
  ManagementRunDto,
} from '../../dist/index.js';

const run: ManagementRunDto = {
  schemaVersion: 1,
  id: 'run-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  rootMessageId: 'message-1',
  mode: 'managed',
  status: 'running',
  placementPolicy: {
    placement: 'device',
    allowServerContext: false,
    requireLocalModelCredentials: true,
  },
  checkpointRevision: 1,
  budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 40 },
  createdAt: 1,
  updatedAt: 1,
};

const checkpoint: ManagementCheckpointV1 = {
  schemaVersion: 1,
  managementRunId: run.id,
  revision: 1,
  authoritative: {
    lastEventSequence: 1,
    taskGraphRevision: 1,
    openTaskIds: [],
    waitingInvocationIds: [],
    completedInvocationIds: [],
    memoryCapsuleIds: [],
  },
  contextHints: {
    objective: 'coordinate',
    planSummary: 'start',
    completedInvocationSummaries: [],
    unresolvedQuestions: [],
  },
  updatedAt: 1,
};

const coordination: TaskCoordinationDto = {
  schemaVersion: 1,
  rootTaskId: 'task-root',
  parentTaskId: 'task-root',
  managementRunId: run.id,
  nodeKind: 'subtask',
  reviewPolicy: 'manager',
  claimPolicy: 'targeted',
  requiredCapabilities: ['coding'],
  acceptanceCriteria: [{
    id: 'criterion-1',
    description: 'Tests pass',
    evidenceRequired: true,
    allowedEvidenceKinds: ['workspace-run'],
  }],
  dependencyTaskIds: [],
  attempt: 1,
  maxAttempts: 2,
};

const delivery: SubtaskDeliveryV1 = {
  schemaVersion: 1,
  id: 'delivery-1',
  taskId: 'task-1',
  taskRevision: 2,
  taskAttempt: 1,
  claimLeaseId: 'claim-1',
  invocationId: 'invocation-1',
  summary: 'Implemented and tested',
  claims: [{
    statement: 'Tests passed',
    evidenceRefs: [{
      kind: 'workspace-run',
      id: 'workspace-run-1',
      snapshotHash: 'sha256:evidence',
      capturedAt: 2,
    }],
  }],
  evidenceRefs: [],
};

const intent: AgentInvocationIntentV1 = {
  schemaVersion: 1,
  teamId: run.teamId,
  channelId: run.channelId,
  targetAgentId: 'agent-1',
  targetKind: 'custom',
  objective: 'Implement the subtask',
  taskContext: {
    taskId: delivery.taskId,
    rootTaskId: 'task-root',
    taskRevision: delivery.taskRevision,
    taskAttempt: delivery.taskAttempt,
    claimLeaseId: delivery.claimLeaseId,
  },
  acceptanceCriteria: coordination.acceptanceCriteria,
  dependencyResults: [],
  memoryCapsuleRef: {
    schemaVersion: 1,
    id: 'capsule-1',
    teamId: run.teamId,
    managementRunId: run.id,
    targetAgentId: 'agent-1',
    contentHash: 'sha256:capsule-1',
    authorizationDecisionId: 'decision-1',
    expiresAt: 100,
  },
  attachmentIds: [],
};

const invocation: AgentInvocationViewDto = {
  schemaVersion: 1,
  id: 'invocation-1',
  managementRunId: run.id,
  intent,
  intentHash: 'sha256:intent',
  idempotencyKey: 'invoke-1',
  createdAt: 2,
  status: 'running',
  dispatchAttempts: [{
    dispatchId: 'dispatch-1',
    attemptNumber: 1,
    status: 'accepted',
  }],
  activeDispatchId: 'dispatch-1',
};

const event: ManagementEventV1 = {
  schemaVersion: 1,
  id: 'event-1',
  managementRunId: run.id,
  sequence: 1,
  type: 'invocation-created',
  actorKind: 'manager',
  actorId: 'worker-1',
  idempotencyKey: 'event-key-1',
  payload: {
    invocationId: invocation.id,
    intentHash: invocation.intentHash,
    taskRevision: 2,
  },
  createdAt: 3,
};

const capsuleRef: MemoryCapsuleRefDto = {
  schemaVersion: 1,
  id: 'capsule-1',
  teamId: run.teamId,
  managementRunId: run.id,
  taskId: 'task-1',
  targetAgentId: intent.targetAgentId,
  contentHash: 'sha256:capsule',
  authorizationDecisionId: 'decision-1',
  expiresAt: 100,
};

const candidateRef: MemoryCandidateRefDto = {
  schemaVersion: 1,
  id: 'candidate-1',
  teamId: run.teamId,
  managementRunId: run.id,
  sourceKind: 'invocation',
  sourceId: invocation.id,
  projectionHash: 'sha256:candidate',
  createdAt: 4,
};

const legacyTask: TaskDto = {
  id: 'legacy-task',
  teamId: run.teamId,
  title: 'Legacy task remains independent',
  status: 'todo',
  creatorId: 'user-1',
  tags: [],
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const legacyDispatch: DispatchDto = {
  id: 'legacy-dispatch',
  teamId: run.teamId,
  channelId: run.channelId,
  messageId: run.rootMessageId,
  agentId: 'agent-1',
  status: 'queued',
  requestId: 'request-1',
  createdAt: 1,
  updatedAt: 1,
};

void [run, checkpoint, coordination, delivery, intent, invocation, event, capsuleRef, candidateRef, legacyTask, legacyDispatch];
