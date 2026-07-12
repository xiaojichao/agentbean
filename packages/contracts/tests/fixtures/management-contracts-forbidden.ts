import type {
  AgentInvocationIntentV1,
  ManagementEventV1,
  ManagementRunDto,
} from '../../dist/index.js';

const forbiddenDirectRun: ManagementRunDto = {
  schemaVersion: 1,
  id: 'run-direct',
  teamId: 'team-1',
  channelId: 'channel-1',
  rootMessageId: 'message-1',
  mode: 'direct',
  status: 'queued',
  placementPolicy: {
    placement: 'managed',
    allowServerContext: true,
    requireLocalModelCredentials: false,
  },
  checkpointRevision: 0,
  budget: { maxSubtasks: 0, maxDepth: 0, maxExternalInvocations: 0 },
  createdAt: 1,
  updatedAt: 1,
};

const forbiddenShadowRunStarted: ManagementEventV1 = {
  schemaVersion: 1,
  id: 'event-shadow',
  managementRunId: 'run-shadow',
  sequence: 1,
  type: 'run-started',
  actorKind: 'system',
  idempotencyKey: 'event-shadow',
  payload: { rootMessageId: 'message-1', mode: 'shadow' },
  createdAt: 1,
};

const forbiddenPrompt: ManagementEventV1 = {
  schemaVersion: 1,
  id: 'event-1',
  managementRunId: 'run-1',
  sequence: 1,
  type: 'run-started',
  actorKind: 'system',
  idempotencyKey: 'event-1',
  payload: {
    rootMessageId: 'message-1',
    mode: 'managed',
    prompt: 'raw prompt must not compile',
  },
  createdAt: 1,
};

const forbiddenSecret: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-2', managementRunId: 'run-1', sequence: 2,
  type: 'run-failed', actorKind: 'system', idempotencyKey: 'event-2',
  payload: { errorCode: 'MODEL_FAILED', recoverable: true, secret: 'secret' }, createdAt: 2,
};

const forbiddenToken: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-3', managementRunId: 'run-1', sequence: 3,
  type: 'worker-leased', actorKind: 'system', idempotencyKey: 'event-3',
  payload: { workerId: 'worker-1', leaseFingerprint: 'hash', expiresAt: 10, token: 'raw-token' }, createdAt: 3,
};

const forbiddenReasoning: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-4', managementRunId: 'run-1', sequence: 4,
  type: 'waiting-for-user', actorKind: 'manager', idempotencyKey: 'event-4',
  payload: { reasonCode: 'NEEDS_INPUT', reasoning: 'chain of thought' }, createdAt: 4,
};

const forbiddenPath: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-5', managementRunId: 'run-1', sequence: 5,
  type: 'checkpoint-updated', actorKind: 'manager', idempotencyKey: 'event-5',
  payload: { checkpointRevision: 2, lastEventSequence: 4, absolutePath: '/private/source' }, createdAt: 5,
};

const forbiddenSource: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-6', managementRunId: 'run-1', sequence: 6,
  type: 'root-delivery-submitted', actorKind: 'manager', idempotencyKey: 'event-6',
  payload: { messageId: 'message-1', contributingInvocationIds: [], sourceCode: 'const secret = true' }, createdAt: 6,
};

const forbiddenLog: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-7', managementRunId: 'run-1', sequence: 7,
  type: 'worker-lost', actorKind: 'system', idempotencyKey: 'event-7',
  payload: { workerId: 'worker-1', lastHeartbeatAt: 6, reasonCode: 'LOST', rawLog: 'full local log' }, createdAt: 7,
};

const forbiddenMemory: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-8', managementRunId: 'run-1', sequence: 8,
  type: 'run-completed', actorKind: 'system', idempotencyKey: 'event-8',
  payload: { deliveryMessageId: 'message-2', memoryContent: 'raw memory' }, createdAt: 8,
};

const freePayload: Record<string, unknown> = {};
const forbiddenFreePayload: ManagementEventV1 = {
  schemaVersion: 1, id: 'event-9', managementRunId: 'run-1', sequence: 9,
  type: 'run-started', actorKind: 'system', idempotencyKey: 'event-9',
  payload: freePayload, createdAt: 9,
};

declare const intent: AgentInvocationIntentV1;
intent.objective = 'mutated objective';

void [
  forbiddenDirectRun, forbiddenShadowRunStarted,
  forbiddenPrompt, forbiddenSecret, forbiddenToken, forbiddenReasoning, forbiddenPath,
  forbiddenSource, forbiddenLog, forbiddenMemory, forbiddenFreePayload,
];
