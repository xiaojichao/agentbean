import { createHash } from 'node:crypto';
import type { ManagementEventTypeV1, ManagementEventV1 } from '../../../../../packages/contracts/src/index.js';

export const PHASE_1_WRITABLE_MANAGEMENT_EVENT_TYPES = [
  'run-started',
  'worker-leased',
  'worker-lost',
  'checkpoint-updated',
  'invocation-created',
  'dispatch-attempt-started',
  'dispatch-attempt-completed',
  'waiting-for-user',
  'root-delivery-submitted',
  'run-completed',
  'run-failed',
  'run-cancelled',
] as const satisfies readonly ManagementEventTypeV1[];

type Phase1WritableEventType = (typeof PHASE_1_WRITABLE_MANAGEMENT_EVENT_TYPES)[number];

export const TASK_COORDINATION_MANAGEMENT_EVENT_TYPES = [
  'task-created',
  'task-revised',
  'task-state-changed',
  'task-published-for-claim',
  'task-assigned',
  'task-claimed',
  'claim-invalidated',
] as const satisfies readonly ManagementEventTypeV1[];

type TaskCoordinationEventType = (typeof TASK_COORDINATION_MANAGEMENT_EVENT_TYPES)[number];
type WritableEventType = Phase1WritableEventType | TaskCoordinationEventType;

const payloadKeys: Record<WritableEventType, { required: readonly string[]; optional?: readonly string[] }> = {
  'run-started': { required: ['rootMessageId', 'mode'], optional: ['rootTaskId'] },
  'worker-leased': { required: ['workerId', 'leaseFingerprint', 'expiresAt'] },
  'worker-lost': { required: ['workerId', 'lastHeartbeatAt', 'reasonCode'] },
  'checkpoint-updated': { required: ['checkpointRevision', 'lastEventSequence'] },
  'invocation-created': { required: ['invocationId', 'intentHash'], optional: ['taskRevision'] },
  'dispatch-attempt-started': { required: ['invocationId', 'dispatchId', 'attemptNumber'] },
  'dispatch-attempt-completed': { required: ['invocationId', 'dispatchId', 'attemptNumber', 'status'] },
  'waiting-for-user': { required: ['reasonCode'], optional: ['questionMessageId'] },
  'root-delivery-submitted': { required: ['messageId', 'contributingInvocationIds'] },
  'run-completed': { required: ['deliveryMessageId'], optional: ['completedTaskId'] },
  'run-failed': { required: ['errorCode', 'recoverable'] },
  'run-cancelled': { required: ['reasonCode', 'cancelledBy'] },
  'task-created': { required: ['taskId', 'taskRevision'], optional: ['parentTaskId'] },
  'task-revised': { required: ['taskId', 'previousRevision', 'taskRevision', 'criterionIds', 'reasonCode'] },
  'task-state-changed': { required: ['taskId', 'taskRevision', 'from', 'to'] },
  'task-published-for-claim': { required: ['taskId', 'taskRevision', 'requiredCapabilities'] },
  'task-assigned': { required: ['taskId', 'taskRevision', 'agentId'] },
  'task-claimed': { required: ['taskId', 'taskRevision', 'agentId', 'claimLeaseId', 'attempt'] },
  'claim-invalidated': { required: ['taskId', 'previousTaskRevision', 'claimLeaseId', 'invalidatedInvocationIds', 'reasonCode'] },
};

export function parsePhase1ManagementEvent(input: unknown): ManagementEventV1 {
  return parseManagementEvent(input, PHASE_1_WRITABLE_MANAGEMENT_EVENT_TYPES);
}

export function parseTaskCoordinationManagementEvent(input: unknown): ManagementEventV1 {
  return parseManagementEvent(input, TASK_COORDINATION_MANAGEMENT_EVENT_TYPES);
}

function parseManagementEvent(input: unknown, allowedTypes: readonly WritableEventType[]): ManagementEventV1 {
  const event = record(input, 'event');
  exactKeys(event, ['schemaVersion', 'id', 'managementRunId', 'sequence', 'type', 'actorKind', 'idempotencyKey', 'payload', 'createdAt'], ['actorId', 'causationEventId']);
  if (event.schemaVersion !== 1) fail('schemaVersion');
  string(event.id, 'id');
  string(event.managementRunId, 'managementRunId');
  positiveInteger(event.sequence, 'sequence');
  const type = string(event.type, 'type') as WritableEventType;
  if (!allowedTypes.includes(type)) fail('type');
  if (!['system', 'manager', 'agent', 'human'].includes(string(event.actorKind, 'actorKind'))) fail('actorKind');
  optionalString(event.actorId, 'actorId');
  string(event.idempotencyKey, 'idempotencyKey');
  optionalString(event.causationEventId, 'causationEventId');
  nonNegativeInteger(event.createdAt, 'createdAt');

  const payload = record(event.payload, 'payload');
  const schema = payloadKeys[type];
  exactKeys(payload, schema.required, schema.optional ?? []);
  validatePayload(type, payload);
  return event as unknown as ManagementEventV1;
}

export function hashManagementEventPayload(input: Pick<ManagementEventV1, 'type' | 'payload'>): string {
  return createHash('sha256').update(canonicalJson({ type: input.type, payload: input.payload })).digest('hex');
}

export function hashManagementCommandInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function validatePayload(type: WritableEventType, payload: Record<string, unknown>): void {
  switch (type) {
    case 'run-started':
      string(payload.rootMessageId, 'payload.rootMessageId');
      optionalString(payload.rootTaskId, 'payload.rootTaskId');
      if (payload.mode !== 'managed') fail('payload.mode');
      return;
    case 'worker-leased':
      string(payload.workerId, 'payload.workerId'); string(payload.leaseFingerprint, 'payload.leaseFingerprint'); nonNegativeInteger(payload.expiresAt, 'payload.expiresAt'); return;
    case 'worker-lost':
      string(payload.workerId, 'payload.workerId'); nonNegativeInteger(payload.lastHeartbeatAt, 'payload.lastHeartbeatAt'); string(payload.reasonCode, 'payload.reasonCode'); return;
    case 'checkpoint-updated':
      positiveInteger(payload.checkpointRevision, 'payload.checkpointRevision'); nonNegativeInteger(payload.lastEventSequence, 'payload.lastEventSequence'); return;
    case 'invocation-created':
      string(payload.invocationId, 'payload.invocationId'); string(payload.intentHash, 'payload.intentHash'); optionalPositiveInteger(payload.taskRevision, 'payload.taskRevision'); return;
    case 'dispatch-attempt-started':
      string(payload.invocationId, 'payload.invocationId'); string(payload.dispatchId, 'payload.dispatchId'); positiveInteger(payload.attemptNumber, 'payload.attemptNumber'); return;
    case 'dispatch-attempt-completed':
      string(payload.invocationId, 'payload.invocationId'); string(payload.dispatchId, 'payload.dispatchId'); positiveInteger(payload.attemptNumber, 'payload.attemptNumber');
      if (!['cancelled', 'succeeded', 'failed', 'timed_out'].includes(string(payload.status, 'payload.status'))) fail('payload.status'); return;
    case 'waiting-for-user':
      string(payload.reasonCode, 'payload.reasonCode'); optionalString(payload.questionMessageId, 'payload.questionMessageId'); return;
    case 'root-delivery-submitted':
      string(payload.messageId, 'payload.messageId'); stringArray(payload.contributingInvocationIds, 'payload.contributingInvocationIds'); return;
    case 'run-completed':
      optionalString(payload.completedTaskId, 'payload.completedTaskId'); string(payload.deliveryMessageId, 'payload.deliveryMessageId'); return;
    case 'run-failed':
      string(payload.errorCode, 'payload.errorCode'); if (typeof payload.recoverable !== 'boolean') fail('payload.recoverable'); return;
    case 'run-cancelled':
      string(payload.reasonCode, 'payload.reasonCode'); string(payload.cancelledBy, 'payload.cancelledBy'); return;
    case 'task-created':
      string(payload.taskId, 'payload.taskId'); optionalString(payload.parentTaskId, 'payload.parentTaskId');
      positiveInteger(payload.taskRevision, 'payload.taskRevision'); return;
    case 'task-revised':
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.previousRevision, 'payload.previousRevision');
      positiveInteger(payload.taskRevision, 'payload.taskRevision');
      if (payload.taskRevision !== (payload.previousRevision as number) + 1) fail('payload.taskRevision');
      stringArray(payload.criterionIds, 'payload.criterionIds'); string(payload.reasonCode, 'payload.reasonCode'); return;
    case 'task-state-changed': {
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.taskRevision, 'payload.taskRevision');
      const from = taskStatus(payload.from, 'payload.from');
      const to = taskStatus(payload.to, 'payload.to');
      if (from === to) fail('payload.to');
      return;
    }
    case 'task-published-for-claim':
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.taskRevision, 'payload.taskRevision');
      stringArray(payload.requiredCapabilities, 'payload.requiredCapabilities'); return;
    case 'task-assigned':
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.taskRevision, 'payload.taskRevision');
      string(payload.agentId, 'payload.agentId'); return;
    case 'task-claimed':
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.taskRevision, 'payload.taskRevision');
      string(payload.agentId, 'payload.agentId'); string(payload.claimLeaseId, 'payload.claimLeaseId');
      positiveInteger(payload.attempt, 'payload.attempt'); return;
    case 'claim-invalidated':
      string(payload.taskId, 'payload.taskId'); positiveInteger(payload.previousTaskRevision, 'payload.previousTaskRevision');
      string(payload.claimLeaseId, 'payload.claimLeaseId');
      stringArray(payload.invalidatedInvocationIds, 'payload.invalidatedInvocationIds');
      string(payload.reasonCode, 'payload.reasonCode'); return;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite-number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const valueRecord = value as Record<string, unknown>;
    return `{${Object.keys(valueRecord).filter((key) => valueRecord[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`).join(',')}}`;
  }
  fail('unsupported-value');
}

function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void { const allowed = new Set([...required, ...optional]); if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) fail('keys'); }
function string(value: unknown, path: string): string { if (typeof value !== 'string' || value.length === 0) fail(path); return value; }
function optionalString(value: unknown, path: string): void { if (value !== undefined) string(value, path); }
function nonNegativeInteger(value: unknown, path: string): void { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path); }
function positiveInteger(value: unknown, path: string): void { if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(path); }
function optionalPositiveInteger(value: unknown, path: string): void { if (value !== undefined) positiveInteger(value, path); }
function stringArray(value: unknown, path: string): void { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) fail(path); }
function taskStatus(value: unknown, path: string): string {
  const status = string(value, path);
  if (!['todo', 'in_progress', 'in_review', 'done', 'closed'].includes(status)) fail(path);
  return status;
}
function fail(path: string): never { throw new Error(`INVALID_MANAGEMENT_EVENT:${path}`); }
