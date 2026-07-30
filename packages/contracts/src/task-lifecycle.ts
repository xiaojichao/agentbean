import type { ID, UnixMs } from './common.js';
import type { SubtaskAcceptanceV1 } from './task-coordination.js';
import type { TaskStatus } from './task.js';
import { COMMAND_PROVENANCE_KINDS, type CommandProvenanceRefV1 } from './message-tracer.js';

export const TASK_LIFECYCLE_COMMAND_NAMES = [
  'transition-task-in-progress','submit-root-delivery','accept-root-delivery',
  'reject-root-delivery','transition-subtask-in-review','accept-subtask',
  'reject-subtask','cancel-task','close-task','start-execution',
] as const;
export type TaskLifecycleCommandName = (typeof TASK_LIFECYCLE_COMMAND_NAMES)[number];
export const TASK_LIFECYCLE_ENVELOPE_SCHEMA_VERSION = 1;
export const TASK_LIFECYCLE_COMMAND_SCHEMA_VERSION = 1;
export const TASK_LIFECYCLE_COMMAND_HASH_VERSION = 1;
export const TASK_LIFECYCLE_AUTHORITY_KINDS = ['pi_driver','human','agent','admin','requester'] as const;
export type TaskLifecycleAuthorityKind = (typeof TASK_LIFECYCLE_AUTHORITY_KINDS)[number];
export const TASK_LIFECYCLE_RECEIPT_OUTCOMES = ['applied','no_op'] as const;
export type TaskLifecycleReceiptOutcome = (typeof TASK_LIFECYCLE_RECEIPT_OUTCOMES)[number];
export const TASK_LIFECYCLE_DISPOSITIONS = ['created','existing','updated'] as const;
export type TaskLifecycleDisposition = (typeof TASK_LIFECYCLE_DISPOSITIONS)[number];

export interface TaskLifecycleCommandEnvelopeV1 {
  readonly schemaVersion: 1; readonly commandName: TaskLifecycleCommandName;
  readonly commandSchemaVersion: number; readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1; readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface TaskLifecycleCommandInputMapV1 {
  readonly 'transition-task-in-progress': { readonly taskId: ID; readonly expectedTaskRevision: number };
  readonly 'submit-root-delivery': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly messageId: ID; readonly contributingInvocationIds: readonly ID[] };
  readonly 'accept-root-delivery': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly deliveryMessageId: ID };
  readonly 'reject-root-delivery': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reason: string };
  readonly 'transition-subtask-in-review': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly deliveryId: ID; readonly claimLeaseId: ID; readonly invocationId: ID; readonly evidenceRefs: readonly { readonly kind: string; readonly id: ID; readonly snapshotHash: string; readonly snapshotRevision?: number; readonly capturedAt: UnixMs }[]; readonly idempotencyKey: string };
  readonly 'accept-subtask': { readonly acceptance: SubtaskAcceptanceV1 };
  readonly 'reject-subtask': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reason: string };
  readonly 'cancel-task': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reason: string };
  readonly 'close-task': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly reason: string };
  readonly 'start-execution': { readonly taskId: ID; readonly expectedTaskRevision: number; readonly claimLeaseId: ID };
}

export interface TaskLifecycleCommandOutputMapV1 {
  readonly 'transition-task-in-progress': { readonly taskId: ID; readonly taskRevision: number; readonly status: TaskStatus };
  readonly 'submit-root-delivery': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'in_review'; readonly deliveryMessageId: ID };
  readonly 'accept-root-delivery': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'done' };
  readonly 'reject-root-delivery': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'in_progress' };
  readonly 'transition-subtask-in-review': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'in_review' };
  readonly 'accept-subtask': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'done'|'in_review' };
  readonly 'reject-subtask': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'todo'; readonly attempt: number };
  readonly 'cancel-task': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'cancelled'; readonly cancelledSubtaskIds: readonly ID[] };
  readonly 'close-task': { readonly taskId: ID; readonly taskRevision: number; readonly status: 'closed'; readonly closedSubtaskIds: readonly ID[] };
  readonly 'start-execution': { readonly taskId: ID; readonly taskRevision: number; readonly startedAt: UnixMs };
}

export interface TaskLifecycleEventRefV1 { readonly streamKind: string; readonly streamId: ID; readonly sequence: number }
export interface TaskLifecycleRevisionRefV1 { readonly streamKind: string; readonly streamId: ID; readonly revision: number }
export interface TaskLifecycleCommandReceiptV1 {
  readonly schemaVersion: 1; readonly receiptId: ID; readonly commandName: TaskLifecycleCommandName;
  readonly commandSchemaVersion: number; readonly idempotencyKey: string; readonly commandHash: string;
  readonly outcome: 'applied'|'no_op'; readonly committedRevisions: readonly TaskLifecycleRevisionRefV1[];
  readonly eventRefs: readonly TaskLifecycleEventRefV1[]; readonly commitTime: UnixMs; readonly resultAvailable: boolean;
}
export const TASK_LIFECYCLE_OUTCOMES = ['applied','no_op','replayed','freshness_hold','conflict','rejected','temporarily_unavailable','outcome_unknown'] as const;
export type TaskLifecycleOutcome = (typeof TASK_LIFECYCLE_OUTCOMES)[number];
export const TASK_LIFECYCLE_RETRY_DIRECTIVES = ['none','same_key','reread_then_new_command','user_action'] as const;
export type TaskLifecycleRetryDirective = (typeof TASK_LIFECYCLE_RETRY_DIRECTIVES)[number];
export interface TaskLifecycleCommandResponseV1 {
  readonly schemaVersion: 1; readonly commandName: TaskLifecycleCommandName;
  readonly outcome: TaskLifecycleOutcome; readonly retryDirective: TaskLifecycleRetryDirective;
  readonly stableCode: string; readonly receipt?: TaskLifecycleCommandReceiptV1;
  readonly result?: TaskLifecycleCommandOutputUnionV1; readonly conflictReason?: string; readonly rejectReason?: string;
}
export type TaskLifecycleCommandOutputUnionV1 =
  |({readonly commandName:'transition-task-in-progress'}&TaskLifecycleCommandOutputMapV1['transition-task-in-progress'])
  |({readonly commandName:'submit-root-delivery'}&TaskLifecycleCommandOutputMapV1['submit-root-delivery'])
  |({readonly commandName:'accept-root-delivery'}&TaskLifecycleCommandOutputMapV1['accept-root-delivery'])
  |({readonly commandName:'reject-root-delivery'}&TaskLifecycleCommandOutputMapV1['reject-root-delivery'])
  |({readonly commandName:'transition-subtask-in-review'}&TaskLifecycleCommandOutputMapV1['transition-subtask-in-review'])
  |({readonly commandName:'accept-subtask'}&TaskLifecycleCommandOutputMapV1['accept-subtask'])
  |({readonly commandName:'reject-subtask'}&TaskLifecycleCommandOutputMapV1['reject-subtask'])
  |({readonly commandName:'cancel-task'}&TaskLifecycleCommandOutputMapV1['cancel-task'])
  |({readonly commandName:'close-task'}&TaskLifecycleCommandOutputMapV1['close-task'])
  |({readonly commandName:'start-execution'}&TaskLifecycleCommandOutputMapV1['start-execution']);

function canonicalizeValue(value: unknown): unknown {
  if(Array.isArray(value)) return value.map(canonicalizeValue);
  if(value&&typeof value==='object'){const s:Record<string,unknown>={};for(const k of Object.keys(value as Record<string,unknown>).sort()){const e=(value as Record<string,unknown>)[k];if(e!==undefined)s[k]=canonicalizeValue(e);}return s;}
  return value;
}
export function canonicalizeTaskLifecycleCommand(cn: TaskLifecycleCommandName, cv: number, input: unknown): string {
  return JSON.stringify(canonicalizeValue({v:TASK_LIFECYCLE_COMMAND_HASH_VERSION,commandName:cn,commandSchemaVersion:cv,input}));
}
