import type { ID, UnixMs } from './common.js';
import type { AgentInvocationStatus, AgentInvocationTargetKind } from './invocation.js';
import type { ManagementCheckpointV1, ManagementRunStatus } from './management.js';
import type { SenderKind } from './message.js';
import type { TaskStatus } from './task.js';
import type { AcceptanceCriterionDto } from './task-coordination.js';
import type { AgentHandoffKind, AgentHandoffReturnMode, AgentHandoffStatus } from './collaboration.js';

export const PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES = [
  'context.get_root_message',
  'context.get_root_task',
  'context.get_visible_thread',
  'context.get_management_state',
  'agents.list_capabilities',
  'agents.get_status',
  'agents.invoke',
  'agents.cancel_invocation',
  'channel.post_management_status',
  'user.request_input',
  'review.submit_root_delivery',
] as const;

export type Phase1ManagementWorkerToolName = (typeof PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES)[number];

export type ManagementWorkerCredentialStatus = 'production_ready' | 'test_only' | 'unavailable';

export interface ManagementWorkerCapacityV1 {
  readonly maxConcurrentLeases: number;
  readonly activeLeaseCount: number;
}

export interface ManagementWorkerRegisterV1 {
  readonly schemaVersion: 1;
  readonly workerInstanceId: ID;
  readonly profileId: ID;
  readonly runtimeVersion: string;
  readonly supportedProtocolVersions: readonly [1];
  readonly supportedPhases: readonly [1];
  readonly credentialStatus: ManagementWorkerCredentialStatus;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly capacity: ManagementWorkerCapacityV1;
}

export type ManagementWorkerFailureCode =
  | 'INVALID_REQUEST'
  | 'NOT_AUTHORIZED'
  | 'CONFLICT'
  | 'UNAVAILABLE';

export interface ManagementWorkerFailureV1 {
  readonly schemaVersion: 1;
  readonly ok: false;
  readonly errorCode: ManagementWorkerFailureCode;
  readonly diagnosticCode?: string;
  readonly retryable: boolean;
}

export type ManagementWorkerRegisterAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly workerId: ID;
  readonly protocolVersion: 1;
} | ManagementWorkerFailureV1;

export interface ManagementLeaseOfferV1 {
  readonly schemaVersion: 1;
  readonly offerId: ID;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly offerExpiresAt: UnixMs;
}

export interface ManagementLeaseAcquireV1 {
  readonly schemaVersion: 1;
  readonly offerId: ID;
  readonly workerInstanceId: ID;
}

export type ManagementLeaseAcquireAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly acquiredAt: UnixMs;
  readonly expiresAt: UnixMs;
} | ManagementWorkerFailureV1;

export interface ManagementWorkerLeaseProofV1 {
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export interface ManagementWorkerAuthorityV1 extends ManagementWorkerLeaseProofV1 {
  readonly idempotencyKey: string;
}

export interface ManagementLeaseRenewV1 extends ManagementWorkerAuthorityV1 {
  readonly schemaVersion: 1;
}

export type ManagementLeaseRenewAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly fencingToken: number;
  readonly expiresAt: UnixMs;
} | ManagementWorkerFailureV1;

export interface ManagementLeaseReleaseV1 extends ManagementWorkerAuthorityV1 {
  readonly schemaVersion: 1;
  readonly reasonCode: string;
}

export type ManagementLeaseReleaseAckV1 = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly fencingToken: number;
  readonly releasedAt: UnixMs;
} | ManagementWorkerFailureV1;

export interface ManagementWorkerAbortV1 extends ManagementWorkerAuthorityV1 {
  readonly schemaVersion: 1;
  readonly reasonCode: string;
}

export interface ManagementWorkerVisibleMessageV1 {
  readonly id: ID;
  readonly senderKind: SenderKind;
  readonly senderId: ID;
  readonly body: string;
  readonly createdAt: UnixMs;
}

export interface ManagementWorkerSessionContextV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly rootMessageId: ID;
  readonly rootTaskId?: ID;
  readonly frozenTarget: {
    readonly agentId: ID;
    readonly kind: AgentInvocationTargetKind;
  };
  readonly visibleThread: {
    readonly revision: number;
    readonly messages: readonly ManagementWorkerVisibleMessageV1[];
  };
}

export interface Phase1ManagementWorkerToolInputMapV1 {
  readonly 'context.get_root_message': Record<string, never>;
  readonly 'context.get_root_task': Record<string, never>;
  readonly 'context.get_visible_thread': Record<string, never>;
  readonly 'context.get_management_state': Record<string, never>;
  readonly 'agents.list_capabilities': Record<string, never>;
  readonly 'agents.get_status': Record<string, never>;
  readonly 'agents.invoke': {
    readonly objective: string;
    readonly attachmentIds: readonly ID[];
    readonly deadlineAt?: UnixMs;
  };
  readonly 'agents.cancel_invocation': {
    readonly invocationId: ID;
    readonly reasonCode: string;
  };
  readonly 'channel.post_management_status': {
    readonly statusCode: string;
  };
  readonly 'user.request_input': {
    readonly question: string;
  };
  readonly 'review.submit_root_delivery': {
    readonly body: string;
    readonly contributingInvocationIds: readonly ID[];
  };
}

export interface Phase1ManagementWorkerToolOutputMapV1 {
  readonly 'context.get_root_message': { readonly message: ManagementWorkerVisibleMessageV1 };
  readonly 'context.get_root_task': {
    readonly task: {
      readonly id: ID;
      readonly title: string;
      readonly status: TaskStatus;
      readonly revision: number;
    } | null;
  };
  readonly 'context.get_visible_thread': ManagementWorkerSessionContextV1['visibleThread'];
  readonly 'context.get_management_state': {
    readonly status: ManagementRunStatus;
    readonly checkpointRevision: number;
    readonly lastEventSequence: number;
    readonly mainAgentId?: ID;
    readonly activeAgentId?: ID;
    readonly collaborationMode?: 'single-agent' | 'manager-orchestrated' | 'handoff';
    readonly collaborationProposals?: readonly {
      readonly proposalId: ID;
      readonly sourceInvocationId: ID;
      readonly sourceAgentId: ID;
      readonly toAgentId: ID;
      readonly kind: Extract<AgentHandoffKind, 'consult' | 'template_request' | 'continuation'>;
      readonly objective: string;
      readonly reason: string;
      readonly contextRefIds: readonly ID[];
      readonly dependencyInvocationIds: readonly ID[];
      readonly attachmentIds: readonly ID[];
      readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
      readonly returnMode: AgentHandoffReturnMode;
      readonly deadlineAt?: UnixMs;
    }[];
    readonly handoffs?: readonly {
      readonly handoffId: ID;
      readonly invocationId?: ID;
      readonly fromAgentId?: ID;
      readonly toAgentId: ID;
      readonly kind: AgentHandoffKind;
      readonly status: AgentHandoffStatus;
    }[];
  };
  readonly 'agents.list_capabilities': {
    readonly agentId: ID;
    readonly kind: AgentInvocationTargetKind;
    readonly capabilities: readonly string[];
  };
  readonly 'agents.get_status': {
    readonly agentId: ID;
    readonly status: 'online' | 'offline' | 'busy' | 'unknown';
  };
  readonly 'agents.invoke': {
    readonly invocationId: ID;
    readonly status: AgentInvocationStatus;
  };
  readonly 'agents.cancel_invocation': {
    readonly invocationId: ID;
    readonly status: Extract<AgentInvocationStatus, 'cancelled' | 'succeeded' | 'failed' | 'timed_out'>;
  };
  readonly 'channel.post_management_status': { readonly messageId: ID };
  readonly 'user.request_input': { readonly questionMessageId: ID };
  readonly 'review.submit_root_delivery': {
    readonly deliveryMessageId: ID;
    readonly status: 'in_review';
  };
}

type ReadManagementWorkerToolName =
  | 'context.get_root_message'
  | 'context.get_root_task'
  | 'context.get_visible_thread'
  | 'context.get_management_state'
  | 'agents.list_capabilities'
  | 'agents.get_status';

type WriteManagementWorkerToolName = Exclude<Phase1ManagementWorkerToolName, ReadManagementWorkerToolName>;

interface ManagementToolRequestBaseV1<K extends Phase1ManagementWorkerToolName> {
  readonly schemaVersion: 1;
  readonly commandId: ID;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly toolCallId: ID;
  readonly toolName: K;
  readonly input: Phase1ManagementWorkerToolInputMapV1[K];
}

export type ManagementWorkerToolRequestV1 = {
  readonly [K in ReadManagementWorkerToolName]: ManagementToolRequestBaseV1<K>;
}[ReadManagementWorkerToolName] | {
  readonly [K in WriteManagementWorkerToolName]: ManagementToolRequestBaseV1<K> & Omit<
    ManagementWorkerAuthorityV1,
    'managementRunId' | 'workerId'
  >;
}[WriteManagementWorkerToolName];

interface ManagementToolResultBaseV1<K extends Phase1ManagementWorkerToolName> {
  readonly schemaVersion: 1;
  readonly commandId: ID;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly toolCallId: ID;
  readonly toolName: K;
}

export type ManagementWorkerToolResultV1 = {
  readonly [K in Phase1ManagementWorkerToolName]: ManagementToolResultBaseV1<K> & {
    readonly ok: true;
    readonly output: Phase1ManagementWorkerToolOutputMapV1[K];
  };
}[Phase1ManagementWorkerToolName] | (ManagementToolResultBaseV1<Phase1ManagementWorkerToolName> & {
  readonly ok: false;
  readonly errorCode: ManagementWorkerFailureCode;
  readonly diagnosticCode?: string;
  readonly retryable: boolean;
});

export interface ManagementCheckpointFetchV1 extends ManagementWorkerLeaseProofV1 {
  readonly schemaVersion: 1;
  readonly knownCheckpointRevision?: number;
}

export interface ManagementCheckpointResultV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly workerId: ID;
  readonly context: Omit<ManagementWorkerSessionContextV1, 'frozenTarget'> & {
    readonly frozenTarget?: ManagementWorkerSessionContextV1['frozenTarget'];
  };
  readonly checkpoint?: ManagementCheckpointV1;
}

export interface ManagementOutboxReplayV1 extends ManagementWorkerAuthorityV1 {
  readonly schemaVersion: 1;
  readonly commandId: ID;
  readonly requestHash: string;
}

export interface ManagementOutboxReplayAckV1 {
  readonly schemaVersion: 1;
  readonly commandId: ID;
  readonly managementRunId: ID;
  readonly idempotencyKey: string;
  readonly disposition: 'existing' | 'committed' | 'conflict' | 'rejected';
  readonly resultReferenceId?: ID;
}

export interface ManagementShadowEvaluationV1 {
  readonly schemaVersion: 1;
  readonly shadowRequestKey: string;
  readonly workerId: ID;
  readonly inputHash: string;
  readonly objective: string;
  readonly context: ManagementWorkerSessionContextV1;
}

export interface ManagementShadowEvaluationResultV1 {
  readonly schemaVersion: 1;
  readonly shadowRequestKey: string;
  readonly workerId: ID;
  readonly inputHash: string;
  readonly objectiveHash: string;
  readonly frozenTarget: ManagementWorkerSessionContextV1['frozenTarget'];
  readonly proposedTools: readonly {
    readonly sequence: number;
    readonly name: Phase1ManagementWorkerToolName;
    readonly argumentHash: string;
  }[];
  readonly diagnosticCodes: readonly string[];
  readonly completedAt: UnixMs;
}

export interface ManagementWorkerPayloadMapV1 {
  readonly register: ManagementWorkerRegisterV1;
  readonly 'register-ack': ManagementWorkerRegisterAckV1;
  readonly 'lease-offer': ManagementLeaseOfferV1;
  readonly 'lease-acquire': ManagementLeaseAcquireV1;
  readonly 'lease-acquire-ack': ManagementLeaseAcquireAckV1;
  readonly 'lease-renew': ManagementLeaseRenewV1;
  readonly 'lease-renew-ack': ManagementLeaseRenewAckV1;
  readonly 'lease-release': ManagementLeaseReleaseV1;
  readonly 'lease-release-ack': ManagementLeaseReleaseAckV1;
  readonly abort: ManagementWorkerAbortV1;
  readonly 'tool-request': ManagementWorkerToolRequestV1;
  readonly 'tool-result': ManagementWorkerToolResultV1;
  readonly 'checkpoint-fetch': ManagementCheckpointFetchV1;
  readonly 'checkpoint-result': ManagementCheckpointResultV1;
  readonly 'outbox-replay': ManagementOutboxReplayV1;
  readonly 'outbox-replay-ack': ManagementOutboxReplayAckV1;
  readonly 'shadow-evaluate': ManagementShadowEvaluationV1;
  readonly 'shadow-result': ManagementShadowEvaluationResultV1;
}

export const MANAGEMENT_WORKER_PAYLOAD_KINDS = [
  'register',
  'register-ack',
  'lease-offer',
  'lease-acquire',
  'lease-acquire-ack',
  'lease-renew',
  'lease-renew-ack',
  'lease-release',
  'lease-release-ack',
  'abort',
  'tool-request',
  'tool-result',
  'checkpoint-fetch',
  'checkpoint-result',
  'outbox-replay',
  'outbox-replay-ack',
  'shadow-evaluate',
  'shadow-result',
] as const satisfies readonly (keyof ManagementWorkerPayloadMapV1)[];

export type ManagementWorkerPayloadKind = (typeof MANAGEMENT_WORKER_PAYLOAD_KINDS)[number];

export interface ManagementWorkerPayloadValidationError {
  readonly code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID';
  readonly path: string;
}

export type SafeParseManagementWorkerPayloadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ManagementWorkerPayloadValidationError };

type Validator = (value: unknown, path: string) => void;
type Field = { readonly validator: Validator; readonly optional?: true };

class PayloadValidationError extends Error {
  constructor(readonly path: string) {
    super('MANAGEMENT_WORKER_PAYLOAD_INVALID');
  }
}

function invalid(path: string): never {
  throw new PayloadValidationError(path);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const literal = (expected: unknown): Validator => (value, path) => {
  if (value !== expected) invalid(path);
};

const oneOf = (values: readonly unknown[]): Validator => (value, path) => {
  if (!values.includes(value)) invalid(path);
};

const text = (maxLength = 32_768): Validator => (value, path) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) invalid(path);
};
const textAllowEmpty = (maxLength = 32_768): Validator => (value, path) => {
  if (typeof value !== 'string' || value.length > maxLength) invalid(path);
};

const id = text(256);
const shortText = text(512);
const hash = text(512);

const integer = (minimum = 0): Validator => (value, path) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(path);
};

const booleanValue: Validator = (value, path) => {
  if (typeof value !== 'boolean') invalid(path);
};

const optional = (validator: Validator): Field => ({ validator, optional: true });
const required = (validator: Validator): Field => ({ validator });

function exactObject(fields: Record<string, Field>): Validator {
  return (value, path) => {
    if (!isPlainRecord(value)) invalid(path);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(fields, key)) invalid(`${path}.${key}`);
      if (value[key] === undefined) invalid(`${path}.${key}`);
    }
    for (const [key, field] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) {
        if (!field.optional) invalid(`${path}.${key}`);
        continue;
      }
      field.validator(value[key], `${path}.${key}`);
    }
  };
}

function arrayOf(validator: Validator, maxLength = 256): Validator {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maxLength) invalid(path);
    value.forEach((entry, index) => validator(entry, `${path}[${index}]`));
  };
}

function exactArray(validators: readonly Validator[]): Validator {
  return (value, path) => {
    if (!Array.isArray(value) || value.length !== validators.length) invalid(path);
    validators.forEach((validator, index) => validator(value[index], `${path}[${index}]`));
  };
}

function nullable(validator: Validator): Validator {
  return (value, path) => {
    if (value !== null) validator(value, path);
  };
}

function union(...validators: Validator[]): Validator {
  return (value, path) => {
    for (const validator of validators) {
      try {
        validator(value, path);
        return;
      } catch (error) {
        if (!(error instanceof PayloadValidationError)) throw error;
      }
    }
    invalid(path);
  };
}

const failureSchema = exactObject({
  schemaVersion: required(literal(1)),
  ok: required(literal(false)),
  errorCode: required(oneOf(['INVALID_REQUEST', 'NOT_AUTHORIZED', 'CONFLICT', 'UNAVAILABLE'])),
  diagnosticCode: optional(shortText),
  retryable: required(booleanValue),
});

const capacitySchema = exactObject({
  maxConcurrentLeases: required(integer(1)),
  activeLeaseCount: required(integer(0)),
});

const frozenTargetSchema = exactObject({
  agentId: required(id),
  kind: required(oneOf(['custom', 'agentos-hosted'])),
});

const visibleMessageSchema = exactObject({
  id: required(id),
  senderKind: required(oneOf(['human', 'agent', 'system'])),
  senderId: required(id),
  body: required(text()),
  createdAt: required(integer(0)),
});

const visibleThreadSchema = exactObject({
  revision: required(integer(0)),
  messages: required(arrayOf(visibleMessageSchema, 512)),
});

const sessionContextSchema = exactObject({
  schemaVersion: required(literal(1)),
  teamId: required(id),
  channelId: required(id),
  rootMessageId: required(id),
  rootTaskId: optional(id),
  frozenTarget: required(frozenTargetSchema),
  visibleThread: required(visibleThreadSchema),
});

const checkpointSessionContextSchema = exactObject({
  schemaVersion: required(literal(1)),
  teamId: required(id),
  channelId: required(id),
  rootMessageId: required(id),
  rootTaskId: optional(id),
  frozenTarget: optional(frozenTargetSchema),
  visibleThread: required(visibleThreadSchema),
});

const checkpointSchema = exactObject({
  schemaVersion: required(literal(1)),
  managementRunId: required(id),
  revision: required(integer(0)),
  authoritative: required(exactObject({
    lastEventSequence: required(integer(0)),
    taskGraphRevision: required(integer(0)),
    openTaskIds: required(arrayOf(id)),
    waitingInvocationIds: required(arrayOf(id)),
    completedInvocationIds: required(arrayOf(id)),
    memoryCapsuleIds: required(arrayOf(id)),
    taskSnapshots: optional(arrayOf(exactObject({
      taskId: required(id),
      taskRevision: required(integer(1)),
      taskAttempt: required(integer(1)),
      status: required(oneOf(['todo', 'in_progress', 'in_review', 'done', 'closed'])),
      claimLeaseId: optional(id),
    }))),
    activeClaimLeaseIds: optional(arrayOf(id)),
  })),
  contextHints: required(exactObject({
    objective: required(text()),
    planSummary: required(textAllowEmpty()),
    completedInvocationSummaries: required(arrayOf(exactObject({
      invocationId: required(id),
      summary: required(text()),
    }))),
    unresolvedQuestions: required(arrayOf(text())),
    nextAction: optional(text()),
  })),
  updatedAt: required(integer(0)),
});

const authorityFields: Record<string, Field> = {
  managementRunId: required(id),
  workerId: required(id),
  leaseToken: required(text(4096)),
  fencingToken: required(integer(1)),
  idempotencyKey: required(text(512)),
};

const leaseProofFields: Record<string, Field> = {
  managementRunId: required(id),
  workerId: required(id),
  leaseToken: required(text(4096)),
  fencingToken: required(integer(1)),
};

const emptySchema = exactObject({});
const toolInputSchemas: Record<Phase1ManagementWorkerToolName, Validator> = {
  'context.get_root_message': emptySchema,
  'context.get_root_task': emptySchema,
  'context.get_visible_thread': emptySchema,
  'context.get_management_state': emptySchema,
  'agents.list_capabilities': emptySchema,
  'agents.get_status': emptySchema,
  'agents.invoke': exactObject({
    objective: required(text()),
    attachmentIds: required(arrayOf(id)),
    deadlineAt: optional(integer(0)),
  }),
  'agents.cancel_invocation': exactObject({
    invocationId: required(id),
    reasonCode: required(shortText),
  }),
  'channel.post_management_status': exactObject({ statusCode: required(shortText) }),
  'user.request_input': exactObject({ question: required(text()) }),
  'review.submit_root_delivery': exactObject({
    body: required(text()),
    contributingInvocationIds: required(arrayOf(id)),
  }),
};

const taskSchema = nullable(exactObject({
  id: required(id),
  title: required(text()),
  status: required(oneOf(['todo', 'in_progress', 'in_review', 'done', 'closed'])),
  revision: required(integer(0)),
}));

const acceptanceCriterionSchema = exactObject({
  id: required(id),
  description: required(text()),
  evidenceRequired: required(booleanValue),
  allowedEvidenceKinds: optional(arrayOf(oneOf([
    'message', 'artifact', 'workspace-run', 'invocation', 'task',
  ]))),
});

const collaborationProposalSummarySchema = exactObject({
  proposalId: required(id),
  sourceInvocationId: required(id),
  sourceAgentId: required(id),
  toAgentId: required(id),
  kind: required(oneOf(['consult', 'template_request', 'continuation'])),
  objective: required(text()),
  reason: required(text()),
  contextRefIds: required(arrayOf(id)),
  dependencyInvocationIds: required(arrayOf(id)),
  attachmentIds: required(arrayOf(id)),
  acceptanceCriteria: required(arrayOf(acceptanceCriterionSchema)),
  returnMode: required(oneOf(['return_to_manager', 'return_to_source_agent', 'deliver_to_root'])),
  deadlineAt: optional(integer(0)),
});

const handoffSummarySchema = exactObject({
  handoffId: required(id),
  invocationId: optional(id),
  fromAgentId: optional(id),
  toAgentId: required(id),
  kind: required(oneOf(['delegate', 'consult', 'review', 'template_request', 'continuation'])),
  status: required(oneOf([
    'requested', 'accepted', 'running', 'returned', 'rejected', 'failed', 'cancelled', 'timed_out',
  ])),
});

const toolOutputSchemas: Record<Phase1ManagementWorkerToolName, Validator> = {
  'context.get_root_message': exactObject({ message: required(visibleMessageSchema) }),
  'context.get_root_task': exactObject({ task: required(taskSchema) }),
  'context.get_visible_thread': visibleThreadSchema,
  'context.get_management_state': exactObject({
    status: required(oneOf([
      'queued', 'running', 'waiting_for_agents', 'waiting_for_user', 'recovering',
      'in_review', 'completed', 'failed', 'cancelled',
    ])),
    checkpointRevision: required(integer(0)),
    lastEventSequence: required(integer(0)),
    mainAgentId: optional(id),
    activeAgentId: optional(id),
    collaborationMode: optional(oneOf(['single-agent', 'manager-orchestrated', 'handoff'])),
    collaborationProposals: optional(arrayOf(collaborationProposalSummarySchema)),
    handoffs: optional(arrayOf(handoffSummarySchema)),
  }),
  'agents.list_capabilities': exactObject({
    agentId: required(id),
    kind: required(oneOf(['custom', 'agentos-hosted'])),
    capabilities: required(arrayOf(shortText)),
  }),
  'agents.get_status': exactObject({
    agentId: required(id),
    status: required(oneOf(['online', 'offline', 'busy', 'unknown'])),
  }),
  'agents.invoke': exactObject({
    invocationId: required(id),
    status: required(oneOf(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'])),
  }),
  'agents.cancel_invocation': exactObject({
    invocationId: required(id),
    status: required(oneOf(['cancelled', 'succeeded', 'failed', 'timed_out'])),
  }),
  'channel.post_management_status': exactObject({ messageId: required(id) }),
  'user.request_input': exactObject({ questionMessageId: required(id) }),
  'review.submit_root_delivery': exactObject({
    deliveryMessageId: required(id),
    status: required(literal('in_review')),
  }),
};

const WRITE_TOOL_NAMES = new Set<Phase1ManagementWorkerToolName>([
  'agents.invoke',
  'agents.cancel_invocation',
  'channel.post_management_status',
  'user.request_input',
  'review.submit_root_delivery',
]);

const toolRequestSchema: Validator = (value, path) => {
  if (!isPlainRecord(value)) invalid(path);
  const toolName = value.toolName;
  if (typeof toolName !== 'string'
    || !PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES.includes(toolName as Phase1ManagementWorkerToolName)) {
    invalid(`${path}.toolName`);
  }
  const fields: Record<string, Field> = {
    schemaVersion: required(literal(1)),
    commandId: required(id),
    managementRunId: required(id),
    workerId: required(id),
    toolCallId: required(id),
    toolName: required(literal(toolName)),
    input: required(toolInputSchemas[toolName as Phase1ManagementWorkerToolName]),
    ...(WRITE_TOOL_NAMES.has(toolName as Phase1ManagementWorkerToolName)
      ? {
          leaseToken: required(text(4096)),
          fencingToken: required(integer(1)),
          idempotencyKey: required(text(512)),
        }
      : {}),
  };
  exactObject(fields)(value, path);
};

const toolResultSchema: Validator = (value, path) => {
  if (!isPlainRecord(value)) invalid(path);
  const toolName = value.toolName;
  if (typeof toolName !== 'string'
    || !PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES.includes(toolName as Phase1ManagementWorkerToolName)) {
    invalid(`${path}.toolName`);
  }
  const common: Record<string, Field> = {
    schemaVersion: required(literal(1)),
    commandId: required(id),
    managementRunId: required(id),
    workerId: required(id),
    toolCallId: required(id),
    toolName: required(literal(toolName)),
  };
  if (value.ok === true) {
    exactObject({
      ...common,
      ok: required(literal(true)),
      output: required(toolOutputSchemas[toolName as Phase1ManagementWorkerToolName]),
    })(value, path);
    return;
  }
  exactObject({
    ...common,
    ok: required(literal(false)),
    errorCode: required(oneOf(['INVALID_REQUEST', 'NOT_AUTHORIZED', 'CONFLICT', 'UNAVAILABLE'])),
    diagnosticCode: optional(shortText),
    retryable: required(booleanValue),
  })(value, path);
};

const registerObjectSchema = exactObject({
  schemaVersion: required(literal(1)),
  workerInstanceId: required(id),
  profileId: required(id),
  runtimeVersion: required(shortText),
  supportedProtocolVersions: required(exactArray([literal(1)])),
  supportedPhases: required(exactArray([literal(1)])),
  credentialStatus: required(oneOf(['production_ready', 'test_only', 'unavailable'])),
  providerId: optional(shortText),
  modelId: optional(shortText),
  capacity: required(capacitySchema),
});

const registerSchema: Validator = (value, path) => {
  registerObjectSchema(value, path);
  const record = value as Record<string, unknown>;
  if (record.credentialStatus === 'production_ready') {
    if (!Object.hasOwn(record, 'providerId')) invalid(`${path}.providerId`);
    if (!Object.hasOwn(record, 'modelId')) invalid(`${path}.modelId`);
  }
  if (record.credentialStatus === 'unavailable') {
    if (Object.hasOwn(record, 'providerId')) invalid(`${path}.providerId`);
    if (Object.hasOwn(record, 'modelId')) invalid(`${path}.modelId`);
  }
  const capacity = record.capacity as ManagementWorkerCapacityV1;
  if (capacity.activeLeaseCount > capacity.maxConcurrentLeases) {
    invalid(`${path}.capacity.activeLeaseCount`);
  }
};

const schemas: { readonly [K in ManagementWorkerPayloadKind]: Validator } = {
  register: registerSchema,
  'register-ack': union(exactObject({
    schemaVersion: required(literal(1)),
    ok: required(literal(true)),
    workerId: required(id),
    protocolVersion: required(literal(1)),
  }), failureSchema),
  'lease-offer': exactObject({
    schemaVersion: required(literal(1)),
    offerId: required(id),
    managementRunId: required(id),
    workerId: required(id),
    offerExpiresAt: required(integer(0)),
  }),
  'lease-acquire': exactObject({
    schemaVersion: required(literal(1)),
    offerId: required(id),
    workerInstanceId: required(id),
  }),
  'lease-acquire-ack': union(exactObject({
    schemaVersion: required(literal(1)),
    ok: required(literal(true)),
    managementRunId: required(id),
    workerId: required(id),
    leaseToken: required(text(4096)),
    fencingToken: required(integer(1)),
    acquiredAt: required(integer(0)),
    expiresAt: required(integer(0)),
  }), failureSchema),
  'lease-renew': exactObject({ schemaVersion: required(literal(1)), ...authorityFields }),
  'lease-renew-ack': union(exactObject({
    schemaVersion: required(literal(1)),
    ok: required(literal(true)),
    managementRunId: required(id),
    workerId: required(id),
    fencingToken: required(integer(1)),
    expiresAt: required(integer(0)),
  }), failureSchema),
  'lease-release': exactObject({
    schemaVersion: required(literal(1)),
    ...authorityFields,
    reasonCode: required(shortText),
  }),
  'lease-release-ack': union(exactObject({
    schemaVersion: required(literal(1)),
    ok: required(literal(true)),
    managementRunId: required(id),
    workerId: required(id),
    fencingToken: required(integer(1)),
    releasedAt: required(integer(0)),
  }), failureSchema),
  abort: exactObject({
    schemaVersion: required(literal(1)),
    ...authorityFields,
    reasonCode: required(shortText),
  }),
  'tool-request': toolRequestSchema,
  'tool-result': toolResultSchema,
  'checkpoint-fetch': exactObject({
    schemaVersion: required(literal(1)),
    ...leaseProofFields,
    knownCheckpointRevision: optional(integer(0)),
  }),
  'checkpoint-result': exactObject({
    schemaVersion: required(literal(1)),
    managementRunId: required(id),
    workerId: required(id),
    context: required(checkpointSessionContextSchema),
    checkpoint: optional(checkpointSchema),
  }),
  'outbox-replay': exactObject({
    schemaVersion: required(literal(1)),
    commandId: required(id),
    requestHash: required(hash),
    ...authorityFields,
  }),
  'outbox-replay-ack': exactObject({
    schemaVersion: required(literal(1)),
    commandId: required(id),
    managementRunId: required(id),
    idempotencyKey: required(text(512)),
    disposition: required(oneOf(['existing', 'committed', 'conflict', 'rejected'])),
    resultReferenceId: optional(id),
  }),
  'shadow-evaluate': exactObject({
    schemaVersion: required(literal(1)),
    shadowRequestKey: required(text(512)),
    workerId: required(id),
    inputHash: required(hash),
    objective: required(text()),
    context: required(sessionContextSchema),
  }),
  'shadow-result': exactObject({
    schemaVersion: required(literal(1)),
    shadowRequestKey: required(text(512)),
    workerId: required(id),
    inputHash: required(hash),
    objectiveHash: required(hash),
    frozenTarget: required(frozenTargetSchema),
    proposedTools: required(arrayOf(exactObject({
      sequence: required(integer(1)),
      name: required(oneOf(PHASE_1_MANAGEMENT_WORKER_TOOL_NAMES)),
      argumentHash: required(hash),
    }))),
    diagnosticCodes: required(arrayOf(shortText)),
    completedAt: required(integer(0)),
  }),
};

export function parseManagementWorkerPayload<K extends ManagementWorkerPayloadKind>(
  kind: K,
  value: unknown,
): ManagementWorkerPayloadMapV1[K] {
  schemas[kind](value, '$');
  return structuredClone(value) as ManagementWorkerPayloadMapV1[K];
}

export function safeParseManagementWorkerPayload<K extends ManagementWorkerPayloadKind>(
  kind: K,
  value: unknown,
): SafeParseManagementWorkerPayloadResult<ManagementWorkerPayloadMapV1[K]> {
  try {
    return { ok: true, value: parseManagementWorkerPayload(kind, value) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'MANAGEMENT_WORKER_PAYLOAD_INVALID',
        path: error instanceof PayloadValidationError ? error.path : '$',
      },
    };
  }
}
